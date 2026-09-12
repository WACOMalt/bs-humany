/**
 * `@bs-humany/anthropometry` -- parameter tables and the morphology solver.
 *
 * Two published sources do the work (ADR-009: both are permissively usable, so the core pays no
 * accuracy tax for staying permissive):
 *
 *   - **de Leva (1996)** for how mass is distributed -- relative segment masses, centre-of-mass
 *     positions and radii of gyration, in complete parallel male and female tables referenced to
 *     joint centres. That parallel structure is what makes the sex parameter a real biomechanical
 *     parameterization rather than a scale factor.
 *   - **ANSUR II (Gordon et al., 2014)** for dimensions and the percentile axis, sex-separated at
 *     source, supplemented by Drillis & Contini (1966) for the segment-length proportions ANSUR II
 *     does not publish directly.
 *
 * Every table carries machine-readable provenance saying what has actually been checked, and the
 * population it describes. Neither is yet verified line-by-line against its source document, and
 * both say so rather than implying otherwise.
 */

export * from './provenance.js';
export * from './deleva.js';
export * from './ansur.js';
export * from './inertia.js';
export * from './morphology.js';
