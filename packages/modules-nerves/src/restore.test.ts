/**
 * Snapshot and restore with the whole loop in it: spec 13.7, that a restored session continues
 * exactly as the captured one would have.
 *
 * The kernel's own restore test runs a body and a constant actuator, which keep nothing outside
 * the channels, so it passed while every module here that does -- the muscles' fibres, the cord's
 * conduction delay, the nerves' held command and memory, both noise streams -- was forgotten on
 * restore and the replay drifted from the run it replayed. This rig has all of them working at
 * once, with gains and noise that are not zero, so a state any of them fails to carry shows up as
 * a hash that differs.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { compileArticulation } from '@bs-humany/compiler';
import { Kernel, type KernelSnapshot } from '@bs-humany/kernel';
import { PassiveJointModule, PhysicsModule } from '@bs-humany/modules-mechanics';
import {
  MUSCLE_DYNAMICS_MODULE_ID,
  MuscleDynamicsModule,
  MusclePathModule,
  MuscleTestDriveModule,
  compileMuscleSet,
} from '@bs-humany/modules-muscle';
import { ANKLE_MUSCLES, KNEE_MUSCLES } from '@bs-humany/muscle-data';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { type DriveOutput, NERVES_MODULE_ID, NervesModule } from './nervesModule.js';
import { MOTOR_NOISE_MODULE_ID, MotorNoiseModule, seededUniform } from './noise.js';
import { MlpPolicy } from './policy.js';
import { SPINAL_MODULE_ID, SpinalModule } from './spinalModule.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l1_standard', morphology);
const muscles = compileMuscleSet(
  [...ANKLE_MUSCLES, ...KNEE_MUSCLES],
  document.attachmentSites,
  articulation,
  morphology.context,
  document.wrappingSurfaces ?? [],
);

const unitsLike = (pattern: RegExp): string[] =>
  muscles.units.filter((u) => pattern.test(u.id)).map((u) => u.id);
const plantar = unitsLike(/soleus|gastrocnemius/);
const dorsi = unitsLike(/tibialis_anterior/);
const knee = unitsLike(/vastus|rectus_femoris/);

const drive = (id: string, units: readonly string[]): DriveOutput => ({
  id,
  units: units.map((unit) => ({ id: unit, weight: 1 })),
});
const outputs = [drive('plantar', plantar), drive('dorsi', dorsi), drive('knee', knee)];

/**
 * Every stateful piece of the loop, switched on: a tone on every muscle, the cord at the gains
 * the studio opens with, a policy with memory reading grainy senses, and a tremor on its drives.
 * The policy's weights come from a fixed seed, so two rigs built by this are the same body with
 * the same brain.
 */
function rig(delaySeconds = 0.03): { kernel: Kernel; spine: SpinalModule } {
  const kernel = new Kernel({ rateHz: 500, seed: 1 });
  kernel.register(new PhysicsModule(new MujocoBackend(), articulation, { ground: { height: 0 } }));
  kernel.register(new PassiveJointModule(articulation));
  kernel.register(
    new MuscleTestDriveModule(muscles, [
      { units: 'all', pattern: { kind: 'constant', level: 0.1 } },
    ]),
  );
  kernel.register(new MusclePathModule(articulation, muscles));
  kernel.register(new MuscleDynamicsModule(articulation, muscles));
  const spine = new SpinalModule(muscles, {
    groups: [
      { id: 'plantar', units: plantar, antagonist: 'dorsi' },
      { id: 'dorsi', units: dorsi, antagonist: 'plantar' },
      { id: 'knee', units: knee },
    ],
    gains: { stretch: 3.5, velocity: 0.25, delaySeconds },
    stepSeconds: 1 / 500,
  });
  kernel.register(spine);
  kernel.register(
    new NervesModule(articulation, muscles, {
      policy: (inputs, count) => MlpPolicy.random([inputs, 8, count], seededUniform(3), 2),
      outputs,
      feet: { left: ['foot_l', 'toes_l'], right: ['foot_r', 'toes_r'] },
      goalSize: 0,
      controlDivisor: 5,
      authority: 0.4,
      senseNoise: 0.05,
      memory: 2,
    }),
  );
  kernel.register(new MotorNoiseModule(muscles, { outputs, level: 0.05, tau: 0.1, divisor: 5 }));
  return { kernel, spine };
}

function hashes(kernel: Kernel, ticks: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < ticks; i++) {
    kernel.step();
    out.push(kernel.stateHash());
  }
  return out;
}

/**
 * A snapshot through a session file and back, as `apps/studio/src/session.ts` writes and reads
 * one: bytes as base64 inside JSON. Copied rather than imported, because a package may not
 * depend on an app; what it has to prove is that every piece of module state survives JSON, which
 * only bytes and plain numbers do.
 */
function throughSessionFile(snapshot: KernelSnapshot): KernelSnapshot {
  const toBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  };
  const fromBase64 = (text: string): Uint8Array => {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  };
  const channels: Record<string, string> = {};
  for (const [id, bytes] of Object.entries(snapshot.channels)) channels[id] = toBase64(bytes);
  const modules: Record<string, unknown> = {};
  for (const [id, state] of Object.entries(snapshot.modules)) {
    modules[id] = state instanceof Uint8Array ? { bytes: toBase64(state) } : state;
  }
  const text = JSON.stringify({ ...snapshot, channels, modules });
  const data = JSON.parse(text) as {
    tick: number;
    dt: number;
    seed: number;
    channels: Record<string, string>;
    random: KernelSnapshot['random'];
    modules: Record<string, unknown>;
  };
  const back: Record<string, Uint8Array> = {};
  for (const [id, value] of Object.entries(data.channels)) back[id] = fromBase64(value);
  const states: Record<string, unknown> = {};
  for (const [id, state] of Object.entries(data.modules)) {
    states[id] =
      state && typeof state === 'object' && typeof (state as { bytes?: unknown }).bytes === 'string'
        ? fromBase64((state as { bytes: string }).bytes)
        : state;
  }
  return { ...data, channels: back, modules: states };
}

describe('restore with the muscles, the cord, the nerves and the noise registered', () => {
  it('replays the run it was taken from, tick for tick, in the same kernel', async () => {
    const { kernel } = rig();
    await kernel.init();
    kernel.run(120);
    const snapshot = kernel.snapshot();
    // Each of them carries its own state now, and as bytes, which is all a session file keeps.
    for (const id of [
      MUSCLE_DYNAMICS_MODULE_ID,
      SPINAL_MODULE_ID,
      NERVES_MODULE_ID,
      MOTOR_NOISE_MODULE_ID,
    ]) {
      expect(snapshot.modules[id], id).toBeInstanceOf(Uint8Array);
    }
    const original = hashes(kernel, 200);
    kernel.restore(snapshot);
    expect(kernel.clock.tick).toBe(120);
    const replay = hashes(kernel, 200);
    const firstDifferent = replay.findIndex((h, i) => h !== original[i]);
    expect(firstDifferent, 'the first tick after restore at which the replay differs').toBe(-1);
    kernel.dispose();
  });

  it('replays it in a new kernel from a session file', async () => {
    // What loading a saved session does: a fresh body built the same way, and the snapshot after
    // a trip through JSON. Every module's state has to be bytes or plain numbers to survive that.
    const first = rig();
    await first.kernel.init();
    first.kernel.run(120);
    const snapshot = throughSessionFile(first.kernel.snapshot());
    const original = hashes(first.kernel, 200);
    first.kernel.dispose();

    const second = rig();
    await second.kernel.init();
    second.kernel.run(37);
    second.kernel.restore(snapshot);
    const replay = hashes(second.kernel, 200);
    const firstDifferent = replay.findIndex((h, i) => h !== original[i]);
    expect(firstDifferent, 'the first tick after restore at which the replay differs').toBe(-1);
    second.kernel.dispose();
  });

  it('starts the cord empty, rather than refusing, when the delay changed after the snapshot', async () => {
    // The delay is a slider. A snapshot from before it moved has a ring of the old length, and
    // there is no history of the new length to put back; a session should still load.
    const { kernel, spine } = rig(0.03);
    await kernel.init();
    kernel.run(60);
    const snapshot = kernel.snapshot();
    spine.adjust({ delaySeconds: 0.05 });
    expect(() => kernel.restore(snapshot)).not.toThrow();
    kernel.run(20);
    expect(Number.isFinite(kernel.stateHash())).toBe(true);
    kernel.dispose();
  });
});
