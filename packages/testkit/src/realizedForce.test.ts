import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { type IPhysicsBackend, ROOT_NQ, ROOT_NV, allocateBuffers } from '@bs-humany/compiler';
import { describe, expect, it } from 'vitest';
import { PENDULUM_ARM, PENDULUM_GROUND, pendulum } from './fixtures.js';

/**
 * Spec section 14.5, item 4: realized, not just commanded, per-DoF force must be readable from
 * the backend. Two situations pin the meaning down:
 *
 *   1. A motor holding the arm out against gravity. The realized force is the motor's torque,
 *      which the backend knows because it emulates motors as torques it applies.
 *   2. The arm resting on a range stop under gravity, with nothing commanded. The realized
 *      force is the stop's constraint torque, which MuJoCo reports natively. (Rapier, while it
 *      existed, could not: its native limit was opaque, and it declared the gap as `estimated`.)
 *   3. A body wrench on the arm. Muscles act only this way (muscle spec M-ADR-003), so a readout
 *      that missed it would show a muscle-driven joint carrying no actuation at all -- which is
 *      what it did until muscle spec N3.5 went looking: MuJoCo takes body wrenches through
 *      `xfrc_applied`, which never appears in `qfrc_applied`.
 */
const G = 9.80665;
const HOLD = 0.8; // radians from hanging
const gravityMoment = (angle: number) => G * PENDULUM_ARM * Math.sin(angle);

async function heldByMotor(backend: IPhysicsBackend) {
  const model = pendulum();
  await backend.init({
    dt: 1 / 1000,
    iterations: 8,
    ground: { height: PENDULUM_GROUND, contactClass: 'ground' },
  });
  await backend.compile(model);
  const buffers = allocateBuffers(model);
  backend.setJointMotorTarget(0, { position: HOLD, stiffness: 400, damping: 20, maxForce: 100 });
  for (let i = 0; i < 4000; i++) backend.step(1);
  backend.readJointState(buffers.jointState);
  const q = buffers.jointState.q[ROOT_NQ] ?? 0;
  const force = buffers.jointState.force[ROOT_NV] ?? 0;
  backend.dispose();
  return { q, force };
}

async function restingOnStop(backend: IPhysicsBackend) {
  const model = pendulum({ range: [0.5, 1.5] });
  await backend.init({
    dt: 1 / 1000,
    iterations: 8,
    ground: { height: PENDULUM_GROUND, contactClass: 'ground' },
  });
  await backend.compile(model);
  const buffers = allocateBuffers(model);
  // Start inside the range, let gravity carry the arm down onto the lower stop.
  for (let i = 0; i < 4000; i++) backend.step(1);
  backend.readJointState(buffers.jointState);
  const q = buffers.jointState.q[ROOT_NQ] ?? 0;
  const force = buffers.jointState.force[ROOT_NV] ?? 0;
  backend.dispose();
  return { q, force };
}

/**
 * One tick of a body wrench on the hanging arm, with gravity off so nothing else loads the hinge.
 *
 * The arm's centre of mass hangs `PENDULUM_ARM` below a hinge about z. A push along +x at the
 * centre of mass is a moment of `PENDULUM_ARM * push` about the hinge; a pure torque about z adds
 * to it directly. Read after one step, the realized force belongs to that step's pose, which is
 * the hanging one.
 */
async function pushedByWrench(backend: IPhysicsBackend, push: number, twist: number) {
  const model = pendulum();
  await backend.init({
    dt: 1 / 1000,
    iterations: 8,
    gravity: { x: 0, y: 0, z: 0 },
    ground: { height: PENDULUM_GROUND, contactClass: 'ground' },
  });
  await backend.compile(model);
  const buffers = allocateBuffers(model);
  backend.applyBodyWrench(1, { x: push, y: 0, z: 0 }, { x: 0, y: 0, z: twist });
  backend.step(1);
  backend.readJointState(buffers.jointState);
  const force = buffers.jointState.force[ROOT_NV] ?? 0;
  // The next step carries no wrench, so the readout must fall back to nothing rather than keep
  // reporting the last one.
  backend.step(1);
  backend.readJointState(buffers.jointState);
  const after = buffers.jointState.force[ROOT_NV] ?? 0;
  backend.dispose();
  return { force, after };
}

describe('realized per-DoF force', () => {
  it('mujoco reports the motor torque that holds the arm against gravity', async () => {
    const { q, force } = await heldByMotor(new MujocoBackend());
    // The PD motor settles a little short of its target; the torque it applies is the gravity
    // moment at the angle it actually reached.
    expect(Math.abs(q - HOLD)).toBeLessThan(0.1);
    expect(force).toBeCloseTo(gravityMoment(q), 1);
  });

  it('mujoco reports the stop’s constraint torque natively', async () => {
    const backend = new MujocoBackend();
    expect(backend.capabilities.realizedDofForce).toBe('native');
    const { q, force } = await restingOnStop(backend);
    expect(q).toBeCloseTo(0.5, 1);
    expect(force).toBeCloseTo(gravityMoment(q), 1);
  });

  it('mujoco reports the joint torque a body wrench produces', async () => {
    const push = 2;
    const twist = 0.3;
    const { force, after } = await pushedByWrench(new MujocoBackend(), push, twist);
    expect(force).toBeCloseTo(PENDULUM_ARM * push + twist, 6);
    expect(after).toBeCloseTo(0, 6);
  });

  it('mujoco reports it with sign, so an opposing wrench reads as opposing', async () => {
    const { force } = await pushedByWrench(new MujocoBackend(), -2, 0);
    expect(force).toBeCloseTo(-PENDULUM_ARM * 2, 6);
  });
});
