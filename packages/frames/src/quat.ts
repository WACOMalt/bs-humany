/**
 * Unit quaternions for rotation.
 *
 * Storage order is `{ x, y, z, w }` with `w` the scalar part, matching three.js and MuJoCo's
 * JavaScript surface. Note that MJCF *text* writes quaternions scalar-first (`w x y z`); that
 * conversion belongs in the MJCF emitter, not here, and is a documented emitter responsibility.
 *
 * Convention: Hamilton product, right-handed, active rotations. `rotate(q, v)` returns `q v q*`,
 * the vector rotated within a fixed frame -- not the frame rotated under a fixed vector.
 */

import { EPSILON, ORTHONORMAL_TOLERANCE } from './constants.js';
import { type Vec3, cross, dot, normalize, vec3 } from './vec3.js';

export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export const IDENTITY_QUAT: Quat = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

export function quat(x: number, y: number, z: number, w: number): Quat {
  return { x, y, z, w };
}

/** Rotation of `angle` radians about `axis`, which need not be normalized. */
export function fromAxisAngle(axis: Vec3, angle: number): Quat {
  const unit = normalize(axis);
  const half = angle * 0.5;
  const s = Math.sin(half);
  return { x: unit.x * s, y: unit.y * s, z: unit.z * s, w: Math.cos(half) };
}

/**
 * Decompose into axis and angle. The returned angle is in [0, pi].
 *
 * For a near-identity rotation the axis is arbitrary, so `UNIT_X` is returned by convention rather
 * than a normalization of float noise.
 */
export function toAxisAngle(q: Quat): { axis: Vec3; angle: number } {
  const n = normalizeQuat(q);
  // Work from |w| so the angle comes back in [0, pi] regardless of which of the two antipodal
  // representations was handed in.
  const w = Math.min(1, Math.max(-1, n.w));
  const angle = 2 * Math.acos(Math.abs(w));
  const sinHalf = Math.sqrt(Math.max(0, 1 - w * w));
  if (sinHalf < EPSILON) {
    return { axis: vec3(1, 0, 0), angle: 0 };
  }
  const sign = w < 0 ? -1 : 1;
  return {
    axis: vec3((n.x * sign) / sinHalf, (n.y * sign) / sinHalf, (n.z * sign) / sinHalf),
    angle,
  };
}

/** Hamilton product. `multiplyQuat(a, b)` applies `b` first, then `a`. */
export function multiplyQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** Conjugate. For a unit quaternion this is the inverse. */
export function conjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/**
 * Inverse, valid for non-unit quaternions too.
 *
 * Prefer `conjugate` where the input is known to be unit -- it is cheaper and exact.
 */
export function invertQuat(q: Quat): Quat {
  const normSq = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
  if (normSq < EPSILON) {
    throw new Error('Cannot invert a zero quaternion.');
  }
  return { x: -q.x / normSq, y: -q.y / normSq, z: -q.z / normSq, w: q.w / normSq };
}

export function normalizeQuat(q: Quat): Quat {
  const norm = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (norm < EPSILON) {
    throw new Error('Cannot normalize a zero quaternion.');
  }
  return { x: q.x / norm, y: q.y / norm, z: q.z / norm, w: q.w / norm };
}

/**
 * Rotate a vector.
 *
 * Uses the standard `v + 2w(u x v) + 2(u x (u x v))` expansion rather than building a matrix,
 * which is both faster and avoids a round-trip through a representation we would then have to
 * re-orthonormalize.
 */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const u = vec3(q.x, q.y, q.z);
  const uv = cross(u, v);
  const uuv = cross(u, uv);
  return {
    x: v.x + 2 * (q.w * uv.x + uuv.x),
    y: v.y + 2 * (q.w * uv.y + uuv.y),
    z: v.z + 2 * (q.w * uv.z + uuv.z),
  };
}

/** Angle in radians between two orientations, in [0, pi]. */
export function angleBetween(a: Quat, b: Quat): number {
  const na = normalizeQuat(a);
  const nb = normalizeQuat(b);
  const d = Math.abs(na.x * nb.x + na.y * nb.y + na.z * nb.z + na.w * nb.w);
  return 2 * Math.acos(Math.min(1, d));
}

/**
 * Shortest-arc rotation taking unit vector `from` onto unit vector `to`.
 *
 * The antiparallel case is genuinely ambiguous -- any axis perpendicular to `from` works -- so a
 * perpendicular is chosen deterministically. Determinism matters here: this function feeds
 * skeleton construction, and an arbitrary choice that varied run to run would break the bit-exact
 * reproducibility contract.
 */
export function rotationBetween(from: Vec3, to: Vec3): Quat {
  const f = normalize(from);
  const t = normalize(to);
  const d = dot(f, t);

  if (d >= 1 - EPSILON) {
    return IDENTITY_QUAT;
  }
  if (d <= -1 + EPSILON) {
    // Antiparallel. Pick the world axis least aligned with `f` so the cross product is well
    // conditioned, then rotate pi about the resulting perpendicular.
    const ax = Math.abs(f.x);
    const ay = Math.abs(f.y);
    const az = Math.abs(f.z);
    const fallback =
      ax <= ay && ax <= az ? vec3(1, 0, 0) : ay <= az ? vec3(0, 1, 0) : vec3(0, 0, 1);
    const axis = normalize(cross(f, fallback));
    return { x: axis.x, y: axis.y, z: axis.z, w: 0 };
  }

  const axis = cross(f, t);
  const w = 1 + d;
  return normalizeQuat({ x: axis.x, y: axis.y, z: axis.z, w });
}

/**
 * Spherical linear interpolation along the shortest arc.
 *
 * Falls back to normalized lerp for nearly-parallel inputs, where `sin(theta)` underflows.
 */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  const na = normalizeQuat(a);
  let nb = normalizeQuat(b);
  let d = na.x * nb.x + na.y * nb.y + na.z * nb.z + na.w * nb.w;

  // Take the shortest path by flipping one input if the pair is more than 90 degrees apart.
  if (d < 0) {
    nb = { x: -nb.x, y: -nb.y, z: -nb.z, w: -nb.w };
    d = -d;
  }

  if (d > 1 - EPSILON) {
    return normalizeQuat({
      x: na.x + (nb.x - na.x) * t,
      y: na.y + (nb.y - na.y) * t,
      z: na.z + (nb.z - na.z) * t,
      w: na.w + (nb.w - na.w) * t,
    });
  }

  const theta = Math.acos(Math.min(1, d));
  const sinTheta = Math.sin(theta);
  const sa = Math.sin((1 - t) * theta) / sinTheta;
  const sb = Math.sin(t * theta) / sinTheta;
  return {
    x: na.x * sa + nb.x * sb,
    y: na.y * sa + nb.y * sb,
    z: na.z * sa + nb.z * sb,
    w: na.w * sa + nb.w * sb,
  };
}

export function isUnitQuat(q: Quat, tolerance = ORTHONORMAL_TOLERANCE): boolean {
  const normSq = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
  return Math.abs(normSq - 1) <= tolerance;
}

/**
 * Compare orientations, treating `q` and `-q` as equal.
 *
 * They represent the same rotation. Any test that compares quaternions component-wise without
 * accounting for this will fail intermittently for no good reason.
 */
export function approxEqualsQuat(a: Quat, b: Quat, tolerance = EPSILON): boolean {
  const same =
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.z - b.z) <= tolerance &&
    Math.abs(a.w - b.w) <= tolerance;
  const negated =
    Math.abs(a.x + b.x) <= tolerance &&
    Math.abs(a.y + b.y) <= tolerance &&
    Math.abs(a.z + b.z) <= tolerance &&
    Math.abs(a.w + b.w) <= tolerance;
  return same || negated;
}

export function isFiniteQuat(q: Quat): boolean {
  return (
    Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w)
  );
}

/** Write into a flat typed array at `index * 4`, in `x, y, z, w` order. */
export function writeQuatToArray(out: Float64Array, index: number, q: Quat): void {
  const base = index * 4;
  out[base] = q.x;
  out[base + 1] = q.y;
  out[base + 2] = q.z;
  out[base + 3] = q.w;
}

/** Read from a flat typed array at `index * 4`. Allocates -- not for use inside `step`. */
export function readQuatFromArray(src: Float64Array, index: number): Quat {
  const base = index * 4;
  return {
    x: src[base] ?? 0,
    y: src[base + 1] ?? 0,
    z: src[base + 2] ?? 0,
    w: src[base + 3] ?? 1,
  };
}
