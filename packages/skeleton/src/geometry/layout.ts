/**
 * Skeletal layout: where the joint centres sit in the anatomical neutral pose.
 *
 * Every length here is an expression over morphology parameters, never a fixed number. Spec
 * section 6.4 step 3 requires rest transforms to be computed from dimensions, and a skeleton with
 * absolute offsets would come apart at the joints the moment a slider moved.
 *
 * ## The anatomical neutral pose
 *
 * Standing, feet parallel and slightly apart, arms at the sides, palms facing anteriorly, gaze
 * horizontal. Spec section 5.3: this is the rest definition. A T-pose or an A-pose is a *pose*,
 * never the rest pose.
 *
 * ## Frame
 *
 * The canonical world frame: `+X` is the subject's right, `+Y` is superior, `+Z` is posterior, so
 * anterior is `-Z`. Ground is at `y = 0` and the top of the head is at `y = stature`.
 *
 * ## Where the numbers come from
 *
 * Heights above the ground are Drillis & Contini (1966) fractions of stature, reproduced in
 * Winter (2009) -- the same source the segment proportions come from, so the two agree by
 * construction. Intermediate values not in that table are interpolated within it and recorded as a
 * known simplification rather than presented as measured; see OQ-003 and OQ-004.
 *
 * Vertebral body heights are apportioned so that the column reaches the atlas at the base of the
 * skull, with lumbar bodies taller than thoracic and thoracic taller than cervical, which is the
 * documented ordering.
 */

import { type ScalarExpr, add, mul, param, sub } from '@bs-humany/hsdl';

/** A length expressed as a fraction of standing height. */
export const H = (fraction: number): ScalarExpr => mul(fraction, param('stature'));

/** Half the bi-iliac breadth, which is where the hip joint centres sit either side of the midline. */
export const halfPelvis: ScalarExpr = mul(0.48, param('biiliacBreadth'));

/** Half the biacromial breadth: the shoulder joint centres. */
export const halfShoulders: ScalarExpr = mul(0.46, param('biacromialBreadth'));

/**
 * Heights above the ground, as fractions of stature.
 *
 * `hipHeight`, `kneeHeight`, `ankleHeight` and `shoulderHeight` are Drillis & Contini values.
 * `sacralPromontory` and `atlas` are derived so the vertebral column, built from its per-level
 * body heights below, spans exactly between them.
 */
export const HEIGHT = Object.freeze({
  ankle: 0.039,
  knee: 0.285,
  hip: 0.53,
  sacralPromontory: 0.58,
  shoulder: 0.818,
  atlas: 0.879,
  chin: 0.87,
  vertex: 1.0,
});

/**
 * Vertebral body heights per region, as fractions of stature.
 *
 * Chosen so that five lumbar, twelve thoracic and seven cervical levels carry the column from the
 * sacral promontory at 0.580 to the atlas at 0.879 -- a span of 0.299 -- while keeping the
 * documented ordering that lumbar bodies are tallest and cervical shortest.
 *
 *     5 x 0.0165 + 12 x 0.0125 + 7 x 0.0095 = 0.0825 + 0.1500 + 0.0665 = 0.299
 *
 * The sum is asserted in the tests, so a future edit to any one of them fails rather than silently
 * detaching the skull from the spine.
 */
export const VERTEBRA_HEIGHT = Object.freeze({
  lumbar: 0.0165,
  thoracic: 0.0125,
  cervical: 0.0095,
});

export const VERTEBRA_COUNT = Object.freeze({ lumbar: 5, thoracic: 12, cervical: 7 });

/** Total span of the mobile column, as a fraction of stature. */
export function columnSpan(): number {
  return (
    VERTEBRA_COUNT.lumbar * VERTEBRA_HEIGHT.lumbar +
    VERTEBRA_COUNT.thoracic * VERTEBRA_HEIGHT.thoracic +
    VERTEBRA_COUNT.cervical * VERTEBRA_HEIGHT.cervical
  );
}

/**
 * Vertebral body width, as a fraction of stature, by level.
 *
 * Bodies widen steadily from the cervical spine down to L5, because each carries the weight of
 * everything above it. Modelling that taper is most of what makes a rendered spine read as a spine
 * rather than as a stack of identical blocks.
 */
export function vertebraWidth(region: 'cervical' | 'thoracic' | 'lumbar', index: number): number {
  switch (region) {
    // C1 to C7, narrowest at the top.
    case 'cervical':
      return 0.019 + (index / 7) * 0.004;
    // T1 to T12.
    case 'thoracic':
      return 0.024 + (index / 12) * 0.008;
    // L1 to L5, widest at the base.
    case 'lumbar':
      return 0.033 + (index / 5) * 0.005;
  }
}

/** Segment lengths as expressions, matching the anthropometry package's proportions. */
export const SEGMENT = Object.freeze({
  thigh: mul(param('relativeLegLength'), H(0.245)),
  shank: mul(param('crural'), mul(param('relativeLegLength'), H(0.245))),
  upperArm: H(0.186),
  forearm: mul(param('brachial'), H(0.186)),
  hand: H(0.108),
  footLength: H(0.152),
});

/** Convenience: a translation expression triple. */
export function at(x: ScalarExpr, y: ScalarExpr, z: ScalarExpr) {
  return { x, y, z };
}

/** Mirror an expression for the left side. `_r` is positive X, `_l` is negative. */
export function sided(side: 'l' | 'r', value: ScalarExpr): ScalarExpr {
  return side === 'r' ? value : mul(-1, value);
}

/** Difference between two heights expressed as fractions of stature. */
export function heightDelta(from: number, to: number): ScalarExpr {
  return H(to - from);
}

export { add, sub };
