/**
 * `@bs-humany/compiler` -- HSDL to `CompiledArticulation`, the backend contract, and the MJCF
 * emitter.
 *
 * The compiler is where names become indices. Everything downstream of it -- both backends, the
 * physics module, the pose module -- works in the index space it defines, and that space is the
 * same whichever backend is loaded.
 */

export * from './articulation.js';
export * from './backend.js';
export * from './compile.js';
export * from './dofInertia.js';
export * from './mjcf.js';
export * from './massMapping.js';
