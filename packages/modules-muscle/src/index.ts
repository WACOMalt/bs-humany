/**
 * `@bs-humany/modules-muscle` -- the kernel modules of section 10.1.
 *
 * `muscle.path` works out where every muscle runs; `muscle.dynamics` turns drive into force on
 * bone. Neither holds any of the science: the curves and the fiber model are in
 * `@bs-humany/muscle-model`, the geometry is in `@bs-humany/muscle-path`, and both of those are
 * testable without a kernel. What lives here is the wiring.
 */

export * from './channels.js';
export * from './compile.js';
export * from './momentArmSweep.js';
export * from './muscleDynamicsModule.js';
export * from './muscleMomentModule.js';
export * from './musclePathModule.js';
export * from './muscleTestDriveModule.js';
export * from './muscleVolumeModule.js';
