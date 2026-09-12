/**
 * The morphology solver.
 *
 * Turns a handful of user-facing parameters -- sex blend, stature, mass, an optional percentile --
 * into the full set of resolved scalars that HSDL dimension expressions evaluate against, and then
 * into segment mass properties.
 *
 * Spec section 6.4 lays out the order, and the order matters:
 *
 *   1. Resolve morphology parameters, filling defaults from `sex` and `stature`.
 *   2. Compute bone dimensions by evaluating the HSDL dimension expressions.
 *   3. Compute rest transforms from dimensions. **Joint centres follow from bone geometry, not the
 *      reverse** -- a joint centre authored independently of the bones it connects will drift away
 *      from them as morphology changes.
 *   4. Compute segment mass properties from de Leva, combining lumped segments by the
 *      parallel-axis theorem.
 *   5. Validate. This is a required test, not an optional check.
 *
 * Step 5 is where a physically impossible body gets caught. A negative dimension, a mass that does
 * not add up, or an inertia tensor violating the triangle inequality all produce a simulation that
 * runs and is wrong, which is the failure mode this project exists to avoid.
 */

import type { Morphology } from '@bs-humany/hsdl';
import type { ExprContext, MorphologyParam } from '@bs-humany/hsdl';
import {
  SEGMENT_PROPORTIONS,
  type SegmentProportions,
  atPercentile,
  blendReference,
} from './ansur.js';
import { type DeLevaSegment, type DeLevaTable, blendDeLeva, totalRelativeMass } from './deleva.js';
import {
  type MassProperties,
  combineMassProperties,
  segmentMassProperties,
  validateInertia,
} from './inertia.js';

/** Everything the solver derived, ready to drive expression evaluation and inertia computation. */
export interface ResolvedMorphology {
  /** The input, with every optional field filled in. */
  readonly input: Required<Pick<Morphology, 'sex' | 'stature' | 'mass'>> & Morphology;
  /** Values an HSDL `ScalarExpr` may reference. */
  readonly context: ExprContext;
  /** Segment lengths in metres, derived from proportions and stature. */
  readonly segmentLengths: Readonly<Record<DeLevaSegment, number>>;
  /** The sex-blended de Leva table used for mass properties. */
  readonly inertialTable: DeLevaTable;
  /** Proportions actually used, after applying any overrides. */
  readonly proportions: SegmentProportions;
}

/**
 * Fill in every optional morphology parameter.
 *
 * `percentile`, when given, supplies stature and mass together -- it is the convenience input that
 * moves the whole body along the ANSUR II distribution at once. Explicit `stature` or `mass` win
 * over it, so a user can pin one and let the other follow the distribution.
 */
export function resolveMorphology(input: Morphology): ResolvedMorphology {
  const { sex } = input;
  if (!(sex >= 0 && sex <= 1)) {
    throw new Error(`Morphology sex must be in [0, 1], got ${sex}.`);
  }

  const fromPercentile =
    input.percentile === undefined
      ? undefined
      : atPercentile(sex, clampPercentile(input.percentile));

  const stature = input.stature ?? fromPercentile?.stature;
  const mass = input.mass ?? fromPercentile?.mass;

  if (stature === undefined || !(stature > 0)) {
    throw new Error(
      `Morphology needs a positive stature, got ${stature}. Supply 'stature' directly, or a ` +
        "'percentile' for it to be derived from.",
    );
  }
  if (mass === undefined || !(mass > 0)) {
    throw new Error(
      `Morphology needs a positive mass, got ${mass}. Supply 'mass' directly, or a 'percentile' ` +
        'for it to be derived from.',
    );
  }

  const reference = blendReference(sex);
  const overrides = input.proportions ?? {};

  // Crural and brachial indices are ratios, so an override rescales the distal segment while
  // leaving the proximal one alone. That is what those indices mean: shank relative to thigh,
  // forearm relative to upper arm.
  const baseCrural = SEGMENT_PROPORTIONS.shank / SEGMENT_PROPORTIONS.thigh;
  const baseBrachial = SEGMENT_PROPORTIONS.forearm / SEGMENT_PROPORTIONS.upperArm;
  const crural = overrides.crural ?? baseCrural;
  const brachial = overrides.brachial ?? baseBrachial;
  const relativeLegLength = overrides.relativeLegLength ?? 1;

  const proportions: SegmentProportions = Object.freeze({
    ...SEGMENT_PROPORTIONS,
    thigh: SEGMENT_PROPORTIONS.thigh * relativeLegLength,
    shank: SEGMENT_PROPORTIONS.thigh * relativeLegLength * crural,
    upperArm: SEGMENT_PROPORTIONS.upperArm,
    forearm: SEGMENT_PROPORTIONS.upperArm * brachial,
  });

  const biacromialBreadth = overrides.biacromialBreadth ?? reference.biacromialFraction * stature;
  const biiliacBreadth = overrides.biiliacBreadth ?? reference.biiliacFraction * stature;

  const context: Readonly<Record<MorphologyParam, number>> = Object.freeze({
    sex,
    stature,
    mass,
    percentile: input.percentile ?? 0.5,
    biiliacBreadth,
    biacromialBreadth,
    crural,
    brachial,
    relativeLegLength,
    asymmetry: input.asymmetry ?? 0,
  });

  return {
    input: { ...input, sex, stature, mass },
    context,
    segmentLengths: deriveSegmentLengths(proportions, stature),
    inertialTable: blendDeLeva(sex),
    proportions,
  };
}

function clampPercentile(percentile: number): number {
  // The normal distribution has no finite 0th or 100th percentile, so a slider pinned to an end
  // resolves to the nearest representable value rather than throwing at the user.
  return Math.min(0.999, Math.max(0.001, percentile));
}

/**
 * Segment lengths in metres.
 *
 * de Leva's parameters are fractions of segment length, so these must mean the same thing his do:
 * distances between joint centres wherever possible. Getting the convention wrong would misplace
 * every centre of mass by a few centimetres.
 */
export function deriveSegmentLengths(
  proportions: SegmentProportions,
  stature: number,
): Readonly<Record<DeLevaSegment, number>> {
  const trunk = proportions.trunk * stature;
  return Object.freeze({
    head: proportions.headHeight * stature,
    trunk,
    // de Leva subdivides the trunk into three stacked regions. Splitting the measured trunk length
    // evenly is an approximation; the alternative would be to invent three separate lengths, which
    // is worse. Recorded as a known simplification rather than presented as measured.
    upperTrunk: trunk / 3,
    midTrunk: trunk / 3,
    lowerTrunk: trunk / 3,
    upperArm: proportions.upperArm * stature,
    forearm: proportions.forearm * stature,
    hand: proportions.hand * stature,
    thigh: proportions.thigh * stature,
    shank: proportions.shank * stature,
    foot: proportions.footLength * stature,
  });
}

/** Mass properties for one de Leva segment of a resolved body. */
export function massPropertiesFor(
  resolved: ResolvedMorphology,
  segment: DeLevaSegment,
): MassProperties {
  return segmentMassProperties(
    resolved.inertialTable[segment],
    resolved.input.mass,
    resolved.segmentLengths[segment],
  );
}

export interface BodyValidation {
  readonly valid: boolean;
  readonly problems: readonly string[];
  /** Sum of all segment masses, kg. */
  readonly totalMass: number;
  /**
   * Signed difference between the summed segment masses and the requested body mass, kg.
   *
   * This is **not** zero, and it is not a bug. See `PUBLISHED_MASS_TOLERANCE`. It is reported so
   * the discrepancy is visible in a validation report rather than being quietly absorbed.
   */
  readonly massResidual: number;
}

/**
 * Relative tolerance on total body mass.
 *
 * de Leva tabulates relative segment masses as percentages to two decimal places, so each value
 * carries up to 5e-5 of rounding. Summed over eleven segments, several counted twice, the
 * fractions come to 1.0000 for the male table and 0.9999 for the female one rather than to exactly
 * 1. A 70 kg female-typical body therefore resolves to 69.993 kg.
 *
 * That residual is the **resolution of the published data**, not an error in the arithmetic, and
 * the right response is to size the tolerance to it rather than to renormalize. Renormalizing
 * would mean silently altering published values so a check passes -- which is precisely the habit
 * CONTRIBUTING rule 2 exists to prevent, applied to data instead of to a golden hash.
 *
 * 1e-3 leaves roughly an order of magnitude of headroom over the observed residual, so it still
 * catches a real transcription error: a single mis-keyed segment mass would shift the sum far
 * further than rounding can.
 */
export const PUBLISHED_MASS_TOLERANCE = 1e-3;

/**
 * Spec section 6.4 step 5.
 *
 * Checks that the resolved body is physically possible before anything is handed to a solver:
 * total mass matches the target, every dimension is positive and finite, and every segment's
 * inertia tensor is valid. A body that fails here would still simulate. It would simply be wrong.
 */
export function validateResolvedBody(
  resolved: ResolvedMorphology,
  massTolerance = PUBLISHED_MASS_TOLERANCE,
): BodyValidation {
  const problems: string[] = [];

  const relativeSum = totalRelativeMass(resolved.inertialTable);
  const totalMass = relativeSum * resolved.input.mass;
  const massResidual = totalMass - resolved.input.mass;

  if (Math.abs(massResidual) > massTolerance * resolved.input.mass) {
    problems.push(
      `Total segment mass ${totalMass.toFixed(4)} kg differs from the requested ` +
        `${resolved.input.mass} kg by ${massResidual.toFixed(4)} kg, which exceeds the ` +
        `${(massTolerance * 100).toFixed(1)}% tolerance. Segment mass fractions sum to ` +
        `${relativeSum.toFixed(6)}. Rounding in the published table accounts for about 1e-4; a ` +
        'discrepancy larger than that points at a transcription error in one segment.',
    );
  }

  for (const [segment, length] of Object.entries(resolved.segmentLengths)) {
    if (!Number.isFinite(length) || length <= 0) {
      problems.push(`Segment '${segment}' has non-positive or non-finite length ${length} m.`);
    }
  }

  for (const [key, value] of Object.entries(resolved.context)) {
    if (value !== undefined && !Number.isFinite(value)) {
      problems.push(`Morphology parameter '${key}' resolved to ${value}.`);
    }
  }

  for (const segment of Object.keys(resolved.segmentLengths) as DeLevaSegment[]) {
    const length = resolved.segmentLengths[segment];
    if (!Number.isFinite(length) || length <= 0) continue;
    const properties = massPropertiesFor(resolved, segment);
    const inertia = validateInertia(properties.inertia);
    if (!inertia.valid) {
      problems.push(`Segment '${segment}': ${inertia.problems.join(' ')}`);
    }
  }

  return { valid: problems.length === 0, problems, totalMass, massResidual };
}

/** Throwing form, for model build. */
export function assertValidBody(resolved: ResolvedMorphology): void {
  const result = validateResolvedBody(resolved);
  if (!result.valid) {
    throw new Error(
      `Resolved body is not physically valid:\n  ${result.problems.join('\n  ')}\n` +
        'A body failing these checks would still simulate. It would simply be wrong.',
    );
  }
}

/**
 * Whole-body mass properties, for the centre-of-mass readout and the ballistic-trajectory
 * plausibility assertion.
 *
 * Each segment is placed along a vertical stack at its own length, which is a crude standing pose
 * and enough for a whole-body total. Real per-bone placement comes from the skeleton's rest
 * transforms; this is the sanity check that the parts add up to the whole.
 */
export function wholeBodyMassProperties(resolved: ResolvedMorphology): MassProperties {
  const contributions: MassProperties[] = [];
  const counts: ReadonlyArray<readonly [DeLevaSegment, number]> = [
    ['head', 1],
    ['upperTrunk', 1],
    ['midTrunk', 1],
    ['lowerTrunk', 1],
    ['upperArm', 2],
    ['forearm', 2],
    ['hand', 2],
    ['thigh', 2],
    ['shank', 2],
    ['foot', 2],
  ];

  for (const [segment, count] of counts) {
    const single = massPropertiesFor(resolved, segment);
    for (let i = 0; i < count; i++) contributions.push(single);
  }

  return combineMassProperties(contributions);
}
