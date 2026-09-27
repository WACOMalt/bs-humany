/**
 * `@bs-humany/testkit` -- scenario runner, plausibility assertions and trajectory hashing (spec
 * section 13). The backend conformance harness (13.3) was retired on 2026-09-26 with the second
 * backend it compared against; `docs/validation/conformance.md` says why.
 */

export * from './runner.js';
export * from './plausibility.js';
export * from './hash.js';
export { placeArticulation } from '@bs-humany/scenarios';
