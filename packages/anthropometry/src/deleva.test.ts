import { describe, expect, it } from 'vitest';
import {
  DE_LEVA_FEMALE,
  DE_LEVA_MALE,
  DE_LEVA_PROVENANCE,
  DE_LEVA_SEGMENTS,
  type DeLevaSegment,
  type DeLevaTable,
  SEGMENT_MULTIPLICITY,
  blendDeLeva,
  totalRelativeMass,
} from './deleva.js';
import { fitForMeasurement } from './provenance.js';

const TABLES: ReadonlyArray<readonly [string, DeLevaTable]> = [
  ['female', DE_LEVA_FEMALE],
  ['male', DE_LEVA_MALE],
];

describe('mass fractions sum to a whole body', () => {
  it('totals 100% of body mass for each sex', () => {
    // The strongest available check on the transcription. Eleven independently-read numbers
    // summing to exactly 1 is very unlikely to survive a transposed digit.
    for (const [name, table] of TABLES) {
      expect(totalRelativeMass(table), name).toBeCloseTo(1, 3);
    }
  });

  it('decomposes the trunk into its three sub-segments', () => {
    // A second independent check: upper + mid + lower trunk must reproduce the trunk entry, which
    // was tabulated separately.
    for (const [name, table] of TABLES) {
      const sum =
        table.upperTrunk.relativeMass + table.midTrunk.relativeMass + table.lowerTrunk.relativeMass;
      expect(sum, `${name} trunk decomposition`).toBeCloseTo(table.trunk.relativeMass, 4);
    }
  });

  it('excludes the aggregate trunk entry from the body total', () => {
    // Counting both the trunk and its sub-segments would double the torso -- roughly 43% of body
    // mass -- which is the kind of error that makes a ragdoll fall like a bowling ball.
    expect(SEGMENT_MULTIPLICITY.trunk).toBe(0);
    expect(SEGMENT_MULTIPLICITY.upperTrunk).toBe(1);
    expect(SEGMENT_MULTIPLICITY.upperArm).toBe(2);
  });
});

describe('parameter ranges', () => {
  it('keeps every centre of mass inside its segment', () => {
    for (const [name, table] of TABLES) {
      for (const segment of DE_LEVA_SEGMENTS) {
        const com = table[segment].comFromProximal;
        expect(com, `${name} ${segment}`).toBeGreaterThan(0);
        expect(com, `${name} ${segment}`).toBeLessThan(1);
      }
    }
  });

  it('keeps every relative mass positive and below half the body', () => {
    for (const [name, table] of TABLES) {
      for (const segment of DE_LEVA_SEGMENTS) {
        const mass = table[segment].relativeMass;
        expect(mass, `${name} ${segment}`).toBeGreaterThan(0);
        expect(mass, `${name} ${segment}`).toBeLessThan(0.5);
      }
    }
  });

  it('keeps every radius of gyration positive and physically plausible', () => {
    // A radius of gyration above the segment length would put the equivalent point mass outside
    // the segment.
    for (const [name, table] of TABLES) {
      for (const segment of DE_LEVA_SEGMENTS) {
        const radii = table[segment].radiiOfGyration;
        for (const [axis, value] of Object.entries(radii)) {
          expect(value, `${name} ${segment} ${axis}`).toBeGreaterThan(0);
          expect(value, `${name} ${segment} ${axis}`).toBeLessThan(1);
        }
      }
    }
  });
});

describe('axis assignment sanity checks', () => {
  it('gives every limb segment its smallest radius about the long axis', () => {
    // A limb is long and thin, so its moment about its own long axis must be much the smallest.
    // If `longitudinal` were mapped to a transverse axis, this would fail.
    const limbs: DeLevaSegment[] = ['upperArm', 'forearm', 'thigh', 'shank'];
    for (const [name, table] of TABLES) {
      for (const segment of limbs) {
        const { sagittal, transverse, longitudinal } = table[segment].radiiOfGyration;
        expect(longitudinal, `${name} ${segment}`).toBeLessThan(sagittal);
        expect(longitudinal, `${name} ${segment}`).toBeLessThan(transverse);
      }
    }
  });

  it('gives the trunk a larger moment about the antero-posterior axis than the medio-lateral', () => {
    // The trunk is wider than it is deep, so mass sits further from the antero-posterior axis.
    // This is the check that pins `sagittal` to the antero-posterior axis rather than leaving the
    // naming to be guessed. See the axis table in inertia.ts.
    for (const [name, table] of TABLES) {
      expect(table.trunk.radiiOfGyration.sagittal, name).toBeGreaterThan(
        table.trunk.radiiOfGyration.transverse,
      );
    }
  });
});

describe('sex blending', () => {
  it('returns the endpoint tables exactly at 0 and 1', () => {
    for (const segment of DE_LEVA_SEGMENTS) {
      expect(blendDeLeva(0)[segment]).toEqual(DE_LEVA_FEMALE[segment]);
      expect(blendDeLeva(1)[segment]).toEqual(DE_LEVA_MALE[segment]);
    }
  });

  it('interpolates linearly on the derived scalars', () => {
    // Spec section 6.2: interpolation happens on the parameters, never on geometry.
    const mid = blendDeLeva(0.5);
    for (const segment of DE_LEVA_SEGMENTS) {
      expect(mid[segment].relativeMass).toBeCloseTo(
        (DE_LEVA_FEMALE[segment].relativeMass + DE_LEVA_MALE[segment].relativeMass) / 2,
        12,
      );
    }
  });

  it('preserves the mass sum at every blend value', () => {
    // The invariant has to survive blending, or an intermediate model quietly gains or loses mass.
    for (const sex of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(totalRelativeMass(blendDeLeva(sex)), `sex=${sex}`).toBeCloseTo(1, 3);
    }
  });

  it('preserves the trunk decomposition at every blend value', () => {
    for (const sex of [0, 0.3, 0.5, 0.7, 1]) {
      const table = blendDeLeva(sex);
      const sum =
        table.upperTrunk.relativeMass + table.midTrunk.relativeMass + table.lowerTrunk.relativeMass;
      expect(sum, `sex=${sex}`).toBeCloseTo(table.trunk.relativeMass, 4);
    }
  });

  it('rejects a blend value outside [0, 1]', () => {
    expect(() => blendDeLeva(-0.1)).toThrow(/must be in \[0, 1\]/);
    expect(() => blendDeLeva(1.5)).toThrow(/must be in \[0, 1\]/);
  });
});

describe('sex differences that the literature reports', () => {
  it('gives females relatively heavier thighs and males relatively heavier forearms', () => {
    // Directional checks against well-known dimorphism, catching a wholesale swap of the two
    // tables -- which no internal consistency check would notice, since both sum to 1.
    expect(DE_LEVA_FEMALE.thigh.relativeMass).toBeGreaterThan(DE_LEVA_MALE.thigh.relativeMass);
    expect(DE_LEVA_MALE.forearm.relativeMass).toBeGreaterThan(DE_LEVA_FEMALE.forearm.relativeMass);
  });

  it('gives males a relatively heavier upper trunk and females a heavier lower trunk', () => {
    expect(DE_LEVA_MALE.upperTrunk.relativeMass).toBeGreaterThan(
      DE_LEVA_FEMALE.upperTrunk.relativeMass,
    );
    expect(DE_LEVA_FEMALE.lowerTrunk.relativeMass).toBeGreaterThan(
      DE_LEVA_MALE.lowerTrunk.relativeMass,
    );
  });
});

describe('provenance is honest about what has been checked', () => {
  it('is not yet claimed as verified against the source document', () => {
    // Automated checks catch a digit that breaks an invariant. They cannot catch a value that is
    // internally consistent and simply not what the paper says. Saying so is the point.
    expect(DE_LEVA_PROVENANCE.status).toBe('consistency-checked');
    expect(fitForMeasurement(DE_LEVA_PROVENANCE)).toBe(false);
  });

  it('names the open question tracking the outstanding verification', () => {
    expect(DE_LEVA_PROVENANCE.openQuestion).toMatch(/^OQ-\d{3}$/);
  });

  it('carries the population limitation', () => {
    expect(DE_LEVA_PROVENANCE.population).toMatch(/college-aged/i);
    expect(DE_LEVA_PROVENANCE.population).toMatch(/small sample/i);
  });
});
