import { UNMODELLED_MUSCLES } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { ALL_MUSCLE_UNITS } from './wholeBody.js';

/**
 * The skeleton's list of what the body goes without, held against the body.
 *
 * `UNMODELLED_MUSCLES` is a claim -- these muscles are not here -- and the whole-body set is the
 * thing it is a claim about. A muscle added to a region set without the list being updated makes
 * the studio's Limitations panel say the body lacks something it has, and nothing else would
 * notice.
 */
describe('UNMODELLED_MUSCLES', () => {
  const ids = ALL_MUSCLE_UNITS.map((u) => u.id);

  it('names no muscle the whole-body set has', () => {
    for (const { group, muscles } of UNMODELLED_MUSCLES) {
      for (const muscle of muscles) {
        const present = ids.filter((id) => id.startsWith(`${muscle}_`));
        expect(present, `${group}: ${muscle}`).toEqual([]);
      }
    }
  });

  it('holds for the hand intrinsics by any spelling', () => {
    // The id stems above are one spelling. Whatever a lumbrical or an interosseous is called when
    // one is added, it will have one of these in it.
    expect(ids.filter((id) => /lumbrical|interosse/.test(id))).toEqual([]);
  });

  it('names each muscle once', () => {
    // The same name in two groups is fine -- the hand and the foot both have lumbricals -- but
    // twice in one group is a list nobody read back.
    for (const { group, muscles } of UNMODELLED_MUSCLES) {
      expect(new Set(muscles).size, group).toBe(muscles.length);
    }
  });
});
