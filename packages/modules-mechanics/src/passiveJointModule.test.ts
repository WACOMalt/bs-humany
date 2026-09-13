import { resolveMorphology } from '@bs-humany/anthropometry';
import { RapierBackend } from '@bs-humany/backend-rapier';
import { ROOT_NQ, ROOT_NV, compileArticulation, dofAxisInertia } from '@bs-humany/compiler';
import { passiveMoment } from '@bs-humany/hsdl';
import { Kernel } from '@bs-humany/kernel';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { BODY_JOINT_STATE } from './channels.js';
import { DEFAULT_PASSIVE, PassiveJointModule, defaultPassiveCurve } from './passiveJointModule.js';
import { PhysicsModule } from './physicsModule.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l1_standard', morphology);

describe('the default passive curve', () => {
  const hipFlexion = articulation.dofs.find(
    (d) => articulation.joints[d.joint]?.id === 'hip_r' && d.axisName === 'flexion',
  );
  if (!hipFlexion) throw new Error('no hip flexion');
  const inertia = dofAxisInertia(articulation, hipFlexion);
  const curve = defaultPassiveCurve(inertia);

  it('is nearly silent mid-range and resists toward both limits', () => {
    const [lo, hi] = hipFlexion.range;
    const mid = passiveMoment(curve, (lo + hi) / 2, hipFlexion.range);
    expect(Math.abs(mid)).toBeLessThan(0.5);
    expect(passiveMoment(curve, hi, hipFlexion.range)).toBeLessThan(-5);
    expect(passiveMoment(curve, lo, hipFlexion.range)).toBeGreaterThan(5);
    // About 5% of the limit moment one soft zone before it.
    const nearHi = passiveMoment(curve, hi - DEFAULT_PASSIVE.softZone, hipFlexion.range);
    expect(nearHi / passiveMoment(curve, hi, hipFlexion.range)).toBeCloseTo(Math.exp(-3), 2);
  });

  it('scales with the inertia it is built for and carries a provisional citation', () => {
    const heavier = defaultPassiveCurve(inertia * 2);
    expect(heavier.upperGain / curve.upperGain).toBeCloseTo(2, 9);
    expect(curve.source.key).toBe('riener1999');
    expect(curve.source.provisional?.openQuestion).toBe('OQ-008');
    // Tens of newton-metres at the hip: the scale of measured passive hip moments.
    expect(curve.upperGain).toBeGreaterThan(5);
    expect(curve.upperGain).toBeLessThan(200);
  });
});

describe('PassiveJointModule', () => {
  it('reports every DoF as defaulted while the document carries no curves', () => {
    const module = new PassiveJointModule(articulation);
    expect(module.defaulted.length).toBe(articulation.dofs.length);
  });

  it('adds damping opposing joint velocity and end-range moments toward the range', () => {
    const module = new PassiveJointModule(articulation);
    const q = new Float64Array(articulation.nq);
    const qdot = new Float64Array(articulation.nv);
    const torque = new Float64Array(articulation.nv);
    const knee = articulation.dofs.find((d) => articulation.joints[d.joint]?.id === 'knee_r');
    if (!knee) throw new Error('no knee');
    const fake = {
      read: () => ({ fields: { q, qdot }, spec: {}, count: 1 }),
      accumulate: () => ({ fields: { torque }, spec: {}, count: 1 }),
      write: () => {
        throw new Error('unexpected');
      },
      random: undefined as never,
      dt: 1 / 500,
      config: {},
    };
    module.init(fake as never);
    // Mid-range, so only damping speaks; the knee's neutral sits on its lower limit.
    q[ROOT_NQ + knee.index] = (knee.range[0] + knee.range[1]) / 2;
    qdot[ROOT_NV + knee.index] = 2;
    module.step({ tick: 0, dt: 1 / 500, simTime: 0 });
    expect(torque[ROOT_NV + knee.index] ?? 0).toBeLessThan(0);
    torque.fill(0);
    qdot.fill(0);
    q[ROOT_NQ + knee.index] = knee.range[1];
    module.step({ tick: 1, dt: 1 / 500, simTime: 0.002 });
    expect(torque[ROOT_NV + knee.index] ?? 0).toBeLessThan(-1);
    torque.fill(0);
    q[ROOT_NQ + knee.index] = knee.range[0];
    module.step({ tick: 2, dt: 1 / 500, simTime: 0.004 });
    expect(torque[ROOT_NV + knee.index] ?? 0).toBeGreaterThan(1);
  });

  it('calms the collapsing ragdoll: less joint speed after a second than without it', async () => {
    const speedAfter = async (passive: boolean) => {
      const kernel = new Kernel({ rateHz: 500, seed: 1 });
      const physics = new PhysicsModule(new RapierBackend(), articulation, {
        ground: { height: 0 },
      });
      kernel.register(physics);
      if (passive) kernel.register(new PassiveJointModule(articulation));
      await kernel.init();
      kernel.run(500);
      const state = kernel.channels.view(physics.manifest.id, BODY_JOINT_STATE, 'write');
      const qdot = state.fields.qdot as Float64Array;
      let sum = 0;
      for (let i = ROOT_NV; i < qdot.length; i++) sum += Math.abs(qdot[i] ?? 0);
      kernel.dispose();
      return sum;
    };
    const withPassive = await speedAfter(true);
    const without = await speedAfter(false);
    expect(withPassive).toBeLessThan(without);
  });
});
