/**
 * `@bs-humany/muscle-data` -- the `muscle.*` HSDL extension and the cited definitions in it.
 *
 * The schema is here rather than in `@bs-humany/hsdl` on purpose: muscle data is an extension
 * namespace, so a build without this package still reads and round-trips a document that carries
 * it (base spec 14.5 obligation 3).
 */

export * from './ankle.js';
export * from './elbow.js';
export * from './forearm.js';
export * from './girdle.js';
export * from './hip.js';
export * from './knee.js';
export * from './neck.js';
export * from './ranges.js';
export * from './schema.js';
export * from './shoulder.js';
export * from './sourceTravel.js';
export * from './thorax.js';
export * from './torso.js';
export * from './trunk.js';
export * from './validate.js';

export * from './hand.js';
export * from './wholeBody.js';
