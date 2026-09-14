/**
 * The Phase 1 channel registry (spec section 10.4), sized from a compiled articulation.
 *
 * Channel ids and field names are the ABI between modules; a module written against
 * `body.pose@1.0.0` must find `position` and `orientation` there for as long as 1.x lasts. The
 * specs are functions of the articulation because element counts are: N segments, nq and nv.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import type { ChannelSpec } from '@bs-humany/kernel';

export const CHANNEL_VERSION = '1.0.0';

export const BODY_POSE = 'body.pose';
export const BODY_VELOCITY = 'body.velocity';
export const BODY_JOINT_STATE = 'body.jointState';
export const BODY_BONE_TRANSFORMS = 'body.boneTransforms';
export const ACTUATION_JOINT_TORQUE = 'actuation.jointTorque';
export const ACTUATION_BODY_WRENCH = 'actuation.bodyWrench';
export const CONTACT_MANIFOLDS = 'contact.manifolds';
export const SIM_GRAVITY = 'sim.gravity';

/** Default capacity of the dynamic contact channel. Overflow is reported, never dropped silently. */
export const DEFAULT_CONTACT_CAPACITY = 256;

export function bodyPoseSpec(model: CompiledArticulation): ChannelSpec {
  return {
    id: BODY_POSE,
    version: CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      { name: 'position', dtype: 'f64', components: 3 },
      { name: 'orientation', dtype: 'f64', components: 4 },
    ],
    elementCount: model.segments.length,
    mode: 'single-writer',
    backing: 'shared',
  };
}

export function bodyVelocitySpec(model: CompiledArticulation): ChannelSpec {
  return {
    id: BODY_VELOCITY,
    version: CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      { name: 'linear', dtype: 'f64', components: 3 },
      { name: 'angular', dtype: 'f64', components: 3 },
    ],
    elementCount: model.segments.length,
    mode: 'single-writer',
    backing: 'shared',
  };
}

/**
 * Joint state is one element per generalized velocity; `q` has one extra scalar for the root
 * quaternion, carried as a separate `nq`-long field on the same channel.
 */
export function bodyJointStateSpec(model: CompiledArticulation): ChannelSpec {
  return {
    id: BODY_JOINT_STATE,
    version: CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      { name: 'q', dtype: 'f64', components: model.nq },
      { name: 'qdot', dtype: 'f64', components: model.nv },
      { name: 'force', dtype: 'f64', components: model.nv },
    ],
    elementCount: 1,
    mode: 'single-writer',
    backing: 'shared',
  };
}

export function actuationJointTorqueSpec(model: CompiledArticulation): ChannelSpec {
  return {
    id: ACTUATION_JOINT_TORQUE,
    version: CHANNEL_VERSION,
    layout: 'SoA',
    fields: [{ name: 'torque', dtype: 'f64', components: 1 }],
    elementCount: model.nv,
    mode: 'accumulator',
    backing: 'local',
  };
}

export function actuationBodyWrenchSpec(model: CompiledArticulation): ChannelSpec {
  return {
    id: ACTUATION_BODY_WRENCH,
    version: CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      { name: 'force', dtype: 'f64', components: 3 },
      { name: 'torque', dtype: 'f64', components: 3 },
    ],
    elementCount: model.segments.length,
    mode: 'accumulator',
    backing: 'local',
  };
}

export function contactManifoldsSpec(capacity = DEFAULT_CONTACT_CAPACITY): ChannelSpec {
  return {
    id: CONTACT_MANIFOLDS,
    version: CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      { name: 'pair', dtype: 'i32', components: 2 },
      { name: 'point', dtype: 'f64', components: 3 },
      { name: 'normal', dtype: 'f64', components: 3 },
      { name: 'impulse', dtype: 'f64', components: 1 },
      { name: 'depth', dtype: 'f64', components: 1 },
    ],
    elementCount: 'dynamic',
    capacity,
    mode: 'single-writer',
    backing: 'shared',
  };
}

export function boneTransformsSpec(boneCount: number): ChannelSpec {
  return {
    id: BODY_BONE_TRANSFORMS,
    version: CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      { name: 'position', dtype: 'f64', components: 3 },
      { name: 'orientation', dtype: 'f64', components: 4 },
    ],
    elementCount: boneCount,
    mode: 'single-writer',
    backing: 'shared',
  };
}

/**
 * The gravity the backend is integrating with, metres per second squared.
 *
 * The compiled articulation carries the gravity it was built for, but gravity can be turned off
 * while a body is in the air, and anything that reads the articulation's copy would go on
 * reporting a potential energy the body no longer has. The physics module publishes what is
 * actually in force, and whoever needs it reads this.
 */
export function simGravitySpec(): ChannelSpec {
  return {
    id: SIM_GRAVITY,
    version: CHANNEL_VERSION,
    layout: 'SoA',
    fields: [{ name: 'gravity', dtype: 'f64', components: 3 }],
    elementCount: 1,
    mode: 'single-writer',
    backing: 'shared',
  };
}
