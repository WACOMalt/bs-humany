/**
 * Forward kinematics of a compiled articulation: segment poses and velocities from generalized
 * coordinates. Used to place a maximal-coordinate backend from joint state (M5.6) and to check a
 * backend's recovered coordinates against the poses they came from.
 *
 * Pose: `child = parent ∘ frameInParent ∘ R(a1,q1)…R(an,qn) ∘ frameInChild⁻¹`.
 * Velocity: the joint adds `Δω = Σ axis_i(world) q̇_i` about the joint point, so
 * `ω_c = ω_p + Δω` and `v_c = v_p + ω_p × (p_c − p_p) + Δω × (p_c − p_j)`.
 */

import {
  type Quat,
  type Transform,
  type Vec3,
  compose,
  fromAxisAngle,
  invert,
  multiplyQuat,
  rotate,
  vec3,
} from '@bs-humany/frames';
import { type CompiledArticulation, ROOT_NQ, ROOT_NV } from './articulation.js';

export interface KinematicState {
  /** 3N */
  readonly position: Float64Array;
  /** 4N, x y z w */
  readonly orientation: Float64Array;
  /** 3N, optional */
  readonly linear?: Float64Array | undefined;
  /** 3N, optional */
  readonly angular?: Float64Array | undefined;
}

/** Segment indices ordered so every parent precedes its children. */
export function kinematicOrder(model: CompiledArticulation): number[] {
  const order: number[] = [model.root];
  const children = new Map<number, number[]>();
  for (const s of model.segments) {
    if (s.parent >= 0) children.set(s.parent, [...(children.get(s.parent) ?? []), s.index]);
  }
  for (let i = 0; i < order.length; i++) {
    for (const c of children.get(order[i] as number) ?? []) order.push(c);
  }
  return order;
}

/** Joint whose child is each segment, by segment index; -1 for the root. */
function parentJointOf(model: CompiledArticulation): Int32Array {
  const out = new Int32Array(model.segments.length).fill(-1);
  for (const j of model.joints) out[j.childSegment] = j.index;
  return out;
}

export function forwardKinematics(
  model: CompiledArticulation,
  q: Float64Array,
  qdot: Float64Array | undefined,
  out: KinematicState,
): void {
  const order = kinematicOrder(model);
  const joints = parentJointOf(model);
  const poses: (Transform | undefined)[] = model.segments.map(() => undefined);
  const omegas: Vec3[] = model.segments.map(() => vec3(0, 0, 0));
  const vels: Vec3[] = model.segments.map(() => vec3(0, 0, 0));

  const rootPose: Transform = {
    translation: vec3(q[0] ?? 0, q[1] ?? 0, q[2] ?? 0),
    rotation: { x: q[3] ?? 0, y: q[4] ?? 0, z: q[5] ?? 0, w: q[6] ?? 1 },
  };
  poses[model.root] = rootPose;
  if (qdot) {
    vels[model.root] = vec3(qdot[0] ?? 0, qdot[1] ?? 0, qdot[2] ?? 0);
    omegas[model.root] = vec3(qdot[3] ?? 0, qdot[4] ?? 0, qdot[5] ?? 0);
  }

  for (const s of order) {
    if (s === model.root) continue;
    const joint = model.joints[joints[s] as number];
    const parent = joint ? poses[joint.parentSegment] : undefined;
    if (!joint || !parent) throw new Error(`Segment ${s} has no kinematic parent.`);
    const jointWorld = compose(parent, joint.frameInParent);
    let rotation: Quat = { x: 0, y: 0, z: 0, w: 1 };
    let dOmega = vec3(0, 0, 0);
    joint.dofs.forEach((dof, i) => {
      const angle = q[ROOT_NQ + joint.dofStart + i] ?? 0;
      // Axis of this hinge in the world, after the preceding hinges of the same joint.
      const axisWorld = rotate(multiplyQuat(jointWorld.rotation, rotation), dof.vector);
      if (qdot) {
        const rate = qdot[ROOT_NV + joint.dofStart + i] ?? 0;
        dOmega = vec3(
          dOmega.x + axisWorld.x * rate,
          dOmega.y + axisWorld.y * rate,
          dOmega.z + axisWorld.z * rate,
        );
      }
      rotation = multiplyQuat(rotation, fromAxisAngle(dof.vector, angle));
    });
    const turned: Transform = {
      translation: jointWorld.translation,
      rotation: multiplyQuat(jointWorld.rotation, rotation),
    };
    const child = compose(turned, invert(joint.frameInChild));
    poses[s] = child;
    if (qdot) {
      const wp = omegas[joint.parentSegment] as Vec3;
      const vp = vels[joint.parentSegment] as Vec3;
      const pp = parent.translation;
      const pc = child.translation;
      const pj = jointWorld.translation;
      const wc = vec3(wp.x + dOmega.x, wp.y + dOmega.y, wp.z + dOmega.z);
      const rcp = vec3(pc.x - pp.x, pc.y - pp.y, pc.z - pp.z);
      const rcj = vec3(pc.x - pj.x, pc.y - pj.y, pc.z - pj.z);
      vels[s] = vec3(
        vp.x + (wp.y * rcp.z - wp.z * rcp.y) + (dOmega.y * rcj.z - dOmega.z * rcj.y),
        vp.y + (wp.z * rcp.x - wp.x * rcp.z) + (dOmega.z * rcj.x - dOmega.x * rcj.z),
        vp.z + (wp.x * rcp.y - wp.y * rcp.x) + (dOmega.x * rcj.y - dOmega.y * rcj.x),
      );
      omegas[s] = wc;
    }
  }

  model.segments.forEach((_, i) => {
    const p = poses[i];
    if (!p) return;
    out.position[3 * i] = p.translation.x;
    out.position[3 * i + 1] = p.translation.y;
    out.position[3 * i + 2] = p.translation.z;
    out.orientation[4 * i] = p.rotation.x;
    out.orientation[4 * i + 1] = p.rotation.y;
    out.orientation[4 * i + 2] = p.rotation.z;
    out.orientation[4 * i + 3] = p.rotation.w;
    if (qdot && out.linear && out.angular) {
      const v = vels[i] as Vec3;
      const w = omegas[i] as Vec3;
      out.linear.set([v.x, v.y, v.z], 3 * i);
      out.angular.set([w.x, w.y, w.z], 3 * i);
    }
  });
}

export interface TransferResult {
  readonly q: Float64Array;
  readonly qdot: Float64Array;
  /** DoFs of the target with no counterpart in the source, left at neutral. */
  readonly unmatched: string[];
}

/**
 * Carry joint state from one articulation to another by joint id and axis name: the same
 * profile recompiled at a new morphology, or a coarser profile handed to a finer one. Root pose
 * and velocity copy over; a DoF the target has and the source lacks starts at its neutral.
 */
export function transferJointState(
  source: {
    readonly model: CompiledArticulation;
    readonly q: Float64Array;
    readonly qdot: Float64Array;
  },
  target: CompiledArticulation,
): TransferResult {
  const q = new Float64Array(target.nq);
  const qdot = new Float64Array(target.nv);
  for (let i = 0; i < ROOT_NQ; i++) q[i] = source.q[i] ?? (i === 6 ? 1 : 0);
  for (let i = 0; i < ROOT_NV; i++) qdot[i] = source.qdot[i] ?? 0;
  const index = new Map<string, number>();
  for (const d of source.model.dofs) {
    index.set(`${source.model.joints[d.joint]?.id}/${d.axisName}`, d.index);
  }
  const unmatched: string[] = [];
  for (const d of target.dofs) {
    const key = `${target.joints[d.joint]?.id}/${d.axisName}`;
    const from = index.get(key);
    if (from === undefined) {
      q[ROOT_NQ + d.index] = d.neutral;
      unmatched.push(key);
      continue;
    }
    q[ROOT_NQ + d.index] = source.q[ROOT_NQ + from] ?? d.neutral;
    qdot[ROOT_NV + d.index] = source.qdot[ROOT_NV + from] ?? 0;
  }
  return { q, qdot, unmatched };
}
