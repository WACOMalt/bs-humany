/**
 * `MuscleMomentModule` -- ticket N3.4, muscle spec sections 8.3 and 10.1.
 *
 * How much leverage each muscle has over each joint it crosses, published for anything that wants
 * to look: the validation harness of N1.9, an inspector panel, a report.
 *
 * ## Output only, and that is the whole point
 *
 * M-ADR-003 keeps the moment arm off the force path entirely -- force reaches the solver as
 * wrenches at the points the tendon actually pulls, and the solver derives the joint torque
 * itself. So nothing in the simulation reads this channel, and that is exactly what makes it
 * worth computing. A quantity the simulation depends on tells you whether the model is
 * self-consistent; one it does not tells you whether the model is *right*, because it can be
 * compared against a cadaver measurement without anything circular about the comparison.
 *
 * It has already earned its place. Measured across elbow flexion, the straight-line triceps
 * moment arm fell from -20 mm to zero and then reversed sign at about 2 rad -- the extensor
 * became a flexor, and a fully driven triceps held a bent elbow bent. Muscle spec 13.2 names a
 * sign change where published data shows none as a hard failure. Wrapping the trochlea fixed it,
 * and this module is where that check now lives.
 *
 * ## By virtual work, from the published path
 *
 * The arm is `-dL/dq`, and for a revolute coordinate that has a closed form: every point the
 * coordinate carries sweeps a circle about its axis, so the derivative is the sum of those
 * sweeps projected on the path's own directions. Everything needed is on `muscle.polyline` --
 * the points and, since it publishes one, the body carrying each. No re-solving, no differencing,
 * and no reaching into the path module.
 *
 * Only revolute coordinates. A slide has a moment arm in the sense of a lever ratio rather than a
 * length, and nothing in the elbow needs one; a model that grows a prismatic joint under a muscle
 * will want this revisited rather than quietly extended.
 *
 * ## Rate
 *
 * A tenth of the physics rate. Nothing consumes it within a tick, a moment arm changes about as
 * fast as a joint angle does, and the cost is a pass over every path point for every crossed
 * coordinate -- which is the one part of this module anyone would notice.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import type {
  ChannelSpec,
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  SimModule,
} from '@bs-humany/kernel';
import { BODY_POSE, CHANNEL_VERSION } from '@bs-humany/modules-mechanics';
import {
  DIAGNOSTICS_MOMENT_ARM,
  MUSCLE_CHANNEL_VERSION,
  MUSCLE_PATH,
  MUSCLE_POLYLINE,
  diagnosticsMomentArmSpec,
} from './channels.js';
import type { CompiledMuscleSet } from './compile.js';
import { MUSCLE_PATH_MODULE_ID } from './musclePathModule.js';

export const MUSCLE_MOMENT_MODULE_ID = 'bsums.xyz.bs-humany.muscle.moment';

/** One muscle's leverage over one joint coordinate. */
export interface MomentPair {
  readonly unit: number;
  readonly unitId: string;
  /** Index into `articulation.dofs`. */
  readonly dof: number;
  readonly dofId: string;
  readonly jointId: string;
}

export class MuscleMomentModule implements SimModule {
  readonly manifest: ModuleManifest;

  /** Which muscle crosses which coordinate, worked out once. */
  readonly pairs: readonly MomentPair[];

  /** Per pair: the coordinate's axis and centre in its parent segment's frame. */
  private readonly axisLocal: Float64Array;
  private readonly centreLocal: Float64Array;
  /** Per pair: the segment the coordinate's frame hangs off, and a mask of what it carries. */
  private readonly parentSegment: Int32Array;
  private readonly carries: Uint8Array;
  private readonly segments: number;

  private point: Float64Array | undefined;
  private pointBody: Int32Array | undefined;
  private pointStart: Int32Array | undefined;
  private pointCount: Int32Array | undefined;
  private posePosition: Float64Array | undefined;
  private poseOrientation: Float64Array | undefined;
  private outUnit: Int32Array | undefined;
  private outDof: Int32Array | undefined;
  private outArm: Float64Array | undefined;

  constructor(
    readonly articulation: CompiledArticulation,
    readonly muscles: CompiledMuscleSet,
  ) {
    const segments = articulation.segments.length;
    this.segments = segments;

    // What each joint carries: its child segment and everything below it.
    const below = new Map<number, Uint8Array>();
    const children = new Map<number, number[]>();
    for (const s of articulation.segments) {
      if (s.parent < 0) continue;
      const list = children.get(s.parent) ?? [];
      list.push(s.index);
      children.set(s.parent, list);
    }
    const mark = (root: number, mask: Uint8Array) => {
      const stack = [root];
      while (stack.length > 0) {
        const at = stack.pop() as number;
        mask[at] = 1;
        for (const child of children.get(at) ?? []) stack.push(child);
      }
    };
    for (const joint of articulation.joints) {
      const mask = new Uint8Array(segments);
      mark(joint.childSegment, mask);
      below.set(joint.index, mask);
    }

    // A unit crosses a coordinate when that coordinate carries one of its attachments and not the
    // other. Working from the two attachments rather than from every path point is deliberate:
    // whether a muscle spans a joint is a fact about where it is anchored, and a wrap surface
    // lying on a bone in between does not change it.
    const pairs: MomentPair[] = [];
    const axis: number[] = [];
    const centre: number[] = [];
    const parent: number[] = [];
    const masks: Uint8Array[] = [];

    for (let unit = 0; unit < muscles.paths.length; unit++) {
      const path = muscles.paths[unit] as CompiledMuscleSet['paths'][number];
      const from = muscles.resolver.bodyOf(path.origin.bone);
      const to = muscles.resolver.bodyOf(path.insertion.bone);
      if (from < 0 || to < 0) continue;

      for (const joint of articulation.joints) {
        const mask = below.get(joint.index) as Uint8Array;
        if ((mask[from] === 1) === (mask[to] === 1)) continue;
        for (const dof of joint.dofs) {
          if (dof.kind !== 'hinge') continue;
          pairs.push({
            unit,
            unitId: muscles.units[unit]?.id ?? String(unit),
            dof: dof.index,
            dofId: dof.axisName,
            jointId: joint.id,
          });
          // The coordinate's axis and centre live in the parent segment's frame, which is where
          // `frameInParent` puts them; the pose turns them into the world each tick.
          const q = joint.frameInParent.rotation;
          const v = dof.vector;
          const tx = 2 * (q.y * v.z - q.z * v.y);
          const ty = 2 * (q.z * v.x - q.x * v.z);
          const tz = 2 * (q.x * v.y - q.y * v.x);
          axis.push(
            v.x + q.w * tx + (q.y * tz - q.z * ty),
            v.y + q.w * ty + (q.z * tx - q.x * tz),
            v.z + q.w * tz + (q.x * ty - q.y * tx),
          );
          centre.push(
            joint.frameInParent.translation.x,
            joint.frameInParent.translation.y,
            joint.frameInParent.translation.z,
          );
          parent.push(joint.parentSegment);
          masks.push(mask);
        }
      }
    }

    this.pairs = pairs;
    this.axisLocal = Float64Array.from(axis);
    this.centreLocal = Float64Array.from(centre);
    this.parentSegment = Int32Array.from(parent);
    this.carries = new Uint8Array(pairs.length * segments);
    for (let i = 0; i < masks.length; i++) {
      this.carries.set(masks[i] as Uint8Array, i * segments);
    }

    this.manifest = {
      id: MUSCLE_MOMENT_MODULE_ID,
      version: '1.0.0',
      // After the solve, reading the path the tick produced.
      phase: 'post',
      rateDivisor: 10,
      dependsOn: [{ id: MUSCLE_PATH_MODULE_ID, version: '1.0.0' }],
      reads: [
        { id: MUSCLE_PATH, version: MUSCLE_CHANNEL_VERSION },
        { id: MUSCLE_POLYLINE, version: MUSCLE_CHANNEL_VERSION },
        { id: BODY_POSE, version: CHANNEL_VERSION },
      ],
      writes: [{ id: DIAGNOSTICS_MOMENT_ARM, version: MUSCLE_CHANNEL_VERSION }],
      accumulates: [],
      gives: [diagnosticsMomentArmSpec(pairs.length)] satisfies ChannelSpec[],
    };
  }

  init(ctx: ModuleInitContext): void {
    this.bind(ctx);
  }

  reset(ctx: ModuleInitContext): void {
    this.bind(ctx);
  }

  private bind(ctx: ModuleInitContext): void {
    const path = ctx.read(MUSCLE_PATH);
    this.pointStart = path.fields.pointStart as Int32Array;
    this.pointCount = path.fields.pointCount as Int32Array;
    const polyline = ctx.read(MUSCLE_POLYLINE);
    this.point = polyline.fields.point as Float64Array;
    this.pointBody = polyline.fields.body as Int32Array;
    const pose = ctx.read(BODY_POSE);
    this.posePosition = pose.fields.position as Float64Array;
    this.poseOrientation = pose.fields.orientation as Float64Array;
    const out = ctx.write(DIAGNOSTICS_MOMENT_ARM);
    this.outUnit = out.fields.unit as Int32Array;
    this.outDof = out.fields.dof as Int32Array;
    this.outArm = out.fields.arm as Float64Array;
  }

  step(_ctx: ModuleStepContext): void {
    const point = this.point;
    const body = this.pointBody;
    const start = this.pointStart;
    const count = this.pointCount;
    const position = this.posePosition;
    const orientation = this.poseOrientation;
    const outUnit = this.outUnit;
    const outDof = this.outDof;
    const outArm = this.outArm;
    if (!point || !body || !start || !count || !position || !orientation) return;
    if (!outUnit || !outDof || !outArm) return;

    for (let i = 0; i < this.pairs.length; i++) {
      const pair = this.pairs[i] as MomentPair;
      outUnit[i] = pair.unit;
      outDof[i] = pair.dof;

      // The coordinate's axis and centre, turned into the world by its parent segment's pose.
      const p = this.parentSegment[i] as number;
      const qx = orientation[4 * p] as number;
      const qy = orientation[4 * p + 1] as number;
      const qz = orientation[4 * p + 2] as number;
      const qw = orientation[4 * p + 3] as number;

      const ax = this.axisLocal[3 * i] as number;
      const ay = this.axisLocal[3 * i + 1] as number;
      const az = this.axisLocal[3 * i + 2] as number;
      let tx = 2 * (qy * az - qz * ay);
      let ty = 2 * (qz * ax - qx * az);
      let tz = 2 * (qx * ay - qy * ax);
      const wx = ax + qw * tx + (qy * tz - qz * ty);
      const wy = ay + qw * ty + (qz * tx - qx * tz);
      const wz = az + qw * tz + (qx * ty - qy * tx);

      const cx = this.centreLocal[3 * i] as number;
      const cy = this.centreLocal[3 * i + 1] as number;
      const cz = this.centreLocal[3 * i + 2] as number;
      tx = 2 * (qy * cz - qz * cy);
      ty = 2 * (qz * cx - qx * cz);
      tz = 2 * (qx * cy - qy * cx);
      const ox = (position[3 * p] as number) + cx + qw * tx + (qy * tz - qz * ty);
      const oy = (position[3 * p + 1] as number) + cy + qw * ty + (qz * tx - qx * tz);
      const oz = (position[3 * p + 2] as number) + cz + qw * tz + (qx * ty - qy * tx);

      outArm[i] = this.armOf(pair.unit, i, wx, wy, wz, ox, oy, oz);
    }
  }

  /**
   * `-dL/dq` for one unit about one coordinate, summed over the path's segments.
   *
   * Each end of a segment contributes the sweep it would make under a unit rate of the
   * coordinate, projected on the segment's own direction; an end the coordinate does not carry
   * contributes nothing. A zero-length segment has no direction and is skipped rather than
   * producing a NaN, which a path with two coincident points would otherwise do.
   */
  private armOf(
    unit: number,
    pair: number,
    axisX: number,
    axisY: number,
    axisZ: number,
    originX: number,
    originY: number,
    originZ: number,
  ): number {
    const point = this.point as Float64Array;
    const body = this.pointBody as Int32Array;
    const from = (this.pointStart as Int32Array)[unit] as number;
    const points = (this.pointCount as Int32Array)[unit] as number;
    const mask = pair * this.segments;

    let derivative = 0;
    for (let i = 0; i + 1 < points; i++) {
      const a = 3 * (from + i);
      const b = 3 * (from + i + 1);
      const dx = (point[b] as number) - (point[a] as number);
      const dy = (point[b + 1] as number) - (point[a + 1] as number);
      const dz = (point[b + 2] as number) - (point[a + 2] as number);
      const segment = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (segment <= 0) continue;
      const ux = dx / segment;
      const uy = dy / segment;
      const uz = dz / segment;

      for (const end of [0, 1]) {
        const carried = this.carries[mask + (body[from + i + end] as number)];
        if (carried !== 1) continue;
        const at = end === 0 ? a : b;
        const rx = (point[at] as number) - originX;
        const ry = (point[at + 1] as number) - originY;
        const rz = (point[at + 2] as number) - originZ;
        const sweep =
          ux * (axisY * rz - axisZ * ry) +
          uy * (axisZ * rx - axisX * rz) +
          uz * (axisX * ry - axisY * rx);
        derivative += end === 0 ? -sweep : sweep;
      }
    }
    return -derivative;
  }
}
