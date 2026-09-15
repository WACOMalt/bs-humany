/**
 * A two-body hinge, for exercising the path solver against answers that can be worked out by
 * hand.
 *
 * Kept out of the test file because the moment arm validation harness (N1.9) needs the same
 * rig: a joint whose axis, centre and angle are all known exactly is the only place a computed
 * moment arm can be checked against a closed form rather than against another computation.
 *
 * Body 0 is the parent and never moves. Body 1 is the child, rotating about the world Z axis
 * through the origin. Everything sits in the XY plane, so the perpendicular distance from the
 * axis to a line of action is a two-dimensional problem with a one-line answer.
 */

import type { PoseBuffer, VelocityBuffer } from '@bs-humany/compiler';
import type { BoneResolver } from './solver.js';
import type { Vec3 } from './types.js';

export const PARENT_BONE = 'parent';
export const CHILD_BONE = 'child';

export const hingeResolver: BoneResolver = {
  bodyOf: (bone) => (bone === PARENT_BONE ? 0 : bone === CHILD_BONE ? 1 : -1),
  toBodyLocal: (_bone, point) => point,
};

export interface HingeState {
  readonly pose: PoseBuffer;
  readonly velocity: VelocityBuffer;
}

export function createHinge(): HingeState {
  return {
    pose: { position: new Float64Array(6), orientation: new Float64Array(8) },
    velocity: { linear: new Float64Array(6), angular: new Float64Array(6) },
  };
}

/** Puts the child at `angle` radians about world +Z through the origin, turning at `rate`. */
export function setHinge(state: HingeState, angle: number, rate = 0): void {
  state.pose.position.fill(0);
  state.velocity.linear.fill(0);
  state.velocity.angular.fill(0);

  // Parent: identity.
  state.pose.orientation[0] = 0;
  state.pose.orientation[1] = 0;
  state.pose.orientation[2] = 0;
  state.pose.orientation[3] = 1;

  // Child: a rotation of `angle` about Z. The centre is the origin, so there is no translation.
  state.pose.orientation[4] = 0;
  state.pose.orientation[5] = 0;
  state.pose.orientation[6] = Math.sin(angle / 2);
  state.pose.orientation[7] = Math.cos(angle / 2);

  state.velocity.angular[5] = rate;
}

/** The joint's axis and centre in world coordinates. Both are constant for this rig. */
export const HINGE_AXIS: Vec3 = { x: 0, y: 0, z: 1 };
export const HINGE_CENTRE: Vec3 = { x: 0, y: 0, z: 0 };

/** Only the child is carried by the coordinate. */
export const hingeMovesWith = (body: number): boolean => body === 1;
