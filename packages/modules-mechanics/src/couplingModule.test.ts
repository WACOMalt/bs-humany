import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { type BackendCapabilities, compileArticulation } from '@bs-humany/compiler';
import { Kernel } from '@bs-humany/kernel';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { CouplingModule } from './couplingModule.js';
import { PassiveJointModule } from './passiveJointModule.js';
import { PhysicsModule } from './physicsModule.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l2_biomechanical', morphology);

/**
 * A backend that cannot solve couplings and says so. None ships since Rapier was deleted, but the
 * module's job is to stand in for exactly such a backend, so its constructor is tested against
 * one.
 */
const APPROXIMATING: BackendCapabilities = {
  reducedCoordinate: false,
  equalityConstraints: 'approximated',
  softJointLimits: 'emulated',
  perDofStiffnessDamping: 'emulated',
  tendons: 'unsupported',
  muscleActuators: 'unsupported',
  deterministicAcrossPlatforms: false,
  maxRecommendedBodies: 60,
  realizedDofForce: 'estimated',
};

async function collapse() {
  const physics = new PhysicsModule(new MujocoBackend(), articulation, { ground: { height: 0 } });
  const kernel = new Kernel({ rateHz: 500, seed: 1 });
  const coupling = new CouplingModule(articulation, physics.backend.capabilities);
  kernel.register(physics);
  kernel.register(new PassiveJointModule(articulation));
  kernel.register(coupling);
  await kernel.init();
  kernel.run(1500);
  const errors = new Float64Array(coupling.count);
  coupling.errors(errors);
  const result = {
    active: coupling.active,
    worstError: Math.max(...Array.from(errors).map((e) => Math.abs(e))),
  };
  kernel.dispose();
  return result;
}

describe('CouplingModule', () => {
  it('compiles every coupling the L2 profile can express, and runs where they are approximated', () => {
    const module = new CouplingModule(articulation, APPROXIMATING);
    expect(module.active).toBe(true);
    // 9 lumbar, and per side: patella, 2 sternoclavicular, 2 scapular counter-rotations,
    // 3 acromioclavicular.
    expect(module.count).toBe(9 + 2 * 8);
  });

  it('pulls each dependent toward its target when it runs, and counts the work it does', async () => {
    // The corrective torques on top of MuJoCo's own constraints: nothing ships this way, but it
    // is the one place left that steps the module, so its arithmetic is exercised on a real body.
    const physics = new PhysicsModule(new MujocoBackend(), articulation, { ground: { height: 0 } });
    const kernel = new Kernel({ rateHz: 500, seed: 1 });
    const coupling = new CouplingModule(articulation, APPROXIMATING);
    kernel.register(physics);
    kernel.register(coupling);
    await kernel.init();
    kernel.run(200);
    const errors = new Float64Array(coupling.count);
    coupling.errors(errors);
    expect(Number.isFinite(coupling.work)).toBe(true);
    expect(coupling.work).not.toBe(0);
    expect(Math.max(...Array.from(errors).map((e) => Math.abs(e)))).toBeLessThan(0.05);
    kernel.dispose();
  }, 60000);

  it('stands down on MuJoCo, where the couplings are solved natively and hold tighter', async () => {
    const m = await collapse();
    expect(m.active).toBe(false);
    expect(m.worstError).toBeLessThan(0.05);
  }, 60000);
});
