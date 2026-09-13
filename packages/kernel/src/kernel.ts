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
   * Hash every channel a module did not declare before and after its step, and throw on a change.
   * Development and tests only: it costs a pass over every buffer per module per tick.
   */
  readonly audit?: boolean;
  /** Per-module configuration, keyed by module id. */
  readonly config?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** Optional per-module state hooks, for modules with internal state worth snapshotting. */
export interface Stateful {
  getState(): unknown;
  setState(state: unknown): void;
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

interface Scheduled {
  readonly module: SimModule;
  readonly rateDivisor: number;
  readonly audited: readonly string[];
}

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
  #hashScratch: number[] = [];

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
    this.#schedule = this.#schedule.map((s) => ({
      ...s,
      audited: this.#options.audit ? this.channels.undeclaredFor(s.module.manifest.id) : [],
    }));
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
        out.push({ module, rateDivisor: module.manifest.rateDivisor ?? 1, audited: [] });
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

    const schedule = this.#schedule;
    for (let i = 0; i < schedule.length; i++) {
      const s = schedule[i] as Scheduled;
      if (s.rateDivisor !== 1 && !this.clock.shouldRun(s.rateDivisor)) continue;
      if (s.audited.length > 0) this.#auditBefore(s);
      s.module.step(ctx);
      if (s.audited.length > 0) this.#auditAfter(s);
    }

    this.clock.advance();
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.step();
  }

  #auditBefore(s: Scheduled): void {
    const scratch = this.#hashScratch;
    scratch.length = 0;
    for (const id of s.audited) scratch.push(this.channels.hash(id));
  }

  #auditAfter(s: Scheduled): void {
    for (let i = 0; i < s.audited.length; i++) {
      const id = s.audited[i] as string;
      if (this.channels.hash(id) !== this.#hashScratch[i]) {
        throw new Error(
          `Module '${s.module.manifest.id}' changed channel '${id}' during step at tick ` +
            `${this.clock.tick} without declaring a write or accumulation. Declared access is ` +
            'enforced (ADR-004).',
        );
      }
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
   * would leave the simulation in a state no run could have produced.
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
      new Uint8Array(storage.buffer, 0, storage.buffer.byteLength).set(bytes);
    }
    for (const [id, prng] of this.#random) {
      const state = snapshot.random[id];
      if (!state) throw new Error(`Snapshot has no random state for module '${id}'.`);
      prng.setState(state);
    }
    for (const { module } of this.#schedule) {
      if (isStateful(module) && module.manifest.id in snapshot.modules) {
        module.setState(snapshot.modules[module.manifest.id]);
      }
    }
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
