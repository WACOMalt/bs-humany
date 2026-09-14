import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { RapierBackend } from '@bs-humany/backend-rapier';
import { type IPhysicsBackend, ROOT_NQ, ROOT_NV, compileArticulation } from '@bs-humany/compiler';
import { Kernel, type SimModule } from '@bs-humany/kernel';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import {
  ACTUATION_JOINT_TORQUE,
  BODY_JOINT_STATE,
  BODY_POSE,
  CHANNEL_VERSION,
  CONTACT_MANIFOLDS,
} from './channels.js';
import { PhysicsModule } from './physicsModule.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l1_standard', morphology);

function physics(backend: IPhysicsBackend = new RapierBackend()) {
  return new PhysicsModule(backend, articulation, {
    ground: { height: 0 },
    iterations: 8,
  });
}

/** A test actuator pushing one DoF with a constant torque. */
function pusher(dof: number, torque: number): SimModule {
  let out: Float64Array | undefined;
  return {
    manifest: {
      id: 'test.pusher',
      version: '1.0.0',
      phase: 'actuate',
      dependsOn: [],
      reads: [],
      writes: [],
      accumulates: [{ id: ACTUATION_JOINT_TORQUE, version: CHANNEL_VERSION }],
      gives: [],
    },
    init(ctx) {
      const f = ctx.accumulate(ACTUATION_JOINT_TORQUE).fields.torque;
      if (f instanceof Float64Array) out = f;
    },
    step() {
      if (out) out[dof] = (out[dof] ?? 0) + torque;
    },
  };
}

describe('PhysicsModule', () => {
  it('publishes the rest pose into body.pose at init and keeps the compile report', async () => {
    const kernel = new Kernel({ rateHz: 500, seed: 1 });
    const module = physics();
    kernel.register(module);
    await kernel.init();
    expect(module.report?.backend).toBe('rapier');
    const pose = kernel.channels.view(module.manifest.id, BODY_POSE, 'write');
    const position = pose.fields.position as Float64Array;
    articulation.segments.forEach((s, i) => {
      expect(position[3 * i + 1]).toBeCloseTo(s.restWorld.translation.y, 5);
    });
    kernel.dispose();
  });

  it('lets the body fall under the kernel clock and reports contacts', async () => {
    const kernel = new Kernel({ rateHz: 500, seed: 1 });
    // On the enabled backend; the vestigial Rapier stands on its hull feet for longer than the
    // second this test allows. The other tests keep Rapier for what only it supports (kinematic
    // switching at runtime).
    const module = physics(new MujocoBackend());
    kernel.register(module);
    await kernel.init();
    kernel.run(500);
    const pose = kernel.channels.view(module.manifest.id, BODY_POSE, 'write');
    const position = pose.fields.position as Float64Array;
    const head = articulation.segments.findIndex((s) => s.id === 'head');
    const restY = articulation.segments[head]?.restWorld.translation.y ?? 0;
    expect(position[3 * head + 1] ?? 0).toBeLessThan(restY - 0.3);
    const contacts = kernel.channels.view(module.manifest.id, CONTACT_MANIFOLDS, 'write');
    expect(contacts.count).toBeGreaterThan(0);
    expect(module.contactsSeen).toBeGreaterThanOrEqual(contacts.count);
    kernel.dispose();
  });

  it('applies accumulated joint torque from an actuate-phase module', async () => {
    const kernel = new Kernel({ rateHz: 500, seed: 1 });
    const module = physics();
    const knee = articulation.joints.find((j) => j.id === 'knee_r');
    if (!knee) throw new Error('no knee');
    // Hold the pelvis so the knee response is not lost in the fall.
    kernel.register(module);
    kernel.register(pusher(ROOT_NV + knee.dofStart, 30));
    await kernel.init();
    module.backend.setKinematic(articulation.root, true);
    kernel.run(100);
    const state = kernel.channels.view(module.manifest.id, BODY_JOINT_STATE, 'write');
    const q = state.fields.q as Float64Array;
    expect(q[ROOT_NQ + knee.dofStart] ?? 0).toBeGreaterThan(0.05);
    kernel.dispose();
  });

  it('round-trips through a kernel snapshot bit for bit', async () => {
    const kernel = new Kernel({ rateHz: 500, seed: 1 });
    const module = physics();
    kernel.register(module);
    await kernel.init();
    kernel.run(120);
    const snapshot = kernel.snapshot();
    kernel.run(80);
    const a = kernel.stateHash();
    kernel.restore(snapshot);
    kernel.run(80);
    expect(kernel.stateHash()).toBe(a);
    kernel.dispose();
  });
});
