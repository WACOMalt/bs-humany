/**
 * `VestibularModule` -- spec section 14.1, and the worked example of `docs/guides/module-authoring.md`.
 *
 * The inner ear does not sense position. The otoliths sense **specific force**, which is the
 * acceleration of the head minus gravity, and the semicircular canals sense **angular velocity**.
 * Both are in the head's own frame, because that is the frame the organs sit in. Standing still,
 * the otoliths read 9.81 m/s^2 straight up: they cannot tell gravity from acceleration, which is
 * why a lift setting off feels like leaning back.
 *
 * This is the demonstration case the spec asks for, and it is small on purpose. It shows the
 * whole module contract in one file: a manifest that declares every channel it touches, a channel
 * of its own that it creates for others, state carried between ticks and cleared on `reset`, and
 * a `step` that allocates nothing and reads no clock.
 *
 * ## What it is not
 *
 * Acceleration is differentiated from the velocity the solver reports, so it lags by one tick and
 * it is noisy at an impact, where velocity changes almost discontinuously. A real otolith is a
 * mass on a membrane with its own dynamics, and a real canal is a fluid loop that high-passes
 * angular velocity with a time constant of several seconds. Neither is modelled. What this
 * publishes is the mechanical input those organs would receive, which is what a nervous system
 * module would need to filter.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import type {
  ChannelSpec,
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  SimModule,
} from '@bs-humany/kernel';
import {
  BODY_POSE,
  BODY_VELOCITY,
  CHANNEL_VERSION,
  SIM_GRAVITY,
} from '@bs-humany/modules-mechanics';

export const VESTIBULAR_MODULE_ID = 'bsums.xyz.bs-humany.vestibular';
export const SENSE_VESTIBULAR = 'sense.vestibular';

/** The segment the organs ride on, when the caller does not say. */
export const DEFAULT_HEAD_SEGMENT = 'head';

export function senseVestibularSpec(): ChannelSpec {
  return {
    id: SENSE_VESTIBULAR,
    version: CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      /** Acceleration less gravity, head frame, m/s^2. Straight up at 9.81 when standing still. */
      { name: 'specificForce', dtype: 'f64', components: 3 },
      /** Angular velocity, head frame, rad/s. */
      { name: 'angularVelocity', dtype: 'f64', components: 3 },
      /**
       * Angle between the head's own up and the specific force, radians.
       *
       * Zero when upright and pi when inverted, which is the quantity a righting reflex would
       * act on. It is meaningless while the head is accelerating hard, for the same reason a
       * person cannot tell up from down on a rollercoaster.
       */
      { name: 'tiltFromVertical', dtype: 'f64', components: 1 },
    ],
    elementCount: 1,
    mode: 'single-writer',
    backing: 'shared',
  };
}

export interface VestibularOptions {
  /** Segment id the organs ride on. Defaults to `head`. */
  readonly segment?: string | undefined;
}

export class VestibularModule implements SimModule {
  readonly manifest: ModuleManifest;
  /** Index of the segment being sensed, or -1 when the profile has no such segment. */
  readonly segment: number;

  private orientation: Float64Array | undefined;
  private linear: Float64Array | undefined;
  private angular: Float64Array | undefined;
  private gravity: Float64Array | undefined;
  private specificForce: Float64Array | undefined;
  private angularVelocity: Float64Array | undefined;
  private tilt: Float64Array | undefined;

  /**
   * Last tick's linear velocity, and whether there was one.
   *
   * The first step after an init or a reset has nothing to differentiate against, and guessing
   * would publish an acceleration the body never had; it publishes zero and says so by leaving
   * `primed` false until the tick after.
   */
  private readonly previousVelocity = new Float64Array(3);
  private primed = false;

  constructor(
    readonly articulation: CompiledArticulation,
    options: VestibularOptions = {},
  ) {
    const wanted = options.segment ?? DEFAULT_HEAD_SEGMENT;
    this.segment = articulation.segments.findIndex((s) => s.id === wanted);
    this.manifest = {
      id: VESTIBULAR_MODULE_ID,
      version: '1.0.0',
      // After the solve, so the pose and velocity are this tick's and not last tick's.
      phase: 'post',
      dependsOn: [],
      reads: [
        { id: BODY_POSE, version: CHANNEL_VERSION },
        { id: BODY_VELOCITY, version: CHANNEL_VERSION },
        // Gravity can be switched off while the body is running, and specific force is defined
        // against whatever is in force, not against what the model was compiled with.
        { id: SIM_GRAVITY, version: CHANNEL_VERSION },
      ],
      writes: [{ id: SENSE_VESTIBULAR, version: CHANNEL_VERSION }],
      accumulates: [],
      gives: [senseVestibularSpec()],
    };
  }

  init(ctx: ModuleInitContext): void {
    this.bind(ctx);
  }

  /** Rebinding after a restore: the views are new, and last tick's velocity is not ours. */
  reset(ctx: ModuleInitContext): void {
    this.bind(ctx);
    this.primed = false;
    this.previousVelocity.fill(0);
  }

  private bind(ctx: ModuleInitContext): void {
    this.orientation = ctx.read(BODY_POSE).fields.orientation as Float64Array;
    const velocity = ctx.read(BODY_VELOCITY);
    this.linear = velocity.fields.linear as Float64Array;
    this.angular = velocity.fields.angular as Float64Array;
    this.gravity = ctx.read(SIM_GRAVITY).fields.gravity as Float64Array;
    const out = ctx.write(SENSE_VESTIBULAR);
    this.specificForce = out.fields.specificForce as Float64Array;
    this.angularVelocity = out.fields.angularVelocity as Float64Array;
    this.tilt = out.fields.tiltFromVertical as Float64Array;
  }

  step(ctx: ModuleStepContext): void {
    const orientation = this.orientation;
    const linear = this.linear;
    const angular = this.angular;
    const gravity = this.gravity;
    const specificForce = this.specificForce;
    const angularVelocity = this.angularVelocity;
    const tilt = this.tilt;
    if (!orientation || !linear || !angular || !gravity) return;
    if (!specificForce || !angularVelocity || !tilt) return;
    if (this.segment < 0) return;

    const s = this.segment;
    const vx = linear[3 * s] as number;
    const vy = linear[3 * s + 1] as number;
    const vz = linear[3 * s + 2] as number;

    // Acceleration by backward difference, then specific force: what an accelerometer riding on
    // the head would read, which is the acceleration less gravity rather than plus it.
    let ax = 0;
    let ay = 0;
    let az = 0;
    if (this.primed) {
      const inverseDt = 1 / ctx.dt;
      ax = (vx - (this.previousVelocity[0] as number)) * inverseDt - (gravity[0] as number);
      ay = (vy - (this.previousVelocity[1] as number)) * inverseDt - (gravity[1] as number);
      az = (vz - (this.previousVelocity[2] as number)) * inverseDt - (gravity[2] as number);
    }
    this.previousVelocity[0] = vx;
    this.previousVelocity[1] = vy;
    this.previousVelocity[2] = vz;
    this.primed = true;

    // Into the head's frame: rotate by the conjugate of the head's orientation.
    const qx = -(orientation[4 * s] as number);
    const qy = -(orientation[4 * s + 1] as number);
    const qz = -(orientation[4 * s + 2] as number);
    const qw = orientation[4 * s + 3] as number;
    rotate(specificForce, 0, qx, qy, qz, qw, ax, ay, az);
    rotate(
      angularVelocity,
      0,
      qx,
      qy,
      qz,
      qw,
      angular[3 * s] as number,
      angular[3 * s + 1] as number,
      angular[3 * s + 2] as number,
    );

    // Tilt: the angle between the head's own up (+Y in its frame) and the specific force. Upright
    // and still, the force is straight up the head and the angle is zero.
    const fx = specificForce[0] as number;
    const fy = specificForce[1] as number;
    const fz = specificForce[2] as number;
    const magnitude = Math.hypot(fx, fy, fz);
    tilt[0] = magnitude > 0 ? Math.acos(clamp(fy / magnitude)) : 0;
  }
}

/** Rotate (x, y, z) by the quaternion, into `out` at `offset`. Allocation-free. */
function rotate(
  out: Float64Array,
  offset: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  x: number,
  y: number,
  z: number,
): void {
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[offset] = x + qw * tx + (qy * tz - qz * ty);
  out[offset + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[offset + 2] = z + qw * tz + (qx * ty - qy * tx);
}

function clamp(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}
