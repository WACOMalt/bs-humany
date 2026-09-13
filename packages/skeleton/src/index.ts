/**
 * `@bs-humany/skeleton` -- the anatomical layer.
 *
 * The complete bone taxonomy, landmarks, local frames and segmentation profiles. Per ADR-001 this
 * layer is always complete regardless of the active fidelity profile.
 */

export * from './taxonomy-types.js';
export * from './taxonomy.js';
export * from './segmentation.js';
export * from './dataset.js';
export * from './document.js';
export * from './landmarks.js';
export * from './frames.js';
export * from './joints.js';
export * from './proxies.js';
export * from './pose.js';
export * from './geometry/layout.js';
export * from './geometry/shapes.js';
export * from './constraints.js';
