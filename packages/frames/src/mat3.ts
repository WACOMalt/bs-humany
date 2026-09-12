/**
 * 3x3 matrices.
 *
 * Storage is **column-major**, matching three.js, WebGL and MuJoCo, so `m[3]` is the first element
 * of the second column. Getting this backwards produces a transposed rotation, which looks almost
 * right and is miserable to track down, so every accessor here names its row and column
 * explicitly.
 *
 * Matrices appear in this project as rotation matrices (orthonormal, determinant +1) and as
 * inertia tensors (symmetric, positive definite). The two have different validity rules, so both
 * have their own checks below.
 */

import { EPSILON, ORTHONORMAL_TOLERANCE } from './constants.js';
import { type Quat, normalizeQuat } from './quat.js';
import { type Vec3, vec3 } from './vec3.js';

/** Column-major 3x3. Index = column * 3 + row. */
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const IDENTITY_MAT3: Mat3 = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]) as Mat3;

/** Element at (row, column). */
export function at(m: Mat3, row: number, column: number): number {
  return m[column * 3 + row] ?? 0;
}

/** Build from three column vectors. For a rotation matrix these are the basis axes. */
export function fromColumns(c0: Vec3, c1: Vec3, c2: Vec3): Mat3 {
  return [c0.x, c0.y, c0.z, c1.x, c1.y, c1.z, c2.x, c2.y, c2.z];
}

/** Build from three row vectors. */
export function fromRows(r0: Vec3, r1: Vec3, r2: Vec3): Mat3 {
  return [r0.x, r1.x, r2.x, r0.y, r1.y, r2.y, r0.z, r1.z, r2.z];
}

export function column(m: Mat3, index: number): Vec3 {
  const base = index * 3;
  return vec3(m[base] ?? 0, m[base + 1] ?? 0, m[base + 2] ?? 0);
}

export function row(m: Mat3, index: number): Vec3 {
  return vec3(at(m, index, 0), at(m, index, 1), at(m, index, 2));
}

export function transpose(m: Mat3): Mat3 {
  return [
    at(m, 0, 0),
    at(m, 0, 1),
    at(m, 0, 2),
    at(m, 1, 0),
    at(m, 1, 1),
    at(m, 1, 2),
    at(m, 2, 0),
    at(m, 2, 1),
    at(m, 2, 2),
  ];
}

/** `multiplyMat3(a, b)` is the matrix product A*B -- b applied first. */
export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let col = 0; col < 3; col++) {
    for (let r = 0; r < 3; r++) {
      out[col * 3 + r] =
        at(a, r, 0) * at(b, 0, col) + at(a, r, 1) * at(b, 1, col) + at(a, r, 2) * at(b, 2, col);
    }
  }
  return out as unknown as Mat3;
}

export function transformVec3(m: Mat3, v: Vec3): Vec3 {
  return {
    x: at(m, 0, 0) * v.x + at(m, 0, 1) * v.y + at(m, 0, 2) * v.z,
    y: at(m, 1, 0) * v.x + at(m, 1, 1) * v.y + at(m, 1, 2) * v.z,
    z: at(m, 2, 0) * v.x + at(m, 2, 1) * v.y + at(m, 2, 2) * v.z,
  };
}

export function determinant(m: Mat3): number {
  return (
    at(m, 0, 0) * (at(m, 1, 1) * at(m, 2, 2) - at(m, 1, 2) * at(m, 2, 1)) -
    at(m, 0, 1) * (at(m, 1, 0) * at(m, 2, 2) - at(m, 1, 2) * at(m, 2, 0)) +
    at(m, 0, 2) * (at(m, 1, 0) * at(m, 2, 1) - at(m, 1, 1) * at(m, 2, 0))
  );
}

export function trace(m: Mat3): number {
  return at(m, 0, 0) + at(m, 1, 1) + at(m, 2, 2);
}

export function scaleMat3(m: Mat3, s: number): Mat3 {
  return m.map((v) => v * s) as unknown as Mat3;
}

export function addMat3(a: Mat3, b: Mat3): Mat3 {
  return a.map((v, i) => v + (b[i] ?? 0)) as unknown as Mat3;
}

/** Diagonal matrix. Used for principal-axis inertia tensors. */
export function diagonal(d: Vec3): Mat3 {
  return [d.x, 0, 0, 0, d.y, 0, 0, 0, d.z];
}

/**
 * True when the matrix is orthonormal with determinant +1 -- a proper rotation.
 *
 * A determinant of -1 means the matrix includes a reflection, which is the signature of a
 * handedness error in an axis convention. That is precisely the bug class this package exists to
 * prevent, so the check is separated out and used in `conventions.ts` at construction time.
 */
export function isRotation(m: Mat3, tolerance = ORTHONORMAL_TOLERANCE): boolean {
  const shouldBeIdentity = multiplyMat3(transpose(m), m);
  for (let i = 0; i < 9; i++) {
    const expected = i % 4 === 0 ? 1 : 0;
    if (Math.abs((shouldBeIdentity[i] ?? 0) - expected) > tolerance) return false;
  }
  return Math.abs(determinant(m) - 1) <= tolerance;
}

export function isSymmetric(m: Mat3, tolerance = ORTHONORMAL_TOLERANCE): boolean {
  return (
    Math.abs(at(m, 0, 1) - at(m, 1, 0)) <= tolerance &&
    Math.abs(at(m, 0, 2) - at(m, 2, 0)) <= tolerance &&
    Math.abs(at(m, 1, 2) - at(m, 2, 1)) <= tolerance
  );
}

/** Rotation matrix from a unit quaternion. */
export function mat3FromQuat(q: Quat): Mat3 {
  const n = normalizeQuat(q);
  const { x, y, z, w } = n;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  return [
    1 - (yy + zz),
    xy + wz,
    xz - wy,
    xy - wz,
    1 - (xx + zz),
    yz + wx,
    xz + wy,
    yz - wx,
    1 - (xx + yy),
  ];
}

/**
 * Quaternion from a rotation matrix.
 *
 * Uses Shepperd's method: pick the branch whose divisor is largest so the square root never
 * operates on a near-zero value. The naive single-branch formula loses catastrophic precision at
 * 180-degree rotations, which is exactly where anatomical frames tend to land.
 */
export function quatFromMat3(m: Mat3): Quat {
  if (!isRotation(m, 1e-6)) {
    throw new Error(
      `quatFromMat3 requires a proper rotation matrix. Determinant was ${determinant(m)}. ` +
        'A determinant near -1 indicates a reflection, which usually means an axis convention ' +
        'has the wrong handedness.',
    );
  }

  const m00 = at(m, 0, 0);
  const m11 = at(m, 1, 1);
  const m22 = at(m, 2, 2);
  const t = m00 + m11 + m22;

  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    return {
      w: 0.25 * s,
      x: (at(m, 2, 1) - at(m, 1, 2)) / s,
      y: (at(m, 0, 2) - at(m, 2, 0)) / s,
      z: (at(m, 1, 0) - at(m, 0, 1)) / s,
    };
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return {
      w: (at(m, 2, 1) - at(m, 1, 2)) / s,
      x: 0.25 * s,
      y: (at(m, 0, 1) + at(m, 1, 0)) / s,
      z: (at(m, 0, 2) + at(m, 2, 0)) / s,
    };
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return {
      w: (at(m, 0, 2) - at(m, 2, 0)) / s,
      x: (at(m, 0, 1) + at(m, 1, 0)) / s,
      y: 0.25 * s,
      z: (at(m, 1, 2) + at(m, 2, 1)) / s,
    };
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return {
    w: (at(m, 1, 0) - at(m, 0, 1)) / s,
    x: (at(m, 0, 2) + at(m, 2, 0)) / s,
    y: (at(m, 1, 2) + at(m, 2, 1)) / s,
    z: 0.25 * s,
  };
}

/** General inverse. Throws on a singular matrix rather than emitting Infinity. */
export function invertMat3(m: Mat3): Mat3 {
  const det = determinant(m);
  if (Math.abs(det) < EPSILON) {
    throw new Error(`Cannot invert a singular matrix (determinant ${det}).`);
  }
  const invDet = 1 / det;
  const c = (
    r0: number,
    c0: number,
    r1: number,
    c1: number,
    r2: number,
    c2: number,
    r3: number,
    c3: number,
  ): number => (at(m, r0, c0) * at(m, r1, c1) - at(m, r2, c2) * at(m, r3, c3)) * invDet;

  return [
    c(1, 1, 2, 2, 1, 2, 2, 1),
    c(1, 2, 2, 0, 1, 0, 2, 2),
    c(1, 0, 2, 1, 1, 1, 2, 0),
    c(0, 2, 2, 1, 0, 1, 2, 2),
    c(0, 0, 2, 2, 0, 2, 2, 0),
    c(0, 1, 2, 0, 0, 0, 2, 1),
    c(0, 1, 1, 2, 0, 2, 1, 1),
    c(0, 2, 1, 0, 0, 0, 1, 2),
    c(0, 0, 1, 1, 0, 1, 1, 0),
  ];
}

export function approxEqualsMat3(a: Mat3, b: Mat3, tolerance = EPSILON): boolean {
  for (let i = 0; i < 9; i++) {
    if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > tolerance) return false;
  }
  return true;
}
