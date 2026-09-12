/**
 * `@bs-humany/frames` -- coordinate conventions, rigid transforms, and the conversions between
 * frames.
 *
 * Small, pure, and exhaustively tested by design. Nothing here knows about anatomy, physics, or
 * rendering. Everything in the project depends on it, which is why it stays that way.
 *
 * The specification singles out coordinate-convention bugs as the most likely source of silent
 * wrongness in this project. The defence is in `conventions.ts`: conventions are declared by
 * anatomical direction and their matrices are derived and checked, so a handedness error throws at
 * module load rather than mirroring the skeleton.
 */

export * from './constants.js';
export * from './vec3.js';
export * from './quat.js';
export * from './mat3.js';
export * from './angles.js';
export * from './transform.js';
export * from './conventions.js';
export * from './euler.js';
export * from './frame.js';
