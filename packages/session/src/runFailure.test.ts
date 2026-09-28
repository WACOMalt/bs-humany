/**
 * A run that goes wrong stops and says so.
 *
 * Two ways a run can stop being the run it was: a tick throws, which used to escape `advance` and
 * take the frame loop with it, so the viewport froze on whatever it last drew; and MuJoCo resets
 * the body after a bad acceleration, which used to carry on from the reference pose as if the run
 * had just started. Both now pause the run and leave a record of what happened for the studio
 * to show.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { ROOT_NV } from '@bs-humany/compiler';
import { SCENARIOS, type Scenario } from '@bs-humany/scenarios';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation.js';

const document = buildDocument();

function collapse(): Scenario {
  const scenario = SCENARIOS.find((s) => s.id === 'drop-standing-collapse');
  if (!scenario) throw new Error('no drop-standing-collapse scenario');
  return scenario;
}

function build(scenario: Scenario): Simulation {
  return new Simulation(document, resolveMorphology(scenario.morphology), {
    profileId: scenario.profileId,
    backend: 'mujoco',
    passiveJoints: scenario.passiveJoints,
    redistribute: true,
    scenario,
    dropHeight: 0,
    groundHeight: scenario.ground.height,
  });
}

describe('a run that fails', () => {
  it('pauses where a tick threw, keeps the message, and runs no further', async () => {
    const throwing: Scenario = {
      ...collapse(),
      script: (time) => {
        if (time > 0.05) throw new Error('the script gave up');
      },
    };
    const simulation = build(throwing);
    await simulation.start();
    // Frames at the default rate until well past the failure; not one of them may throw.
    for (let frame = 0; frame < 20; frame++) {
      expect(() => simulation.advance(1 / 60)).not.toThrow();
    }
    expect(simulation.paused).toBe(true);
    expect(simulation.failure?.message).toBe('the script gave up');
    // The script is called before the kernel steps, with the time of the tick about to run.
    const failedAt = simulation.failure?.tick ?? -1;
    expect(failedAt * simulation.dt).toBeGreaterThan(0.05);
    expect(simulation.ticks).toBe(failedAt);
    expect(simulation.divergedAt).toBeUndefined();

    // Resuming does not run past it either: the next tick throws again and the run stays put.
    simulation.paused = false;
    simulation.advance(1 / 60);
    expect(simulation.paused).toBe(true);
    expect(simulation.ticks).toBe(failedAt);
    expect(simulation.failure?.tick).toBe(failedAt);
    simulation.dispose();
  }, 60_000);

  it('pauses when the backend resets the body, and records when', async () => {
    const simulation = build(collapse());
    await simulation.start();
    simulation.advance(1 / 60);
    expect(simulation.divergedAt).toBeUndefined();
    expect(simulation.paused).toBe(false);
    // A root velocity past MuJoCo's bad-value threshold: the next step resets the whole state.
    const { q, qdot } = simulation.jointState();
    qdot[ROOT_NV] = 1e12;
    simulation.physics.writeJointState(q, qdot);
    const before = simulation.ticks;
    const plan = simulation.advance(1 / 60);
    expect(plan.ticks).toBe(1);
    expect(simulation.divergedAt).toBe(before + 1);
    expect(simulation.paused).toBe(true);
    expect(simulation.physics.backendResets).toBe(1);
    expect(simulation.failure).toBeUndefined();
    simulation.dispose();
  }, 60_000);
});
