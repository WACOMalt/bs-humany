/**
 * Three-component vectors.
 *
 * Values are SI: metres for positions and displacements, metres per second for velocities.
 * Nothing in this module knows about anatomy or about any particular axis convention -- a `Vec3`
 * is meaningless until you say which frame it is expressed in. See `conventions.ts`.
 */

import { EPSILON, MIN_DIRECTION_LENGTH } from './constants.js';

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Mutable form, for out-parameters in code that must not allocate. */
export interface Vec3Mut {
  x: number;
  y: number;
  z: number;
}

export const ZERO3: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });
export const UNIT_X: Vec3 = Object.freeze({ x: 1, y: 0, z: 0 });
export const UNIT_Y: Vec3 = Object.freeze({ x: 0, y: 1, z: 0 });
export const UNIT_Z: Vec3 = Object.freeze({ x: 0, y: 0, z: 1 });

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function negate(a: Vec3): Vec3 {
  return { x: -a.x, y: -a.y, z: -a.z };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lengthSquared(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length(a: Vec3): number {
  return Math.sqrt(lengthSquared(a));
}

export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

/**
 * Normalize to unit length.
 *
 * Throws on a vector too short to carry a reliable direction, rather than returning NaN or a
 * silently arbitrary axis. A degenerate direction almost always means upstream data is wrong --
 * two landmarks placed at the same point, say -- and that should surface at the point of failure
 * rather than as a mysterious NaN three layers downstream.
 */
export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < MIN_DIRECTION_LENGTH) {
    throw new Error(
      `Cannot normalize a vector of length ${len} (${a.x}, ${a.y}, ${a.z}). ` +
        'This usually means two landmarks are coincident or a dimension resolved to zero.',
    );
  }
  return { x: a.x / len, y: a.y / len, z: a.z / len };
}

/** Linear interpolation. `t` is not clamped. */
export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/** Component-wise multiply. Used for anisotropic scaling of bone dimensions. */
export function multiply(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x * b.x, y: a.y * b.y, z: a.z * b.z };
}

/** The component of `a` perpendicular to unit vector `axis`. */
export function rejectFrom(a: Vec3, axis: Vec3): Vec3 {
  return sub(a, scale(axis, dot(a, axis)));
}

export function approxEquals(a: Vec3, b: Vec3, tolerance = EPSILON): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.z - b.z) <= tolerance
  );
}

export function isFinite3(a: Vec3): boolean {
  return Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
}

/** Write into a flat typed array at `index * 3`. For SoA channel buffers. */
export function writeToArray(out: Float64Array, index: number, v: Vec3): void {
  const base = index * 3;
  out[base] = v.x;
  out[base + 1] = v.y;
  out[base + 2] = v.z;
}

/** Read from a flat typed array at `index * 3`. Allocates -- not for use inside `step`. */
export function readFromArray(src: Float64Array, index: number): Vec3 {
  const base = index * 3;
  return { x: src[base] ?? 0, y: src[base + 1] ?? 0, z: src[base + 2] ?? 0 };
}
