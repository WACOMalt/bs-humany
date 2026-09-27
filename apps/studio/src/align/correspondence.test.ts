/**
 * The Align tab's pairing lists, as the data they are drawn from.
 */

import { describe, expect, it } from 'vitest';
import { type Pair, missingSegments, pairLabel, pairedIn, unpairAt } from './correspondence.js';

describe('the muscle pairing list', () => {
  it('greys out only the muscles paired on the model being shown', () => {
    const pairs: Pair[] = [
      { model: 'torso', theirs: 'EO1', ours: 'external_oblique_r' },
      { model: 'legs', theirs: 'EO1', ours: 'gluteus_maximus_r' },
      { model: 'legs', theirs: 'soleus_r', ours: 'soleus_r' },
    ];
    expect([...pairedIn(pairs, 'legs')].sort()).toEqual(['EO1', 'soleus_r']);
    expect([...pairedIn(pairs, 'torso')]).toEqual(['EO1']);
    expect(pairedIn(pairs, 'arm').size).toBe(0);
  });

  it('gives one of theirs paired to two of ours two different rows', () => {
    const right: Pair = { model: 'torso', theirs: 'EO1', ours: 'external_oblique_r' };
    const left: Pair = { model: 'torso', theirs: 'EO1', ours: 'external_oblique_l' };
    expect(pairLabel(right)).not.toBe(pairLabel(left));
    expect(pairLabel(right)).toBe('torso: EO1 → external_oblique_r');
  });

  it('unpairs the row that was chosen, not the first with the same muscle', () => {
    const right: Pair = { model: 'torso', theirs: 'EO1', ours: 'external_oblique_r' };
    const left: Pair = { model: 'torso', theirs: 'EO1', ours: 'external_oblique_l' };
    const pairs = [right, left];
    expect(unpairAt(pairs, 1)).toBe(left);
    expect(pairs).toEqual([right]);
  });

  it('leaves the list alone for an index that is not in it', () => {
    const pairs: Pair[] = [{ model: 'legs', theirs: 'soleus_r', ours: 'soleus_r' }];
    expect(unpairAt(pairs, 1)).toBeUndefined();
    expect(unpairAt(pairs, -1)).toBeUndefined();
    expect(unpairAt(pairs, Number.NaN)).toBeUndefined();
    expect(pairs).toHaveLength(1);
  });
});

describe('the bone pairing list', () => {
  it('finds the pairs whose segment of ours is not in the body built', () => {
    const pairs = [
      { theirs: 'femur_r', ours: 'thigh_r' },
      { theirs: 'calcn_r', ours: 'calcaneus_r' },
      { theirs: 'toes_r', ours: 'toes_r' },
    ];
    const body = new Set(['pelvis', 'thigh_r', 'shank_r', 'foot_r']);
    expect(missingSegments(pairs, body)).toEqual([
      { theirs: 'calcn_r', ours: 'calcaneus_r' },
      { theirs: 'toes_r', ours: 'toes_r' },
    ]);
    expect(missingSegments(pairs, new Set(['thigh_r', 'calcaneus_r', 'toes_r']))).toEqual([]);
  });
});
