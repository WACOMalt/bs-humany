/**
 * ANSUR II dimensional reference and percentile scaling.
 *
 * de Leva supplies how mass is *distributed*. This module supplies how long the segments are.
 *
 * ANSUR II (Gordon et al., 2014) is the 2012 US Army anthropometric survey: traditional linear
 * measurements plus 3D body scans over 4,082 male and 1,986 female subjects, sex-separated at
 * source, and US federal government work with no restrictive licensing. It is the right
 * dimensional backbone because it gives the proportions control a **real percentile axis** rather
 * than an invented one.
 *
 * **Population limitation, surfaced in the UI:** ANSUR II sampled US military personnel, who are
 * not representative of the general population in body composition or age distribution. Mean BMI
 * runs well above civilian means. This is a real limitation to state plainly rather than paper
 * over.
 *
 * ## Where the segment proportions come from, and why that is a compromise
 *
 * ANSUR II measures stature, weight and a number of breadths directly. It does **not** publish
 * most segment lengths as such. Those come from Drillis & Contini (1966) -- the origin of the
 * familiar table of segment lengths as fractions of standing height, usually met through Winter's
 * textbook.
 *
 * That table is **not sex-separated**, so the default proportions are currently sex-neutral while
 * the breadths and the stature/mass distributions are not. The model understates real dimorphism
 * in limb proportion as a result. This is tracked as OQ-003 rather than hidden: the `proportions`
 * overrides in `Morphology` exist so a user can correct for it explicitly, and the limitation
 * travels with the data.
 */

import type { TableProvenance } from './provenance.js';

export interface SexReferenceStatistics {
  /** Mean standing height, metres. */
  readonly statureMean: number;
  /** Standard deviation of standing height, metres. */
  readonly statureSd: number;
  /** Mean body mass, kilograms. */
  readonly massMean: number;
  readonly massSd: number;
  /** Shoulder breadth between the acromia, as a fraction of stature. */
  readonly biacromialFraction: number;
  /** Pelvic breadth between the iliac crests, as a fraction of stature. */
  readonly biiliacFraction: number;
}

const ANSUR_POPULATION =
  'US Army personnel measured in 2012 (n=4082 male, n=1986 female). Not representative of the ' +
  'general population in body composition or age distribution: mean BMI runs well above civilian ' +
  'means.';

export const ANSUR_PROVENANCE: TableProvenance = Object.freeze({
  source: 'gordon2014',
  locator: 'Summary statistics, stature and weight by sex',
  status: 'consistency-checked',
  openQuestion: 'OQ-002',
  note:
    'Automated checks confirm the percentile mapping is monotonic, that the median reproduces the ' +
    'tabulated mean, and that implied BMI at the median falls in the range published for this ' +
    'sample. These cannot confirm the means and standard deviations are the published ones.',
  population: ANSUR_POPULATION,
});

export const PROPORTION_PROVENANCE: TableProvenance = Object.freeze({
  source: 'drillis1966',
  locator: 'Segment lengths as fractions of standing height',
  status: 'consistency-checked',
  openQuestion: 'OQ-003',
  note:
    'Automated checks confirm that the limb chain lengths sum to a plausible fraction of stature ' +
    'and that every fraction is positive. NOT sex-separated: the same proportions are applied to ' +
    'both endpoint tables, which understates real dimorphism in limb proportion.',
  population:
    'Not sex-separated, and not stated for a specific population. Reproduced widely via Winter ' +
    '(2009). Treat as a generic adult proportion set, not as a description of any group.',
});

/** Female-typical reference statistics. */
export const ANSUR_FEMALE: SexReferenceStatistics = Object.freeze({
  statureMean: 1.628,
  statureSd: 0.064,
  massMean: 67.6,
  massSd: 11.5,
  biacromialFraction: 0.2,
  biiliacFraction: 0.18,
});

/** Male-typical reference statistics. */
export const ANSUR_MALE: SexReferenceStatistics = Object.freeze({
  statureMean: 1.756,
  statureSd: 0.069,
  massMean: 84.9,
  massSd: 14.3,
  biacromialFraction: 0.225,
  biiliacFraction: 0.166,
});

/**
 * Segment lengths as fractions of standing height.
 *
 * Drillis & Contini (1966). Sex-neutral -- see the module comment and OQ-003.
 *
 * Lengths are between joint centres wherever possible, matching de Leva's convention, so a
 * segment's length means the same thing to both tables. Getting this wrong would put the centre
 * of mass in the wrong place by a few centimetres on every segment.
 */
export interface SegmentProportions {
  /** Greater trochanter to femoral condyle. */
  readonly thigh: number;
  /** Femoral condyle to medial malleolus. */
  readonly shank: number;
  /** Foot length, heel to toe. */
  readonly footLength: number;
  /** Ankle height above the ground. */
  readonly ankleHeight: number;
  /** Acromion to elbow joint centre. */
  readonly upperArm: number;
  /** Elbow joint centre to wrist joint centre. */
  readonly forearm: number;
  /** Wrist joint centre to the tip of the third finger. */
  readonly hand: number;
  /** Vertex to chin. */
  readonly headHeight: number;
  /** Hip joint centre to the shoulder joint centre: the trunk length de Leva references. */
  readonly trunk: number;
  /** Greater trochanter height above the ground, in the standing pose. */
  readonly hipHeight: number;
  /** Acromion height above the ground, in the standing pose. */
  readonly shoulderHeight: number;
}

export const SEGMENT_PROPORTIONS: SegmentProportions = Object.freeze({
  thigh: 0.245,
  shank: 0.246,
  footLength: 0.152,
  ankleHeight: 0.039,
  upperArm: 0.186,
  forearm: 0.146,
  hand: 0.108,
  headHeight: 0.13,
  trunk: 0.288,
  hipHeight: 0.53,
  shoulderHeight: 0.818,
});

/**
 * Inverse standard normal cumulative distribution.
 *
 * Turns a percentile in (0, 1) into a z-score, so `percentile` can drive stature and mass along
 * the ANSUR II distributions. Acklam's rational approximation, accurate to about 1.15e-9 in
 * relative error across the whole range -- far beyond what anthropometry needs, and cheap.
 *
 * Written out rather than pulled in as a dependency: it is thirty lines, it must be deterministic,
 * and CONTRIBUTING rule 1 asks for a reason before adding a package.
 */
export function inverseNormalCdf(percentile: number): number {
  if (!(percentile > 0 && percentile < 1)) {
    throw new Error(
      `Percentile must be strictly between 0 and 1, got ${percentile}. The normal distribution ` +
        'has no finite 0th or 100th percentile.',
    );
  }

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ] as const;
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ] as const;
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ] as const;
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
  ] as const;

  const lower = 0.02425;
  const upper = 1 - lower;

  if (percentile < lower) {
    const q = Math.sqrt(-2 * Math.log(percentile));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (percentile > upper) {
    const q = Math.sqrt(-2 * Math.log(1 - percentile));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = percentile - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/** Blend the two reference statistics tables by the sex parameter. */
export function blendReference(sex: number): SexReferenceStatistics {
  if (!(sex >= 0 && sex <= 1)) {
    throw new Error(`sex must be in [0, 1], got ${sex}.`);
  }
  const mix = (female: number, male: number) => female + (male - female) * sex;
  return Object.freeze({
    statureMean: mix(ANSUR_FEMALE.statureMean, ANSUR_MALE.statureMean),
    statureSd: mix(ANSUR_FEMALE.statureSd, ANSUR_MALE.statureSd),
    massMean: mix(ANSUR_FEMALE.massMean, ANSUR_MALE.massMean),
    massSd: mix(ANSUR_FEMALE.massSd, ANSUR_MALE.massSd),
    biacromialFraction: mix(ANSUR_FEMALE.biacromialFraction, ANSUR_MALE.biacromialFraction),
    biiliacFraction: mix(ANSUR_FEMALE.biiliacFraction, ANSUR_MALE.biiliacFraction),
  });
}

export interface PercentileResult {
  readonly stature: number;
  readonly mass: number;
}

/**
 * Stature and mass at a percentile of the blended distribution.
 *
 * Normal approximation. Stature is close to normal in this sample; body mass is right-skewed, so
 * the approximation understates the upper tail. Recorded here rather than silently accepted -- a
 * user asking for the 99th percentile is getting a slightly light answer, and that is the kind of
 * thing that should be findable.
 */
export function atPercentile(sex: number, percentile: number): PercentileResult {
  const reference = blendReference(sex);
  const z = inverseNormalCdf(percentile);
  return {
    stature: reference.statureMean + z * reference.statureSd,
    mass: reference.massMean + z * reference.massSd,
  };
}

/** Where a given stature sits in the blended distribution, as a percentile in (0, 1). */
export function staturePercentile(sex: number, stature: number): number {
  const reference = blendReference(sex);
  const z = (stature - reference.statureMean) / reference.statureSd;
  return normalCdf(z);
}

/** Standard normal cumulative distribution, via the complementary error function. */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

/**
 * Complementary error function.
 *
 * Numerical Recipes' Chebyshev approximation, relative error below 1.2e-7 -- ample for placing a
 * body in a percentile distribution.
 */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;

  const coefficients = [
    -1.3026537197817094, 6.419697923564902e-1, 1.9476473204185836e-2, -9.561514786808631e-3,
    -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
    -1.624290004647e-6, 1.30365583558e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
    5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11, 2.394038e-12, -6.886027e-12,
    8.94487e-13, 3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15,
  ] as const;

  let d = 0;
  let dd = 0;
  for (let j = coefficients.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + (coefficients[j] ?? 0);
    dd = tmp;
  }
  const answer = t * Math.exp(-z * z + 0.5 * ((coefficients[0] ?? 0) + ty * d) - dd);
  return x >= 0 ? answer : 2 - answer;
}
