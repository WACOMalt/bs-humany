/**
 * What a hand in a headset asks of the simulation, applied.
 *
 * The viewer writes a slot per hand: squeezing or not, which bone, where it took hold, where the
 * hand is now and which way it is turned, all already in the simulation's frame. This does what
 * the studio's Ctrl-click does with it: finds the segment behind the bone, expresses the grabbed
 * point in that segment's own frame, and holds it toward the hand -- and, from the hand's turn
 * since the grab, which way the segment should face. Each hand is its own grab slot, so both can
 * hold at once. Shared by the headless publisher and the studio, so there is one of it.
 *
 * It also keeps watch on the viewer. The slots are the viewer's last word, and a viewer that is
 * killed, or stops drawing, leaves its last word in the file: a hand squeezing a bone, held for
 * ever, and taken hold of again after every reset. The viewer rewrites the slots every frame it
 * draws, so the count of writes in the file's header climbs while it is there; given that count
 * and the reader's own clock, a count that has not moved for `GRAB_QUIET_MS` means both hands are
 * read as open.
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

/**
 * How long the viewer's write count may stand still before its hands are read as open. A viewer
 * that is drawing writes every frame, about 11 ms apart at 90 Hz, and the slowest reader, the
 * studio's page, looks about once a frame of its own; a quarter of a second is a score of missed
 * frames on either side, which no live viewer comes near, and short enough that a body left
 * hanging from a hand that has gone drops before anyone wonders why.
 */
export const GRAB_QUIET_MS = 250;

/**
 * An open hand, stated: active false rather than no reading at all. An unreadable slot leaves a
 * grab as it was, which is right for a slot caught mid-write and wrong for a viewer that has gone.
 */
const OPEN_HAND: GrabIntent = {
  active: false,
  bone: -1,
  point: [0, 0, 0],
  target: [0, 0, 0],
  strength: 0,
  rotation: [0, 0, 0, 1],
};
const BOTH_OPEN: readonly GrabIntent[] = [OPEN_HAND, OPEN_HAND];

export class GrabIntents {
  readonly held: [Held | null, Held | null] = [null, null];
  grabsSeen = 0;
  /** Whether the viewer's write count has stood still past `GRAB_QUIET_MS`, as of the last apply. */
  quiet = false;
  /** The write count last seen, and the reader's time when it last moved. */
  private lastWritten: bigint | undefined;
  private movedAt = 0;

  /**
   * Apply both hands' intents to the simulation, in grab slots 0 and 1.
   *
   * `written` is the grab file's write count from the same read as `hands`, and `nowMs` the
   * caller's own clock; given both, a count that has not moved for `GRAB_QUIET_MS` makes both
   * hands open, whatever the slots say. The watch outlives `letGo`, so the stale slots cannot
   * take hold again after a reset. Any change of count is the viewer writing, a smaller one
   * included, because a viewer that started again counts from zero. The first count seen is taken
   * as a change too: one look cannot tell a live viewer from a dead one, and the allowance is what
   * decides. Without them, no watch is kept.
   *
   * True on the call that let go of something because the viewer went quiet, so the caller can
   * say so, once.
   */
  apply(
    simulation: Simulation,
    order: readonly string[],
    hands: readonly (GrabIntent | undefined)[],
    strength: number,
    written?: bigint,
    nowMs?: number,
  ): boolean {
    let wentQuiet = false;
    let read = hands;
    if (written !== undefined && nowMs !== undefined) {
      if (written !== this.lastWritten) {
        this.lastWritten = written;
        this.movedAt = nowMs;
        this.quiet = false;
      } else if (nowMs - this.movedAt > GRAB_QUIET_MS) {
        if (!this.quiet) {
          this.quiet = true;
          wentQuiet = this.held[0] !== null || this.held[1] !== null;
        }
        read = BOTH_OPEN;
      }
    }
    for (let hand = 0; hand < 2; hand++) {
      const intent = read[hand];
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
    return wentQuiet;
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
