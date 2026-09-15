/**
 * `@bs-humany/muscle-model` -- musculotendon dynamics as pure arithmetic.
 *
 * No kernel, no backend, no renderer: this package takes numbers and returns numbers, which is
 * what lets it be checked directly against published benchmarks (muscle spec section 15).
 */

export * from './activation.js';
export * from './benchmark.js';
export * from './curves.js';
export * from './fiber.js';
export * from './rigid.js';
