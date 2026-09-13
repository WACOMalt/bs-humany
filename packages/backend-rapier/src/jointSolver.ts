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
 * Regularisation weight pulling `q` toward neutral where the Jacobian does not care.
 *
 * A sequence such as the ISB Y-X-Y humerus is singular at zero elevation: the first and third
 * hinges share an axis, and any split of the twist between them fits the measurement. Without a
 * preference the split wanders step to step and the range stops fight over it. With this term the
 * solution in the null space is the one nearest neutral; away from singularity the bias is of
 * order `damping` relative to unit Jacobian columns, which is negligible.
 */
export const NULL_SPACE_DAMPING = 1e-2;

/**
 * Update `state.q` so that R(q) matches the relative rotation `rel` (x y z w, child frame in the
 * parent joint frame). Returns the residual rotation angle in radians.
 */
export function solveJointAngles(
  state: JointSolverState,
  rel: Float64Array,
  iterations = 3,
  damping = NULL_SPACE_DAMPING,
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
    // Normal equations (n <= 3): (J^T J + damping I) dq = J^T e + damping (neutral - q).
    const n = state.n;
    const J = state.jacobian;
    for (let i = 0; i < n; i++) {
      jte[i] =
        (J[3 * i] as number) * (err[0] as number) +
        (J[3 * i + 1] as number) * (err[1] as number) +
        (J[3 * i + 2] as number) * (err[2] as number) +
        damping * ((state.neutral[i] as number) - (state.q[i] as number));
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
