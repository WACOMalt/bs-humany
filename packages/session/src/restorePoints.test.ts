/**
 * What a run holds on to while it goes on, and where Reset takes it.
 *
 * Three things grew for as long as a run did. The timeline kept a kernel snapshot every tenth of
 * a second, up to six hundred of them -- about four megabytes each with the muscle set, two and a
 * third gigabytes in all -- although the studio's timeline plays the captures back and never
 * restored one. The sampled recording grew fifty samples a simulated second with no bound at all.
 * And the ring capture took a frame every tick although the bellies are swept one tick in four.
 * These pin all three to what is read, and pin that Reset goes to the start of the run -- the
 * scenario's tick 0 on the body that is running -- after a carry or a restore as well, rather
 * than to wherever the carry or the restore put it.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { BODY_JOINT_STATE, BODY_POSE } from '@bs-humany/modules-mechanics';
import { DEFAULT_UPDATE_HZ, rateDivisorFor } from '@bs-humany/modules-muscle';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { Simulation, type SimulationOptions } from './simulation.js';

const document = buildDocument();

/** L1 at its own 500 Hz, which runs the whole muscle set at a fraction of L3's cost. */
function build(extra: Partial<SimulationOptions> = {}, stature = 1.7): Simulation {
  return new Simulation(document, resolveMorphology({ sex: 0.5, stature, mass: 70 }), {
    profileId: 'l1_standard',
    backend: 'mujoco',
    passiveJoints: true,
    redistribute: true,
    dropHeight: 0.2,
    groundHeight: 0,
    ...extra,
  });
}

/** A copy of the segment poses, for a bitwise comparison later. */
function pose(simulation: Simulation): { position: Float64Array; orientation: Float64Array } {
  const fields = simulation.channel(BODY_POSE).fields;
  return {
    position: Float64Array.from(fields.position as Float64Array),
    orientation: Float64Array.from(fields.orientation as Float64Array),
  };
}

function expectSamePose(
  simulation: Simulation,
  expected: { position: Float64Array; orientation: Float64Array },
): void {
  const now = pose(simulation);
  expect(Array.from(now.position)).toEqual(Array.from(expected.position));
  expect(Array.from(now.orientation)).toEqual(Array.from(expected.orientation));
}

describe('Reset', () => {
  it('goes back to the start of the run, bitwise, and empties both captures', async () => {
    const simulation = build({ muscles: true });
    await simulation.start();
    const start = pose(simulation);
    for (let t = 0; t < 500; t++) simulation.tick();
    expect(simulation.capture.frameCount).toBe(500);
    simulation.reset();
    expect(simulation.ticks).toBe(0);
    expectSamePose(simulation, start);
    expect(simulation.capture.frameCount).toBe(0);
    expect(simulation.muscleCapture.frameCount).toBe(0);
    simulation.dispose();
  }, 60_000);

  it('goes to tick 0 of the new body after a carry, not to the tick the carry began at', async () => {
    // The Drop, a Stature change mid-fall, Reset: what the studio does when a slider is moved
    // during a run is build a new body and carry the old one's joint state into it.
    const old = build();
    await old.start();
    for (let t = 0; t < 200; t++) old.tick();
    const state = old.jointState();

    const carried = build({}, 1.85);
    await carried.start();
    const start = pose(carried);
    carried.carryFrom(state, old.ticks);
    expect(carried.ticks).toBe(200);
    for (let t = 0; t < 50; t++) carried.tick();
    carried.reset();
    expect(carried.ticks).toBe(0);
    // The scenario's start at the new stature, which is the pose this body started in.
    expectSamePose(carried, start);
    old.dispose();
    carried.dispose();
  }, 60_000);

  it('goes to tick 0 after a session restore, not to the tick the session was saved at', async () => {
    const saved = build();
    await saved.start();
    for (let t = 0; t < 150; t++) saved.tick();
    const snapshot = saved.snapshot();

    const loaded = build();
    await loaded.start();
    const start = pose(loaded);
    loaded.restore(snapshot, saved.ticks);
    expect(loaded.ticks).toBe(150);
    for (let t = 0; t < 20; t++) loaded.tick();
    loaded.reset();
    expect(loaded.ticks).toBe(0);
    expectSamePose(loaded, start);
    saved.dispose();
    loaded.dispose();
  }, 60_000);
});

describe('what a long run holds', () => {
  it('holds the captures and a constant, and captures the rings once a sweep', async () => {
    const simulation = build({ muscles: true });
    await simulation.start();
    // A few ticks first, so what is measured is the run and not the first allocations of it.
    for (let t = 0; t < 20; t++) simulation.tick();
    const before = process.memoryUsage().arrayBuffers;
    const heldBefore = simulation.capture.bytes + simulation.muscleCapture.bytes;
    const ticks = 3000;
    for (let t = 0; t < ticks; t++) simulation.tick();
    const grown = process.memoryUsage().arrayBuffers - before;
    const held = simulation.capture.bytes + simulation.muscleCapture.bytes - heldBefore;
    // The captures, and a constant for what the captures' last chunks hold ahead of their frames
    // and for the engine's own churn. The timeline alone used to add sixty snapshots over these
    // six simulated seconds, about four megabytes apiece.
    expect(grown).toBeLessThan(held + 32 * 1024 * 1024);

    // The rings, once a sweep: one tick in four at 500 Hz. Every bone tick finds a ring frame no
    // more than a sweep's divisor, less one, older than itself.
    const divisor = rateDivisorFor(simulation.stepsPerSecond, DEFAULT_UPDATE_HZ);
    expect(divisor).toBe(4);
    const total = ticks + 20;
    expect(simulation.capture.frameCount).toBe(total);
    expect(simulation.muscleCapture.frameCount).toBe(Math.ceil(total / divisor));
    const rings = simulation.muscleCapture;
    for (let tick = 1; tick <= total; tick++) {
      const age = tick - rings.tickAt(rings.indexForTick(tick));
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThanOrEqual(divisor - 1);
    }
    simulation.dispose();
  }, 120_000);
});

describe('the sampled recording', () => {
  it('stops at the capture budget, keeping what it has, and goes on when given room', async () => {
    const budget = 64 * 1024;
    const simulation = build({ captureBudgetBytes: budget });
    await simulation.start();
    // Seven numbers a segment, one a joint coordinate, and the tick, time and two energies.
    const segments = simulation.articulation.segments.length;
    const q = (simulation.channel(BODY_JOINT_STATE).fields.q as Float64Array).length;
    const sampleBytes = (7 * segments + q + 4) * 8;
    const room = Math.floor(budget / sampleBytes);
    // Ten ticks a sample at 500 Hz, and well past the room.
    for (let t = 0; t < 10 * (room + 20); t++) simulation.tick();
    expect(simulation.recordingStopped).toBe(true);
    expect(simulation.recording.samples).toHaveLength(room);
    expect(simulation.recording.samples[0]?.tick).toBe(0);
    expect(simulation.recordingBytes).toBeLessThanOrEqual(budget);
    expect(JSON.parse(simulation.exportRecording()).samples).toHaveLength(room);

    simulation.captureBudgetBytes = 2 * budget;
    expect(simulation.recordingStopped).toBe(false);
    for (let t = 0; t < 20; t++) simulation.tick();
    expect(simulation.recording.samples).toHaveLength(room + 2);
    simulation.dispose();
  }, 60_000);
});

describe('restore points', () => {
  it('keep a window, and a scrub lands on the tick asked for, as a straight run does', async () => {
    const simulation = build({ restorePoints: 10, snapshotEverySeconds: 0.1 });
    await simulation.start();
    // Four seconds: forty restore points taken, the newest ten kept.
    for (let t = 0; t < 2000; t++) simulation.tick();
    // Inside the window, and far behind it, where only the start of the run is left.
    for (const seconds of [3.5, 0.5]) {
      simulation.scrubTo(seconds);
      const target = Math.round(seconds / simulation.dt);
      expect(simulation.ticks).toBe(target);
      const straight = build();
      await straight.start();
      for (let t = 0; t < target; t++) straight.tick();
      expectSamePose(simulation, pose(straight));
      straight.dispose();
    }
    simulation.dispose();
  }, 120_000);

  it('are none by default, and the start of the run still answers a scrub', async () => {
    const simulation = build();
    await simulation.start();
    for (let t = 0; t < 300; t++) simulation.tick();
    simulation.scrubTo(0.2);
    expect(simulation.ticks).toBe(100);
    simulation.dispose();
  }, 60_000);
});
