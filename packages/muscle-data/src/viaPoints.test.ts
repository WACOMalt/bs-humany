import { MUSCLE_VIA_POINTS, VIA_PATH_DIRECTION } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { ALL_MUSCLE_UNITS } from './wholeBody.js';

/**
 * Units whose carried via points are deliberately left out of their paths, and why.
 *
 * The via-point table and the region sets are two generated files joined by unit id, and each
 * generator reads only its own side of the join. A unit renamed on one side and not the other
 * used to lose its via points without a word: the table kept them, the path never named them,
 * and the muscle ran as a straight chord that every other check was happy with. So every point
 * the table holds has to be named by its unit's path, and a unit that leaves its points out on
 * purpose is listed here with the reason -- the same reason its generator states in `because`.
 */
const VIA_POINTS_LEFT_OUT: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    ['tibialis_anterior', 'extensor_digitorum_longus', 'extensor_hallucis_longus'].flatMap(
      (muscle) =>
        ['r', 'l'].map((side) => [
          `${muscle}_${side}`,
          'generate-ankle-muscles.mjs runs the three dorsiflexors straight: carried, their points ' +
            'left them within millimetres of the ankle axis and changing sign (OQ-021)',
        ]),
    ),
  ),
);

const UNIT_IDS = new Set(ALL_MUSCLE_UNITS.map((unit) => unit.id));
const PATH_SITES = new Map(
  ALL_MUSCLE_UNITS.map((unit) => [
    unit.id,
    new Set(
      (unit.path ?? []).flatMap((element) => (element.kind === 'site' ? [element.site] : [])),
    ),
  ]),
);

describe('the via-point table and the muscle set agree about which unit is which', () => {
  it('names only units the whole body has', () => {
    const strangers = [
      ...new Set([
        ...MUSCLE_VIA_POINTS.map((point) => point.unit),
        ...Object.keys(VIA_PATH_DIRECTION),
      ]),
    ].filter((unit) => !UNIT_IDS.has(unit));
    expect(strangers).toEqual([]);
  });

  it("puts every carried point in its unit's path, unless the unit says why not", () => {
    const orphaned = MUSCLE_VIA_POINTS.filter(
      (point) =>
        VIA_POINTS_LEFT_OUT[point.unit] === undefined &&
        !(PATH_SITES.get(point.unit)?.has(point.id) ?? false),
    ).map((point) => point.id);
    expect(orphaned).toEqual([]);
  });

  it('keeps the allowance to units that still leave points out', () => {
    // An entry whose unit now names every one of its points is an excuse for nothing, and a stale
    // excuse is how the next real omission would slip past.
    const stale = Object.keys(VIA_POINTS_LEFT_OUT).filter((unit) =>
      MUSCLE_VIA_POINTS.filter((point) => point.unit === unit).every(
        (point) => PATH_SITES.get(unit)?.has(point.id) ?? false,
      ),
    );
    expect(stale).toEqual([]);
  });
});
