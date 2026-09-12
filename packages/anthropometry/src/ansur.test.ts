import { describe, expect, it } from 'vitest';
import {
  ANSUR_FEMALE,
  ANSUR_MALE,
  ANSUR_PROVENANCE,
  PROPORTION_PROVENANCE,
  SEGMENT_PROPORTIONS,
  atPercentile,
  blendReference,
  inverseNormalCdf,
  normalCdf,
  staturePercentile,
} from './ansur.js';
import { fitForMeasurement } from './provenance.js';

describe('inverseNormalCdf', () => {
  it('gives zero at the median', () => {
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 12);
  });

  it('reproduces the standard z-scores', () => {
    // The values every statistics table lists. If the approximation were wrong, these would be
    // the first thing to drift.
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.959964, 5);
    expect(inverseNormalCdf(0.025)).toBeCloseTo(-1.959964, 5);
    expect(inverseNormalCdf(0.95)).toBeCloseTo(1.644854, 5);
    expect(inverseNormalCdf(0.99)).toBeCloseTo(2.326348, 5);
    expect(inverseNormalCdf(0.01)).toBeCloseTo(-2.326348, 5);
    expect(inverseNormalCdf(0.8413447)).toBeCloseTo(1, 4);
  });

  it('is antisymmetric about the median', () => {
    for (const p of [0.001, 0.01, 0.1, 0.25, 0.4]) {
      expect(inverseNormalCdf(p)).toBeCloseTo(-inverseNormalCdf(1 - p), 6);
    }
  });

  it('is monotonically increasing', () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (let p = 0.001; p < 0.999; p += 0.001) {
      const z = inverseNormalCdf(p);
      expect(z).toBeGreaterThan(previous);
      previous = z;
    }
  });

  it('holds accuracy in the tails, across the branch boundaries', () => {
    // Acklam's approximation switches branch at p = 0.02425 and its mirror. A seam there would
    // show up as a discontinuity.
    for (const p of [0.0242, 0.02425, 0.0243, 0.9757, 0.97575, 0.9758]) {
      expect(normalCdf(inverseNormalCdf(p))).toBeCloseTo(p, 7);
    }
  });

  it('refuses the impossible endpoints', () => {
    expect(() => inverseNormalCdf(0)).toThrow(/strictly between 0 and 1/);
    expect(() => inverseNormalCdf(1)).toThrow(/no finite 0th or 100th percentile/);
  });
});

describe('normalCdf', () => {
  it('gives the familiar values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 10);
    expect(normalCdf(1)).toBeCloseTo(0.841345, 5);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 5);
    expect(normalCdf(1.96)).toBeCloseTo(0.975002, 5);
    expect(normalCdf(3)).toBeCloseTo(0.99865, 5);
  });

  it('round-trips with its inverse', () => {
    for (const p of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) {
      expect(normalCdf(inverseNormalCdf(p))).toBeCloseTo(p, 7);
    }
  });
});

describe('reference statistics', () => {
  it('gives males a greater mean stature and mass than females', () => {
    expect(ANSUR_MALE.statureMean).toBeGreaterThan(ANSUR_FEMALE.statureMean);
    expect(ANSUR_MALE.massMean).toBeGreaterThan(ANSUR_FEMALE.massMean);
  });

  it('gives males relatively broader shoulders and females relatively broader hips', () => {
    // The clearest skeletal dimorphism, and a directional check that the two tables have not been
    // swapped -- which no internal consistency check would catch.
    expect(ANSUR_MALE.biacromialFraction).toBeGreaterThan(ANSUR_FEMALE.biacromialFraction);
    expect(ANSUR_FEMALE.biiliacFraction).toBeGreaterThan(ANSUR_MALE.biiliacFraction);
  });

  it('implies a BMI consistent with the published sample', () => {
    // ANSUR II sampled military personnel, whose mean BMI runs well above civilian means. A value
    // in the normal civilian range would suggest the wrong numbers were transcribed.
    for (const [name, reference] of [
      ['female', ANSUR_FEMALE],
      ['male', ANSUR_MALE],
    ] as const) {
      const bmi = reference.massMean / reference.statureMean ** 2;
      expect(bmi, `${name} BMI`).toBeGreaterThan(24);
      expect(bmi, `${name} BMI`).toBeLessThan(29);
    }
  });

  it('has plausible dispersion', () => {
    for (const reference of [ANSUR_FEMALE, ANSUR_MALE]) {
      // Adult stature SD is a few centimetres.
      expect(reference.statureSd).toBeGreaterThan(0.05);
      expect(reference.statureSd).toBeLessThan(0.08);
      expect(reference.massSd).toBeGreaterThan(8);
      expect(reference.massSd).toBeLessThan(20);
    }
  });
});

describe('blending', () => {
  it('returns the endpoints exactly', () => {
    expect(blendReference(0)).toEqual(ANSUR_FEMALE);
    expect(blendReference(1)).toEqual(ANSUR_MALE);
  });

  it('interpolates linearly', () => {
    const mid = blendReference(0.5);
    expect(mid.statureMean).toBeCloseTo(
      (ANSUR_FEMALE.statureMean + ANSUR_MALE.statureMean) / 2,
      12,
    );
  });

  it('rejects a value outside [0, 1]', () => {
    expect(() => blendReference(-0.01)).toThrow(/must be in \[0, 1\]/);
    expect(() => blendReference(1.01)).toThrow(/must be in \[0, 1\]/);
  });
});

describe('percentile scaling', () => {
  it('reproduces the mean at the 50th percentile', () => {
    for (const sex of [0, 0.5, 1]) {
      const reference = blendReference(sex);
      const median = atPercentile(sex, 0.5);
      expect(median.stature, `sex=${sex}`).toBeCloseTo(reference.statureMean, 10);
      expect(median.mass, `sex=${sex}`).toBeCloseTo(reference.massMean, 10);
    }
  });

  it('is monotonic in the percentile', () => {
    let previousStature = 0;
    let previousMass = 0;
    for (let p = 0.01; p <= 0.99; p += 0.01) {
      const result = atPercentile(0.5, p);
      expect(result.stature).toBeGreaterThan(previousStature);
      expect(result.mass).toBeGreaterThan(previousMass);
      previousStature = result.stature;
      previousMass = result.mass;
    }
  });

  it('spans a plausible range from the 1st to the 99th percentile', () => {
    // Spec section 2.3 wants the model to scale across the 1st to 99th percentile range.
    const low = atPercentile(1, 0.01);
    const high = atPercentile(1, 0.99);
    expect(low.stature).toBeGreaterThan(1.5);
    expect(high.stature).toBeLessThan(2.0);
    expect(low.mass).toBeGreaterThan(40);
    expect(high.mass).toBeLessThan(140);
  });

  it('round-trips through staturePercentile', () => {
    for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const { stature } = atPercentile(0.3, p);
      expect(staturePercentile(0.3, stature)).toBeCloseTo(p, 6);
    }
  });
});

describe('segment proportions', () => {
  it('are all positive fractions of stature', () => {
    for (const [name, value] of Object.entries(SEGMENT_PROPORTIONS)) {
      expect(value, name).toBeGreaterThan(0);
      expect(value, name).toBeLessThan(1);
    }
  });

  it('build a leg that reaches the ground from the hip', () => {
    // thigh + shank + ankle height should reconstruct hip height, which is measured independently.
    // Two numbers read from the same table agreeing is a real check on both.
    const reconstructed =
      SEGMENT_PROPORTIONS.thigh + SEGMENT_PROPORTIONS.shank + SEGMENT_PROPORTIONS.ankleHeight;
    expect(reconstructed).toBeCloseTo(SEGMENT_PROPORTIONS.hipHeight, 2);
  });

  it('build an arm that reaches roughly to mid-thigh', () => {
    // Fingertip height with the arm hanging: shoulder height minus the whole arm chain. In a
    // standing adult that lands a little below the greater trochanter.
    const fingertipHeight =
      SEGMENT_PROPORTIONS.shoulderHeight -
      (SEGMENT_PROPORTIONS.upperArm + SEGMENT_PROPORTIONS.forearm + SEGMENT_PROPORTIONS.hand);
    expect(fingertipHeight).toBeGreaterThan(0.33);
    expect(fingertipHeight).toBeLessThan(0.42);
    expect(fingertipHeight).toBeLessThan(SEGMENT_PROPORTIONS.hipHeight);
  });

  it('give the shank and thigh nearly equal length', () => {
    // A well-known near-equality in adult proportions, and a good check on both values.
    expect(Math.abs(SEGMENT_PROPORTIONS.thigh - SEGMENT_PROPORTIONS.shank)).toBeLessThan(0.01);
  });

  it('place the shoulder above the hip by a sensible trunk length', () => {
    const trunkSpan = SEGMENT_PROPORTIONS.shoulderHeight - SEGMENT_PROPORTIONS.hipHeight;
    expect(trunkSpan).toBeCloseTo(SEGMENT_PROPORTIONS.trunk, 1);
  });
});

describe('provenance is honest about what has been checked', () => {
  it('does not claim either table is verified against its source', () => {
    expect(ANSUR_PROVENANCE.status).toBe('consistency-checked');
    expect(PROPORTION_PROVENANCE.status).toBe('consistency-checked');
    expect(fitForMeasurement(ANSUR_PROVENANCE)).toBe(false);
    expect(fitForMeasurement(PROPORTION_PROVENANCE)).toBe(false);
  });

  it('states plainly that the proportions are not sex-separated', () => {
    // The limitation must travel with the data, not live only in a design document.
    expect(PROPORTION_PROVENANCE.note).toMatch(/NOT sex-separated/);
    expect(PROPORTION_PROVENANCE.population).toMatch(/[Nn]ot sex-separated/);
    expect(PROPORTION_PROVENANCE.openQuestion).toBe('OQ-003');
  });

  it('states the ANSUR II population limitation', () => {
    expect(ANSUR_PROVENANCE.population).toMatch(/US Army/);
    expect(ANSUR_PROVENANCE.population).toMatch(/[Nn]ot representative/);
  });
});
