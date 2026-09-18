/**
 * What a hand in a headset asks of the simulation, applied.
 *
 * The viewer writes a slot per hand: squeezing or not, which bone, where it took hold, where the
 * hand is now and which way it is turned, all already in the simulation's frame. This does what
 * the studio's Ctrl-click does with it: finds the segment behind the bone, expresses the grabbed
 * point in that segment's own frame, and holds it toward the hand -- and, from the hand's turn
 * since the grab, which way the segment should face. Each hand is its own grab slot, so both can
 * hold at once. Shared by the headless publisher and the studio, so there is one of it.
 */

import type { GrabIntent } from '@bs-humany/pose-bridge/codec';
import type { Simulation } from './simulation.js';

interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export interface Held {
  readonly segment: number;
  readonly bone: string;
  /** The hand's orientation at the moment of the grab, and the segment's. */
  readonly handAtGrab: Quat;
  readonly segmentAtGrab: Quat;
}

const qmul = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
const qconj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

export class GrabIntents {
  readonly held: [Held | null, Held | null] = [null, null];
  grabsSeen = 0;

  /** Apply both hands' intents to the simulation, in grab slots 0 and 1. */
  apply(
    simulation: Simulation,
    order: readonly string[],
    hands: readonly (GrabIntent | undefined)[],
    strength: number,
  ): void {
    for (let hand = 0; hand < 2; hand++) {
      const intent = hands[hand];
      if (!intent) continue;
      const holding = this.held[hand] ?? null;
      if (intent.active) {
        if (holding === null && intent.bone >= 0 && intent.bone < order.length) {
          const bone = order[intent.bone] as string;
          const segment = simulation.segmentOfBone(bone);
          if (segment < 0) continue;
          const at = simulation.segmentPose(segment);
          const [px, py, pz] = intent.point;
          // The grabbed point in the segment's frame: its offset from the segment's position,
          // rotated back by the inverse of the segment's orientation -- what `beginGrab` does.
          const dx = px - at.position.x;
          const dy = py - at.position.y;
          const dz = pz - at.position.z;
          const { x, y, z, w } = at.rotation;
          // conj(q) * v * q, expanded.
          const ix = w * dx - y * dz + z * dy;
          const iy = w * dy - z * dx + x * dz;
          const iz = w * dz - x * dy + y * dx;
          const iw = x * dx + y * dy + z * dz;
          const local = {
            x: ix * w + iw * x - iy * z + iz * y,
            y: iy * w + iw * y - iz * x + ix * z,
            z: iz * w + iw * z - ix * y + iy * x,
          };
          const [tx, ty, tz] = intent.target;
          simulation.grab.grab(segment, local, { x: tx, y: ty, z: tz }, strength, hand);
          const [hx, hy, hz, hw] = intent.rotation;
          this.held[hand] = {
            segment,
            bone,
            handAtGrab: { x: hx, y: hy, z: hz, w: hw },
            segmentAtGrab: { ...at.rotation },
          };
          this.grabsSeen += 1;
        } else if (holding !== null) {
          const [tx, ty, tz] = intent.target;
          const [hx, hy, hz, hw] = intent.rotation;
          // target orientation = hand_now * conj(hand_at_grab) * segment_at_grab
          const delta = qmul({ x: hx, y: hy, z: hz, w: hw }, qconj(holding.handAtGrab));
          simulation.grab.moveTo({ x: tx, y: ty, z: tz }, hand, qmul(delta, holding.segmentAtGrab));
        }
      } else if (holding !== null) {
        simulation.grab.release(hand);
        this.held[hand] = null;
      }
    }
  }

  /** Let go of everything, as before a reset or a rebuild. */
  letGo(simulation: Simulation | null): void {
    simulation?.grab.release();
    this.held[0] = null;
    this.held[1] = null;
  }

  /** The bones held, for a status line. */
  holding(): string[] {
    return this.held.filter((h): h is Held => h !== null).map((h) => h.bone);
  }
}
