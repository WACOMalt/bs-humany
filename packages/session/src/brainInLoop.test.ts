/**
 * What the running body does follows the policy actually in the loop.
 *
 * Two things used to follow something else. A policy handed over live was evaluated at the
 * divisor the body was built with, whatever rate it was trained at. And the panel was the one
 * working the divisor out for a new run, from a copy of the rate rule the run itself did not share.
 *
 * A third went with the scenarios that drove muscles, deleted on 2026-09-28: whether the
 * scenario's script fed the muscles under a policy used to be read off the checkpoint selected in
 * the list. No scenario drives a muscle now, brain or no brain, and that is pinned here instead.
 *
 * All at L3 with the muscles on, which is where the studio runs the brain, in "Drop, standing" at
 * 0 m, the default scenario the one shipped behaviour was trained in.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import type { PolicyFile } from '@bs-humany/modules-nerves';
import balancePolicy from '@bs-humany/modules-nerves/policies/balance.json' with { type: 'json' };
import { DEFAULT_SCENARIO, scenario } from '@bs-humany/scenarios';
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
 * A test-only copy of it at no recorded rate: the same weights with the recipe taken off, which is
 * what a checkpoint from before recipes is.
 */
const unrecorded: PolicyFile = (() => {
  const { recipe: _recipe, ...rest } = balance;
  return rest;
})();

function build(extra: Partial<SimulationOptions> = {}): Simulation {
  const chosen = scenario(DEFAULT_SCENARIO);
  return new Simulation(document, resolveMorphology(chosen.morphology), {
    // L3 rather than the scenario's own L1: the brain is run on the anatomical body.
    profileId: 'l3_anatomical',
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

describe('the scenario', () => {
  it('drives no muscle, with no brain, under one handed over, or after its release', async () => {
    const simulation = build();
    await simulation.start();
    const units = simulation.muscles?.units.map((u) => u.id) ?? [];
    expect(units.length).toBeGreaterThan(0);
    // Nothing drives a unit but a slider, and no slider has been moved.
    const driven = () => units.filter((id) => simulation.muscleDrive?.overrideFor(id) !== null);
    ticks(simulation, 5);
    expect(driven()).toEqual([]);
    simulation.handOver(balance, 0.3);
    ticks(simulation, 5);
    expect(driven()).toEqual([]);
    simulation.releaseBrain();
    ticks(simulation, 5);
    expect(driven()).toEqual([]);
    simulation.dispose();
  }, 60_000);
});

describe('the policy in the loop', () => {
  it('is nothing, then each file handed over in turn, then nothing', async () => {
    const simulation = build();
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
    const simulation = build({
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
    const simulation = build();
    expect(simulation.stepsPerSecond).toBe(1000);
    expect(simulation.nerves?.divisor).toBe(10);
    simulation.dispose();
  }, 60_000);
});
