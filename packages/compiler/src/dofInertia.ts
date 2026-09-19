/**
 * Inertia of a joint's child segment about a DoF axis, at the rest pose.
 *
 * The number that scales anything spring-like applied in joint space -- an emulated range stop,
 * a default passive curve, a motor gain -- so that every joint responds at the same frequency
 * whatever its size. A backend and an actuation module must agree on it, hence it lives here.
 */

import { type Mat3, type Vec3, mat3FromQuat, rotate, transformPoint } from '@bs-humany/frames';
import type { CompiledArticulation, CompiledDof } from './articulation.js';

/** `axis^T I axis` for a unit axis and a row-major 3x3 tensor. */
export function axisInertia(inertia: readonly number[], axis: Vec3): number {
  const ix =
    (inertia[0] as number) * axis.x +
    (inertia[1] as number) * axis.y +
    (inertia[2] as number) * axis.z;
  const iy =
    (inertia[3] as number) * axis.x +
    (inertia[4] as number) * axis.y +
    (inertia[5] as number) * axis.z;
  const iz =
    (inertia[6] as number) * axis.x +
    (inertia[7] as number) * axis.y +
    (inertia[8] as number) * axis.z;
  return ix * axis.x + iy * axis.y + iz * axis.z;
}

/** Child-segment inertia about a DoF's axis, in kg*m^2, taken in the child frame at rest. */
export function dofAxisInertia(model: CompiledArticulation, dof: CompiledDof): number {
  const joint = model.joints[dof.joint];
  const child = joint ? model.segments[joint.childSegment] : undefined;
  if (!joint || !child) return 0;
  const axisInChild = rotate(joint.frameInChild.rotation, dof.vector);
  return axisInertia(child.inertia, axisInChild);
}

/** `R I R^T` for row-major 3x3 matrices. */
function rotateTensor(inertia: Mat3, rotation: Mat3): number[] {
  const r = rotation as readonly number[];
  const i = inertia as readonly number[];
  const ri = new Array<number>(9).fill(0);
  for (let a = 0; a < 3; a++)
    for (let b = 0; b < 3; b++)
      for (let k = 0; k < 3; k++)
        ri[3 * a + b] =
          (ri[3 * a + b] as number) + (r[3 * a + k] as number) * (i[3 * k + b] as number);
  const out = new Array<number>(9).fill(0);
  for (let a = 0; a < 3; a++)
    for (let b = 0; b < 3; b++)
      for (let k = 0; k < 3; k++)
        out[3 * a + b] =
          (out[3 * a + b] as number) + (ri[3 * a + k] as number) * (r[3 * b + k] as number);
  return out;
}

/**
 * The reduced inertia of the two bodies a DoF separates, about its axis, at the rest pose:
 * `Ia Ib / (Ia + Ib)` for the child's subtree and everything else, each taken as rigid about the
 * axis line through the joint.
 *
 * The number to scale a spring between the two with: a wall at the hip has the leg on one side
 * and the trunk on the other, and a wall at a lumbar level has the legs and pelvis on one side
 * and the rest of the trunk on the other, and what leans on it is what it must hold. The child
 * segment's own inertia (`dofAxisInertia`) is the thigh at the hip and a single vertebra at a
 * spinal level -- a wall sized to that let the trunk sink into it. The reduced inertia is also
 * the one the relative motion actually has, so a spring set to a frequency for it oscillates at
 * that frequency for whichever side is lighter, and is stable where a wall sized to the heavier
 * side alone would not be.
 */
export function dofReducedInertia(model: CompiledArticulation, dof: CompiledDof): number {
  const joint = model.joints[dof.joint];
  const child = joint ? model.segments[joint.childSegment] : undefined;
  if (!joint || !child) return 0;
  const axis = rotate(child.restWorld.rotation, rotate(joint.frameInChild.rotation, dof.vector));
  const norm = Math.hypot(axis.x, axis.y, axis.z) || 1;
  const a = { x: axis.x / norm, y: axis.y / norm, z: axis.z / norm };
  const point = transformPoint(child.restWorld, joint.frameInChild.translation);
  const below = new Array<boolean>(model.segments.length).fill(false);
  for (const segment of model.segments) {
    let at: number = segment.index;
    while (at >= 0) {
      if (at === child.index) {
        below[segment.index] = true;
        break;
      }
      at = model.segments[at]?.parent ?? -1;
    }
  }
  let childSide = 0;
  let otherSide = 0;
  for (const segment of model.segments) {
    const world = rotateTensor(segment.inertia, mat3FromQuat(segment.restWorld.rotation));
    const com = transformPoint(segment.restWorld, segment.com);
    const d = { x: com.x - point.x, y: com.y - point.y, z: com.z - point.z };
    const along = d.x * a.x + d.y * a.y + d.z * a.z;
    const perp2 = d.x * d.x + d.y * d.y + d.z * d.z - along * along;
    const about = axisInertia(world, a) + segment.mass * Math.max(0, perp2);
    if (below[segment.index]) childSide += about;
    else otherSide += about;
  }
  if (otherSide <= 0) return childSide;
  if (childSide <= 0) return otherSide;
  return (childSide * otherSide) / (childSide + otherSide);
}

/**
 * The frequency the default passive wall is set to, and the highest a light body may be asked to
 * oscillate at under one: the wall's stiffness for the joint's reduced inertia may not exceed
 * what the child segment alone would ring at 25 Hz with, which an explicit torque at 500 Hz
 * or more integrates stably (omega dt of about 0.3). A vertebra between two walls sized to the
 * whole trunk rang at over a kilohertz and the spine came apart at 1000 Hz.
 */
export const PASSIVE_WALL_HZ = 6;
export const PASSIVE_RING_LIMIT_HZ = 25;

/**
 * The inertia the default passive curve is scaled to: the reduced inertia of the two bodies the
 * DoF separates, capped at what keeps the child segment's own ringing under the wall below
 * `PASSIVE_RING_LIMIT_HZ`. At the hip that is the reduced inertia -- the trunk is held; at a
 * spinal level it is the cap -- a vertebra is light, and what holds the trunk there is not a
 * wall at the end of the range but the disc, which the backend carries as a constraint.
 */
export function dofPassiveInertia(model: CompiledArticulation, dof: CompiledDof): number {
  const ratio = (PASSIVE_RING_LIMIT_HZ / PASSIVE_WALL_HZ) ** 2;
  const child = Math.max(dofAxisInertia(model, dof), 1e-6);
  return Math.min(dofReducedInertia(model, dof), child * ratio);
}
