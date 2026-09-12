/**
 * `@bs-humany/render-three` -- procedural geometry and three.js presentation.
 *
 * Per ADR-007 this is the only package allowed to depend on three.js, and even here the dependency
 * is confined to `geometry.ts`. Everything else -- recipe evaluation, mesh generation, the
 * skeleton build -- is pure and testable without a WebGL context.
 */

export * from './mesh/index.js';
export * from './skeletonMesh.js';
export * from './geometry.js';
