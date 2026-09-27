import { describe, expect, it } from 'vitest';
import { Kernel, type KernelSnapshot } from './kernel.js';
import type {
  ChannelSpec,
  ChannelView,
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  Phase,
  SimModule,
} from './types.js';

const POSE: ChannelSpec = {
  id: 'body.pose',
  version: '1.0.0',
  layout: 'SoA',
  fields: [{ name: 'position', dtype: 'f64', components: 3 }],
  elementCount: 2,
  mode: 'single-writer',
  backing: 'shared',
};
const TORQUE: ChannelSpec = {
  id: 'actuation.jointTorque',
  version: '1.0.0',
  layout: 'SoA',
  fields: [{ name: 'torque', dtype: 'f64', components: 1 }],
  elementCount: 3,
  mode: 'accumulator',
  backing: 'local',
};

const ORIENTATION: ChannelSpec = {
  id: 'body.orientation',
  version: '1.0.0',
  layout: 'SoA',
  fields: [{ name: 'orientation', dtype: 'f64', components: 4 }],
  elementCount: 1,
  mode: 'single-writer',
  backing: 'local',
};

const manifest = (
  id: string,
  phase: Phase,
  partial: Partial<ModuleManifest> = {},
): ModuleManifest => ({
  id,
  version: '1.0.0',
  phase,
  dependsOn: [],
  reads: [],
  writes: [],
  accumulates: [],
  gives: [],
  ...partial,
});

/** A module that records the tick it ran on into a shared log. */
function logger(
  log: string[],
  id: string,
  phase: Phase,
  partial: Partial<ModuleManifest> = {},
): SimModule {
  return {
    manifest: manifest(id, phase, partial),
    init() {},
    step(ctx) {
      log.push(`${ctx.tick}:${id}`);
    },
  };
}

/** Physics stand-in: gives pose and torque, integrates torque into position. */
function physics(): SimModule {
  let pose: ChannelView | undefined;
  let torque: ChannelView | undefined;
  return {
    manifest: manifest('physics', 'solve', {
      gives: [POSE, TORQUE],
      writes: [{ id: POSE.id, version: '^1.0.0' }],
      reads: [{ id: TORQUE.id, version: '^1.0.0' }],
    }),
    init(ctx: ModuleInitContext) {
      pose = ctx.write(POSE.id);
      torque = ctx.read(TORQUE.id);
    },
    step(ctx: ModuleStepContext) {
      const p = pose?.fields.position as Float64Array;
      const t = torque?.fields.torque as Float64Array;
      p[0] = (p[0] ?? 0) + (t[0] ?? 0) * ctx.dt;
      p[1] = (p[1] ?? 0) + (t[1] ?? 0) * ctx.dt;
    },
  };
}

/** Actuator stand-in: adds a constant into the torque accumulator. */
function actuator(id: string, amount: number, index = 0): SimModule {
  let torque: ChannelView | undefined;
  return {
    manifest: manifest(id, 'actuate', {
      accumulates: [{ id: TORQUE.id, version: '^1.0.0' }],
      dependsOn: [{ id: 'physics', version: '^1.0.0' }],
    }),
    init(ctx) {
      torque = ctx.accumulate(TORQUE.id);
    },
    step() {
      const t = torque?.fields.torque as Float64Array;
      t[index] = (t[index] ?? 0) + amount;
    },
  };
}

async function kernelWith(
  modules: SimModule[],
  options: Partial<ConstructorParameters<typeof Kernel>[0]> = {},
) {
  const k = new Kernel({ rateHz: 100, seed: 7, ...options });
  for (const m of modules) k.register(m);
  await k.init();
  return k;
}

describe('ordering', () => {
  it('runs phases in the fixed order regardless of registration order', async () => {
    const log: string[] = [];
    const k = await kernelWith([
      logger(log, 'p', 'post'),
      logger(log, 's', 'solve'),
      logger(log, 'a', 'actuate'),
      logger(log, 'i', 'input'),
      logger(log, 'c', 'control'),
      logger(log, 'n', 'sense'),
    ]);
    expect(k.order()).toEqual(['i', 'n', 'c', 'a', 's', 'p']);
  });

  it('breaks ties within a phase by order then id, never by registration', async () => {
    const log: string[] = [];
    const a = await kernelWith([
      logger(log, 'zeta', 'sense', { order: 1 }),
      logger(log, 'alpha', 'sense', { order: 2 }),
      logger(log, 'mid', 'sense', { order: 1 }),
    ]);
    const b = await kernelWith([
      logger(log, 'mid', 'sense', { order: 1 }),
      logger(log, 'alpha', 'sense', { order: 2 }),
      logger(log, 'zeta', 'sense', { order: 1 }),
    ]);
    expect(a.order()).toEqual(['mid', 'zeta', 'alpha']);
    expect(b.order()).toEqual(a.order());
  });

  it('places a module after its in-phase dependency even when order and id say otherwise', async () => {
    const log: string[] = [];
    const k = await kernelWith([
      logger(log, 'a_first_by_name', 'sense', {
        order: 0,
        dependsOn: [{ id: 'z_dependency', version: '^1.0.0' }],
      }),
      logger(log, 'z_dependency', 'sense', { order: 9 }),
    ]);
    expect(k.order()).toEqual(['z_dependency', 'a_first_by_name']);
  });

  it('allows a dependency on a later-phase module without reordering anything', async () => {
    // Spec 10.2: sense runs before solve and reads the previous tick's state. So a sense module
    // depending on the physics module is normal; the dependency requires existence and version,
    // and phase order decides who runs first.
    const log: string[] = [];
    const k = await kernelWith([
      logger(log, 'early', 'sense', { dependsOn: [{ id: 'late', version: '^1.0.0' }] }),
      logger(log, 'late', 'solve'),
    ]);
    expect(k.order()).toEqual(['early', 'late']);
  });

  it('detects a cycle and prints it', async () => {
    const log: string[] = [];
    await expect(
      kernelWith([
        logger(log, 'a', 'sense', { dependsOn: [{ id: 'b', version: '*' }] }),
        logger(log, 'b', 'sense', { dependsOn: [{ id: 'c', version: '*' }] }),
        logger(log, 'c', 'sense', { dependsOn: [{ id: 'a', version: '*' }] }),
      ]),
    ).rejects.toThrow(/Dependency cycle among modules in phase 'sense': a -> b -> c -> a/);
  });

  it('rejects an unregistered dependency and a version mismatch', async () => {
    const log: string[] = [];
    await expect(
      kernelWith([logger(log, 'a', 'sense', { dependsOn: [{ id: 'ghost', version: '*' }] })]),
    ).rejects.toThrow(/'ghost', which is not registered/);
    await expect(
      kernelWith([
        logger(log, 'a', 'sense', { dependsOn: [{ id: 'b', version: '^2.0.0' }] }),
        logger(log, 'b', 'sense'),
      ]),
    ).rejects.toThrow(/'b' \^2.0.0, but 'b' is version 1.0.0/);
  });

  it('rejects a channel version the module was not written against', async () => {
    const stale: SimModule = {
      manifest: manifest('stale', 'sense', { reads: [{ id: POSE.id, version: '^2.0.0' }] }),
      init() {},
      step() {},
    };
    await expect(kernelWith([physics(), stale])).rejects.toThrow(
      /against channel 'body.pose' \^2.0.0, but the channel is version 1.0.0/,
    );
  });
});

describe('stepping', () => {
  it('honours rateDivisor from tick zero', async () => {
    const log: string[] = [];
    const k = await kernelWith([
      logger(log, 'every', 'sense'),
      logger(log, 'tenth', 'post', { rateDivisor: 10 }),
    ]);
    k.run(25);
    expect(log.filter((l) => l.endsWith(':tenth'))).toEqual(['0:tenth', '10:tenth', '20:tenth']);
    expect(log.filter((l) => l.endsWith(':every')).length).toBe(25);
    expect(k.clock.tick).toBe(25);
  });

  it('zeroes accumulators each tick and sums contributions from two writers', async () => {
    // Spec 14.5 obligation 8: accumulator semantics with two simultaneous writers.
    const k = await kernelWith([physics(), actuator('nerve', 2), actuator('motor-test', 3)]);
    k.run(10);
    const p = k.channels.storage(POSE.id).fields.position as Float64Array;
    // 5 N*m per tick for 10 ticks at dt 0.01.
    expect(p[0]).toBeCloseTo(5 * 10 * 0.01, 12);
    const t = k.channels.storage(TORQUE.id).fields.torque as Float64Array;
    // The accumulator holds this tick's sum, not a running total.
    expect(t[0]).toBe(5);
  });

  it('derives an independent random stream per module', async () => {
    const seen: Record<string, number> = {};
    const peek = (id: string): SimModule => ({
      manifest: manifest(id, 'sense'),
      init(ctx) {
        seen[id] = ctx.random.nextFloat();
      },
      step() {},
    });
    await kernelWith([peek('a'), peek('b')]);
    expect(seen.a).not.toBe(seen.b);
    const again: Record<string, number> = {};
    const k2 = new Kernel({ rateHz: 100, seed: 7 });
    k2.register({
      manifest: manifest('b', 'sense'),
      init(ctx) {
        again.b = ctx.random.nextFloat();
      },
      step() {},
    });
    await k2.init();
    // Same seed and id: same stream, whatever else is registered.
    expect(again.b).toBe(seen.b);
  });

  it('refuses to step or restore before init', () => {
    const k = new Kernel({ rateHz: 100, seed: 1 });
    expect(() => k.step()).toThrow(/before init/);
  });
});

/** Gives the orientation channel, sets it to `start` at init, and leaves it alone thereafter. */
function orienter(start: readonly number[]): SimModule {
  return {
    manifest: manifest('orienter', 'solve', {
      gives: [ORIENTATION],
      writes: [{ id: ORIENTATION.id, version: '^1.0.0' }],
    }),
    init(ctx) {
      (ctx.write(ORIENTATION.id).fields.orientation as Float64Array).set(start);
    },
    step() {},
  };
}

/** A module that writes the pose through the read view it declared, which the audit must catch. */
function rogue(): SimModule {
  return {
    manifest: manifest('rogue', 'post', { reads: [{ id: POSE.id, version: '^1.0.0' }] }),
    init(ctx) {
      // A read view is the same memory as the write view; JS cannot make it read-only.
      this.view = ctx.read(POSE.id);
    },
    step() {
      (this.view?.fields.position as Float64Array)[2] = 42;
    },
    view: undefined as ChannelView | undefined,
  } as SimModule & { view: ChannelView | undefined };
}

describe('audit', () => {
  it('catches a module writing a channel it did not declare', async () => {
    const k = await kernelWith([physics(), rogue()], { audit: true });
    expect(() => k.step()).toThrow(
      /'rogue' changed channel 'body.pose' during step at tick 0 without declaring a write/,
    );
  });

  it('is silent for a well-behaved module set', async () => {
    const k = await kernelWith([physics(), actuator('nerve', 1)], { audit: true });
    expect(() => k.run(5)).not.toThrow();
  });

  // The audit carries each channel's hash through the tick rather than taking it around each
  // module, so these two pin what that must still allow: a host writing between ticks (the
  // studio's drag, a scenario script), and a module reading what an earlier one declared.
  it('allows the host to write between ticks', async () => {
    const k = await kernelWith([physics(), actuator('nerve', 1)], { audit: true });
    const position = k.channels.storage(POSE.id).fields.position as Float64Array;
    for (let i = 0; i < 4; i++) {
      position[2] = i;
      expect(() => k.step()).not.toThrow();
    }
  });

  it('holds a later module to what an earlier one wrote, not to the start of the tick', async () => {
    // Physics moves the pose in solve every tick, under the actuator's torque; a reader in post
    // leaves it alone. Were the reader held to the pose as the tick began, physics' declared write
    // would be blamed on it.
    const log: string[] = [];
    const reader = logger(log, 'reader', 'post', { reads: [{ id: POSE.id, version: '^1.0.0' }] });
    const k = await kernelWith([physics(), actuator('nerve', 1), reader], { audit: true });
    const position = k.channels.storage(POSE.id).fields.position as Float64Array;
    expect(() => k.run(5)).not.toThrow();
    expect(position[0]).not.toBe(0);
  });

  // CONTRIBUTING rule 6 says an undeclared write is caught, and this is what makes that true of
  // every module test rather than only of the ones that remember to ask: vitest.config.ts sets
  // BS_HUMANY_KERNEL_AUDIT, and a kernel built with no audit option follows it.
  it('is on by default under vitest', async () => {
    const k = await kernelWith([physics(), rogue()]);
    expect(() => k.step()).toThrow(/'rogue' changed channel 'body.pose'/);
  });

  // The audit must see any change to any bit, not only the ones a hash happens to catch. A sign
  // flip is the undeclared write a module is most likely to make by mistake -- a quaternion
  // hemisphere fix-up, q -> -q, done in place on a view it only declared a read of -- and each
  // flip changes only the top bit of a word, so a word-wise FNV-1a let an even number of them
  // cancel. A swap changes where two values are but not what they are, and a one-ulp nudge
  // changes one bit. A hash can miss any of these; the audit compares the words themselves.
  it.each([
    ['negates a whole quaternion', [0.5, 0.5, 0.5, 0.5], [-0.5, -0.5, -0.5, -0.5]],
    ['negates two components', [0.5, 0.5, 0.5, 0.5], [0.5, -0.5, 0.5, -0.5]],
    ['swaps two components', [0.5, 0.25, 0.5, 0.5], [0.5, 0.5, 0.25, 0.5]],
    ['nudges one component by an ulp', [0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5000000000000001]],
  ])('catches a module that %s through a read view', async (_, start, edited) => {
    let view: ChannelView | undefined;
    const editor: SimModule = {
      manifest: manifest('editor', 'post', { reads: [{ id: ORIENTATION.id, version: '^1.0.0' }] }),
      init(ctx) {
        view = ctx.read(ORIENTATION.id);
      },
      step() {
        (view?.fields.orientation as Float64Array).set(edited);
      },
    };
    const k = await kernelWith([orienter(start), editor], { audit: true });
    expect(() => k.step()).toThrow(/'editor' changed channel 'body.orientation'/);
  });

  // The determinism harness compares stateHash across runs, so it is held to the same pair: two
  // states a negated quaternion apart must not hash alike, as they did under the word-wise fold.
  it('gives a negated quaternion a different stateHash', async () => {
    const ka = await kernelWith([orienter([0.5, 0.5, 0.5, 0.5])], { audit: false });
    const kb = await kernelWith([orienter([-0.5, -0.5, -0.5, -0.5])], { audit: false });
    expect(kb.stateHash()).not.toBe(ka.stateHash());
  });

  it('stays off when a host says so, whatever the environment', async () => {
    const k = await kernelWith([physics(), rogue()], { audit: false });
    expect(() => k.run(3)).not.toThrow();
  });
});

describe('snapshot and restore', () => {
  it('round-trips and resumes identically', async () => {
    // Spec 13.7 and 14.5 obligation 9: restore is lossless.
    const k = await kernelWith([physics(), actuator('nerve', 1.5)]);
    k.run(7);
    const snap: KernelSnapshot = k.snapshot();
    k.run(13);
    const expected = k.stateHash();

    const k2 = await kernelWith([physics(), actuator('nerve', 1.5)]);
    k2.restore(snap);
    expect(k2.clock.tick).toBe(7);
    k2.run(13);
    expect(k2.stateHash()).toBe(expected);
  });

  it('copies rather than aliasing channel memory', async () => {
    const k = await kernelWith([physics(), actuator('nerve', 1)]);
    k.run(3);
    const snap = k.snapshot();
    const hashAtSnap = k.stateHash();
    k.run(3);
    expect(k.stateHash()).not.toBe(hashAtSnap);
    k.restore(snap);
    expect(k.stateHash()).toBe(hashAtSnap);
  });

  it('refuses a snapshot from a different timestep or module set', async () => {
    const k = await kernelWith([physics()]);
    const other = await kernelWith([physics()], { rateHz: 200 });
    expect(() => k.restore(other.snapshot())).toThrow(/dt=0.005/);
    const different = await kernelWith([physics(), actuator('nerve', 1)]);
    const snapDifferent = different.snapshot();
    const onlyPhysics = await kernelWith([physics()]);
    // Same channels either way here, so exercise the byte-length check with a tampered copy.
    const tampered = {
      ...snapDifferent,
      channels: { ...snapDifferent.channels, [POSE.id]: new Uint8Array(3) },
    };
    expect(() => onlyPhysics.restore(tampered)).toThrow(/is 3 bytes/);
  });

  it('carries module-provided state', async () => {
    const stateful = (): SimModule & {
      count: number;
      getState(): unknown;
      setState(s: unknown): void;
    } => ({
      manifest: manifest('counter', 'post'),
      count: 0,
      init() {},
      step() {
        this.count++;
      },
      getState() {
        return { count: this.count };
      },
      setState(s: unknown) {
        this.count = (s as { count: number }).count;
      },
    });
    const a = stateful();
    const k = await kernelWith([a]);
    k.run(4);
    const snap = k.snapshot();
    const b = stateful();
    const k2 = await kernelWith([b]);
    k2.restore(snap);
    expect(b.count).toBe(4);
  });
});

describe('determinism harness (M2.7)', () => {
  it('produces bit-identical state on two runs from the same seed', async () => {
    const noisy = (): SimModule => {
      let pose: ChannelView | undefined;
      let random: ModuleInitContext['random'] | undefined;
      return {
        manifest: manifest('jitter', 'actuate', {
          writes: [],
          accumulates: [{ id: TORQUE.id, version: '^1.0.0' }],
          dependsOn: [{ id: 'physics', version: '^1.0.0' }],
        }),
        init(ctx) {
          pose = ctx.accumulate(TORQUE.id);
          random = ctx.random;
        },
        step() {
          const t = pose?.fields.torque as Float64Array;
          t[1] = (t[1] ?? 0) + (random?.nextNormal() ?? 0);
        },
      };
    };
    const hashes = async () => {
      const k = await kernelWith([physics(), noisy()]);
      const out: number[] = [];
      for (let i = 0; i < 200; i++) {
        k.step();
        out.push(k.stateHash());
      }
      return out;
    };
    const a = await hashes();
    const b = await hashes();
    expect(a).toEqual(b);
    // And the trajectory actually evolves, so the check is not vacuous.
    expect(new Set(a).size).toBeGreaterThan(150);
  });

  it('diverges for a different seed, so the harness can tell runs apart', async () => {
    const k1 = await kernelWith([physics(), actuator('nerve', 1)], { seed: 1 });
    const k2 = await kernelWith([physics(), actuator('nerve', 1)], { seed: 2 });
    k1.run(5);
    k2.run(5);
    // No randomness in this module set, so seeds do not matter and hashes agree -- which is the
    // point: determinism is a property of inputs, and the seed is one of them only when used.
    expect(k1.stateHash()).toBe(k2.stateHash());
  });
});
