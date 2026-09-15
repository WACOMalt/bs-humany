import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { compileArticulation } from '@bs-humany/compiler';
import { Kernel } from '@bs-humany/kernel';
import { BODY_POSE, BODY_VELOCITY, PhysicsModule } from '@bs-humany/modules-mechanics';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HEAD_SEGMENT, SENSE_VESTIBULAR, VestibularModule } from './vestibularModule.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l1_standard', morphology);
const GRAVITY = 9.80665;
const HEAD = articulation.segments.findIndex((s) => s.id === DEFAULT_HEAD_SEGMENT);

async function session() {
  const kernel = new Kernel({ rateHz: 500, seed: 1 });
  const physics = new PhysicsModule(new MujocoBackend(), articulation, { ground: { height: 0 } });
  kernel.register(physics);
  kernel.register(new VestibularModule(articulation));
  await kernel.init();
  const sense = kernel.channels.storage(SENSE_VESTIBULAR).fields;
  const pose = kernel.channels.storage(BODY_POSE).fields;
  const velocity = kernel.channels.storage(BODY_VELOCITY).fields;
  const three = (field: unknown, at = 0) =>
    Array.from((field as Float64Array).subarray(3 * at, 3 * at + 3));
  return {
    kernel,
    physics,
    specificForce: () => three(sense.specificForce),
    angularVelocity: () => three(sense.angularVelocity),
    tilt: () => (sense.tiltFromVertical as Float64Array)[0] ?? 0,
    headSpin: () => three(velocity.angular, HEAD),
    headOrientation: () =>
      Array.from((pose.orientation as Float64Array).subarray(4 * HEAD, 4 * HEAD + 4)),
  };
}

const magnitude = (v: readonly number[]) => Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);

describe('VestibularModule', () => {
  it('finds the head, and stands down where a profile has no such segment', () => {
    expect(new VestibularModule(articulation).segment).toBe(HEAD);
    expect(new VestibularModule(articulation, { segment: 'no_such_bone' }).segment).toBe(-1);
  });

  it('publishes nothing on the first tick, having nothing to differentiate', async () => {
    const s = await session();
    s.kernel.run(1);
    expect(s.specificForce()).toEqual([0, 0, 0]);
    s.kernel.dispose();
  });

  it('reads one g once the ground is holding the body up', async () => {
    const s = await session();
    s.kernel.run(2000);
    // At rest the only force on the head beyond gravity is the body holding it up, and that is
    // exactly what an otolith reads: one g, in whatever direction the head came to lie.
    expect(magnitude(s.specificForce())).toBeCloseTo(GRAVITY, 1);
    s.kernel.dispose();
  });

  it('reads nothing at all in free fall, which is what weightlessness is', async () => {
    const s = await session();
    // Two ticks to prime the difference, while the body is still only falling.
    s.kernel.run(3);
    expect(magnitude(s.specificForce())).toBeLessThan(0.5);
    s.kernel.dispose();
  });

  it('follows the gravity actually in force, not the one compiled in', async () => {
    const s = await session();
    s.kernel.run(2000);
    expect(magnitude(s.specificForce())).toBeCloseTo(GRAVITY, 1);
    // Switch gravity off and the ground stops having to hold anything up.
    s.physics.setGravity({ x: 0, y: 0, z: 0 });
    s.kernel.run(200);
    expect(magnitude(s.specificForce())).toBeLessThan(0.5);
    s.physics.setGravity({ x: 0, y: -GRAVITY, z: 0 });
    s.kernel.run(400);
    expect(magnitude(s.specificForce())).toBeCloseTo(GRAVITY, 1);
    s.kernel.dispose();
  });

  it('senses rotation in the head frame, which a rotation cannot lengthen', async () => {
    const s = await session();
    s.kernel.run(60);
    // The canals report the same turning the solver does, seen from the head rather than the
    // world. Rotating a vector does not change its length, so a wrong frame shows up here.
    expect(magnitude(s.angularVelocity())).toBeCloseTo(magnitude(s.headSpin()), 9);
    expect(magnitude(s.headSpin())).toBeGreaterThan(0.01);
    s.kernel.dispose();
  });

  it('reports tilt as the angle between the head’s own up and the force it feels', async () => {
    const s = await session();
    s.kernel.run(2000);
    const force = s.specificForce();
    const expected = Math.acos((force[1] ?? 0) / magnitude(force));
    expect(s.tilt()).toBeCloseTo(expected, 9);
    // The body has collapsed by now, so the head is not upright and the angle says so.
    expect(s.tilt()).toBeGreaterThan(0.2);
    s.kernel.dispose();
  });
});
