import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { RapierBackend } from '@bs-humany/backend-rapier';
import { ROOT_NQ, compileArticulation } from '@bs-humany/compiler';
import { Kernel } from '@bs-humany/kernel';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { BODY_JOINT_STATE } from './channels.js';
import { CouplingModule } from './couplingModule.js';
import { PassiveJointModule } from './passiveJointModule.js';
import { PhysicsModule } from './physicsModule.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l2_biomechanical', morphology);

async function collapse(backend: 'rapier' | 'mujoco') {
  const physics = new PhysicsModule(
    backend === 'rapier' ? new RapierBackend() : new MujocoBackend(),
    articulation,
    { ground: { height: 0 } },
  );
  const kernel = new Kernel({ rateHz: 500, seed: 1 });
  const coupling = new CouplingModule(articulation, physics.backend.capabilities);
  kernel.register(physics);
  kernel.register(new PassiveJointModule(articulation));
  kernel.register(coupling);
  await kernel.init();
  kernel.run(1500);
  const q = kernel.channels.storage(BODY_JOINT_STATE).fields.q as Float64Array;
  const errors = new Float64Array(coupling.count);
  coupling.errors(errors);
  const knee = articulation.dofs.find((d) => articulation.joints[d.joint]?.id === 'knee_r');
  const patella = articulation.dofs.find(
    (d) => articulation.joints[d.joint]?.id === 'patellofemoral_r',
  );
  if (!knee || !patella) throw new Error('missing');
  const result = {
    active: coupling.active,
    count: coupling.count,
    worstError: Math.max(...Array.from(errors).map((e) => Math.abs(e))),
    knee: q[ROOT_NQ + knee.index] ?? 0,
    patella: q[ROOT_NQ + patella.index] ?? 0,
  };
  kernel.dispose();
  return result;
}

describe('CouplingModule', () => {
  it('compiles every coupling the L2 profile can express', () => {
    const backend = new RapierBackend();
    const module = new CouplingModule(articulation, backend.capabilities);
    // 9 lumbar, and per side: patella, 2 sternoclavicular, 3 acromioclavicular.
    expect(module.count).toBe(9 + 2 * 6);
  });

  it('holds the patella on its knee polynomial through a collapse on Rapier', async () => {
    const r = await collapse('rapier');
    expect(r.active).toBe(true);
    // The knee flexed during the collapse and the patella followed the quartic.
    expect(r.knee).toBeGreaterThan(0.2);
    const expected =
      0.010506 +
      0.0247615 * r.knee -
      1.31647 * r.knee ** 2 +
      0.716337 * r.knee ** 3 -
      0.138302 * r.knee ** 4;
    expect(Math.abs(r.patella - expected)).toBeLessThan(0.15);
    expect(r.worstError).toBeLessThan(0.3);
  }, 60000);

  it('stands down on MuJoCo, where the couplings are solved natively and hold tighter', async () => {
    const m = await collapse('mujoco');
    expect(m.active).toBe(false);
    expect(m.worstError).toBeLessThan(0.05);
  }, 60000);
});
