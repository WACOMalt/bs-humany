/**
 * `@bs-humany/kernel` -- deterministic simulation infrastructure.
 *
 * Phase 1 milestone M0.4 delivers the two pieces everything else is built on: a splittable seeded
 * PRNG and the fixed-timestep clock. The scheduler, channel registry and delay lines arrive in M2.
 *
 * Nothing here imports three.js, a UI framework, or a physics backend. The kernel must run
 * headless -- in Node for CI, in a Web Worker for the app, potentially in a service (ADR-007).
 */

export * from './prng.js';
export * from './clock.js';
