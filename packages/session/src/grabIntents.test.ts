/**
 * A hand in the headset, applied -- and let go of when the headset stops saying anything.
 *
 * The viewer rewrites both hands' slots every frame it draws, and a viewer that is killed, or
 * stops drawing, leaves its last slots in the file: a squeezing hand on a bone, for ever. What
 * tells the two apart is the header's write count, which a live viewer keeps climbing, held
 * against the reader's own clock. These drive `GrabIntents` with a stand-in simulation that
 * records what it is asked to do, so the only thing under test is what is asked.
 */

import type { GrabIntent } from '@bs-humany/pose-bridge/codec';
import { describe, expect, it, vi } from 'vitest';
import { GRAB_QUIET_MS, GrabIntents } from './grabIntents.js';
import type { Simulation } from './simulation.js';

const order = ['pelvis', 'humerus_r', 'radius_r'];

/** A simulation with one segment behind every bone, standing at the origin unturned. */
function fakeSimulation() {
  const grab = { grab: vi.fn(), moveTo: vi.fn(), release: vi.fn() };
  const simulation = {
    segmentOfBone: (bone: string) => order.indexOf(bone),
    segmentPose: () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
    grab,
  } as unknown as Simulation;
  return { simulation, grab };
}

/** The left hand squeezing the forearm, as the viewer's last frame left it. */
const squeezing: GrabIntent = {
  active: true,
  bone: 2,
  point: [0.1, 1.2, 0.3],
  target: [0.15, 1.25, 0.3],
  strength: 1,
  rotation: [0, 0, 0, 1],
};
const hands = [squeezing, undefined] as const;

describe('GrabIntents', () => {
  it('lets go when the viewer stops writing, and says so once', () => {
    const { simulation, grab } = fakeSimulation();
    const intents = new GrabIntents();
    // The same count at every read: a viewer that wrote this frame and then nothing more.
    expect(intents.apply(simulation, order, hands, 1, 41n, 0)).toBe(false);
    expect(grab.grab).toHaveBeenCalledTimes(1);
    expect(intents.holding()).toEqual(['radius_r']);

    // Inside the allowance the grab carries on toward the hand.
    expect(intents.apply(simulation, order, hands, 1, 41n, 100)).toBe(false);
    expect(grab.moveTo).toHaveBeenCalledTimes(1);
    expect(grab.release).not.toHaveBeenCalled();

    // Past it, the stale squeeze is read as an open hand.
    expect(400).toBeGreaterThan(GRAB_QUIET_MS);
    expect(intents.apply(simulation, order, hands, 1, 41n, 400)).toBe(true);
    expect(grab.release).toHaveBeenCalledWith(0);
    expect(intents.holding()).toEqual([]);
    expect(intents.quiet).toBe(true);

    // Still quiet: nothing more to let go of, and nothing more said.
    expect(intents.apply(simulation, order, hands, 1, 41n, 500)).toBe(false);
    expect(grab.release).toHaveBeenCalledTimes(1);
    expect(grab.grab).toHaveBeenCalledTimes(1);
  });

  it('does not take hold again from the same stale slots after a reset', () => {
    const first = fakeSimulation();
    const intents = new GrabIntents();
    intents.apply(first.simulation, order, hands, 1, 41n, 0);
    intents.apply(first.simulation, order, hands, 1, 41n, 400);
    // Reset, or a rebuild: a new simulation and every grab let go. The watchdog is the link's,
    // not the simulation's, so it still knows the viewer has said nothing new.
    intents.letGo(first.simulation);
    const second = fakeSimulation();
    intents.apply(second.simulation, order, hands, 1, 41n, 450);
    intents.apply(second.simulation, order, hands, 1, 41n, 900);
    expect(second.grab.grab).not.toHaveBeenCalled();
    expect(intents.holding()).toEqual([]);

    // The viewer speaking again, with the hand still squeezing, is a grab again.
    intents.apply(second.simulation, order, hands, 1, 43n, 950);
    expect(second.grab.grab).toHaveBeenCalledTimes(1);
    expect(intents.quiet).toBe(false);
  });

  it('keeps holding while the viewer keeps writing, however long', () => {
    const { simulation, grab } = fakeSimulation();
    const intents = new GrabIntents();
    for (let frame = 0; frame < 100; frame++) {
      // Two slot writes a frame at about 90 Hz: eleven milliseconds apart, for over a second.
      intents.apply(simulation, order, hands, 1, BigInt(2 * frame), frame * 11);
    }
    expect(grab.grab).toHaveBeenCalledTimes(1);
    expect(grab.moveTo).toHaveBeenCalledTimes(99);
    expect(grab.release).not.toHaveBeenCalled();
    expect(intents.holding()).toEqual(['radius_r']);
  });

  it('counts a viewer that started again from zero as one that is writing', () => {
    const { simulation, grab } = fakeSimulation();
    const intents = new GrabIntents();
    intents.apply(simulation, order, hands, 1, 900n, 0);
    // A new viewer truncates the file and counts from nothing; a smaller number is a change.
    intents.apply(simulation, order, hands, 1, 0n, 200);
    intents.apply(simulation, order, hands, 1, 0n, 400);
    expect(grab.release).not.toHaveBeenCalled();
    intents.apply(simulation, order, hands, 1, 0n, 451);
    expect(grab.release).toHaveBeenCalledWith(0);
  });

  it('keeps no watch when the caller gives no count, as before', () => {
    const { simulation, grab } = fakeSimulation();
    const intents = new GrabIntents();
    intents.apply(simulation, order, hands, 1);
    intents.apply(simulation, order, hands, 1);
    expect(grab.grab).toHaveBeenCalledTimes(1);
    expect(grab.moveTo).toHaveBeenCalledTimes(1);
    expect(grab.release).not.toHaveBeenCalled();
  });
});
