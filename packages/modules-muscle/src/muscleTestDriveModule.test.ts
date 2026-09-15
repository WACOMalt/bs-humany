import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { compileArticulation } from '@bs-humany/compiler';
import { Kernel } from '@bs-humany/kernel';
import { PhysicsModule } from '@bs-humany/modules-mechanics';
import { ELBOW_MUSCLES } from '@bs-humany/muscle-data';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { MUSCLE_STATE } from './channels.js';
import { compileMuscleSet } from './compile.js';
import { MuscleDynamicsModule } from './muscleDynamicsModule.js';
import { MusclePathModule } from './musclePathModule.js';
import { type DriveAssignment, MuscleTestDriveModule } from './muscleTestDriveModule.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l3_anatomical', morphology);
const muscles = compileMuscleSet(
  ELBOW_MUSCLES,
  document.attachmentSites,
  articulation,
  morphology.context,
  document.wrappingSurfaces ?? [],
);
const BICEPS = muscles.units.findIndex((u) => u.id === 'biceps_brachii_long_r');
const TRICEPS = muscles.units.findIndex((u) => u.id === 'triceps_brachii_long_r');

async function session(assignments: readonly DriveAssignment[]) {
  const kernel = new Kernel({ rateHz: 500, seed: 1 });
  kernel.register(new PhysicsModule(new MujocoBackend(), articulation, { ground: { height: 0 } }));
  kernel.register(new MuscleTestDriveModule(muscles, assignments));
  kernel.register(new MusclePathModule(articulation, muscles));
  kernel.register(new MuscleDynamicsModule(articulation, muscles));
  await kernel.init();
  const activation = kernel.channels.storage(MUSCLE_STATE).fields.activation as Float64Array;
  return { kernel, activation };
}

/**
 * Activation is a lagged, floored copy of excitation, so these tests read it at a steady state
 * where the lag has run out. That is deliberate: reading the accumulator directly would test the
 * pattern generator against itself, whereas this tests that the drive actually arrives.
 */
describe('MuscleTestDriveModule', () => {
  it('holds a constant level', async () => {
    const s = await session([{ units: 'all', pattern: { kind: 'constant', level: 0.6 } }]);
    s.kernel.run(200);
    for (let i = 0; i < muscles.units.length; i++) {
      expect(s.activation[i], muscles.units[i]?.id).toBeCloseTo(0.6, 3);
    }
    s.kernel.dispose();
  });

  it('drives only the units it was given, leaving the rest at rest', async () => {
    // What makes the module usable for a demo: the elbow flexors go on, the extensors do not.
    const s = await session([
      { units: ['biceps_brachii_long_r'], pattern: { kind: 'constant', level: 0.9 } },
    ]);
    s.kernel.run(200);
    expect(s.activation[BICEPS]).toBeCloseTo(0.9, 3);
    expect(s.activation[TRICEPS]).toBeLessThan(0.01);
    s.kernel.dispose();
  });

  it('steps at the simulated time it was told, not at a tick count', async () => {
    const s = await session([
      { units: 'all', pattern: { kind: 'step', at: 0.4, before: 0.1, after: 0.9 } },
    ]);
    s.kernel.run(150);
    expect(s.activation[BICEPS]).toBeCloseTo(0.1, 3);
    s.kernel.run(50);
    // 200 ticks at 500 Hz is 0.4 s exactly, so the step has just fired and the lag is starting.
    s.kernel.run(100);
    expect(s.activation[BICEPS]).toBeCloseTo(0.9, 3);
    s.kernel.dispose();
  });

  it('sweeps a sine, and comes back', async () => {
    const s = await session([
      { units: 'all', pattern: { kind: 'sine', mean: 0.5, amplitude: 0.4, frequency: 1 } },
    ]);
    // A quarter of a 1 Hz cycle is 0.25 s: the peak. Three quarters is the trough.
    s.kernel.run(125);
    const peak = s.activation[BICEPS] as number;
    s.kernel.run(250);
    const trough = s.activation[BICEPS] as number;
    expect(peak).toBeGreaterThan(0.75);
    expect(trough).toBeLessThan(0.25);
    s.kernel.dispose();
  });

  it('clamps a pattern that leaves the range, rather than passing it on', async () => {
    // An excitation above 1 is not a louder muscle, it is an out-of-range input that the fiber
    // model would carry into its curves. Clamped at the writer, so a second writer's contribution
    // is still added to something meaningful.
    const s = await session([
      { units: 'all', pattern: { kind: 'sine', mean: 0.5, amplitude: 5, frequency: 1 } },
    ]);
    s.kernel.run(125);
    expect(s.activation[BICEPS]).toBeLessThanOrEqual(1);
    expect(s.activation[BICEPS]).toBeGreaterThan(0.95);
    s.kernel.dispose();
  });

  it('plays a script, interpolating between its breakpoints', async () => {
    const s = await session([
      {
        units: 'all',
        pattern: {
          kind: 'scripted',
          points: [
            { time: 0, level: 0 },
            { time: 0.4, level: 1 },
            { time: 0.8, level: 0 },
          ],
        },
      },
    ]);
    s.kernel.run(100); // 0.2 s: half way up the ramp.
    expect(s.activation[BICEPS]).toBeGreaterThan(0.3);
    expect(s.activation[BICEPS]).toBeLessThan(0.7);
    s.kernel.run(100); // 0.4 s: the top.
    expect(s.activation[BICEPS]).toBeGreaterThan(0.9);
    s.kernel.run(200); // 0.8 s: the script has reached zero.
    // Activation has not, and should not have: it trails the ramp down by the deactivation time
    // constant, so at the instant the script hits zero the muscle is still a tenth on. Reading it
    // here and demanding zero would be asserting that the physiology is not there.
    expect(s.activation[BICEPS]).toBeLessThan(0.2);
    s.kernel.run(75); // Another three deactivation time constants.
    expect(s.activation[BICEPS]).toBeLessThan(0.02);
    s.kernel.dispose();
  });

  it('holds a finished script flat rather than extrapolating off the end', async () => {
    const s = await session([
      {
        units: 'all',
        pattern: {
          kind: 'scripted',
          points: [
            { time: 0, level: 0 },
            { time: 0.2, level: 0.7 },
          ],
        },
      },
    ]);
    s.kernel.run(400); // Well past the last breakpoint.
    expect(s.activation[BICEPS]).toBeCloseTo(0.7, 3);
    s.kernel.dispose();
  });

  it('adds up when two patterns drive the same unit, because it is an accumulator', async () => {
    // The property a nerve module will rely on: several sources of drive on one muscle sum. If
    // this were a single-writer channel the second one registered would be a conflict.
    const s = await session([
      { units: 'all', pattern: { kind: 'constant', level: 0.3 } },
      { units: ['biceps_brachii_long_r'], pattern: { kind: 'constant', level: 0.3 } },
    ]);
    s.kernel.run(200);
    expect(s.activation[TRICEPS]).toBeCloseTo(0.3, 3);
    s.kernel.dispose();
  });

  it('refuses a pattern for a unit that is not in the set', async () => {
    expect(
      () =>
        new MuscleTestDriveModule(muscles, [
          { units: ['gastrocnemius_r'], pattern: { kind: 'constant', level: 1 } },
        ]),
    ).toThrow(/gastrocnemius_r/);
  });

  it('refuses an empty script instead of silently driving nothing', () => {
    expect(
      () =>
        new MuscleTestDriveModule(muscles, [
          { units: 'all', pattern: { kind: 'scripted', points: [] } },
        ]),
    ).toThrow(/breakpoint/);
  });

  it('writes drive and nothing else', async () => {
    const driver = new MuscleTestDriveModule(muscles, [
      { units: 'all', pattern: { kind: 'constant', level: 1 } },
    ]);
    expect(driver.manifest.writes).toEqual([]);
    expect(driver.manifest.reads).toEqual([]);
    expect(driver.manifest.accumulates.map((c) => c.id)).toEqual(['efferent.alphaMotor']);
    // Not a provider: `muscle.dynamics` owns the channel, so this module can be swapped for a
    // nerve module without the channel going away with it.
    expect(driver.manifest.gives).toEqual([]);
    expect(driver.manifest.phase).toBe('input');
  });
});
