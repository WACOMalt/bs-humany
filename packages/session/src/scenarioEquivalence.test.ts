/**
 * A scenario watched in the studio is the scenario the goldens pin.
 *
 * The studio assembles its own kernel rather than calling the testkit's runner, and it assembles
 * more: the skeleton pose it draws, the muscle bellies it sweeps, a spinal cord at zero gain and a
 * brain with no authority, both there so that a panel or a hand-over can switch them on live. None
 * of those may change what the body does. They read and do not write, or they add exactly nothing,
 * and the kernel's order comes from phases rather than from the order modules were registered in.
 * The script reaches both bodies through the one `createScenarioApi`, with the studio asking only
 * to skip a scenery move that changes nothing.
 *
 * So the studio, run passive as the scenario asks and with no cord passed, must reproduce the
 * runner bit for bit. Checked over the opening of two scenarios at L3, one for each part of the
 * script API the studio sets up differently: the tilting floor, with the muscles on, moves
 * scenery, and the shaken skull grabs. The window is short because any difference in a falling
 * body grows within a few ticks; the full runs were compared too when this was written
 * (2026-09-27) and matched the committed goldens. A third part, a script's muscle drive, was
 * checked on quiet standing until scenarios stopped driving muscles and it was deleted
 * (2026-09-28); the tilting floor still carries the muscle set through the comparison.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { BODY_JOINT_STATE, BODY_POSE } from '@bs-humany/modules-mechanics';
import { TILTING_PLATFORM, scenario } from '@bs-humany/scenarios';
import { buildDocument } from '@bs-humany/skeleton';
import { runScenario, trajectoryHash } from '@bs-humany/testkit';
import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation.js';

const document = buildDocument();

/** The studio's run of a scenario, sampled where and as the runner samples it. */
async function studioRun(id: string, ticks: number) {
  const chosen = scenario(id);
  const simulation = new Simulation(document, resolveMorphology(chosen.morphology), {
    profileId: chosen.profileId,
    backend: 'mujoco',
    passiveJoints: chosen.passiveJoints,
    redistribute: true,
    scenario: chosen,
    dropHeight: 0,
    groundHeight: chosen.ground.height,
    muscles: chosen.muscles ?? false,
  });
  await simulation.start();
  const pose = simulation.channel(BODY_POSE).fields;
  const joint = simulation.channel(BODY_JOINT_STATE).fields;
  const samples: { position: Float64Array; orientation: Float64Array; q: Float64Array }[] = [];
  const sample = () =>
    samples.push({
      position: Float64Array.from(pose.position as Float64Array),
      orientation: Float64Array.from(pose.orientation as Float64Array),
      q: Float64Array.from(joint.q as Float64Array),
    });
  const every = Math.max(1, Math.round(simulation.stepsPerSecond / 50));
  sample();
  for (let tick = 1; tick <= ticks; tick++) {
    simulation.tick();
    if (tick % every === 0 || tick === ticks) sample();
  }
  return { simulation, samples };
}

async function compare(id: string, ticks: number) {
  const golden = await runScenario(new MujocoBackend(), scenario(id), {
    document,
    maxTicks: ticks,
  });
  const studio = await studioRun(id, ticks);
  expect(studio.samples).toHaveLength(golden.samples.length);
  // The runner's samples with the studio's pose laid over each: everything the hash reads is then
  // the studio's, and everything else is the runner's, which the hash does not look at.
  const watched = golden.samples.map((s, i) => ({ ...s, ...studio.samples[i] }));
  expect(trajectoryHash({ ...golden, samples: watched })).toBe(trajectoryHash(golden));
  return studio.simulation;
}

describe('the studio against the golden runner', () => {
  it('turns the tilting floor under the same trajectory, and draws it where the solver has it', async () => {
    const simulation = await compare('tilting-floor', 1000);
    const platform = simulation.staticBoxes.find((b) => b.id === TILTING_PLATFORM);
    // The first pulse lands inside the first second, so the platform the viewport draws is no
    // longer the level one the scenario declared.
    expect(platform?.rotation?.w).toBeLessThan(1);
  }, 120_000);

  it('shakes the skull by the same grab to the same trajectory', async () => {
    await compare('skull-wiggle', 500);
  }, 120_000);
});
