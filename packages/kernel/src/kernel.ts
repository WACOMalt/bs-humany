/**
 * The scheduler -- M2.3, with snapshot and restore -- M2.5.
 *
 * ADR-004. Fixed timestep; modules run in declared phases in a deterministic order; every channel
 * has one writer except accumulators. Reproducibility is the property everything else rests on,
 * so the ordering rules are spelled out and nothing depends on registration order:
 *
 *   1. Phases run in the fixed order `input, sense, control, actuate, solve, post`.
 *   2. Within a phase, a module runs after every module it `dependsOn` in that phase.
 *   3. Remaining ties break by `order` (ascending), then by module `id` (lexicographic).
 *
 * A dependency on a module in another phase orders nothing -- phase order already decides -- and
 * is checked only for existence and version. Depending on a *later* phase is the normal case: a
 * sense module reads what solve wrote on the previous tick, by design (spec 10.2).
 *
 * Step-rate code touches no strings and allocates nothing. Views are acquired at init; the step
 * context is one reused object; the module list is a resolved array.
 */

import { ChannelRegistry, type ChannelStorage } from './channels.js';
import { SimClock } from './clock.js';
import { type Prng, type PrngState, createPrng } from './prng.js';
import { satisfies } from './semver.js';
import {
  type ChannelView,
  type ModuleInitContext,
  type ModuleStepContext,
  PHASES,
  type SimModule,
} from './types.js';

export interface KernelOptions {
  /** Physics rate, Hz. Immutable for the session (spec 10.6). */
  readonly rateHz: number;
  /** Session seed. Each module derives its own stream from it by id. */
  readonly seed: number;
  /** Prefer SharedArrayBuffer for `shared` channels when available. */
  readonly preferShared?: boolean;
  /**
   * Check that a module's step leaves every channel it did not declare bit-for-bit as it found it,
   * and throw on any change. Development and tests only: it keeps a copy of every channel and costs
   * a pass over every buffer per module per tick.
   *
   * Left unset, it follows the environment: on when `BS_HUMANY_KERNEL_AUDIT` is `1`, which
   * `vitest.config.ts` sets for every test run, and off everywhere else, including every browser.
   * A host that wants it regardless passes `true`; one that must not pay for it inside a test run
   * passes `false`.
   */
  readonly audit?: boolean;
  /**
   * Per-module configuration, keyed by module id, handed to each module as
   * `ModuleInitContext.config`. Reserved for data-driven module configuration (spec 10.1's
   * `configSchema`, and the WorkerHost path, where modules are built in the worker). No module
   * reads it today; configure a module through its constructor.
   */
  readonly config?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/**
 * Optional per-module state hooks, for modules with internal state worth snapshotting.
 *
 * Anything a module keeps outside the channels and carries from one tick to the next -- a fibre
 * length, a conduction delay's history, a noise stream half-way through -- is state, and a
 * restore that does not bring it back starts a different run from the one that was captured
 * (spec 13.7). `restore` calls `reset` on every module first, then `setState`, then writes the
 * captured channels. What `setState` puts back is what the next tick starts from, and the
 * channels that tick reads are the captured bytes, whatever either hook published into them.
 *
 * Return a `Uint8Array` from `getState`. A session file is JSON, and the studio's serializer
 * carries module state across as base64 only when it is bytes; `packState` and `unpackState`
 * turn a module's numbers into bytes and back. Only these two hooks may allocate: they run when a
 * host asks for a snapshot, never inside `step`.
 */
export interface Stateful {
  getState(): unknown;
  setState(state: unknown): void;
}

/**
 * A module's numbers as bytes, for `Stateful.getState`: each one as a float64, in the platform's
 * byte order, as the channels in a snapshot are.
 *
 * Float64 for everything, counters and flags included, because every integer a module keeps --
 * a tick count, a 32-bit generator word, a ring's head -- is exact in one, and a single element
 * type is one less thing for a reader to get wrong.
 */
export function packState(values: ArrayLike<number>): Uint8Array {
  const words = Float64Array.from(values);
  return new Uint8Array(words.buffer);
}

/**
 * The numbers `packState` packed, for `Stateful.setState`, copied into memory of their own.
 *
 * Copied rather than viewed because the bytes may come from anywhere -- a base64 decode, a slice
 * of a larger buffer -- and a Float64Array over another buffer needs an offset that is a multiple
 * of eight, which nothing promises. Throws with the module's name when the state is not bytes or
 * not whole float64s, which is what a session saved by some other build of a module looks like.
 */
export function unpackState(state: unknown, moduleId: string): Float64Array {
  if (!(state instanceof Uint8Array) || state.byteLength % 8 !== 0) {
    throw new Error(
      `Module '${moduleId}' was handed state that is not the bytes its getState produced; ` +
        'the snapshot was probably taken by a different build of the module.',
    );
  }
  const words = new Float64Array(state.byteLength / 8);
  new Uint8Array(words.buffer).set(state);
  return words;
}

function isStateful(m: SimModule): m is SimModule & Stateful {
  return (
    typeof (m as Partial<Stateful>).getState === 'function' &&
    typeof (m as Partial<Stateful>).setState === 'function'
  );
}

export interface KernelSnapshot {
  readonly tick: number;
  readonly dt: number;
  readonly seed: number;
  /** Every channel's bytes, keyed by id. Copies, not views. */
  readonly channels: Readonly<Record<string, Uint8Array>>;
  /** Each module's random stream. */
  readonly random: Readonly<Record<string, PrngState>>;
  /** Module-provided state, for modules implementing `Stateful`. */
  readonly modules: Readonly<Record<string, unknown>>;
}

/**
 * Whether the environment asks for the audit. Read through `globalThis` so the kernel neither
 * imports Node types nor throws where there is no `process` -- a browser, a Worker in one.
 */
function auditFromEnvironment(): boolean {
  const process = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return typeof process === 'object' && process.env?.BS_HUMANY_KERNEL_AUDIT === '1';
}

/**
 * Whether two equal-length word views hold the same bits. Signed words, not unsigned: an unsigned
 * word at or above 2^31 is not a small integer to V8, so every float with its sign or top exponent
 * bit set would leave the fast path, and the loop ran slower than the hash it replaced.
 */
function sameWords(a: Int32Array, b: Int32Array): boolean {
  const n = a.length;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface Scheduled {
  readonly module: SimModule;
  readonly rateDivisor: number;
  /** Indices into the kernel's audit id list of the channels this module must not change. */
  readonly audited: Int32Array;
  /** Indices of the channels it writes or accumulates into, whose kept copies it moves on. */
  readonly declared: Int32Array;
}

const NONE = new Int32Array(0);

class StepContext implements ModuleStepContext {
  tick = 0;
  dt = 0;
  simTime = 0;
}

export class Kernel {
  readonly clock: SimClock;
  readonly channels: ChannelRegistry;
  readonly #options: KernelOptions;
  readonly #registered = new Map<string, SimModule>();
  readonly #random = new Map<string, Prng>();
  readonly #master: Prng;
  readonly #stepContext = new StepContext();
  #schedule: Scheduled[] = [];
  #initialised = false;
  /** Whether the declared-access audit runs, resolved once at init. */
  #auditing = false;
  /** Every channel id, in the order the audit's indices refer to. */
  #auditIds: readonly string[] = [];
  /** Each channel's live words, in `#auditIds` order, taken once at init. */
  #auditLive: readonly Int32Array[] = [];
  /**
   * What each channel should hold right now: copied from every channel at the top of the tick, and
   * moved on after each module's step for the channels that module declared. Allocated at init, so
   * the audit allocates nothing per tick.
   */
  #auditKept: readonly Int32Array[] = [];

  constructor(options: KernelOptions) {
    this.#options = options;
    this.clock = new SimClock(options.rateHz);
    this.channels = new ChannelRegistry({ preferShared: options.preferShared ?? true });
    this.#master = createPrng(options.seed);
  }

  /** Add a module. Must precede `init`. */
  register(module: SimModule): void {
    if (this.#initialised) throw new Error('Cannot register a module after init.');
    const id = module.manifest.id;
    if (this.#registered.has(id)) throw new Error(`Module '${id}' is registered twice.`);
    if (!PHASES.includes(module.manifest.phase)) {
      throw new Error(`Module '${id}' declares unknown phase '${module.manifest.phase}'.`);
    }
    const divisor = module.manifest.rateDivisor ?? 1;
    if (!Number.isInteger(divisor) || divisor < 1) {
      throw new Error(`Module '${id}' rateDivisor must be a positive integer, got ${divisor}.`);
    }
    this.#registered.set(id, module);
  }

  /** The resolved run order, for tests and diagnostics. */
  order(): string[] {
    return this.#schedule.map((s) => s.module.manifest.id);
  }

  /**
   * Resolve dependencies, allocate channels, check every declaration, and initialise modules in
   * run order.
   */
  async init(): Promise<void> {
    if (this.#initialised) throw new Error('Kernel is already initialised.');
    this.#schedule = this.#resolveOrder();

    for (const { module } of this.#schedule) {
      for (const spec of module.manifest.gives) this.channels.give(spec, module.manifest.id);
    }
    for (const { module } of this.#schedule) this.#checkVersions(module);
    for (const { module } of this.#schedule) this.channels.declare(module.manifest);

    for (const { module } of this.#schedule) {
      const id = module.manifest.id;
      const random = this.#master.derive(id);
      this.#random.set(id, random);
      await module.init(this.#initContext(module, random));
    }

    // The audit lists are computed after every declaration is in, so they see the final ownership.
    this.#auditing = this.#options.audit ?? auditFromEnvironment();
    if (this.#auditing) {
      const ids = this.channels.ids();
      const index = new Map(ids.map((id, i) => [id, i]));
      this.#auditIds = ids;
      this.#auditLive = ids.map((id) => this.channels.words(id));
      this.#auditKept = this.#auditLive.map((live) => new Int32Array(live.length));
      this.#schedule = this.#schedule.map((s) => {
        const undeclared = new Set(this.channels.undeclaredFor(s.module.manifest.id));
        return {
          ...s,
          audited: Int32Array.from(undeclared, (id) => index.get(id) ?? -1),
          declared: Int32Array.from(
            ids.filter((id) => !undeclared.has(id)),
            (id) => index.get(id) ?? -1,
          ),
        };
      });
    }
    this.#initialised = true;
  }

  #initContext(module: SimModule, random: Prng): ModuleInitContext {
    const id = module.manifest.id;
    const channels = this.channels;
    return {
      read: (channelId): ChannelView => channels.view(id, channelId, 'read'),
      write: (channelId): ChannelView => channels.view(id, channelId, 'write'),
      accumulate: (channelId): ChannelView => channels.view(id, channelId, 'accumulate'),
      random,
      dt: this.clock.dt,
      config: this.#options.config?.[id] ?? {},
    };
  }

  #checkVersions(module: SimModule): void {
    const m = module.manifest;
    for (const dep of m.dependsOn) {
      const target = this.#registered.get(dep.id);
      if (!target)
        throw new Error(`Module '${m.id}' depends on '${dep.id}', which is not registered.`);
      if (!satisfies(target.manifest.version, dep.version)) {
        throw new Error(
          `Module '${m.id}' depends on '${dep.id}' ${dep.version}, but '${dep.id}' is version ` +
            `${target.manifest.version}.`,
        );
      }
    }
    for (const ref of [...m.reads, ...m.writes, ...m.accumulates]) {
      if (!this.channels.has(ref.id)) continue; // declare() reports missing channels with more context
      const spec = this.channels.storage(ref.id).spec;
      if (!satisfies(spec.version, ref.version)) {
        throw new Error(
          `Module '${m.id}' was written against channel '${ref.id}' ${ref.version}, but the ` +
            `channel is version ${spec.version}.`,
        );
      }
    }
  }

  /**
   * Deterministic order: phases fixed, dependencies respected within a phase, ties broken by
   * `order` then id. Kahn's algorithm with a sorted ready set, so the result is a pure function of
   * the manifests and never of registration order.
   */
  #resolveOrder(): Scheduled[] {
    const modules = [...this.#registered.values()];
    const byId = new Map(modules.map((m) => [m.manifest.id, m]));
    const out: Scheduled[] = [];

    for (const phase of PHASES) {
      const inPhase = modules.filter((m) => m.manifest.phase === phase);
      const indegree = new Map<string, number>();
      const dependents = new Map<string, string[]>();
      for (const m of inPhase) {
        indegree.set(m.manifest.id, 0);
        dependents.set(m.manifest.id, []);
      }
      for (const m of inPhase) {
        for (const dep of m.manifest.dependsOn) {
          const target = byId.get(dep.id);
          if (!target)
            throw new Error(
              `Module '${m.manifest.id}' depends on '${dep.id}', which is not registered.`,
            );
          // A dependency in another phase is an existence-and-version requirement only; ordering
          // between phases is fixed. Depending on a *later* phase is normal, not an error: a sense
          // module reads what solve wrote last tick, by design (spec 10.2).
          if (target.manifest.phase !== phase) continue;
          indegree.set(m.manifest.id, (indegree.get(m.manifest.id) ?? 0) + 1);
          dependents.get(dep.id)?.push(m.manifest.id);
        }
      }

      const tieBreak = (a: string, b: string) => {
        const ma = byId.get(a)?.manifest;
        const mb = byId.get(b)?.manifest;
        return (ma?.order ?? 0) - (mb?.order ?? 0) || (a < b ? -1 : a > b ? 1 : 0);
      };
      const ready = inPhase
        .map((m) => m.manifest.id)
        .filter((id) => indegree.get(id) === 0)
        .sort(tieBreak);
      const placed: string[] = [];
      while (ready.length > 0) {
        const id = ready.shift() as string;
        placed.push(id);
        for (const d of dependents.get(id) ?? []) {
          const n = (indegree.get(d) ?? 0) - 1;
          indegree.set(d, n);
          if (n === 0) {
            ready.push(d);
            ready.sort(tieBreak);
          }
        }
      }
      if (placed.length !== inPhase.length) {
        const stuck = inPhase.map((m) => m.manifest.id).filter((id) => !placed.includes(id));
        throw new Error(
          `Dependency cycle among modules in phase '${phase}': ${this.#describeCycle(stuck, byId).join(' -> ')}.`,
        );
      }
      for (const id of placed) {
        const module = byId.get(id) as SimModule;
        out.push({
          module,
          rateDivisor: module.manifest.rateDivisor ?? 1,
          audited: NONE,
          declared: NONE,
        });
      }
    }
    return out;
  }

  #describeCycle(stuck: string[], byId: Map<string, SimModule>): string[] {
    // Walk dependsOn edges among the stuck set until an id repeats.
    const start = [...stuck].sort()[0] as string;
    const path = [start];
    const seen = new Set([start]);
    let current = start;
    for (let i = 0; i < stuck.length + 1; i++) {
      const next = byId
        .get(current)
        ?.manifest.dependsOn.map((d) => d.id)
        .find((id) => stuck.includes(id));
      if (!next) break;
      path.push(next);
      if (seen.has(next)) break;
      seen.add(next);
      current = next;
    }
    return path;
  }

  /** Advance one fixed tick. */
  step(): void {
    if (!this.#initialised) throw new Error('Kernel.step called before init.'); // allocation-ok: error path
    const ctx = this.#stepContext;
    ctx.tick = this.clock.tick;
    ctx.dt = this.clock.dt;
    ctx.simTime = this.clock.simTime;

    this.channels.zeroAccumulators();

    const auditing = this.#auditing;
    if (auditing) this.#auditStart();
    const schedule = this.#schedule;
    for (let i = 0; i < schedule.length; i++) {
      const s = schedule[i] as Scheduled;
      if (s.rateDivisor !== 1 && !this.clock.shouldRun(s.rateDivisor)) continue;
      s.module.step(ctx);
      if (auditing) this.#auditAfter(s);
    }

    this.clock.advance();
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.step();
  }

  /*
   * The audit. Each module must leave every channel it did not declare as it found it, so every
   * channel is copied once at the top of the tick -- after the accumulators are zeroed and whatever
   * the host wrote between ticks, both of which are allowed -- and the copy is carried through the
   * tick: after a module's step, the channels it did not declare must still match their copies word
   * for word, and the ones it did declare are copied again so the next module is held to what this
   * one left. That is one pass over every channel per module, where checking each module's
   * undeclared channels before and after its step was two.
   *
   * It compares the words rather than a hash of them because a hash can collide, and the audit is
   * the only thing between a write through a read view and a silently wrong simulation. An earlier
   * word-wise FNV-1a let two sign flips cancel, so a module negating a quaternion in place got
   * through. Comparing is exact for any change to any bit, and it is cheaper than hashing: the copy
   * is a block move, and the check is one compare per word where the hash was a dependent multiply
   * per word. On a kernel with the trainer's channels it took about two thirds of the word hash's
   * time per tick. The words are compared as integers, not floats, so a NaN matches itself and -0
   * does not match 0. The copies cost as much memory again as the channels, and only when auditing.
   */
  #auditStart(): void {
    const live = this.#auditLive;
    const kept = this.#auditKept;
    for (let i = 0; i < live.length; i++) (kept[i] as Int32Array).set(live[i] as Int32Array);
  }

  #auditAfter(s: Scheduled): void {
    const live = this.#auditLive;
    const kept = this.#auditKept;
    for (let i = 0; i < s.audited.length; i++) {
      const at = s.audited[i] as number;
      if (!sameWords(live[at] as Int32Array, kept[at] as Int32Array)) {
        throw new Error(
          `Module '${s.module.manifest.id}' changed channel '${this.#auditIds[at]}' during step ` +
            `at tick ${this.clock.tick} without declaring a write or accumulation. Declared ` +
            'access is enforced (ADR-004).',
        );
      }
    }
    for (let i = 0; i < s.declared.length; i++) {
      const at = s.declared[i] as number;
      (kept[at] as Int32Array).set(live[at] as Int32Array);
    }
  }

  /** Full state: clock, every channel, every module's random stream, and module-provided state. */
  snapshot(): KernelSnapshot {
    const channels: Record<string, Uint8Array> = {};
    for (const id of this.channels.ids()) {
      const storage: ChannelStorage = this.channels.storage(id);
      channels[id] = new Uint8Array(storage.buffer, 0, storage.buffer.byteLength).slice();
    }
    const random: Record<string, PrngState> = {};
    for (const [id, prng] of this.#random) random[id] = prng.getState();
    const modules: Record<string, unknown> = {};
    for (const { module } of this.#schedule) {
      if (isStateful(module)) modules[module.manifest.id] = module.getState();
    }
    return {
      tick: this.clock.tick,
      dt: this.clock.dt,
      seed: this.#options.seed,
      channels,
      random,
      modules,
    };
  }

  /**
   * Restore a snapshot taken from a kernel with the same modules, channels and timestep.
   *
   * Refuses a mismatch rather than partially applying it: a snapshot from a different module set
   * would leave the simulation in a state no run could have produced. The channels and random
   * streams are checked before anything is touched. A module's `setState` checks its own state and
   * may still refuse after the resets have run, and a host that sees `restore` throw should treat
   * the simulation as spent and start it again, not step it.
   */
  restore(snapshot: KernelSnapshot): void {
    if (!this.#initialised) throw new Error('Kernel.restore called before init.');
    if (snapshot.dt !== this.clock.dt) {
      throw new Error(
        `Snapshot was taken at dt=${snapshot.dt}; this kernel runs at dt=${this.clock.dt}.`,
      );
    }
    const ids = this.channels.ids();
    const snapIds = Object.keys(snapshot.channels).sort();
    if (ids.join('\n') !== snapIds.join('\n')) {
      throw new Error(
        `Snapshot channels [${snapIds.join(', ')}] do not match this kernel's [${ids.join(', ')}].`,
      );
    }
    for (const id of ids) {
      const storage = this.channels.storage(id);
      const bytes = snapshot.channels[id] as Uint8Array;
      if (bytes.byteLength !== storage.buffer.byteLength) {
        throw new Error(
          `Snapshot channel '${id}' is ${bytes.byteLength} bytes; expected ${storage.buffer.byteLength}.`,
        );
      }
    }
    for (const [id] of this.#random) {
      if (!snapshot.random[id]) throw new Error(`Snapshot has no random state for module '${id}'.`);
    }
    // Every module is told the world has moved under it, so it rebinds and forgets. Without this
    // the muscles' fibres belonged to the pose the last run ended in, and the first tick after a
    // restore pulled the body off the ground with them.
    for (const { module } of this.#schedule) {
      const random = this.#random.get(module.manifest.id);
      if (module.reset && random) module.reset(this.#initContext(module, random));
    }
    // Then what was captured goes back, all of it after the resets so that none of them can undo
    // any of it. A module with an entry in `snapshot.modules` gets its exact state back, and the
    // run continues as the captured one would have (spec 13.7). A module without one -- it is not
    // Stateful, or the snapshot is from a session file older than its state -- keeps what its
    // reset left, which is to forget and start again from here, as every module used to.
    for (const { module } of this.#schedule) {
      if (isStateful(module) && module.manifest.id in snapshot.modules) {
        module.setState(snapshot.modules[module.manifest.id]);
      }
    }
    // The channels last, because a reset or a setState may publish into them, and what it
    // publishes is not always what the captured run held. The physics module is the case that
    // matters: it republishes from the restored backend, whose joint forces and contacts are
    // worked out afresh at the restored pose, where the captured run's were what its last step
    // left. The next tick reads the channels, so they have to be the captured bytes exactly.
    for (const id of ids) {
      const storage = this.channels.storage(id);
      new Uint8Array(storage.buffer, 0, storage.buffer.byteLength).set(
        snapshot.channels[id] as Uint8Array,
      );
    }
    // And the random streams, after anything that might have drawn from one.
    for (const [id, prng] of this.#random) prng.setState(snapshot.random[id] as PrngState);
    this.clock.restore({ tick: snapshot.tick, dt: snapshot.dt });
  }

  /** Order-sensitive hash of every channel, for the determinism harness and golden trajectories. */
  stateHash(): number {
    let h = 2166136261;
    for (const id of this.channels.ids()) {
      h ^= this.channels.hash(id);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return (h ^ this.clock.tick) >>> 0;
  }

  dispose(): void {
    for (const { module } of this.#schedule) module.dispose?.();
  }
}
