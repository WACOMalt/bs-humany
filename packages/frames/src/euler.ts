/**
 * Euler and Tait-Bryan angle sequences, with the order always explicit.
 *
 * HSDL models joints as ordered lists of single degrees of freedom, not as Euler triplets -- that
 * is the whole point of the per-DoF decomposition, and it is what avoids the order ambiguity that
 * composite joint types smuggle in. So nothing in the simulation path uses this module.
 *
 * It exists for **reporting**: the ISB recommendations define joint angles as specific rotation
 * sequences, and a joint angle is only comparable to published literature if it is decomposed the
 * same way the literature decomposed it. The inspector panel, the joint-sweep validation report
 * and the external-validation harness all need that, so the decomposition lives here, tested,
 * rather than being improvised at three call sites.
 *
 * All sequences are **intrinsic** (body-fixed, each rotation about the axis moved by the previous
 * one), which is what ISB uses. An extrinsic sequence is the same code with the order reversed.
 */

import { clamp } from './angles.js';
import { EPSILON } from './constants.js';
import { type Mat3, at, mat3FromQuat } from './mat3.js';
import { type Quat, fromAxisAngle, multiplyQuat } from './quat.js';
import { UNIT_X, UNIT_Y, UNIT_Z, type Vec3 } from './vec3.js';

/**
 * A three-character intrinsic rotation order.
 *
 * Orders with three distinct axes (`xyz`, `zxy`, ...) are Tait-Bryan. Orders whose first and third
 * axes repeat (`zxz`, `yxy`, ...) are proper Euler, and are what ISB recommends for ball joints
 * such as the glenohumeral, because they place the singularity where the joint does not go.
 */
export type EulerOrder =
  | 'xyz'
  | 'xzy'
  | 'yxz'
  | 'yzx'
  | 'zxy'
  | 'zyx'
  | 'xyx'
  | 'xzx'
  | 'yxy'
  | 'yzy'
  | 'zxz'
  | 'zyz';

export interface EulerAngles {
  /** Rotation about the first axis of the order, radians. */
  readonly first: number;
  /** Rotation about the second axis, radians. */
  readonly second: number;
  /** Rotation about the third axis, radians. */
  readonly third: number;
  readonly order: EulerOrder;
  /**
   * True when the second angle sat at a singularity, so the first and third rotations act about
   * the same axis and cannot be told apart. The decomposition then reports `third = 0` and folds
   * the whole rotation into `first`.
   *
   * This flag MUST be surfaced rather than swallowed. A joint angle silently reported at a
   * singularity is a number that looks fine and means nothing.
   */
  readonly gimbalLock: boolean;
}

const AXIS_INDEX: Readonly<Record<string, 0 | 1 | 2>> = Object.freeze({ x: 0, y: 1, z: 2 });
const AXIS_VECTOR: Readonly<Record<0 | 1 | 2, Vec3>> = Object.freeze({
  0: UNIT_X,
  1: UNIT_Y,
  2: UNIT_Z,
});

function axisIndices(order: EulerOrder): readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2] {
  const a = AXIS_INDEX[order[0] ?? ''];
  const b = AXIS_INDEX[order[1] ?? ''];
  const c = AXIS_INDEX[order[2] ?? ''];
  if (a === undefined || b === undefined || c === undefined) {
    throw new Error(`Invalid Euler order '${order}'.`);
  }
  if (a === b || b === c) {
    throw new Error(
      `Invalid Euler order '${order}': consecutive axes must differ. ` +
        'A repeated adjacent axis is a degenerate sequence, not a rotation decomposition.',
    );
  }
  return [a, b, c];
}

/**
 * Sign of the permutation. `+1` when the axis triple is a cyclic permutation of (x, y, z),
 * `-1` otherwise. This is the term that keeps the generic extraction formulae correct for all
 * twelve orders instead of just the one they were derived from.
 */
function permutationSign(i: 0 | 1 | 2, j: 0 | 1 | 2, k: 0 | 1 | 2): 1 | -1 {
  return (j - i + 3) % 3 === 1 && (k - j + 3) % 3 === 1 ? 1 : -1;
}

/** The axis not used by `i` or `j`. */
function thirdAxis(i: 0 | 1 | 2, j: 0 | 1 | 2): 0 | 1 | 2 {
  return (3 - i - j) as 0 | 1 | 2;
}

/** Compose an intrinsic sequence into a quaternion. */
export function quatFromEuler(
  first: number,
  second: number,
  third: number,
  order: EulerOrder,
): Quat {
  const [i, j, k] = axisIndices(order);
  const q1 = fromAxisAngle(AXIS_VECTOR[i], first);
  const q2 = fromAxisAngle(AXIS_VECTOR[j], second);
  const q3 = fromAxisAngle(AXIS_VECTOR[k], third);
  // Intrinsic composition: each rotation is about the axis as already moved by those before it,
  // which is left-to-right multiplication.
  return multiplyQuat(multiplyQuat(q1, q2), q3);
}

/** Decompose a rotation matrix into an intrinsic sequence. */
export function eulerFromMat3(m: Mat3, order: EulerOrder): EulerAngles {
  const [i, j, k] = axisIndices(order);
  const isProperEuler = i === k;

  if (isProperEuler) {
    // Sequence i-j-i. The spare axis completes the triple.
    const spare = thirdAxis(i, j);
    const sign = permutationSign(i, j, spare);

    const cosSecond = clamp(at(m, i, i), -1, 1);
    const second = Math.acos(cosSecond);

    if (Math.abs(Math.sin(second)) < EPSILON) {
      // Degenerate: first and third act about the same axis. Fold into `first`.
      return {
        first: Math.atan2(sign * at(m, spare, j), at(m, j, j)),
        second,
        third: 0,
        order,
        gimbalLock: true,
      };
    }

    return {
      first: Math.atan2(at(m, j, i), -sign * at(m, spare, i)),
      second,
      third: Math.atan2(at(m, i, j), sign * at(m, i, spare)),
      order,
      gimbalLock: false,
    };
  }

  // Tait-Bryan sequence i-j-k, all axes distinct.
  const sign = permutationSign(i, j, k);
  const sinSecond = clamp(sign * at(m, i, k), -1, 1);
  const second = Math.asin(sinSecond);

  if (Math.abs(Math.abs(sinSecond) - 1) < EPSILON) {
    // Degenerate: the second rotation has swung the third axis onto the first, so only the sum or
    // difference of the outer two angles is observable. Fold it all into `first`.
    //
    // Note there is deliberately no permutation-sign factor here, unlike the general branch above.
    // `sinSecond` already carries it, and applying it twice flips the recovered angle for the
    // anti-cyclic orders (xzy, yxz, zyx) while leaving the cyclic ones looking correct -- which is
    // exactly the kind of half-right bug that survives a spot check.
    return {
      first: Math.atan2(sinSecond * at(m, j, i), at(m, j, j)),
      second,
      third: 0,
      order,
      gimbalLock: true,
    };
  }

  return {
    first: Math.atan2(-sign * at(m, j, k), at(m, k, k)),
    second,
    third: Math.atan2(-sign * at(m, i, j), at(m, i, i)),
    order,
    gimbalLock: false,
  };
}

/** Decompose a quaternion into an intrinsic sequence. */
export function eulerFromQuat(q: Quat, order: EulerOrder): EulerAngles {
  return eulerFromMat3(mat3FromQuat(q), order);
}

/**
 * ISB-recommended decomposition orders, by joint.
 *
 * These are the sequences the literature uses, so a value reported in any other order is not
 * comparable to a published range of motion even when the underlying rotation is identical. Joint
 * definitions in HSDL carry their own reporting order; this table is the default and the
 * cross-check.
 *
 * Source: Wu et al. (2002) for ankle, hip and spine; Wu et al. (2005) for shoulder, elbow, wrist
 * and hand.
 */
export const ISB_REPORTING_ORDER = Object.freeze({
  /** Wu 2002. Flexion/extension, adduction/abduction, internal/external rotation. */
  hip: 'zxy' as EulerOrder,
  /** Wu 2002. Same sequence as the hip. */
  knee: 'zxy' as EulerOrder,
  /** Wu 2002. Dorsiflexion/plantarflexion, inversion/eversion, adduction/abduction. */
  ankle: 'zxy' as EulerOrder,
  /** Wu 2002. Lateral bending, flexion/extension, axial rotation, per vertebral level. */
  spine: 'zxy' as EulerOrder,
  /**
   * Wu 2005. Plane of elevation, elevation, axial rotation.
   *
   * A proper Euler sequence, chosen so the singularity sits at the pole -- arm straight overhead
   * -- rather than in the middle of everyday range. Decomposing the glenohumeral joint with a
   * Tait-Bryan order puts a singularity somewhere the arm actually goes, and the reported angle
   * jumps there.
   */
  glenohumeral: 'yxy' as EulerOrder,
  /** Wu 2005. Flexion/extension, carrying angle, pronation/supination. */
  elbow: 'zxy' as EulerOrder,
  /** Wu 2005. Flexion/extension, radial/ulnar deviation, pronation/supination. */
  wrist: 'zxy' as EulerOrder,
});
