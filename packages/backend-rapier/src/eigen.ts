/**
 * Principal axes of a symmetric 3x3 tensor, by cyclic Jacobi rotations.
 *
 * Rapier takes a body's inertia as principal moments plus the rotation of the principal frame,
 * so a full inertia tensor from the compiler has to be diagonalised on the way in. Jacobi is the
 * right tool at this size: unconditionally convergent for symmetric input, a handful of sweeps,
 * and it returns the eigenvectors as a proper rotation, which is what a frame needs.
 */

import { type Mat3, type Quat, type Vec3, quatFromMat3, vec3 } from '@bs-humany/frames';

export interface PrincipalAxes {
  /** Eigenvalues, in the order of the columns of `rotation`. */
  readonly moments: Vec3;
  /** Rotation whose columns are the principal axes, expressed in the tensor's frame. */
  readonly rotation: Quat;
}

export function principalAxes(tensor: Mat3, maxSweeps = 20): PrincipalAxes {
  // Row-major working copies.
  const a = [...tensor] as number[];
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const at = (i: number, j: number) => a[i * 3 + j] as number;
  const set = (i: number, j: number, x: number) => {
    a[i * 3 + j] = x;
  };

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    const off = at(0, 1) ** 2 + at(0, 2) ** 2 + at(1, 2) ** 2;
    if (off < 1e-30) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = at(p, q);
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (at(q, q) - at(p, p)) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = at(k, p);
        const akq = at(k, q);
        set(k, p, c * akp - s * akq);
        set(k, q, s * akp + c * akq);
      }
      for (let k = 0; k < 3; k++) {
        const apk = at(p, k);
        const aqk = at(q, k);
        set(p, k, c * apk - s * aqk);
        set(q, k, s * apk + c * aqk);
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p] as number;
        const vkq = v[k * 3 + q] as number;
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }

  // Ensure a proper rotation: flip the third column if the determinant is negative.
  const det =
    (v[0] as number) * ((v[4] as number) * (v[8] as number) - (v[5] as number) * (v[7] as number)) -
    (v[1] as number) * ((v[3] as number) * (v[8] as number) - (v[5] as number) * (v[6] as number)) +
    (v[2] as number) * ((v[3] as number) * (v[7] as number) - (v[4] as number) * (v[6] as number));
  if (det < 0) {
    v[2] = -(v[2] as number);
    v[5] = -(v[5] as number);
    v[8] = -(v[8] as number);
  }
  return {
    moments: vec3(at(0, 0), at(1, 1), at(2, 2)),
    rotation: quatFromMat3(v as unknown as Mat3),
  };
}
