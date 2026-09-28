/**
 * The cord and the policy follow the run, rather than the run it opened as.
 *
 * Two things the panel reads off a running body and used to read off the wrong one. The Spine
 * sliders were not passed to a new run at all, so a run started after the sliders moved had no
 * cord whatever they showed. And the brain's note named the checkpoint the run opened with, so
 * after handing another one over it went on reporting the first one's generations and fitness
 * under the second one's weights. (The run opened with the scenario's own policy then, from
 * "Standing, with the nerves"; that scenario was deleted on 2026-09-28, and a run opens with the
 * panel's hand-over or with none.)
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import type { PolicyFile } from '@bs-humany/modules-nerves';
import balancePolicy from '@bs-humany/modules-nerves/policies/balance.json' with { type: 'json' };
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { Simulation, type SimulationOptions } from './simulation.js';

const document = buildDocument();

function build(extra: Partial<SimulationOptions>): Simulation {
  return new Simulation(document, resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 }), {
    profileId: 'l3_anatomical',
    backend: 'mujoco',
    passiveJoints: true,
    redistribute: true,
    dropHeight: 0.2,
    groundHeight: 0,
    muscles: true,
    ...extra,
  });
}

describe('the cord a new run starts with', () => {
  it('is the one passed in, and none by default', async () => {
    const corded = build({ reflex: { stretch: 2, velocity: 0.25 } });
    await corded.start();
    expect(corded.spine?.gains.stretch).toBe(2);
    expect(corded.spine?.gains.velocity).toBe(0.25);
    corded.dispose();

    const bare = build({});
    await bare.start();
    expect(bare.spine?.gains.stretch).toBe(0);
    expect(bare.spine?.gains.velocity).toBe(0);
    bare.dispose();
  }, 60_000);
});

describe('the policy in charge', () => {
  it('is the one the run was built with, then whatever was handed over, then nothing', async () => {
    const committed = balancePolicy as unknown as PolicyFile;
    const simulation = build({ nerves: { policy: committed, authority: 0.3, goal: 0 } });
    await simulation.start();
    expect(simulation.policyInCharge?.trained).toEqual(committed.trained);

    // A copy that says it was trained differently: the weights are the same, which is fine,
    // because what is under test is which file the note would describe.
    const other: PolicyFile = {
      ...committed,
      trained: { generations: 7, fitness: 1.25, episodes: 896, at: '2026-09-25T00:00:00.000Z' },
    };
    simulation.handOver(other, 0.3);
    expect(simulation.policyInCharge?.trained?.generations).toBe(7);
    expect(simulation.policyInCharge?.trained?.fitness).toBe(1.25);

    simulation.releaseBrain();
    expect(simulation.policyInCharge).toBeUndefined();
    simulation.dispose();
  }, 60_000);
});
