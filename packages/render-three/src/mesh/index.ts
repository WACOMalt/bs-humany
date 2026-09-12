/**
 * Pure procedural mesh generation.
 *
 * Nothing in this directory imports three.js. It turns HSDL geometry recipes into vertex buffers,
 * which the adapter one level up wraps in a `BufferGeometry`. Keeping the mathematics separable
 * means it is testable headlessly in CI, without a WebGL context.
 */

export * from './types.js';
export * from './axis.js';
export * from './primitives.js';
export * from './evaluate.js';
