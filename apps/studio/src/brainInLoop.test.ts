/**
 * What the running body does follows the policy actually in the loop.
 *
 * Three things used to follow something else. Whether the scenario's script fed the muscles was
 * read off the checkpoint selected in the Brain panel's list when a run was built, so a policy
 * trained with nothing under it and handed over mid-run stood on the scenario's tone for the rest
 * of the run, and merely selecting one -- handing nothing over -- took the tone off the next run.
 * A policy handed over live was evaluated at the divisor the body was built with, whatever rate
 * it was trained at. And the panel was the one working the divisor out for a new run, from a copy
 * of the rate rule the run itself did not share.
 *
 * All at L3 with the muscles on, which is where the studio runs the brain.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import type { PolicyFile } from '@bs-humany/modules-nerves';
import balancePolicy from '@bs-humany/modules-nerves/policies/balance.json' with { type: 'json' };
import { type NervesSetup, scenario } from '@bs-humany/scenarios';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { Simulation, type SimulationOptions } from './simulation.js';

const document = buildDocument();
/**
 * The one shipped checkpoint. Trained with nothing under it -- its recipe's feedforward is `none`
 * -- and it records the rate it was trained at: 1000 steps a second, every ten.
 */
const balance = balancePolicy as unknown as PolicyFile;
/**
 * A test-only copy of it trained, it says, over the scenario's own muscles and at no recorded
 * rate: the same weights with the recipe taken off, which is what a checkpoint from before recipes
 * is. The studio lets a scenario's script go on driving the muscles under such a policy.
 */
const unrecorded: PolicyFile = (() => {
  const { recipe: _recipe, ...rest } = balance;
  return rest;
})();
/** A unit quiet standing tones from its first tick, as the calf is toned in a person standing. */
const TONED = 'soleus_r';

function build(id: string, extra: Partial<SimulationOptions> = {}): Simulation {
  const chosen = scenario(id);
  return new Simulation(document, resolveMorphology(chosen.morphology), {
    profileId: chosen.profileId,
    backend: 'mujoco',
    passiveJoints: true,
    redistribute: true,
    scenario: chosen,
    dropHeight: 0,
    groundHeight: chosen.ground.height,
    muscles: true,
    ...extra,
  });
}

function ticks(simulation: Simulation, count: number): void {
  for (let t = 0; t < count; t++) simulation.tick();
}

describe('the scenario’s muscle drive', () => {
  it('stops at once when a policy trained with nothing under it is handed over, and comes back at a release', async () => {
    expect(balance.recipe?.feedforward.kind).toBe('none');
    const simulation = build('quiet-standing');
    await simulation.start();
    // No brain: the script tones the calf.
    expect(simulation.scriptDrivingMuscles).toBe(true);
    ticks(simulation, 5);
    expect(simulation.muscleDrive?.overrideFor(TONED)).not.toBeNull();
    expect(simulation.muscleDrive?.overrideFor(TONED)).toBeGreaterThan(0);

    // Handed over live: the tone it had already set is cleared, not left standing under a brain
    // that never felt it, and the script's next drive is refused.
    simulation.handOver(balance, 0.3);
    expect(simulation.scriptDrivingMuscles).toBe(false);
    ticks(simulation, 1);
    expect(simulation.muscleDrive?.overrideFor(TONED)).toBeNull();

    // Released: the run carries on under the scenario, which tones the calf again.
    simulation.releaseBrain();
    ticks(simulation, 1);
    expect(simulation.scriptDrivingMuscles).toBe(true);
    expect(simulation.muscleDrive?.overrideFor(TONED)).toBeGreaterThan(0);
    simulation.dispose();
  }, 60_000);

  it('is off from the first tick of a run built with such a policy, and on under the scenario’s own', async () => {
    const setup: NervesSetup = { policy: balance, authority: 0.3, goal: 0 };
    const trained = build('quiet-standing', { nerves: setup });
    expect(trained.scriptDrivingMuscles).toBe(false);
    await trained.start();
    ticks(trained, 5);
    expect(trained.muscleDrive?.overrideFor(TONED)).toBeNull();
    trained.dispose();

    // A policy with no recipe says nothing of what it was trained over, so the scenario's clip
    // goes on under it.
    const underClip = build('quiet-standing', {
      nerves: { policy: unrecorded, authority: 0.3, goal: 0 },
    });
    expect(underClip.scriptDrivingMuscles).toBe(true);
    underClip.dispose();
    // nerves-stand hands the body to balance, which was trained with nothing under it, so its
    // clip is held back from the first tick.
    const stand = build('nerves-stand');
    expect(stand.scriptDrivingMuscles).toBe(false);
    stand.dispose();
  }, 60_000);
});

describe('the policy in the loop', () => {
  it('is nothing, then each file handed over in turn, then nothing', async () => {
    const simulation = build('quiet-standing');
    await simulation.start();
    expect(simulation.policyInCharge).toBeUndefined();

    const trainedFor = (generations: number): PolicyFile => ({
      ...balance,
      trained: { generations, fitness: 1, episodes: 128, at: '2026-09-27T00:00:00.000Z' },
    });
    simulation.handOver(trainedFor(7), 0.3);
    expect(simulation.policyInCharge?.trained?.generations).toBe(7);
    simulation.handOver(trainedFor(12), 0.3);
    expect(simulation.policyInCharge?.trained?.generations).toBe(12);

    simulation.releaseBrain();
    expect(simulation.policyInCharge).toBeUndefined();
    simulation.dispose();
  }, 60_000);
});

describe('the control rate', () => {
  it('keeps the period a policy was trained at, at the start of a run and on a live hand-over', async () => {
    // A policy that recorded no rate is evaluated at a hundred hertz at 500 steps a second:
    // every five ticks, where a pinned ten would have been fifty.
    const simulation = build('quiet-standing', {
      stepsPerSecond: 500,
      nerves: { policy: unrecorded, authority: 0.3, goal: 0 },
    });
    await simulation.start();
    expect(simulation.nerves?.divisor).toBe(5);

    // balance ran every ten ticks at 1000: at 500 that period is five ticks.
    const handed = simulation.handOver(balance, 0.3);
    expect(simulation.nerves?.divisor).toBe(5);
    expect(handed.trainedRate).toBe(1000);
    expect(handed.rate).toBe(500);

    // A checkpoint that ran every twenty at 1000 -- fifty hertz -- is every ten here.
    const slower: PolicyFile = {
      ...balance,
      recipe: { ...(balance.recipe as NonNullable<PolicyFile['recipe']>), controlDivisor: 20 },
    };
    simulation.handOver(slower, 0.3);
    expect(simulation.nerves?.divisor).toBe(10);
    simulation.dispose();
  }, 60_000);

  it('is a hundred hertz at the profile’s own rate when nothing says otherwise', () => {
    const simulation = build('nerves-stand');
    expect(simulation.stepsPerSecond).toBe(1000);
    expect(simulation.nerves?.divisor).toBe(10);
    simulation.dispose();
  }, 60_000);
});
