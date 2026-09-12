/**
 * Building orthonormal frames from anatomical landmarks.
 *
 * The ISB recommendations define every segment and joint coordinate system the same way: name an
 * origin landmark, name a primary axis as the direction between two landmarks, then name a
 * reference direction that fixes the roll about that primary axis. The third axis follows from the
 * cross product.
 *
 * That recipe is implemented once, here. Bone frames are then *data* -- three landmark names and
 * an axis assignment -- rather than nine hand-authored numbers per bone, across ~206 bones. Data
 * can be reviewed against the publication it came from; hand-authored matrices cannot.
 *
 * See ADR-009 and CONTRIBUTING section 11: landmark positions must come from cited textual
 * sources, never from clicking on mesh geometry.
 */

import { MIN_DIRECTION_LENGTH } from './constants.js';
import { type Mat3, fromColumns, isRotation, mat3FromQuat, quatFromMat3 } from './mat3.js';
import { type Transform, transform } from './transform.js';
import { type Vec3, cross, length, normalize, rejectFrom, sub } from './vec3.js';

export type AxisName = 'x' | 'y' | 'z';

export interface FrameFromLandmarksOptions {
  /** Frame origin. */
  readonly origin: Vec3;
  /**
   * Direction of the primary axis, usually the long axis of a bone taken between a proximal and a
   * distal landmark. Need not be normalized.
   */
  readonly primaryDirection: Vec3;
  /** Which of the frame's axes the primary direction becomes. */
  readonly primaryAxis: AxisName;
  /**
   * A direction that fixes roll about the primary axis -- typically the line between two
   * medial/lateral landmarks. Only its component perpendicular to the primary direction is used,
   * so it does not need to be exactly perpendicular, which matters because real bony landmarks
   * never are.
   */
  readonly secondaryDirection: Vec3;
  /** Which axis the orthogonalized secondary direction becomes. Must differ from `primaryAxis`. */
  readonly secondaryAxis: AxisName;
}

const AXIS_ORDER: readonly AxisName[] = ['x', 'y', 'z'];

/**
 * True when going `from` -> `to` is a forward step in the cyclic order x -> y -> z -> x.
 * Used to get the sign of the derived third axis right.
 */
function isCyclic(from: AxisName, to: AxisName): boolean {
  const i = AXIS_ORDER.indexOf(from);
  const j = AXIS_ORDER.indexOf(to);
  return (j - i + 3) % 3 === 1;
}

/**
 * Construct a right-handed orthonormal frame by Gram-Schmidt.
 *
 * Throws rather than returning a degenerate frame when the two input directions are parallel or
 * near-parallel, because a bone frame silently collapsing to an arbitrary roll is exactly the kind
 * of plausible wrongness this project is built to avoid. The message names the likely cause.
 */
export function frameFromLandmarks(options: FrameFromLandmarksOptions): Transform {
  const { origin, primaryDirection, primaryAxis, secondaryDirection, secondaryAxis } = options;

  if (primaryAxis === secondaryAxis) {
    throw new Error(
      `frameFromLandmarks: primaryAxis and secondaryAxis are both '${primaryAxis}'. ` +
        'They must be different axes.',
    );
  }

  const primary = normalize(primaryDirection);

  // Keep only the part of the secondary direction perpendicular to the primary. Real landmark
  // pairs are never exactly perpendicular, and forcing them to be is the point of this step.
  const rejected = rejectFrom(secondaryDirection, primary);
  const rejectedLength = length(rejected);
  if (rejectedLength < MIN_DIRECTION_LENGTH) {
    throw new Error(
      'frameFromLandmarks: the secondary direction is parallel to the primary direction, so the ' +
        'roll about the primary axis is undefined. This usually means the wrong landmark pair was ' +
        'chosen for one of the two directions, or that two landmarks are coincident.',
    );
  }
  const secondary = normalize(rejected);

  const tertiaryAxis = AXIS_ORDER.find((a) => a !== primaryAxis && a !== secondaryAxis);
  if (!tertiaryAxis) {
    throw new Error('frameFromLandmarks: could not determine the third axis.');
  }

  // Cross order follows the cyclic convention so the result is right-handed either way round.
  const tertiary = isCyclic(primaryAxis, secondaryAxis)
    ? cross(primary, secondary)
    : cross(secondary, primary);

  const axes = { x: primary, y: secondary, z: tertiary } as Record<AxisName, Vec3>;
  axes[primaryAxis] = primary;
  axes[secondaryAxis] = secondary;
  axes[tertiaryAxis] = tertiary;

  const rotationMatrix = fromColumns(axes.x, axes.y, axes.z);

  if (!isRotation(rotationMatrix, 1e-8)) {
    throw new Error(
      'frameFromLandmarks: produced a non-orthonormal or left-handed frame. This is an internal ' +
        'error in the Gram-Schmidt construction and should be reported.',
    );
  }

  return transform(origin, quatFromMat3(rotationMatrix));
}

/**
 * Convenience wrapper taking landmark positions directly, which is how bone frame definitions read
 * in the skeleton package.
 *
 * `primary` runs from `primaryFrom` to `primaryTo`. `secondary` runs from `secondaryFrom` to
 * `secondaryTo`.
 */
export function frameFromLandmarkPoints(options: {
  readonly origin: Vec3;
  readonly primaryFrom: Vec3;
  readonly primaryTo: Vec3;
  readonly primaryAxis: AxisName;
  readonly secondaryFrom: Vec3;
  readonly secondaryTo: Vec3;
  readonly secondaryAxis: AxisName;
}): Transform {
  return frameFromLandmarks({
    origin: options.origin,
    primaryDirection: sub(options.primaryTo, options.primaryFrom),
    primaryAxis: options.primaryAxis,
    secondaryDirection: sub(options.secondaryTo, options.secondaryFrom),
    secondaryAxis: options.secondaryAxis,
  });
}

/** The rotation part of a frame, as a matrix whose columns are the frame's axes. */
export function frameAxes(frame: Transform): Mat3 {
  return mat3FromQuat(frame.rotation);
}
