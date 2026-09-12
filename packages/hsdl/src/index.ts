/**
 * `@bs-humany/hsdl` -- the HumanSim Description Language.
 *
 * The single source of truth for a body (ADR-002). Declarative, versioned, JSON-serializable,
 * diffable in git, and containing no code. Backend representations -- MJCF for MuJoCo, builder
 * calls for Rapier -- are compile targets generated from this, never hand-edited and never
 * round-tripped back.
 *
 * HSDL's dynamics semantics are deliberately a **superset of MJCF's**, so the accuracy ceiling is
 * set by the most capable backend rather than by the intersection of all of them.
 */

export * from './namespace.js';
export * from './citation.js';
export * from './primitives.js';
export * from './expr.js';
export * from './extensions.js';
export * from './geometry.js';
export * from './landmark.js';
export * from './attachment.js';
export * from './bone.js';
export * from './joint.js';
export * from './collision.js';
export * from './constraints.js';
export * from './segmentation.js';
export * from './morphology.js';
export * from './document.js';
export * from './validate.js';
export * from './jsonSchema.js';
