/**
 * The studio source the headless tools reach into, held to the shape they use.
 *
 * Three tools load studio application code directly through jiti rather than through a package:
 *
 * - `tools/cli/bin/publish-pose.mjs` imports `apps/studio/src/simulation.ts`, `tissue.ts` and
 *   `grabIntents.ts`, and drives a `Simulation` the way the studio's frame loop does.
 * - `tools/train/bin/showcase.mjs` imports `apps/studio/src/tissue.ts`.
 * - `tools/train/runs/discprobe2.mjs`, a local probe, imports `simulation.ts` the same way.
 *
 * None of them is type-checked and none of them runs in CI, because they need the anatomical
 * asset pack from disk and a bridge on tmpfs. So a rename in the studio -- `muscleRings` becoming
 * something else, `scrubTo` taking another argument -- used to break them silently and be found
 * at runtime, by whoever next tried to publish a pose. This test is the tripwire: it builds a real
 * `Simulation` the way `blenderExport.test.ts` does and touches every member those tools call, so
 * the break shows up in `pnpm test` instead. Rename a member here and in the tools together.
 */

import { describe, expect, it } from 'vitest';
import { GrabIntents } from '../../../apps/studio/src/grabIntents.ts';
import { Simulation } from '../../../apps/studio/src/simulation.ts';
import { tissueTable } from '../../../apps/studio/src/tissue.ts';
// By path rather than by package name, as the tools themselves load them: this package declares
// no workspace dependencies, and the point is to resolve exactly what jiti resolves.
import { resolveMorphology } from '../../../packages/anthropometry/src/index.ts';
import { SCENARIOS } from '../../../packages/scenarios/src/index.ts';
import { buildDocument } from '../../../packages/skeleton/src/index.ts';

const document = buildDocument();

describe('the studio surface the headless tools import', () => {
  it('exports what publish-pose and the showcase load by name', () => {
    expect(typeof Simulation).toBe('function');
    expect(typeof tissueTable).toBe('function');
    expect(typeof GrabIntents).toBe('function');
  });

  it('runs a muscle scenario through every member the tools call', async () => {
    // A muscle scenario, because half of what publish-pose reads -- the rings, the muscle state,
    // the drive -- exists only when the muscle set is running.
    const chosen = SCENARIOS.find((s) => s.muscles === true);
    if (!chosen) throw new Error('no committed scenario runs muscles');
    const simulation = new Simulation(
      document,
      resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 }),
      {
        profileId: 'l3_anatomical',
        backend: 'mujoco',
        passiveJoints: true,
        redistribute: true,
        scenario: chosen,
        dropHeight: chosen.clearance,
        groundHeight: chosen.ground.height,
        muscles: true,
        // Small, so the test never holds more than a few frames of capture.
        captureBudgetBytes: 4 * 1024 * 1024,
      },
    );
    await simulation.start();
    simulation.setGravity(true);
    simulation.setGroundCollision(true);
    for (let t = 0; t < 20; t++) simulation.tick();

    expect(simulation.ticks).toBe(20);
    expect(simulation.dt).toBeGreaterThan(0);
    expect(simulation.stepsPerSecond).toBe(Math.round(1 / simulation.dt));
    expect(simulation.ticksPerOutputFrame).toBeGreaterThan(0);
    expect(simulation.boneOrder().length).toBeGreaterThan(0);
    const bones = simulation.boneTransforms();
    expect(bones.position.length).toBe(simulation.boneOrder().length * 3);
    expect(bones.orientation.length).toBe(simulation.boneOrder().length * 4);
    expect(simulation.channel('body.pose').count).toBeGreaterThan(0);
    expect(simulation.muscleRings()?.units).toBeGreaterThan(0);
    expect(simulation.muscleState()?.activation.length).toBe(simulation.muscles?.units.length);
    expect(simulation.muscleDrive).toBeDefined();
    expect(simulation.muscles?.units.length).toBeGreaterThan(0);
    expect(simulation.resolved.input.stature).toBeCloseTo(1.7, 6);
    expect(simulation.articulation.segments.length).toBeGreaterThan(0);
    expect(typeof simulation.lastStepMs).toBe('number');

    // The scrub publish-pose does to rewind a loop: a time in seconds, landing on the tick nearest
    // it, which at the profile's rate is a whole number of ticks.
    simulation.scrubTo(0.01);
    expect(simulation.ticks).toBe(Math.round(0.01 / simulation.dt));
    simulation.reset();
    expect(simulation.ticks).toBe(0);
    simulation.dispose();
  }, 60_000);
});
