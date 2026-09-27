/**
 * Where the body is, for the two things in the studio that need one point for it: the centre of
 * mass the overlay draws, and the point the camera aims at when a view button or F is pressed.
 *
 * Pure functions over the flat arrays the simulation's `body.pose` channel and the bridge already
 * hand over, writing into an output the caller owns, so the overlay can call them every frame
 * without allocating anything (CONTRIBUTING rule 7 is about `step()`, but a frame loop that
 * allocates stutters for the same reason).
 */

import type { Vec3 } from '@bs-humany/frames';
import type { Vector3 } from 'three';

/**
 * Each segment's centre of mass in the world, from the segments' poses.
 *
 * `coms` are the centres in each segment's own frame, as the compiled articulation states them;
 * `position` and `orientation` are the segment poses, three and four numbers a segment, in the
 * same order. Written into `out`, three numbers a segment. The rotation is the quaternion
 * sandwich written out, `v + 2w(q x v) + 2 q x (q x v)`, rather than through three's Quaternion,
 * which would need a scratch object per call site.
 */
export function segmentComs(
  coms: readonly Vec3[],
  position: ArrayLike<number>,
  orientation: ArrayLike<number>,
  out: Float64Array,
): void {
  for (let i = 0; i < coms.length; i++) {
    const c = coms[i] as Vec3;
    const qx = orientation[4 * i] ?? 0;
    const qy = orientation[4 * i + 1] ?? 0;
    const qz = orientation[4 * i + 2] ?? 0;
    const qw = orientation[4 * i + 3] ?? 1;
    // t = 2 (q x v)
    const tx = 2 * (qy * c.z - qz * c.y);
    const ty = 2 * (qz * c.x - qx * c.z);
    const tz = 2 * (qx * c.y - qy * c.x);
    // v' = v + w t + q x t
    out[3 * i] = c.x + qw * tx + (qy * tz - qz * ty) + (position[3 * i] ?? 0);
    out[3 * i + 1] = c.y + qw * ty + (qz * tx - qx * tz) + (position[3 * i + 1] ?? 0);
    out[3 * i + 2] = c.z + qw * tz + (qx * ty - qy * tx) + (position[3 * i + 2] ?? 0);
  }
}

/**
 * The whole body's centre of mass: the mass-weighted mean of the segments' own centres.
 *
 * `masses` one number a segment, `positions` three (the output of `segmentComs`). Written into
 * `out` and returned. A body with no mass at all has no centre of mass, and `out` is left as it
 * was; the return is then false, so a caller can fall back to something else.
 */
export function wholeBodyCom(
  masses: ArrayLike<number>,
  positions: ArrayLike<number>,
  out: Vector3,
): boolean {
  let total = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < masses.length; i++) {
    const m = masses[i] ?? 0;
    total += m;
    x += m * (positions[3 * i] ?? 0);
    y += m * (positions[3 * i + 1] ?? 0);
    z += m * (positions[3 * i + 2] ?? 0);
  }
  if (!(total > 0)) return false;
  out.set(x / total, y / total, z / total);
  return true;
}

/**
 * The middle of the box around a set of points, three numbers a point.
 *
 * For a body whose masses are not known here -- one followed on the bridge, which sends bone
 * poses and nothing about the segments they make -- the middle of its bones is the honest stand-in
 * for where it is. False, and `out` untouched, when there are no points.
 */
export function boundsMidpoint(positions: ArrayLike<number>, out: Vector3): boolean {
  const count = Math.floor(positions.length / 3);
  if (count === 0) return false;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const x = positions[3 * i] ?? 0;
    const y = positions[3 * i + 1] ?? 0;
    const z = positions[3 * i + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  out.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  return true;
}
