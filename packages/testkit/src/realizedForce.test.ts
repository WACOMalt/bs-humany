import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { RapierBackend } from '@bs-humany/backend-rapier';
import { type IPhysicsBackend, ROOT_NQ, ROOT_NV, allocateBuffers } from '@bs-humany/compiler';
import { describe, expect, it } from 'vitest';
import { PENDULUM_ARM, PENDULUM_GROUND, pendulum } from './fixtures.js';

/**
 * Spec section 14.5, item 4: realized, not just commanded, per-DoF force must be readable from
 * both backends. Two situations pin the meaning down:
 *
 *   1. A motor holding the arm out against gravity. The realized force is the motor's torque,
 *      which both backends know because both emulate motors as torques they apply.
 *   2. The arm resting on a range stop under gravity, with nothing commanded. The realized
 *      force is the stop's constraint torque. MuJoCo reports it natively; Rapier's native
 *      revolute limit is opaque, so its estimate is what was commanded plus what it emulated,
 *      which here is nothing. That gap is declared in its capabilities as `estimated`.
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

describe('realized per-DoF force', () => {
  it.each([
    ['rapier', () => new RapierBackend()],
    ['mujoco', () => new MujocoBackend()],
  ] as const)(
    '%s reports the motor torque that holds the arm against gravity',
    async (_name, make) => {
      const { q, force } = await heldByMotor(make());
      // The PD motor settles a little short of its target; the torque it applies is the gravity
      // moment at the angle it actually reached.
      expect(Math.abs(q - HOLD)).toBeLessThan(0.1);
      expect(force).toBeCloseTo(gravityMoment(q), 1);
    },
  );

  it('mujoco reports the stop’s constraint torque natively', async () => {
    const backend = new MujocoBackend();
    expect(backend.capabilities.realizedDofForce).toBe('native');
    const { q, force } = await restingOnStop(backend);
    expect(q).toBeCloseTo(0.5, 1);
    expect(force).toBeCloseTo(gravityMoment(q), 1);
  });

  it('rapier estimates only what it applied, and says so', async () => {
    const backend = new RapierBackend();
    expect(backend.capabilities.realizedDofForce).toBe('estimated');
    const { q, force } = await restingOnStop(backend);
    expect(q).toBeCloseTo(0.5, 1);
    // Nothing commanded, nothing emulated on a one-DoF joint: the native limit's torque is
    // invisible to the estimate. This is the documented gap, not a passing test dressed up.
    expect(Math.abs(force)).toBeLessThan(1e-9);
  });
});
