/**
 * `GrabModule` -- milestone M3.11.
 *
 * Direct manipulation: pick a point on a segment, drag it toward a world target through a
 * constraint, let go. The constraint itself is the backend's (`createGrabConstraint`); the
 * module owns its lifetime, keeps the target current in the `actuate` phase so a grab moves at
 * simulation rate rather than at pointer rate, holds up to `MAX_GRABS` of them in numbered slots, and publishes `interaction.grab` so overlays and
 * tests can see what is being held without reaching into the backend.
 */

import type { CompiledArticulation, GrabHandle, IPhysicsBackend } from '@bs-humany/compiler';
import type { Quat, Vec3 } from '@bs-humany/frames';
import type {
  ChannelSpec,
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  SimModule,
} from '@bs-humany/kernel';
import { BODY_POSE, CHANNEL_VERSION } from './channels.js';
import { qRotate } from './qmath.js';

/** Metres the target may lead the held point; matches the backend's spring sizing. */
export const GRAB_LEASH = 0.3;
/** How many things can be held at once: two hands in a headset, with room to spare. */
export const MAX_GRABS = 4;

export const GRAB_MODULE_ID = 'bsums.xyz.bs-humany.grab';
export const INTERACTION_GRAB = 'interaction.grab';

export function interactionGrabSpec(): ChannelSpec {
  return {
    id: INTERACTION_GRAB,
    version: CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      { name: 'active', dtype: 'u8', components: 1 },
      { name: 'segment', dtype: 'i32', components: 1 },
      { name: 'point', dtype: 'f64', components: 3 },
      { name: 'target', dtype: 'f64', components: 3 },
    ],
    elementCount: MAX_GRABS,
    mode: 'single-writer',
    backing: 'shared',
  };
}

/** One hold: which segment, where on it, and where it is being pulled toward. */
interface Slot {
  handle: GrabHandle | undefined;
  segment: number;
  readonly point: { x: number; y: number; z: number };
  readonly target: { x: number; y: number; z: number };
  readonly local: Float64Array;
}

/**
 * Several holds at once, in numbered slots. The studio's pointer uses slot 0 and never says so;
 * a headset uses one slot per hand. Each slot is its own constraint in the backend, which holds
 * any number of them; what this owns is their lifetimes and their targets.
 */
export class GrabModule implements SimModule {
  readonly manifest: ModuleManifest;
  private readonly slots: Slot[] = Array.from({ length: MAX_GRABS }, () => ({
    handle: undefined,
    segment: -1,
    point: { x: 0, y: 0, z: 0 },
    target: { x: 0, y: 0, z: 0 },
    local: new Float64Array(3),
  }));
  private position: Float64Array | undefined;
  private orientation: Float64Array | undefined;
  private readonly held = new Float64Array(3);
  private readonly leashed = { x: 0, y: 0, z: 0 };
  private active: Uint8Array | undefined;
  private segmentOut: Int32Array | undefined;
  private pointOut: Float64Array | undefined;
  private targetOut: Float64Array | undefined;

  constructor(
    readonly backend: IPhysicsBackend,
    readonly articulation: CompiledArticulation,
  ) {
    this.manifest = {
      id: GRAB_MODULE_ID,
      version: '1.0.0',
      phase: 'actuate',
      dependsOn: [],
      reads: [{ id: BODY_POSE, version: CHANNEL_VERSION }],
      writes: [{ id: INTERACTION_GRAB, version: CHANNEL_VERSION }],
      accumulates: [],
      gives: [interactionGrabSpec()],
    };
  }

  init(ctx: ModuleInitContext): void {
    const pose = ctx.read(BODY_POSE);
    this.position = pose.fields.position as Float64Array;
    this.orientation = pose.fields.orientation as Float64Array;
    const view = ctx.write(INTERACTION_GRAB);
    this.active = view.fields.active as Uint8Array;
    this.segmentOut = view.fields.segment as Int32Array;
    this.pointOut = view.fields.point as Float64Array;
    this.targetOut = view.fields.target as Float64Array;
    this.publish();
  }

  reset(ctx: ModuleInitContext): void {
    this.release();
    this.init(ctx);
  }

  /** Is anything held, in any slot? */
  get holding(): boolean {
    return this.slots.some((s) => s.handle !== undefined);
  }

  /** Is this slot holding something? */
  holds(slot = 0): boolean {
    return this.slotAt(slot).handle !== undefined;
  }

  /**
   * Take hold of a point on a segment, in a slot; whatever that slot held is let go first.
   * `strength` scales the spring the backend sizes: 1 is the default, which can carry a fraction
   * of the body's weight.
   */
  grab(segmentIndex: number, localPoint: Vec3, worldTarget: Vec3, strength = 1, slot = 0): void {
    if (segmentIndex < 0 || segmentIndex >= this.articulation.segments.length) {
      throw new RangeError(`Segment index ${segmentIndex} is out of range.`);
    }
    const s = this.slotAt(slot);
    this.release(slot);
    s.segment = segmentIndex;
    s.point.x = localPoint.x;
    s.point.y = localPoint.y;
    s.point.z = localPoint.z;
    s.local[0] = localPoint.x;
    s.local[1] = localPoint.y;
    s.local[2] = localPoint.z;
    s.target.x = worldTarget.x;
    s.target.y = worldTarget.y;
    s.target.z = worldTarget.z;
    s.handle = this.backend.createGrabConstraint(segmentIndex, localPoint, worldTarget, strength);
    this.publish();
  }

  /**
   * Move a slot's target; applied, leashed, on the next step. With an `orientation` the segment
   * is also turned toward it, which is what a hand that twists expects.
   */
  moveTo(worldTarget: Vec3, slot = 0, orientation: Quat | null = null): void {
    const s = this.slotAt(slot);
    s.target.x = worldTarget.x;
    s.target.y = worldTarget.y;
    s.target.z = worldTarget.z;
    s.handle?.setTargetOrientation(orientation);
  }

  /** Let go of one slot, or of everything when no slot is named. */
  release(slot?: number): void {
    if (slot === undefined) {
      for (let i = 0; i < MAX_GRABS; i++) this.release(i);
      return;
    }
    const s = this.slotAt(slot);
    if (!s.handle) return;
    s.handle.release();
    s.handle = undefined;
    s.segment = -1;
    this.publish();
  }

  step(_ctx: ModuleStepContext): void {
    if (this.position && this.orientation) {
      for (const s of this.slots) {
        if (!s.handle) continue;
        // Where the held point is now: segment pose applied to the local point.
        const seg = s.segment;
        qRotate(this.held, 0, this.orientation, 4 * seg, s.local, 0);
        const hx = (this.held[0] as number) + (this.position[3 * seg] as number);
        const hy = (this.held[1] as number) + (this.position[3 * seg + 1] as number);
        const hz = (this.held[2] as number) + (this.position[3 * seg + 2] as number);
        // The target the spring sees never leads the held point by more than the leash.
        let dx = s.target.x - hx;
        let dy = s.target.y - hy;
        let dz = s.target.z - hz;
        const distance = Math.hypot(dx, dy, dz);
        if (distance > GRAB_LEASH) {
          const k = GRAB_LEASH / distance;
          dx *= k;
          dy *= k;
          dz *= k;
        }
        this.leashed.x = hx + dx;
        this.leashed.y = hy + dy;
        this.leashed.z = hz + dz;
        s.handle.setTarget(this.leashed);
      }
    }
    this.publish();
  }

  private slotAt(slot: number): Slot {
    const s = this.slots[slot];
    if (!s) throw new RangeError(`Grab slot ${slot} is out of range; there are ${MAX_GRABS}.`);
    return s;
  }

  private publish(): void {
    if (!this.active || !this.segmentOut || !this.pointOut || !this.targetOut) return;
    this.slots.forEach((s, i) => {
      (this.active as Uint8Array)[i] = s.handle ? 1 : 0;
      (this.segmentOut as Int32Array)[i] = s.segment;
      (this.pointOut as Float64Array)[3 * i] = s.point.x;
      (this.pointOut as Float64Array)[3 * i + 1] = s.point.y;
      (this.pointOut as Float64Array)[3 * i + 2] = s.point.z;
      (this.targetOut as Float64Array)[3 * i] = s.target.x;
      (this.targetOut as Float64Array)[3 * i + 1] = s.target.y;
      (this.targetOut as Float64Array)[3 * i + 2] = s.target.z;
    });
  }

  dispose(): void {
    this.release();
  }
}
