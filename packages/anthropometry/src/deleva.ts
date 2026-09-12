/**
 * de Leva (1996) segment inertial parameters.
 *
 * The load-bearing citation for mass distribution. de Leva adjusted Zatsiorsky-Seluyanov's
 * gamma-ray scanning results so that they are referenced to **joint centres** rather than to the
 * skin landmarks of the original study, and published complete, parallel male and female tables.
 *
 * That parallel structure is what makes the sex parameter (spec section 6.2) a real biomechanical
 * parameterization rather than a cosmetic scale factor: there are two genuine endpoint tables to
 * blend between, not one table and a multiplier.
 *
 * Three quantities per segment, all dimensionless:
 *   - **relative mass** as a fraction of total body mass;
 *   - **centre of mass** as a fraction of segment length from the proximal joint centre;
 *   - **radii of gyration** about the three principal axes, as fractions of segment length.
 *
 * Source: de Leva, P. (1996). Adjustments to Zatsiorsky-Seluyanov's segment inertia parameters.
 * Journal of Biomechanics 29(9), 1223-1230. Table 4.
 *
 * **Population limitation, surfaced in the UI:** the underlying sample is college-aged Caucasian
 * adults (100 male, 15 female). This is not a universal human norm, and the female table in
 * particular rests on a small sample.
 */

import type { TableProvenance } from './provenance.js';

/**
 * The segments de Leva parameterizes.
 *
 * Note these are *de Leva's* segments, not this project's dynamic segments. A fidelity profile
 * that lumps several of them into one rigid body combines their parameters through the
 * parallel-axis theorem; one that splits a segment finer than de Leva does must distribute rather
 * than invent. The mapping lives in the segmentation compiler, not here.
 */
export type DeLevaSegment =
  | 'head'
  | 'trunk'
  | 'upperTrunk'
  | 'midTrunk'
  | 'lowerTrunk'
  | 'upperArm'
  | 'forearm'
  | 'hand'
  | 'thigh'
  | 'shank'
  | 'foot';

export interface RadiiOfGyration {
  /** About the medio-lateral axis: the axis flexion and extension turn about. */
  readonly sagittal: number;
  /** About the antero-posterior axis: the axis abduction and adduction turn about. */
  readonly transverse: number;
  /** About the segment's own long axis: the axis internal and external rotation turn about. */
  readonly longitudinal: number;
}

export interface SegmentInertialParameters {
  /** Fraction of total body mass, 0..1. */
  readonly relativeMass: number;
  /** Centre of mass as a fraction of segment length from the proximal joint centre, 0..1. */
  readonly comFromProximal: number;
  /** Radii of gyration as fractions of segment length. */
  readonly radiiOfGyration: RadiiOfGyration;
}

export type DeLevaTable = Readonly<Record<DeLevaSegment, SegmentInertialParameters>>;

/**
 * Segments that are counted once (`1`) or once per side (`2`) when summing body mass.
 *
 * Used by the consistency check below. `trunk` is excluded from the sum because it is the total of
 * the three trunk sub-segments -- counting both would double the torso.
 */
export const SEGMENT_MULTIPLICITY: Readonly<Record<DeLevaSegment, number>> = Object.freeze({
  head: 1,
  trunk: 0,
  upperTrunk: 1,
  midTrunk: 1,
  lowerTrunk: 1,
  upperArm: 2,
  forearm: 2,
  hand: 2,
  thigh: 2,
  shank: 2,
  foot: 2,
});

const POPULATION =
  'College-aged Caucasian adults: 100 male, 15 female. Not a universal human norm. The female ' +
  'table rests on a notably small sample and should be described as such wherever it is used.';

const CONSISTENCY_NOTE =
  'Automated checks confirm that segment masses sum to total body mass, that the three trunk ' +
  'sub-segments decompose the trunk, that every centre of mass falls inside its segment, and ' +
  'that every derived inertia tensor satisfies the triangle inequality. These catch a transposed ' +
  'digit that breaks an invariant. They CANNOT catch a value that is internally consistent and ' +
  'simply not what the paper says, so this table is not yet fit for a measurement run.';

export const DE_LEVA_PROVENANCE: TableProvenance = Object.freeze({
  source: 'deleva1996',
  locator: 'Table 4, adjusted parameters referenced to joint centres',
  status: 'consistency-checked',
  openQuestion: 'OQ-001',
  note: CONSISTENCY_NOTE,
  population: POPULATION,
});

/**
 * Female-typical endpoint table. Fractions, not percentages -- the paper tabulates percentages,
 * and they are divided by 100 here so the data model carries pure ratios.
 */
export const DE_LEVA_FEMALE: DeLevaTable = Object.freeze({
  head: {
    relativeMass: 0.0668,
    comFromProximal: 0.5894,
    radiiOfGyration: { sagittal: 0.33, transverse: 0.359, longitudinal: 0.318 },
  },
  trunk: {
    relativeMass: 0.4257,
    comFromProximal: 0.4151,
    radiiOfGyration: { sagittal: 0.357, transverse: 0.339, longitudinal: 0.171 },
  },
  upperTrunk: {
    relativeMass: 0.1545,
    comFromProximal: 0.2077,
    radiiOfGyration: { sagittal: 0.746, transverse: 0.502, longitudinal: 0.718 },
  },
  midTrunk: {
    relativeMass: 0.1465,
    comFromProximal: 0.4512,
    radiiOfGyration: { sagittal: 0.433, transverse: 0.354, longitudinal: 0.415 },
  },
  lowerTrunk: {
    relativeMass: 0.1247,
    comFromProximal: 0.492,
    radiiOfGyration: { sagittal: 0.433, transverse: 0.402, longitudinal: 0.444 },
  },
  upperArm: {
    relativeMass: 0.0255,
    comFromProximal: 0.5754,
    radiiOfGyration: { sagittal: 0.278, transverse: 0.26, longitudinal: 0.148 },
  },
  forearm: {
    relativeMass: 0.0138,
    comFromProximal: 0.4559,
    radiiOfGyration: { sagittal: 0.261, transverse: 0.257, longitudinal: 0.094 },
  },
  hand: {
    relativeMass: 0.0056,
    comFromProximal: 0.7474,
    radiiOfGyration: { sagittal: 0.531, transverse: 0.454, longitudinal: 0.335 },
  },
  thigh: {
    relativeMass: 0.1478,
    comFromProximal: 0.3612,
    radiiOfGyration: { sagittal: 0.369, transverse: 0.364, longitudinal: 0.162 },
  },
  shank: {
    relativeMass: 0.0481,
    comFromProximal: 0.4416,
    radiiOfGyration: { sagittal: 0.271, transverse: 0.267, longitudinal: 0.093 },
  },
  foot: {
    relativeMass: 0.0129,
    comFromProximal: 0.4014,
    radiiOfGyration: { sagittal: 0.299, transverse: 0.279, longitudinal: 0.139 },
  },
});

/** Male-typical endpoint table. */
export const DE_LEVA_MALE: DeLevaTable = Object.freeze({
  head: {
    relativeMass: 0.0694,
    comFromProximal: 0.5976,
    radiiOfGyration: { sagittal: 0.362, transverse: 0.376, longitudinal: 0.312 },
  },
  trunk: {
    relativeMass: 0.4346,
    comFromProximal: 0.4486,
    radiiOfGyration: { sagittal: 0.372, transverse: 0.347, longitudinal: 0.191 },
  },
  upperTrunk: {
    relativeMass: 0.1596,
    comFromProximal: 0.2999,
    radiiOfGyration: { sagittal: 0.716, transverse: 0.454, longitudinal: 0.659 },
  },
  midTrunk: {
    relativeMass: 0.1633,
    comFromProximal: 0.4502,
    radiiOfGyration: { sagittal: 0.482, transverse: 0.383, longitudinal: 0.468 },
  },
  lowerTrunk: {
    relativeMass: 0.1117,
    comFromProximal: 0.6115,
    radiiOfGyration: { sagittal: 0.615, transverse: 0.551, longitudinal: 0.587 },
  },
  upperArm: {
    relativeMass: 0.0271,
    comFromProximal: 0.5772,
    radiiOfGyration: { sagittal: 0.285, transverse: 0.269, longitudinal: 0.158 },
  },
  forearm: {
    relativeMass: 0.0162,
    comFromProximal: 0.4574,
    radiiOfGyration: { sagittal: 0.276, transverse: 0.265, longitudinal: 0.121 },
  },
  hand: {
    relativeMass: 0.0061,
    comFromProximal: 0.79,
    radiiOfGyration: { sagittal: 0.628, transverse: 0.513, longitudinal: 0.401 },
  },
  thigh: {
    relativeMass: 0.1416,
    comFromProximal: 0.4095,
    radiiOfGyration: { sagittal: 0.329, transverse: 0.329, longitudinal: 0.149 },
  },
  shank: {
    relativeMass: 0.0433,
    comFromProximal: 0.4459,
    radiiOfGyration: { sagittal: 0.255, transverse: 0.249, longitudinal: 0.103 },
  },
  foot: {
    relativeMass: 0.0137,
    comFromProximal: 0.4415,
    radiiOfGyration: { sagittal: 0.257, transverse: 0.245, longitudinal: 0.124 },
  },
});

export const DE_LEVA_SEGMENTS: readonly DeLevaSegment[] = Object.freeze(
  Object.keys(DE_LEVA_MALE) as DeLevaSegment[],
);

/**
 * Blend the two endpoint tables.
 *
 * Spec section 6.2: interpolation is linear in the parameter and is performed on the **derived
 * scalar parameters**, never on geometry. `sex` 0 is female-typical, 1 is male-typical.
 *
 * See `SEX_PARAMETER_NOTE` in `@bs-humany/hsdl` before putting a UI control on this: an
 * intermediate blend is a modelling convenience for exploring the parameter space, not a
 * description of any real population.
 */
export function blendDeLeva(sex: number): DeLevaTable {
  if (!(sex >= 0 && sex <= 1)) {
    throw new Error(`sex must be in [0, 1], got ${sex}.`);
  }
  const mix = (female: number, male: number) => female + (male - female) * sex;

  const out = {} as Record<DeLevaSegment, SegmentInertialParameters>;
  for (const segment of DE_LEVA_SEGMENTS) {
    const f = DE_LEVA_FEMALE[segment];
    const m = DE_LEVA_MALE[segment];
    out[segment] = {
      relativeMass: mix(f.relativeMass, m.relativeMass),
      comFromProximal: mix(f.comFromProximal, m.comFromProximal),
      radiiOfGyration: {
        sagittal: mix(f.radiiOfGyration.sagittal, m.radiiOfGyration.sagittal),
        transverse: mix(f.radiiOfGyration.transverse, m.radiiOfGyration.transverse),
        longitudinal: mix(f.radiiOfGyration.longitudinal, m.radiiOfGyration.longitudinal),
      },
    };
  }
  return Object.freeze(out);
}

/**
 * Sum of segment masses as a fraction of body mass.
 *
 * Should be 1. The trunk entry is excluded via `SEGMENT_MULTIPLICITY` because it is the total of
 * the three trunk sub-segments; counting both would double the torso.
 */
export function totalRelativeMass(table: DeLevaTable): number {
  let total = 0;
  for (const segment of DE_LEVA_SEGMENTS) {
    total += table[segment].relativeMass * (SEGMENT_MULTIPLICITY[segment] ?? 0);
  }
  return total;
}
