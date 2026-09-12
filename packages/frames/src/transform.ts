/**
 * Rigid transforms: a rotation and a translation, nothing else.
 *
 * **Deliberately no scale component.** Bones change size through their HSDL dimension expressions,
 * which regenerate geometry and recompute inertia. A scale factor hidden in a transform would
 * silently desynchronize rendered size from simulated mass properties, and non-uniform scale in a
 * hierarchy produces shear that no physics backend accepts. Morphology reshapes bones; it does not
 * scale their transforms.
 */

import { EPSILON } from './constants.js';
import {
  IDENTITY_QUAT,
  type Quat,
  approxEqualsQuat,
  conjugate,
  isFiniteQuat,
  multiplyQuat,
  normalizeQuat,
  rotate,
  slerp,
} from './quat.js';
import { type Vec3, ZERO3, add, approxEquals, isFinite3, lerp, negate, sub } from './vec3.js';

export interface Transform {
  readonly translation: Vec3;
  readonly rotation: Quat;
}

export const IDENTITY_TRANSFORM: Transform = Object.freeze({
  translation: ZERO3,
  rotation: IDENTITY_QUAT,
});

export function transform(translation: Vec3, rotation: Quat): Transform {
  return { translation, rotation };
}

export function fromTranslation(translation: Vec3): Transform {
  return { translation, rotation: IDENTITY_QUAT };
}

export function fromRotation(rotation: Quat): Transform {
  return { translation: ZERO3, rotation };
}

/**
 * Compose two transforms. `compose(a, b)` applies `b` first, then `a`.
 *
 * Read it as "a of b", the same way function composition reads. For a bone hierarchy,
 * `compose(parentWorld, childLocal)` gives the child's world transform.
 */
export function compose(a: Transform, b: Transform): Transform {
  return {
    translation: add(a.translation, rotate(a.rotation, b.translation)),
    rotation: multiplyQuat(a.rotation, b.rotation),
  };
}

/** Inverse transform, such that `compose(invert(t), t)` is the identity. */
export function invert(t: Transform): Transform {
  const inverseRotation = conjugate(normalizeQuat(t.rotation));
  return {
    translation: rotate(inverseRotation, negate(t.translation)),
    rotation: inverseRotation,
  };
}

/** Apply to a point: rotate then translate. */
export function transformPoint(t: Transform, point: Vec3): Vec3 {
  return add(rotate(t.rotation, point), t.translation);
}

/**
 * Apply to a direction: rotate only.
 *
 * Joint axes, surface normals and velocities are directions. Passing one through
 * `transformPoint` adds a spurious offset, which for a joint axis means an axis that drifts as the
 * body moves -- subtly wrong rather than obviously broken.
 */
export function transformDirection(t: Transform, direction: Vec3): Vec3 {
  return rotate(t.rotation, direction);
}

/** Express `child` relative to `parent`. The inverse of `compose`. */
export function relativeTo(child: Transform, parent: Transform): Transform {
  return compose(invert(parent), child);
}

/**
 * Interpolate between two transforms: lerp the translation, slerp the rotation.
 *
 * This is what the renderer uses to smooth between the last two simulation states using leftover
 * accumulator time. Rendering raw simulation state at render rate produces visible judder whenever
 * the rates do not divide evenly.
 */
export function interpolate(a: Transform, b: Transform, t: number): Transform {
  return {
    translation: lerp(a.translation, b.translation, t),
    rotation: slerp(a.rotation, b.rotation, t),
  };
}

export function approxEqualsTransform(a: Transform, b: Transform, tolerance = EPSILON): boolean {
  return (
    approxEquals(a.translation, b.translation, tolerance) &&
    approxEqualsQuat(a.rotation, b.rotation, tolerance)
  );
}

/**
 * Validity check used by the plausibility assertions.
 *
 * A NaN in a transform propagates through an entire kinematic chain in one tick and is far easier
 * to diagnose at the point it appears than three frames later when the model has vanished.
 */
export function isValidTransform(t: Transform): boolean {
  return isFinite3(t.translation) && isFiniteQuat(t.rotation);
}

/** Displacement from `a` to `b`. */
export function translationBetween(a: Transform, b: Transform): Vec3 {
  return sub(b.translation, a.translation);
}
