/**
 * `GrabModule` -- milestone M3.11.
 *
 * Direct manipulation: pick a point on a segment, drag it toward a world target through a
 * constraint, let go. The constraint itself is the backend's (`createGrabConstraint`); the
 * module owns its lifetime, keeps the target current in the `actuate` phase so a grab moves at
 * simulation rate rather than at pointer rate, and publishes `interaction.grab` so overlays and
 * tests can see what is being held without reaching into the backend.
 */

import type { CompiledArticulation, GrabHandle, IPhysicsBackend } from '@bs-humany/compiler';
import type { Vec3 } from '@bs-humany/frames';
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
    elementCount: 1,
    mode: 'single-writer',
    backing: 'shared',
  };
}

export class GrabModule implements SimModule {
  readonly manifest: ModuleManifest;
  private handle: GrabHandle | undefined;
  private segment = -1;
  private readonly point = { x: 0, y: 0, z: 0 };
  private readonly target = { x: 0, y: 0, z: 0 };
  private position: Float64Array | undefined;
  private orientation: Float64Array | undefined;
  private readonly local = new Float64Array(3);
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

  /** Is something held? */
  get holding(): boolean {
    return this.handle !== undefined;
  }

  /** Hold `localPoint` (in the segment's frame) toward `worldTarget`. Releases any prior grab. */
  grab(segmentIndex: number, localPoint: Vec3, worldTarget: Vec3): void {
    if (segmentIndex < 0 || segmentIndex >= this.articulation.segments.length) {
      throw new RangeError(`Segment index ${segmentIndex} is out of range.`);
    }
    this.release();
    this.segment = segmentIndex;
    this.point.x = localPoint.x;
    this.point.y = localPoint.y;
    this.point.z = localPoint.z;
    this.local[0] = localPoint.x;
    this.local[1] = localPoint.y;
    this.local[2] = localPoint.z;
    this.target.x = worldTarget.x;
    this.target.y = worldTarget.y;
    this.target.z = worldTarget.z;
    this.handle = this.backend.createGrabConstraint(segmentIndex, localPoint, worldTarget);
    this.publish();
  }

  /** Move the target; applied, leashed, on the next step. */
  moveTo(worldTarget: Vec3): void {
    this.target.x = worldTarget.x;
    this.target.y = worldTarget.y;
    this.target.z = worldTarget.z;
  }

  release(): void {
    if (!this.handle) return;
    this.handle.release();
    this.handle = undefined;
    this.segment = -1;
    this.publish();
  }

  step(_ctx: ModuleStepContext): void {
    if (this.handle && this.position && this.orientation) {
      // Where the held point is now: segment pose applied to the local point.
      const s = this.segment;
      qRotate(this.held, 0, this.orientation, 4 * s, this.local, 0);
      const hx = (this.held[0] as number) + (this.position[3 * s] as number);
      const hy = (this.held[1] as number) + (this.position[3 * s + 1] as number);
      const hz = (this.held[2] as number) + (this.position[3 * s + 2] as number);
      // The target the spring sees never leads the held point by more than the leash.
      let dx = this.target.x - hx;
      let dy = this.target.y - hy;
      let dz = this.target.z - hz;
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
      this.handle.setTarget(this.leashed);
    }
    this.publish();
  }

  private publish(): void {
    if (!this.active || !this.segmentOut || !this.pointOut || !this.targetOut) return;
    this.active[0] = this.handle ? 1 : 0;
    this.segmentOut[0] = this.segment;
    this.pointOut[0] = this.point.x;
    this.pointOut[1] = this.point.y;
    this.pointOut[2] = this.point.z;
    this.targetOut[0] = this.target.x;
    this.targetOut[1] = this.target.y;
    this.targetOut[2] = this.target.z;
  }

  dispose(): void {
    this.release();
  }
}
