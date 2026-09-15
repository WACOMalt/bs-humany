/**
 * `@bs-humany/muscle-path` -- where a muscle runs, how fast that path is changing, and what
 * leverage it has.
 *
 * The package holds the geometry half of the muscle module. It knows about bones, poses and
 * surfaces; it knows nothing about force, activation or fibers, which live in `muscle-model`.
 * The two meet only in the kernel module that owns both (N3).
 */

export * from './momentArm.js';
export * from './geodesicSolver.js';
export * from './solver.js';
export * from './types.js';
export * from './wrap.js';
