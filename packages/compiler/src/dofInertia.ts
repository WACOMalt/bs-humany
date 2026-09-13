/**
 * Inertia of a joint's child segment about a DoF axis, at the rest pose.
 *
 * The number that scales anything spring-like applied in joint space -- an emulated range stop,
 * a default passive curve, a motor gain -- so that every joint responds at the same frequency
 * whatever its size. A backend and an actuation module must agree on it, hence it lives here.
 */

import { type Vec3, rotate } from '@bs-humany/frames';
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
