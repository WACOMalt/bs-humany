/**
 * The rig from a recipe: a scenario places the body, a morphology sizes it, and the brain can
 * stand alone with nothing played under it. A coarse body, because a rig is a whole simulation
 * and the point here is the wiring, not the standing.
 */

import { describe, expect, it } from 'vitest';
import { StandRig, defaultRecipe, rigOptionsFor } from './rig.js';

describe('a training recipe', () => {
  it('turns into rig options, and the old flags into the reference recipe', () => {
    const recipe = defaultRecipe('stand', 'l1_standard', 0.3);
    expect(recipe.feedforward).toEqual({ kind: 'clip', clip: 'quiet-standing' });
    expect(recipe.scenario).toBe('');
    const options = rigOptionsFor(
      {
        ...recipe,
        scenario: 'drop-standing-collapse',
        parameters: { clearance: 0 },
        passive: false,
      },
      { hidden: [8], seconds: 2, poseBones: true },
    );
    expect(options.scenario).toEqual({
      id: 'drop-standing-collapse',
      parameters: { clearance: 0 },
    });
    expect(options.passiveJoints).toBe(false);
    expect(options.poseBones).toBe(true);
    expect(options.profileId).toBe('l1_standard');
    expect(rigOptionsFor(recipe, { hidden: [8], seconds: 2 }).scenario).toBeUndefined();
  });
});

describe('a rig built from a scenario with the brain alone', () => {
  it('stands the chosen body on the ground with every muscle slack, and plays a script only when asked', async () => {
    const rig = await StandRig.build({
      profileId: 'l1_standard',
      hidden: [8],
      seconds: 1,
      authority: 0.3,
      feedforward: { kind: 'none' },
      scenario: { id: 'drop-standing-collapse', parameters: { clearance: 0 } },
      morphology: { sex: 0.2, stature: 1.6, mass: 55 },
      passiveJoints: true,
    });
    expect(rig.profileId).toBe('l1_standard');
    expect(rig.stepSeconds).toBeCloseTo(1 / 500, 9);
    // Zero weights: the policy asks for nothing, nothing plays under it, and the body is still
    // up a few control steps in -- it starts on its feet, and a slack body takes a moment to go.
    const result = rig.episode(new Float32Array(rig.parameterCount), 1);
    expect(result.aliveSeconds).toBeGreaterThan(0);
    expect(result.fitness).toBeGreaterThan(0);
    // Ticked from the top, the head is where a 1.6 m body's head is, not the reference's.
    rig.begin(new Float32Array(rig.parameterCount));
    const first = rig.tick();
    expect(first.headHeight).toBeGreaterThan(1.3);
    expect(first.headHeight).toBeLessThan(1.6);

    // The scenario's own muscle script drives nothing with the brain alone; asked for, it does.
    const quiet = async (kind: 'none' | 'script') => {
      const r = await StandRig.build({
        profileId: 'l1_standard',
        hidden: [8],
        seconds: 1,
        authority: 0.3,
        feedforward: kind === 'script' ? { kind: 'script' } : { kind: 'none' },
        scenario: { id: 'quiet-standing', parameters: { settle: 0 } },
      });
      r.begin(new Float32Array(r.parameterCount));
      for (let i = 0; i < 100; i++) r.tick();
      // The activation senses of the last observation: what the muscles were told, as felt.
      const senses = r.activity().layers[0] as Float64Array;
      let activation = 0;
      r.inputNames.forEach((name, i) => {
        if (name.startsWith('activation:')) activation += senses[i] as number;
      });
      r.dispose();
      return activation;
    };
    // Not zero: the muscle model keeps a floor of activation; the script's tone is well above it.
    const alone = await quiet('none');
    expect(alone).toBeLessThan(0.2);
    expect(await quiet('script')).toBeGreaterThan(alone * 3);
  }, 120_000);
});
