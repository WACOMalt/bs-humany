/**
 * Test-only helpers.
 *
 * Exported from the package so other packages' tests can use the same deterministic generators
 * rather than each inventing their own. Nothing in the simulation path imports this.
 *
 * The generator here is a plain LCG, not the project's real PRNG -- it exists only so tests can
 * sweep a wide input space without `Math.random`, which is banned outright (CONTRIBUTING rule 7)
 * and which would make a failure impossible to reproduce.
 */

import { type Quat, fromAxisAngle } from './quat.js';
import { type Vec3, vec3 } from './vec3.js';

/** Deterministic 32-bit LCG. Same seed, same sequence, forever. */
export function makeTestRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** A pseudo-random vector with components in `[-range, range]`. */
export function randomVec3(next: () => number, range = 1): Vec3 {
  return vec3((next() * 2 - 1) * range, (next() * 2 - 1) * range, (next() * 2 - 1) * range);
}

/**
 * A pseudo-random unit quaternion, uniform over orientations.
 *
 * Uses Shoemake's subgroup algorithm rather than normalizing a random 4-vector, which would
 * concentrate samples away from the corners and leave parts of the rotation space untested.
 */
export function randomQuat(next: () => number): Quat {
  const u1 = next();
  const u2 = next();
  const u3 = next();
  const sqrt1MinusU1 = Math.sqrt(1 - u1);
  const sqrtU1 = Math.sqrt(u1);
  return {
    x: sqrt1MinusU1 * Math.sin(2 * Math.PI * u2),
    y: sqrt1MinusU1 * Math.cos(2 * Math.PI * u2),
    z: sqrtU1 * Math.sin(2 * Math.PI * u3),
    w: sqrtU1 * Math.cos(2 * Math.PI * u3),
  };
}

/** A rotation about a named canonical axis. Convenience for readable fixtures. */
export function rotationAbout(axis: Vec3, degrees: number): Quat {
  return fromAxisAngle(axis, (degrees * Math.PI) / 180);
}
