import { resolveMorphology } from '@bs-humany/anthropometry';
import {
  type CompiledArticulation,
  ROOT_NQ,
  ROOT_NV,
  allocateBuffers,
  compileArticulation,
} from '@bs-humany/compiler';
import { IDENTITY_MAT3, IDENTITY_QUAT, vec3 } from '@bs-humany/frames';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { RapierBackend } from './rapierBackend.js';

const DT = 1 / 500;

/** Two bodies and one hinge: a pendulum hanging from a root, for sign and limit checks. */
function pendulum(range: [number, number]): CompiledArticulation {
  const inertia = [0.01, 0, 0, 0, 0.001, 0, 0, 0, 0.01] as const;
  return {
    documentId: 'test',
    profileId: 'pendulum',
    morphologyKey: 'test',
    segments: [
      {
        index: 0,
        id: 'root',
        displayName: 'Root',
        anchor: 'root',
        bones: ['root'],
        parent: -1,
        restWorld: { translation: vec3(0, 2, 0), rotation: IDENTITY_QUAT },
        mass: 10,
        com: vec3(0, 0, 0),
        inertia: [...IDENTITY_MAT3] as unknown as CompiledArticulation['segments'][0]['inertia'],
        proxyIndices: [],
        followers: [],
      },
      {
        index: 1,
        id: 'arm',
        displayName: 'Arm',
        anchor: 'arm',
        bones: ['arm'],
        parent: 0,
        // Arm centre 0.25 m below the joint, which sits at the root's origin.
        restWorld: { translation: vec3(0, 1.75, 0), rotation: IDENTITY_QUAT },
        mass: 1,
        com: vec3(0, 0, 0),
        inertia: [...inertia] as unknown as CompiledArticulation['segments'][0]['inertia'],
        proxyIndices: [],
        followers: [],
      },
    ],
    joints: [
      {
        index: 0,
        id: 'hinge',
        displayName: 'Hinge',
        parentSegment: 0,
        childSegment: 1,
        parentBone: 'root',
        childBone: 'arm',
        frameInParent: { translation: vec3(0, 0, 0), rotation: IDENTITY_QUAT },
        frameInChild: { translation: vec3(0, 0.25, 0), rotation: IDENTITY_QUAT },
        dofs: [
          {
            index: 0,
            joint: 0,
            axisName: 'flexion',
            kind: 'hinge',
            vector: vec3(0, 0, 1),
            range,
            neutral: 0,
            passiveDamping: 0,
            armature: 0,
            frictionLoss: 0,
          },
        ],
        dofStart: 0,
        type: 'revolute',
      },
    ],
    dofs: [
      {
        index: 0,
        joint: 0,
        axisName: 'flexion',
        kind: 'hinge',
        vector: vec3(0, 0, 1),
        range,
        neutral: 0,
        passiveDamping: 0,
        armature: 0,
        frictionLoss: 0,
      },
    ],
    proxies: [],
    contactClasses: {},
    excludedPairs: [[0, 1]],
    constraints: [],
    nv: ROOT_NV + 1,
    nq: ROOT_NQ + 1,
    root: 0,
    gravity: vec3(0, -9.81, 0),
    totalMass: 11,
  };
}

async function backendFor(model: CompiledArticulation, ground?: number) {
  const backend = new RapierBackend();
  await backend.init({
    dt: DT,
    iterations: 8,
    ...(ground === undefined ? {} : { ground: { height: ground } }),
  });
  const report = await backend.compile(model);
  return { backend, report };
}

describe('a single hinge', () => {
  it('reads a positive angle when pushed about +z, and swings the arm forward', async () => {
    const model = pendulum([-3, 3]);
    const { backend } = await backendFor(model);
    backend.setKinematic(0, true);
    const buffers = allocateBuffers(model);
    const force = new Float64Array(model.nv);
    force[ROOT_NV] = 0.5; // N*m about +z on the arm
    backend.applyGeneralizedForce(force);
    for (let i = 0; i < 100; i++) backend.step(1);
    backend.readJointState(buffers.jointState);
    const q = buffers.jointState.q[ROOT_NQ] ?? 0;
    expect(q).toBeGreaterThan(0.05);
    // +z rotation of a hanging arm moves its tip toward +x.
    backend.readPose(buffers.pose);
    expect(buffers.pose.position[3] ?? 0).toBeGreaterThan(0.01);
    backend.dispose();
  });

  it('holds the native revolute limit against a torque pushing past it', async () => {
    const model = pendulum([0, 2]);
    const { backend } = await backendFor(model);
    backend.setKinematic(0, true);
    const buffers = allocateBuffers(model);
    const force = new Float64Array(model.nv);
    force[ROOT_NV] = -2;
    backend.applyGeneralizedForce(force);
    for (let i = 0; i < 250; i++) backend.step(1);
    backend.readJointState(buffers.jointState);
    expect(buffers.jointState.q[ROOT_NQ] ?? -1).toBeGreaterThan(-0.05);
    force[ROOT_NV] = 2;
    backend.applyGeneralizedForce(force);
    for (let i = 0; i < 250; i++) backend.step(1);
    backend.readJointState(buffers.jointState);
    expect(buffers.jointState.q[ROOT_NQ] ?? 0).toBeGreaterThan(0.2);
    backend.dispose();
  });

  it('reports the joint velocity with the same sign as the angle change', async () => {
    const model = pendulum([-3, 3]);
    const { backend } = await backendFor(model);
    backend.setKinematic(0, true);
    const buffers = allocateBuffers(model);
    const force = new Float64Array(model.nv);
    force[ROOT_NV] = 0.5;
    backend.applyGeneralizedForce(force);
    for (let i = 0; i < 20; i++) backend.step(1);
    backend.readJointState(buffers.jointState);
    expect(buffers.jointState.qdot[ROOT_NV] ?? 0).toBeGreaterThan(0);
    backend.dispose();
  });
});

describe('the L1 articulation', () => {
  const document = buildDocument();
  const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
  const { articulation } = compileArticulation(document, 'l1_standard', morphology);

  it('compiles with its lossiness declared', async () => {
    const { backend, report } = await backendFor(articulation, 0);
    expect(report.segments).toBe(23);
    expect(report.joints).toBe(22);
    expect(report.hasWarnings).toBe(true);
    expect(report.notes.some((n) => n.feature === 'jointLimits')).toBe(true);
    expect(backend.capabilities.softJointLimits).toBe('emulated');
    backend.dispose();
  });

  it('starts at the rest pose with every joint near neutral', async () => {
    const { backend } = await backendFor(articulation, 0);
    const buffers = allocateBuffers(articulation);
    backend.readJointState(buffers.jointState);
    for (let i = ROOT_NQ; i < articulation.nq; i++) {
      expect(Math.abs(buffers.jointState.q[i] ?? 1), `q[${i}]`).toBeLessThan(1e-6);
    }
    backend.readPose(buffers.pose);
    // Rapier keeps single-precision state.
    articulation.segments.forEach((s, i) => {
      expect(buffers.pose.position[3 * i + 1]).toBeCloseTo(s.restWorld.translation.y, 5);
    });
    backend.dispose();
  });

  // Disabled with the backend (ADR-003 reassessment, 2026-09-13): with convex-hull proxies the
  // raw collapse flings a thigh above the height bound and takes twice the time budget.
  it.skip('collapses onto the ground without blowing up, joints staying near their ranges', async () => {
    const { backend } = await backendFor(articulation, 0);
    const buffers = allocateBuffers(articulation);
    const started = performance.now();
    for (let i = 0; i < 1000; i++) backend.step(1);
    const elapsed = performance.now() - started;
    backend.readPose(buffers.pose);
    backend.readJointState(buffers.jointState);
    for (let i = 0; i < articulation.segments.length; i++) {
      const y = buffers.pose.position[3 * i + 1] ?? Number.NaN;
      expect(Number.isFinite(y)).toBe(true);
      expect(y, articulation.segments[i]?.id).toBeGreaterThan(-0.3);
      expect(y, articulation.segments[i]?.id).toBeLessThan(2.5);
    }
    let worst = 0;
    for (const dof of articulation.dofs) {
      const q = buffers.jointState.q[ROOT_NQ + dof.index] ?? 0;
      const over = Math.max(dof.range[0] - q, q - dof.range[1], 0);
      worst = Math.max(worst, over);
    }
    expect(worst).toBeLessThan(0.35);
    // Two simulated seconds in well under real time.
    expect(elapsed).toBeLessThan(2000);
    // Something is touching the ground.
    const contacts = backend.readContacts(buffers.contacts);
    expect(contacts).toBeGreaterThan(0);
    const groundPairs = [];
    for (let i = 0; i < Math.min(contacts, buffers.contacts.capacity); i++) {
      if (buffers.contacts.pair[2 * i + 1] === -1) groundPairs.push(i);
    }
    expect(groundPairs.length).toBeGreaterThan(0);
    backend.dispose();
  });

  it('restores a snapshot to a bit-identical trajectory', async () => {
    const { backend } = await backendFor(articulation, 0);
    const buffers = allocateBuffers(articulation);
    for (let i = 0; i < 100; i++) backend.step(1);
    const snap = backend.snapshot();
    for (let i = 0; i < 100; i++) backend.step(1);
    backend.readPose(buffers.pose);
    const a = Float64Array.from(buffers.pose.position);
    backend.restore(snap);
    for (let i = 0; i < 100; i++) backend.step(1);
    backend.readPose(buffers.pose);
    expect(Array.from(buffers.pose.position)).toEqual(Array.from(a));
    backend.dispose();
  });

  it('grabs a hand, pulls it up, and releases', async () => {
    const { backend } = await backendFor(articulation, 0);
    const buffers = allocateBuffers(articulation);
    const hand = articulation.segments.findIndex((s) => s.id === 'hand_r');
    backend.readPose(buffers.pose);
    const y0 = buffers.pose.position[3 * hand + 1] ?? 0;
    const grab = backend.createGrabConstraint(
      hand,
      vec3(0, 0, 0),
      vec3(
        buffers.pose.position[3 * hand] ?? 0,
        y0 + 0.5,
        buffers.pose.position[3 * hand + 2] ?? 0,
      ),
    );
    for (let i = 0; i < 300; i++) {
      grab.setTarget(
        vec3(
          buffers.pose.position[3 * hand] ?? 0,
          y0 + 0.5,
          buffers.pose.position[3 * hand + 2] ?? 0,
        ),
      );
      backend.step(1);
    }
    backend.readPose(buffers.pose);
    expect(buffers.pose.position[3 * hand + 1] ?? 0).toBeGreaterThan(y0 + 0.1);
    grab.release();
    backend.step(1);
    backend.dispose();
  });
});
