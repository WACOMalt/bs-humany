/**
 * Raising the capture budget after it filled keeps the frames it held.
 *
 * The regression this pins: the status line said "pause, raise the budget, and it carries on",
 * and doing exactly that threw the whole capture away. By the time anybody has read the message
 * the run has gone on past the last captured tick, the capture is contiguous in tick number, so
 * the first frame after the raise found a gap and started the capture over from there -- a
 * recording of several seconds became one of a single frame, and Export wrote that.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation.js';

const document = buildDocument();

async function running(captureBudgetBytes?: number): Promise<Simulation> {
  const simulation = new Simulation(
    document,
    resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 }),
    {
      profileId: 'l3_anatomical',
      backend: 'mujoco',
      passiveJoints: true,
      redistribute: true,
      dropHeight: 0.2,
      groundHeight: 0,
      muscles: true,
      captureBudgetBytes,
    },
  );
  await simulation.start();
  return simulation;
}

describe('raising a full capture budget', () => {
  it('keeps the frames held, and captures more only on a new run', async () => {
    // One tick's worth of rings, measured rather than assumed, so a budget of a few of them is a
    // few frames whatever the muscle set grows to.
    const probe = await running();
    probe.tick();
    const perFrame = probe.muscleCapture.bytes;
    probe.dispose();
    expect(perFrame).toBeGreaterThan(0);

    const simulation = await running(3 * perFrame + 1);
    for (let t = 0; t < 50 && simulation.capturesStoppedBy === undefined; t++) simulation.tick();
    expect(simulation.capturesStoppedBy).toBe('muscles');
    const held = simulation.capture.frameCount;
    expect(held).toBeGreaterThan(0);

    // The run goes on, somebody pauses and gives the capture room.
    for (let t = 0; t < 20; t++) simulation.tick();
    simulation.paused = true;
    simulation.captureBudgetBytes = 100 * perFrame;
    for (let t = 0; t < 5; t++) simulation.tick();

    expect(simulation.capture.frameCount).toBe(held);
    expect(simulation.muscleCapture.frameCount).toBe(held);
    expect(simulation.captureBehindRun).toBe(true);

    // A new run -- Reset and Start -- is what captures more, at the budget it was given.
    simulation.reset();
    for (let t = 0; t < held + 5; t++) simulation.tick();
    expect(simulation.capture.frameCount).toBeGreaterThan(held);
    expect(simulation.muscleCapture.frameCount).toBe(simulation.capture.frameCount);
    expect(simulation.captureBehindRun).toBe(false);
    simulation.dispose();
  }, 60_000);

  it('stops a bones-only capture again and says which one stopped', async () => {
    // Without muscles nothing levels the two captures, so nothing ever recorded which one had
    // stopped; the status line then had nothing to say about a capture that had stopped.
    const simulation = new Simulation(
      document,
      resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 }),
      {
        profileId: 'l1_standard',
        backend: 'mujoco',
        passiveJoints: true,
        redistribute: true,
        dropHeight: 0.2,
        groundHeight: 0,
        captureBudgetBytes: 1,
      },
    );
    await simulation.start();
    simulation.tick();
    expect(simulation.capture.frameCount).toBe(0);
    // Nothing held, so there is nothing to keep: the raise simply lets it capture.
    simulation.captureBudgetBytes = 1024 * 1024;
    for (let t = 0; t < 3; t++) simulation.tick();
    const held = simulation.capture.frameCount;
    expect(held).toBe(3);
    simulation.captureBudgetBytes = 1;
    for (let t = 0; t < 5; t++) simulation.tick();
    simulation.captureBudgetBytes = 1024 * 1024;
    simulation.tick();
    expect(simulation.capture.frameCount).toBe(held);
    expect(simulation.capturesStoppedBy).toBe('bones');
    simulation.dispose();
  }, 60_000);
});
