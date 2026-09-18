import { resolveMorphology } from '@bs-humany/anthropometry';
import { RapierBackend } from '@bs-humany/backend-rapier';
import { compileArticulation } from '@bs-humany/compiler';
import { vec3 } from '@bs-humany/frames';
import { Kernel } from '@bs-humany/kernel';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { BODY_POSE } from './channels.js';
import { GrabModule, INTERACTION_GRAB } from './grabModule.js';
import { PhysicsModule } from './physicsModule.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l1_standard', morphology);

describe('GrabModule', () => {
  it('lifts a hand toward the target, publishes the hold, and lets go', async () => {
    const kernel = new Kernel({ rateHz: 500, seed: 1 });
    const physics = new PhysicsModule(new RapierBackend(), articulation, { ground: { height: 0 } });
    const grab = new GrabModule(physics.backend, articulation);
    kernel.register(physics);
    kernel.register(grab);
    await kernel.init();
    const hand = articulation.segments.findIndex((s) => s.id === 'hand_r');
    const pose = kernel.channels.storage(BODY_POSE).fields.position as Float64Array;
    const y0 = pose[3 * hand + 1] ?? 0;
    const target = vec3(pose[3 * hand] ?? 0, y0 + 0.6, pose[3 * hand + 2] ?? 0);
    grab.grab(hand, vec3(0, 0, 0), target);
    const channel = kernel.channels.storage(INTERACTION_GRAB).fields;
    expect((channel.active as Uint8Array)[0]).toBe(1);
    expect((channel.segment as Int32Array)[0]).toBe(hand);
    // A leashed spring pulls with a bounded force, so the hand rises and settles around the
    // target with some overshoot; judge the average height once it is up, not one instant.
    let sum = 0;
    let peak = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 500; i++) {
      grab.moveTo(target);
      kernel.step();
      const y = pose[3 * hand + 1] ?? 0;
      peak = Math.max(peak, y);
      if (i >= 400) sum += y;
    }
    // The body collapses while the hand is held; without the grab the hand ends near the floor,
    // so holding it near its starting height is the hold working.
    expect(sum / 100).toBeGreaterThan(y0 - 0.1);
    expect(peak).toBeLessThan(y0 + 2);
    grab.release();
    kernel.step();
    expect((channel.active as Uint8Array)[0]).toBe(0);
    expect(grab.holding).toBe(false);
    kernel.dispose();
  });

  it('holds two things at once in two slots, and lets go of them separately', async () => {
    const kernel = new Kernel({ rateHz: 500, seed: 1 });
    const physics = new PhysicsModule(new RapierBackend(), articulation, { ground: { height: 0 } });
    const grab = new GrabModule(physics.backend, articulation);
    kernel.register(physics);
    kernel.register(grab);
    await kernel.init();
    const right = articulation.segments.findIndex((s) => s.id === 'hand_r');
    const left = articulation.segments.findIndex((s) => s.id === 'hand_l');
    const pose = kernel.channels.storage(BODY_POSE).fields.position as Float64Array;
    const above = (seg: number) =>
      vec3(pose[3 * seg] ?? 0, (pose[3 * seg + 1] ?? 0) + 0.5, pose[3 * seg + 2] ?? 0);
    grab.grab(right, vec3(0, 0, 0), above(right), 1, 0);
    grab.grab(left, vec3(0, 0, 0), above(left), 1, 1);
    const channel = kernel.channels.storage(INTERACTION_GRAB).fields;
    expect(Array.from((channel.active as Uint8Array).slice(0, 2))).toEqual([1, 1]);
    expect((channel.segment as Int32Array)[1]).toBe(left);
    expect(grab.holds(0) && grab.holds(1)).toBe(true);
    for (let i = 0; i < 50; i++) kernel.step();
    grab.release(1);
    kernel.step();
    expect(grab.holds(0)).toBe(true);
    expect(grab.holds(1)).toBe(false);
    expect((channel.active as Uint8Array)[1]).toBe(0);
    grab.release();
    expect(grab.holding).toBe(false);
    expect(() => grab.grab(right, vec3(0, 0, 0), above(right), 1, 9)).toThrow(RangeError);
    kernel.dispose();
  });

  it('rejects a segment index outside the articulation', async () => {
    const physics = new PhysicsModule(new RapierBackend(), articulation, {});
    const grab = new GrabModule(physics.backend, articulation);
    expect(() => grab.grab(99, vec3(0, 0, 0), vec3(0, 0, 0))).toThrow(RangeError);
  });
});
