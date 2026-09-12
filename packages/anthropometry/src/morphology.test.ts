import type { Morphology } from '@bs-humany/hsdl';
import { blend, evaluate, mul, param } from '@bs-humany/hsdl';
import { describe, expect, it } from 'vitest';
import { SEGMENT_PROPORTIONS, atPercentile, blendReference } from './ansur.js';
import { DE_LEVA_FEMALE, DE_LEVA_MALE } from './deleva.js';
import { validateInertia } from './inertia.js';
import {
  PUBLISHED_MASS_TOLERANCE,
  assertValidBody,
  deriveSegmentLengths,
  massPropertiesFor,
  resolveMorphology,
  validateResolvedBody,
  wholeBodyMassProperties,
} from './morphology.js';

const base: Morphology = { sex: 0.5, stature: 1.7, mass: 70 };

describe('parameter resolution', () => {
  it('passes explicit stature and mass through', () => {
    const resolved = resolveMorphology(base);
    expect(resolved.input.stature).toBe(1.7);
    expect(resolved.input.mass).toBe(70);
    expect(resolved.context.stature).toBe(1.7);
  });

  it('derives stature and mass from a percentile', () => {
    const resolved = resolveMorphology({ sex: 1, percentile: 0.5 } as Morphology);
    const expected = atPercentile(1, 0.5);
    expect(resolved.input.stature).toBeCloseTo(expected.stature, 10);
    expect(resolved.input.mass).toBeCloseTo(expected.mass, 10);
  });

  it('lets an explicit value win over the percentile, so one can be pinned', () => {
    const resolved = resolveMorphology({ sex: 1, percentile: 0.9, stature: 1.7 } as Morphology);
    expect(resolved.input.stature).toBe(1.7);
    expect(resolved.input.mass).toBeCloseTo(atPercentile(1, 0.9).mass, 10);
  });

  it('clamps a percentile at the ends rather than throwing at the user', () => {
    // A slider pinned to an end must not blow up: the normal distribution has no finite 0th or
    // 100th percentile, so it resolves to the nearest representable value.
    expect(() => resolveMorphology({ sex: 0.5, percentile: 0 } as Morphology)).not.toThrow();
    expect(() => resolveMorphology({ sex: 0.5, percentile: 1 } as Morphology)).not.toThrow();
    const low = resolveMorphology({ sex: 0.5, percentile: 0 } as Morphology);
    const high = resolveMorphology({ sex: 0.5, percentile: 1 } as Morphology);
    expect(low.input.stature).toBeLessThan(high.input.stature);
  });

  it('fills breadths from the sex-blended reference fractions', () => {
    const resolved = resolveMorphology({ sex: 1, stature: 1.8, mass: 80 });
    const reference = blendReference(1);
    expect(resolved.context.biacromialBreadth).toBeCloseTo(reference.biacromialFraction * 1.8, 10);
    expect(resolved.context.biiliacBreadth).toBeCloseTo(reference.biiliacFraction * 1.8, 10);
  });

  it('honours explicit proportion overrides', () => {
    const resolved = resolveMorphology({
      ...base,
      proportions: { biiliacBreadth: 0.31, biacromialBreadth: 0.42 },
    });
    expect(resolved.context.biiliacBreadth).toBe(0.31);
    expect(resolved.context.biacromialBreadth).toBe(0.42);
  });

  it('rejects a missing or non-positive stature with an actionable message', () => {
    expect(() => resolveMorphology({ sex: 0.5, mass: 70 } as Morphology)).toThrow(
      /needs a positive stature/,
    );
    expect(() => resolveMorphology({ sex: 0.5, mass: 70 } as Morphology)).toThrow(/'percentile'/);
    expect(() => resolveMorphology({ ...base, stature: -1 })).toThrow(/positive stature/);
  });

  it('rejects a missing mass', () => {
    expect(() => resolveMorphology({ sex: 0.5, stature: 1.7 } as Morphology)).toThrow(
      /needs a positive mass/,
    );
  });

  it('rejects a sex outside [0, 1]', () => {
    expect(() => resolveMorphology({ ...base, sex: 1.2 })).toThrow(/must be in \[0, 1\]/);
  });
});

describe('proportion overrides', () => {
  it('rescales the shank when the crural index changes, leaving the thigh alone', () => {
    // The crural index is shank relative to thigh. Overriding it must move exactly one of them.
    const standard = resolveMorphology(base);
    const longShank = resolveMorphology({ ...base, proportions: { crural: 1.2 } });
    expect(longShank.proportions.thigh).toBeCloseTo(standard.proportions.thigh, 12);
    expect(longShank.proportions.shank).toBeCloseTo(standard.proportions.thigh * 1.2, 12);
    expect(longShank.proportions.shank).toBeGreaterThan(standard.proportions.shank);
  });

  it('rescales the forearm when the brachial index changes', () => {
    const standard = resolveMorphology(base);
    const longForearm = resolveMorphology({ ...base, proportions: { brachial: 0.9 } });
    expect(longForearm.proportions.upperArm).toBeCloseTo(standard.proportions.upperArm, 12);
    expect(longForearm.proportions.forearm).toBeCloseTo(standard.proportions.upperArm * 0.9, 12);
  });

  it('scales the whole leg with relativeLegLength', () => {
    const standard = resolveMorphology(base);
    const longLegs = resolveMorphology({ ...base, proportions: { relativeLegLength: 1.1 } });
    expect(longLegs.proportions.thigh / standard.proportions.thigh).toBeCloseTo(1.1, 10);
    expect(longLegs.proportions.shank / standard.proportions.shank).toBeCloseTo(1.1, 10);
  });

  it('leaves the defaults untouched by an override on another instance', () => {
    resolveMorphology({ ...base, proportions: { relativeLegLength: 2 } });
    expect(SEGMENT_PROPORTIONS.thigh).toBe(0.245);
  });
});

describe('segment lengths', () => {
  it('scale linearly with stature', () => {
    const short = resolveMorphology({ ...base, stature: 1.5 });
    const tall = resolveMorphology({ ...base, stature: 2.0 });
    expect(tall.segmentLengths.thigh / short.segmentLengths.thigh).toBeCloseTo(2.0 / 1.5, 10);
    expect(tall.segmentLengths.forearm / short.segmentLengths.forearm).toBeCloseTo(2.0 / 1.5, 10);
  });

  it('give plausible absolute values for a 1.7 m body', () => {
    const { segmentLengths } = resolveMorphology(base);
    // Sanity ranges a physiotherapist would recognise.
    expect(segmentLengths.thigh).toBeGreaterThan(0.35);
    expect(segmentLengths.thigh).toBeLessThan(0.48);
    expect(segmentLengths.shank).toBeGreaterThan(0.35);
    expect(segmentLengths.shank).toBeLessThan(0.48);
    expect(segmentLengths.upperArm).toBeGreaterThan(0.27);
    expect(segmentLengths.upperArm).toBeLessThan(0.36);
    expect(segmentLengths.foot).toBeGreaterThan(0.22);
    expect(segmentLengths.foot).toBeLessThan(0.3);
  });

  it('decompose the trunk into three equal stacked regions', () => {
    // A documented simplification: de Leva subdivides the trunk but the proportion table gives one
    // trunk length. Splitting evenly beats inventing three.
    const { segmentLengths } = resolveMorphology(base);
    expect(segmentLengths.upperTrunk).toBeCloseTo(segmentLengths.trunk / 3, 12);
    expect(
      segmentLengths.upperTrunk + segmentLengths.midTrunk + segmentLengths.lowerTrunk,
    ).toBeCloseTo(segmentLengths.trunk, 12);
  });

  it('are all positive for the whole supported stature range', () => {
    for (let stature = 1.4; stature <= 2.05; stature += 0.05) {
      const lengths = deriveSegmentLengths(SEGMENT_PROPORTIONS, stature);
      for (const [segment, value] of Object.entries(lengths)) {
        expect(value, `${segment} at ${stature} m`).toBeGreaterThan(0);
      }
    }
  });
});

describe('mass properties', () => {
  it('picks up the sex-blended inertial table', () => {
    expect(resolveMorphology({ ...base, sex: 0 }).inertialTable.thigh.relativeMass).toBe(
      DE_LEVA_FEMALE.thigh.relativeMass,
    );
    expect(resolveMorphology({ ...base, sex: 1 }).inertialTable.thigh.relativeMass).toBe(
      DE_LEVA_MALE.thigh.relativeMass,
    );
  });

  it('scales segment mass with body mass', () => {
    const light = massPropertiesFor(resolveMorphology({ ...base, mass: 50 }), 'thigh');
    const heavy = massPropertiesFor(resolveMorphology({ ...base, mass: 100 }), 'thigh');
    expect(heavy.mass / light.mass).toBeCloseTo(2, 10);
  });

  it('produces a valid inertia tensor for every segment', () => {
    const resolved = resolveMorphology(base);
    for (const segment of Object.keys(resolved.segmentLengths) as Array<
      keyof typeof resolved.segmentLengths
    >) {
      const properties = massPropertiesFor(resolved, segment);
      expect(validateInertia(properties.inertia).problems, segment).toEqual([]);
    }
  });

  it('sums the parts to the requested whole-body mass', () => {
    const resolved = resolveMorphology(base);
    expect(wholeBodyMassProperties(resolved).mass).toBeCloseTo(70, 2);
  });

  it('gives a valid whole-body tensor', () => {
    expect(validateInertia(wholeBodyMassProperties(resolveMorphology(base)).inertia).valid).toBe(
      true,
    );
  });
});

describe('physical validity, spec section 6.4 step 5', () => {
  it('accepts a well-formed body', () => {
    const result = validateResolvedBody(resolveMorphology(base));
    expect(result.problems).toEqual([]);
    expect(result.valid).toBe(true);
    // Within the published table's rounding -- see the residual test below.
    expect(result.totalMass).toBeCloseTo(70, 2);
  });

  it('accepts every combination across the supported parameter space', () => {
    // The slider sweep. A body that is valid at the endpoints and impossible in the middle would
    // be close to undiagnosable in use.
    for (const sex of [0, 0.25, 0.5, 0.75, 1]) {
      for (const stature of [1.4, 1.6, 1.8, 2.05]) {
        for (const mass of [40, 70, 120]) {
          const result = validateResolvedBody(resolveMorphology({ sex, stature, mass }));
          expect(result.problems, `sex=${sex} stature=${stature} mass=${mass}`).toEqual([]);
        }
      }
    }
  });

  it('accepts every percentile across the 1st to 99th range', () => {
    for (const sex of [0, 0.5, 1]) {
      for (let p = 0.01; p <= 0.99; p += 0.07) {
        const resolved = resolveMorphology({ sex, percentile: p } as Morphology);
        expect(validateResolvedBody(resolved).problems, `sex=${sex} p=${p.toFixed(2)}`).toEqual([]);
      }
    }
  });

  it('accepts extreme but legal proportion overrides', () => {
    for (const crural of [0.8, 1.0, 1.3]) {
      for (const relativeLegLength of [0.85, 1, 1.15]) {
        const resolved = resolveMorphology({
          ...base,
          proportions: { crural, relativeLegLength },
        });
        expect(validateResolvedBody(resolved).problems, `${crural}/${relativeLegLength}`).toEqual(
          [],
        );
      }
    }
  });

  it('reports total mass and the residual, so neither is quietly absorbed', () => {
    const result = validateResolvedBody(resolveMorphology({ ...base, mass: 95 }));
    expect(result.totalMass).toBeCloseTo(95, 1);
    expect(result.massResidual).toBeCloseTo(result.totalMass - 95, 12);
  });

  it("leaves a residual no larger than the published table's own rounding", () => {
    // de Leva tabulates percentages to two decimal places, so the fractions sum to 1.0000 for the
    // male table and 0.9999 for the female one. The residual is the resolution of the source
    // data, not an arithmetic error -- and renormalizing to hide it would mean altering published
    // values so a check passes.
    for (const sex of [0, 0.5, 1]) {
      const result = validateResolvedBody(resolveMorphology({ ...base, sex }));
      expect(Math.abs(result.massResidual) / 70, `sex=${sex}`).toBeLessThan(2e-4);
      expect(result.valid, `sex=${sex}`).toBe(true);
    }
  });

  it('still catches a transcription error an order of magnitude above the rounding', () => {
    // The tolerance must not be so loose that it stops meaning anything. A single mis-keyed
    // segment mass shifts the sum far beyond what rounding can explain.
    const resolved = resolveMorphology(base);
    const damaged = {
      ...resolved,
      inertialTable: {
        ...resolved.inertialTable,
        thigh: { ...resolved.inertialTable.thigh, relativeMass: 0.1516 },
      },
    };
    const result = validateResolvedBody(damaged);
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/transcription error/);
  });

  it('throws with an explanation from the asserting form', () => {
    expect(() => assertValidBody(resolveMorphology(base))).not.toThrow();
  });

  it('sizes its default tolerance to the published data, not to whatever passes', () => {
    expect(PUBLISHED_MASS_TOLERANCE).toBe(1e-3);
  });
});

describe('driving HSDL expressions', () => {
  it('supplies a context every dimension expression can evaluate against', () => {
    // The join between this package and HSDL: a bone's dimension is an expression, and this is
    // what it resolves against.
    const { context } = resolveMorphology(base);
    expect(evaluate(mul(0.245, param('stature')), context)).toBeCloseTo(0.4165, 10);
    expect(evaluate(param('mass'), context)).toBe(70);
    expect(evaluate(param('biiliacBreadth'), context)).toBeGreaterThan(0);
  });

  it('makes blend expressions respond to the sex parameter', () => {
    const female = resolveMorphology({ ...base, sex: 0 }).context;
    const male = resolveMorphology({ ...base, sex: 1 }).context;
    const pelvisWidth = blend(0.28, 0.26);
    expect(evaluate(pelvisWidth, female)).toBeCloseTo(0.28, 12);
    expect(evaluate(pelvisWidth, male)).toBeCloseTo(0.26, 12);
  });

  it('resolves every parameter an expression might reference', () => {
    // A missing parameter throws at evaluation time, deep inside geometry generation, where the
    // message is least useful. Better to know here that the context is complete.
    const { context } = resolveMorphology(base);
    const required = [
      'sex',
      'stature',
      'mass',
      'percentile',
      'biiliacBreadth',
      'biacromialBreadth',
      'crural',
      'brachial',
      'relativeLegLength',
      'asymmetry',
    ] as const;
    for (const name of required) {
      expect(context[name], name).toBeTypeOf('number');
      expect(Number.isFinite(context[name]), name).toBe(true);
    }
  });
});
