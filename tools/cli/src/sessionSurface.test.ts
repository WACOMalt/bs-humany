/**
 * The session the headless tools load, held to the shape they use.
 *
 * Two tools load `@bs-humany/session` by name through jiti, as this workspace resolves it:
 *
 * - `tools/cli/bin/publish-pose.mjs` takes `Simulation`, `GrabIntents`, `tissueTable` and the
 *   publisher's status builders, and drives a `Simulation` the way the studio's frame loop does.
 * - `tools/train/bin/showcase.mjs` takes `tissueTable`.
 *
 * They used to reach into the studio's source for these, by path, before the session became a
 * package of its own (ADR-008, 2026-09-27). The reason for this test outlived that: neither tool
 * is type-checked and neither runs in CI, because they need the anatomical asset pack from disk
 * and a bridge on tmpfs. So a rename in the session -- `muscleRings` becoming something else,
 * `scrubTo` taking another argument -- would break them silently and be found at runtime, by
 * whoever next tried to publish a pose. This test is the tripwire: it builds a real `Simulation`
 * the way the studio's `blenderExport.test.ts` does and touches every member those tools call, so
 * the break shows up in `pnpm test` instead. Rename a member here and in the tools together.
 */

// The session by package name, exactly as the tools ask jiti for it.
import {
  GrabIntents,
  Simulation,
  publisherMorphology,
  publisherStatus,
  scenarioDefinition,
  tissueTable,
} from '@bs-humany/session';
import { describe, expect, it } from 'vitest';
// The rest by path rather than by package name, as the tools themselves load them: this package
// declares no workspace dependency but the session, and the point is to resolve exactly what
// jiti resolves.
import { resolveMorphology } from '../../../packages/anthropometry/src/index.ts';
import { SCENARIOS } from '../../../packages/scenarios/src/index.ts';
import { buildDocument } from '../../../packages/skeleton/src/index.ts';

const document = buildDocument();

describe('the session surface the headless tools import', () => {
  it('exports what publish-pose and the showcase load by name', () => {
    expect(typeof Simulation).toBe('function');
    expect(typeof tissueTable).toBe('function');
    expect(typeof GrabIntents).toBe('function');
    expect(typeof publisherStatus).toBe('function');
    expect(typeof publisherMorphology).toBe('function');
    expect(typeof scenarioDefinition).toBe('function');
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

    // The status publish-pose writes beside the poses, built from the same arguments it passes.
    const definition = scenarioDefinition(chosen.id);
    const settings = {
      scenario: chosen.id,
      profile: 'l3_anatomical',
      muscles: null,
      sex: null,
      stature: null,
      mass: null,
      crural: null,
      brachial: null,
      legLength: null,
      passive: null,
      redistribute: true,
      fps: 60,
      stepsPerSecond: null,
      gravity: true,
      floor: true,
    };
    expect(publisherMorphology(settings, chosen).stature).toBe(chosen.morphology.stature);
    const status = publisherStatus({
      generation: 1,
      settings,
      profiles: [{ id: 'l3_anatomical', title: 'L3' }],
      definition,
      scenario: chosen,
      values: {},
      simulation,
      muscles: true,
      tissue: tissueTable(simulation.articulation),
      wallSeconds: 1,
      speed: 1,
      paused: false,
      holding: new GrabIntents().holding(),
      grabStrength: 1,
      drives: [],
      overlays: {},
    });
    expect(status.scenario.id).toBe(chosen.id);
    expect(status.simSeconds).toBeCloseTo(20 * simulation.dt, 12);
    expect(status.tension).toHaveLength(simulation.muscles?.units.length ?? -1);

    // The scrub publish-pose does to rewind a loop: a time in seconds, landing on the tick nearest
    // it, which at the profile's rate is a whole number of ticks.
    simulation.scrubTo(0.01);
    expect(simulation.ticks).toBe(Math.round(0.01 / simulation.dt));
    simulation.reset();
    expect(simulation.ticks).toBe(0);
    simulation.dispose();
  }, 60_000);
});
