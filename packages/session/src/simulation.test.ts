/**
 * The cord a run is built with, and what handing a policy over does and does not change.
 *
 * The Spine panel is the one owner of the cord: the studio passes its gains into every run it
 * builds, and moves them on a running body through `setReflex`. Two things used to go around it.
 * A new run always started with no cord, whatever the sliders said, so a Reset after turning the
 * stretch up ran a body without it. And a hand-over set the cord from the policy's own recipe, so
 * the body's reflexes changed under a panel that went on showing the old ones. These pin both
 * shut, and pin that moving Authority is only a change of authority.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import type { PolicyFile } from '@bs-humany/modules-nerves';
import { SCENARIOS } from '@bs-humany/scenarios';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { Simulation, type SimulationOptions } from './simulation.js';

const document = buildDocument();

function build(extra: Partial<SimulationOptions> = {}): Simulation {
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

/** The committed standing policy, with a recipe that asks for a cord of its own. */
function policyAskingForACord(): PolicyFile {
  const stand = SCENARIOS.find((s) => s.id === 'nerves-stand')?.nerves?.policy;
  if (!stand) throw new Error('the nerves-stand scenario has no policy');
  return {
    ...stand,
    recipe: {
      name: 'probe',
      task: 'stand',
      scenario: 'nerves-stand',
      parameters: {},
      profile: 'l3_anatomical',
      morphology: { sex: 0.5, stature: 1.7, mass: 70 },
      passive: true,
      redistribute: true,
      feedforward: { kind: 'none' },
      authority: 0.3,
      reflex: {
        stretch: 1,
        velocity: 1,
        setPoint: 0,
        inhibition: 0.3,
        forceCeiling: 1.2,
        forceInhibition: 0.5,
        delaySeconds: 0.03,
      },
    },
  };
}

describe('the cord a run is built with', () => {
  it('is the one it is given, and none when it is given nothing', async () => {
    const given = build({ reflex: { stretch: 3.5, velocity: 0.25 } });
    expect(given.spine?.gains.stretch).toBe(3.5);
    expect(given.spine?.gains.velocity).toBe(0.25);
    given.dispose();

    // Nothing passed is no cord at all, which is what publish-pose and every other headless
    // caller has always run and must go on running.
    const bare = build();
    expect(bare.spine?.gains.stretch).toBe(0);
    expect(bare.spine?.gains.velocity).toBe(0);
    bare.dispose();
  }, 60_000);

  it('is left alone by a hand-over, and by a change of authority', async () => {
    const simulation = build({ reflex: { stretch: 3.5, velocity: 0.25 } });
    await simulation.start();
    const before = { ...simulation.spine?.gains };

    // The policy's recipe asks for stretch 1. The body keeps the panel's 3.5: the studio puts a
    // recipe's cord on the sliders when it wants it, and the sliders set the body.
    simulation.handOver(policyAskingForACord(), 0.3);
    expect(simulation.spine?.gains).toEqual(before);

    simulation.setAuthority(0.7);
    expect(simulation.nerves?.authorityLevel).toBeCloseTo(0.7, 12);
    expect(simulation.spine?.gains).toEqual(before);
    simulation.dispose();
  }, 60_000);

  it('keeps the handed-over policy in charge when only its authority moves', async () => {
    // What `setAuthority` is for: adopting the same policy again would refit it and start a
    // remembering policy's context over, so a change of authority must leave the policy alone.
    const simulation = build();
    await simulation.start();
    const policy = policyAskingForACord();
    simulation.handOver(policy, 0.3);
    simulation.setAuthority(0.9);
    expect(simulation.policyInCharge).toBe(policy);
    expect(simulation.brainActive).toBe(true);
    simulation.dispose();
  }, 60_000);
});
