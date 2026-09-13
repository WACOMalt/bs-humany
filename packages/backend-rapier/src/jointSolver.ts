/**
 * Joint angles from body poses.
 *
 * Rapier's impulse joints are maximal-coordinate: they constrain two free bodies and never report
 * a joint angle. The articulation, though, is defined as ordered hinges with ranges, and the
 * passive model, the limits and the diagnostics all live in that space. So the backend recovers
 * each joint's generalized coordinates from the two bodies' relative rotation every step.
 *
 * For a joint with hinges `a_1 .. a_n` (unit vectors in the joint frame, applied in order), the
 * child frame relative to the parent frame is `R(a_1, q_1) R(a_2, q_2) ... R(a_n, q_n)`. Given the
 * measured relative rotation, `q` is found by damped Gauss-Newton on the rotation-vector error,
 * warm-started from the previous step; two or three iterations suffice at simulation rates. This
 * handles oblique axes (the subtalar axis) and gimbal-lock neighbourhoods without a special case,
 * at the cost of being iterative -- which is fine, because the state is continuous.
 *
 * Everything here is allocation-free at step rate: scratch storage is owned by the solver.
 */

import type { CompiledJoint } from '@bs-humany/compiler';

export interface JointSolverState {
  /** Number of hinges. */
  readonly n: number;
  /** Axis components, joint frame, `3 * n`. */
  readonly axes: Float64Array;
  /** Current generalized coordinates, `n`. */
  readonly q: Float64Array;
  /** Neutral coordinates, `n`: where the null space of a singular sequence is pulled toward. */
  readonly neutral: Float64Array;
  /** Instantaneous axis of each hinge in the joint-parent frame at the current `q`, `3 * n`. */
  readonly jacobian: Float64Array;
}

export function createJointSolverState(joint: CompiledJoint): JointSolverState {
  const n = joint.dofs.length;
  const axes = new Float64Array(3 * n);
  joint.dofs.forEach((d, i) => {
    axes[3 * i] = d.vector.x;
    axes[3 * i + 1] = d.vector.y;
    axes[3 * i + 2] = d.vector.z;
  });
  const q = new Float64Array(n);
  const neutral = new Float64Array(n);
  joint.dofs.forEach((d, i) => {
    q[i] = d.neutral;
    neutral[i] = d.neutral;
  });
  return { n, axes, q, neutral, jacobian: new Float64Array(3 * n) };
}

// Scratch quaternions and vectors, module-level so no step allocates. x y z w.
const qa = new Float64Array(4);
const qb = new Float64Array(4);
const qc = new Float64Array(4);
const jtj = new Float64Array(9);
const jte = new Float64Array(3);
const dq = new Float64Array(3);
const err = new Float64Array(3);

function quatSet(out: Float64Array, x: number, y: number, z: number, w: number): void {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = w;
}

function quatFromAxisAngle(out: Float64Array, ax: number, ay: number, az: number, angle: number) {
  const h = angle / 2;
  const s = Math.sin(h);
  quatSet(out, ax * s, ay * s, az * s, Math.cos(h));
}

/** out = a * b. `out` may alias `a`. */
function quatMul(out: Float64Array, a: Float64Array, b: Float64Array): void {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const aw = a[3] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  const bz = b[2] as number;
  const bw = b[3] as number;
  quatSet(
    out,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  );
}

/** Rotate (x, y, z) by quaternion q, writing into out[o..o+3). */
function quatRotate(
  q: Float64Array,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
  o: number,
) {
  const qx = q[0] as number;
  const qy = q[1] as number;
  const qz = q[2] as number;
  const qw = q[3] as number;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[o] = x + qw * tx + (qy * tz - qz * ty);
  out[o + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[o + 2] = z + qw * tz + (qx * ty - qy * tx);
}

/**
 * Compose R(q) for the current coordinates into `qa`, and fill the Jacobian: column i is
 * `R(a_1,q_1)..R(a_{i-1},q_{i-1}) a_i`.
 */
function forward(state: JointSolverState): void {
  quatSet(qa, 0, 0, 0, 1);
  for (let i = 0; i < state.n; i++) {
    const ax = state.axes[3 * i] as number;
    const ay = state.axes[3 * i + 1] as number;
    const az = state.axes[3 * i + 2] as number;
    quatRotate(qa, ax, ay, az, state.jacobian, 3 * i);
    quatFromAxisAngle(qb, ax, ay, az, state.q[i] as number);
    quatMul(qa, qa, qb);
  }
}

/**
 * Levenberg damping of the Gauss-Newton step, added to the diagonal of `J^T J`.
 *
 * Bounds the gain in a direction the Jacobian barely sees to `1 / damping`, so a measurement
 * jitter of a microradian near a singular configuration moves `q` by at most a tenth of a
 * milliradian per iteration instead of without limit. It biases nothing: the step is zero when
 * the error is zero.
 */
export const LEVENBERG_DAMPING = 1e-2;

/**
 * Below this squared singular value of the Jacobian, the direction counts as a null space and
 * `q` is pulled toward neutral along it.
 *
 * A sequence such as the ISB Y-X-Y humerus is singular at zero elevation: the first and third
 * hinges share an axis, and any split of the twist between them fits the measurement. Without a
 * preference the split wanders step to step and the range stops fight over it. The smallest
 * eigenvalue of `J^T J` for that sequence is `1 - cos(elevation)`, so the pull starts at about
 * 25 degrees of elevation, reaches half weight near 13 degrees, and is complete at zero. A hinge
 * or a joint whose axes stay well apart has every eigenvalue near one and is never pulled, so a
 * recovered angle there carries no bias at all; that is what a pull folded into the damping
 * term could not offer, since it shifted every angle by `damping` of its distance from neutral.
 */
export const NULL_SPACE_ONSET = 0.1;

/** Weight of the neutral pull along an eigen-direction with squared singular value `s2`. */
function pullWeight(s2: number): number {
  if (s2 >= NULL_SPACE_ONSET) return 0;
  const t = 1 - s2 / NULL_SPACE_ONSET;
  return t * t;
}

// Smallest eigenpair of the symmetric `n x n` matrix in `jtj` (3-stride), into `nullVec`.
const nullVec = new Float64Array(3);

/**
 * Smallest eigenvalue of `J^T J` and its unit eigenvector, for `n` of 2 or 3. Closed form: the
 * 2x2 case directly, the 3x3 case by the trigonometric solution of the characteristic cubic and
 * the largest column of the adjugate of `M - s2 I`, which is rank one along the eigenvector.
 * The Jacobi routine in eigen.ts is for compile time; it allocates, and this runs per joint per
 * iteration per step.
 */
function smallestEigenpair(n: number, M: Float64Array): number {
  if (n === 2) {
    const a = M[0] as number;
    const b = M[1] as number;
    const c = M[4] as number;
    const mean = (a + c) / 2;
    const half = Math.hypot((a - c) / 2, b);
    const s2 = mean - half;
    // (M - s2 I) v = 0: either row gives v.
    let vx = b;
    let vy = s2 - a;
    if (vx * vx + vy * vy < (s2 - c) * (s2 - c) + b * b) {
      vx = s2 - c;
      vy = b;
    }
    const len = Math.hypot(vx, vy);
    nullVec[0] = len > 0 ? vx / len : 1;
    nullVec[1] = len > 0 ? vy / len : 0;
    nullVec[2] = 0;
    return s2;
  }
  const a = M[0] as number;
  const b = M[1] as number;
  const c = M[2] as number;
  const d = M[4] as number;
  const e = M[5] as number;
  const f = M[8] as number;
  const tr = (a + d + f) / 3;
  const A = a - tr;
  const D = d - tr;
  const F = f - tr;
  const p2 = (A * A + D * D + F * F + 2 * (b * b + c * c + e * e)) / 6;
  const p = Math.sqrt(p2);
  let s2: number;
  if (p < 1e-15) {
    s2 = tr;
  } else {
    const B00 = A / p;
    const B01 = b / p;
    const B02 = c / p;
    const B11 = D / p;
    const B12 = e / p;
    const B22 = F / p;
    const detB =
      B00 * (B11 * B22 - B12 * B12) - B01 * (B01 * B22 - B12 * B02) + B02 * (B01 * B12 - B11 * B02);
    const r = Math.max(-1, Math.min(1, detB / 2));
    const phi = Math.acos(r) / 3;
    // Eigenvalues are tr + 2 p cos(phi + 2 pi k / 3); the smallest takes k = 1.
    s2 = tr + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  }
  // Adjugate columns of (M - s2 I); the largest is the eigenvector.
  const a0 = a - s2;
  const d0 = d - s2;
  const f0 = f - s2;
  const c0x = d0 * f0 - e * e;
  const c0y = c * e - b * f0;
  const c0z = b * e - c * d0;
  const c1x = c0y;
  const c1y = a0 * f0 - c * c;
  const c1z = b * c - a0 * e;
  const c2x = c0z;
  const c2y = c1z;
  const c2z = a0 * d0 - b * b;
  const n0 = c0x * c0x + c0y * c0y + c0z * c0z;
  const n1 = c1x * c1x + c1y * c1y + c1z * c1z;
  const n2 = c2x * c2x + c2y * c2y + c2z * c2z;
  let vx: number;
  let vy: number;
  let vz: number;
  if (n0 >= n1 && n0 >= n2) {
    vx = c0x;
    vy = c0y;
    vz = c0z;
  } else if (n1 >= n2) {
    vx = c1x;
    vy = c1y;
    vz = c1z;
  } else {
    vx = c2x;
    vy = c2y;
    vz = c2z;
  }
  const len = Math.hypot(vx, vy, vz);
  if (len > 0) {
    nullVec[0] = vx / len;
    nullVec[1] = vy / len;
    nullVec[2] = vz / len;
  } else {
    nullVec[0] = 1;
    nullVec[1] = 0;
    nullVec[2] = 0;
  }
  return s2;
}

/**
 * Update `state.q` so that R(q) matches the relative rotation `rel` (x y z w, child frame in the
 * parent joint frame). Returns the residual rotation angle in radians.
 */
export function solveJointAngles(
  state: JointSolverState,
  rel: Float64Array,
  iterations = 3,
  damping = LEVENBERG_DAMPING,
): number {
  let residual = 0;
  for (let iter = 0; iter < iterations; iter++) {
    forward(state);
    // error rotation e = rel * conj(R(q)), as a rotation vector.
    quatSet(qc, -(qa[0] as number), -(qa[1] as number), -(qa[2] as number), qa[3] as number);
    quatMul(qb, rel, qc);
    let w = qb[3] as number;
    let sx = qb[0] as number;
    let sy = qb[1] as number;
    let sz = qb[2] as number;
    if (w < 0) {
      w = -w;
      sx = -sx;
      sy = -sy;
      sz = -sz;
    }
    const sinHalf = Math.hypot(sx, sy, sz);
    const angle = 2 * Math.atan2(sinHalf, w);
    residual = angle;
    if (sinHalf < 1e-12) {
      err[0] = 0;
      err[1] = 0;
      err[2] = 0;
    } else {
      const k = angle / sinHalf;
      err[0] = sx * k;
      err[1] = sy * k;
      err[2] = sz * k;
    }
    // Normal equations (n <= 3): (J^T J + damping I) dq = J^T e, then the neutral pull along
    // the least-observed direction, weighted by how close to null it is.
    const n = state.n;
    const J = state.jacobian;
    for (let i = 0; i < n; i++) {
      jte[i] =
        (J[3 * i] as number) * (err[0] as number) +
        (J[3 * i + 1] as number) * (err[1] as number) +
        (J[3 * i + 2] as number) * (err[2] as number);
      for (let j = 0; j < n; j++) {
        jtj[i * 3 + j] =
          (J[3 * i] as number) * (J[3 * j] as number) +
          (J[3 * i + 1] as number) * (J[3 * j + 1] as number) +
          (J[3 * i + 2] as number) * (J[3 * j + 2] as number) +
          (i === j ? damping : 0);
      }
    }
    solveSmall(n, jtj, jte, dq);
    for (let i = 0; i < n; i++) state.q[i] = (state.q[i] as number) + (dq[i] as number);
    if (n > 1) {
      for (let i = 0; i < n; i++) jtj[i * 3 + i] = (jtj[i * 3 + i] as number) - damping;
      const weight = pullWeight(smallestEigenpair(n, jtj));
      if (weight > 0) {
        let along = 0;
        for (let i = 0; i < n; i++) {
          along += (nullVec[i] as number) * ((state.neutral[i] as number) - (state.q[i] as number));
        }
        for (let i = 0; i < n; i++) {
          state.q[i] = (state.q[i] as number) + weight * along * (nullVec[i] as number);
        }
      }
    }
  }
  forward(state);
  return residual;
}

/**
 * Least-squares joint velocities from the relative angular velocity (joint-parent frame),
 * using the Jacobian left by the last `solveJointAngles`.
 */
export function solveJointVelocities(
  state: JointSolverState,
  omegaX: number,
  omegaY: number,
  omegaZ: number,
  out: Float64Array,
  offset: number,
  damping = 1e-6,
): void {
  const n = state.n;
  const J = state.jacobian;
  for (let i = 0; i < n; i++) {
    jte[i] =
      (J[3 * i] as number) * omegaX +
      (J[3 * i + 1] as number) * omegaY +
      (J[3 * i + 2] as number) * omegaZ;
    for (let j = 0; j < n; j++) {
      jtj[i * 3 + j] =
        (J[3 * i] as number) * (J[3 * j] as number) +
        (J[3 * i + 1] as number) * (J[3 * j + 1] as number) +
        (J[3 * i + 2] as number) * (J[3 * j + 2] as number) +
        (i === j ? damping : 0);
    }
  }
  solveSmall(n, jtj, jte, dq);
  for (let i = 0; i < n; i++) out[offset + i] = dq[i] as number;
}

/** Solve an n x n (n <= 3) symmetric positive system by Gaussian elimination in place. */
function solveSmall(n: number, A: Float64Array, b: Float64Array, x: Float64Array): void {
  if (n === 1) {
    x[0] = (b[0] as number) / (A[0] as number);
    return;
  }
  if (n === 2) {
    const a = A[0] as number;
    const bb = A[1] as number;
    const c = A[3] as number;
    const d = A[4] as number;
    const det = a * d - bb * c;
    x[0] = ((b[0] as number) * d - bb * (b[1] as number)) / det;
    x[1] = (a * (b[1] as number) - c * (b[0] as number)) / det;
    return;
  }
  const m = A;
  const r0 = m[0] as number;
  const r1 = m[1] as number;
  const r2 = m[2] as number;
  const r3 = m[3] as number;
  const r4 = m[4] as number;
  const r5 = m[5] as number;
  const r6 = m[6] as number;
  const r7 = m[7] as number;
  const r8 = m[8] as number;
  const det = r0 * (r4 * r8 - r5 * r7) - r1 * (r3 * r8 - r5 * r6) + r2 * (r3 * r7 - r4 * r6);
  const inv = 1 / det;
  const b0 = b[0] as number;
  const b1 = b[1] as number;
  const b2 = b[2] as number;
  x[0] = ((r4 * r8 - r5 * r7) * b0 + (r2 * r7 - r1 * r8) * b1 + (r1 * r5 - r2 * r4) * b2) * inv;
  x[1] = ((r5 * r6 - r3 * r8) * b0 + (r0 * r8 - r2 * r6) * b1 + (r2 * r3 - r0 * r5) * b2) * inv;
  x[2] = ((r3 * r7 - r4 * r6) * b0 + (r1 * r6 - r0 * r7) * b1 + (r0 * r4 - r1 * r3) * b2) * inv;
}
