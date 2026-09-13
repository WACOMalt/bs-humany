/**
 * `MetricsModule` -- milestone M3.12.
 *
 * Publishes what a user needs to judge a run rather than admire it (spec section 10.4):
 *
 *   - `diagnostics.energy`: kinetic and potential energy, linear and angular momentum, and a
 *     drift indicator -- the largest separation between the two sides of any joint. Impulse
 *     joints drift under load (spec section 9.4); this is the number that says by how much.
 *   - `diagnostics.limits`: per DoF, how close to a range stop the joint is and whether it has
 *     gone past one. Feeds the end-range heat overlay and, later, the injury model.
 *
 * Runs in the `post` phase from the solver's own outputs; it computes nothing the solver did not
 * already decide, and it allocates nothing per tick.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import { ROOT_NQ } from '@bs-humany/compiler';
import type {
  ChannelSpec,
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  SimModule,
} from '@bs-humany/kernel';
import { BODY_JOINT_STATE, BODY_POSE, BODY_VELOCITY, CHANNEL_VERSION } from './channels.js';
import { qRotate } from './qmath.js';

export const METRICS_MODULE_ID = 'bsums.xyz.bs-humany.metrics';
export const DIAGNOSTICS_ENERGY = 'diagnostics.energy';
export const DIAGNOSTICS_LIMITS = 'diagnostics.limits';

export function diagnosticsEnergySpec(): ChannelSpec {
  return {
    id: DIAGNOSTICS_ENERGY,
    version: CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      { name: 'kinetic', dtype: 'f64', components: 1 },
      { name: 'potential', dtype: 'f64', components: 1 },
      { name: 'linearMomentum', dtype: 'f64', components: 3 },
      { name: 'angularMomentum', dtype: 'f64', components: 3 },
      /** Largest joint separation, metres. */
      { name: 'drift', dtype: 'f64', components: 1 },
    ],
    elementCount: 1,
    mode: 'single-writer',
    backing: 'shared',
  };
}

export function diagnosticsLimitsSpec(model: CompiledArticulation): ChannelSpec {
  return {
    id: DIAGNOSTICS_LIMITS,
    version: CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      /** 0 at mid-range, 1 at either stop, clamped. */
      { name: 'proximity', dtype: 'f64', components: 1 },
      /** Signed distance to the nearer stop, radians or metres; negative once past it. */
      { name: 'margin', dtype: 'f64', components: 1 },
      { name: 'violation', dtype: 'u8', components: 1 },
    ],
    elementCount: model.dofs.length,
    mode: 'single-writer',
    backing: 'shared',
  };
}

export class MetricsModule implements SimModule {
  readonly manifest: ModuleManifest;
  private readonly gravity: number;
  private readonly mass: Float64Array;
  /** Segment-frame inertia, 9 per segment. */
  private readonly inertia: Float64Array;
  /** Segment-frame centre of mass, 3 per segment. */
  private readonly com: Float64Array;
  private readonly jointParent: Int32Array;
  private readonly jointChild: Int32Array;
  /** Anchor points in the parent and child segment frames, 3 per joint each. */
  private readonly anchorParent: Float64Array;
  private readonly anchorChild: Float64Array;
  private readonly lower: Float64Array;
  private readonly upper: Float64Array;
  private position: Float64Array | undefined;
  private orientation: Float64Array | undefined;
  private linear: Float64Array | undefined;
  private angular: Float64Array | undefined;
  private q: Float64Array | undefined;
  private kinetic: Float64Array | undefined;
  private potential: Float64Array | undefined;
  private linearMomentum: Float64Array | undefined;
  private angularMomentum: Float64Array | undefined;
  private drift: Float64Array | undefined;
  private proximity: Float64Array | undefined;
  private margin: Float64Array | undefined;
  private violation: Uint8Array | undefined;
  private readonly scratch = new Float64Array(3);
  private readonly scratchB = new Float64Array(3);

  constructor(readonly articulation: CompiledArticulation) {
    const n = articulation.segments.length;
    this.gravity = Math.hypot(
      articulation.gravity.x,
      articulation.gravity.y,
      articulation.gravity.z,
    );
    this.mass = Float64Array.from(articulation.segments.map((s) => s.mass));
    this.inertia = new Float64Array(9 * n);
    this.com = new Float64Array(3 * n);
    articulation.segments.forEach((s, i) => {
      this.inertia.set(s.inertia, 9 * i);
      this.com.set([s.com.x, s.com.y, s.com.z], 3 * i);
    });
    const m = articulation.joints.length;
    this.jointParent = Int32Array.from(articulation.joints.map((j) => j.parentSegment));
    this.jointChild = Int32Array.from(articulation.joints.map((j) => j.childSegment));
    this.anchorParent = new Float64Array(3 * m);
    this.anchorChild = new Float64Array(3 * m);
    articulation.joints.forEach((j, k) => {
      const a = j.frameInParent.translation;
      const b = j.frameInChild.translation;
      this.anchorParent.set([a.x, a.y, a.z], 3 * k);
      this.anchorChild.set([b.x, b.y, b.z], 3 * k);
    });
    this.lower = Float64Array.from(articulation.dofs.map((d) => d.range[0]));
    this.upper = Float64Array.from(articulation.dofs.map((d) => d.range[1]));
    this.manifest = {
      id: METRICS_MODULE_ID,
      version: '1.0.0',
      phase: 'post',
      dependsOn: [],
      reads: [
        { id: BODY_POSE, version: CHANNEL_VERSION },
        { id: BODY_VELOCITY, version: CHANNEL_VERSION },
        { id: BODY_JOINT_STATE, version: CHANNEL_VERSION },
      ],
      writes: [
        { id: DIAGNOSTICS_ENERGY, version: CHANNEL_VERSION },
        { id: DIAGNOSTICS_LIMITS, version: CHANNEL_VERSION },
      ],
      accumulates: [],
      gives: [diagnosticsEnergySpec(), diagnosticsLimitsSpec(articulation)],
    };
  }

  init(ctx: ModuleInitContext): void {
    const pose = ctx.read(BODY_POSE);
    this.position = pose.fields.position as Float64Array;
    this.orientation = pose.fields.orientation as Float64Array;
    const velocity = ctx.read(BODY_VELOCITY);
    this.linear = velocity.fields.linear as Float64Array;
    this.angular = velocity.fields.angular as Float64Array;
    this.q = ctx.read(BODY_JOINT_STATE).fields.q as Float64Array;
    const energy = ctx.write(DIAGNOSTICS_ENERGY);
    this.kinetic = energy.fields.kinetic as Float64Array;
    this.potential = energy.fields.potential as Float64Array;
    this.linearMomentum = energy.fields.linearMomentum as Float64Array;
    this.angularMomentum = energy.fields.angularMomentum as Float64Array;
    this.drift = energy.fields.drift as Float64Array;
    const limits = ctx.write(DIAGNOSTICS_LIMITS);
    this.proximity = limits.fields.proximity as Float64Array;
    this.margin = limits.fields.margin as Float64Array;
    this.violation = limits.fields.violation as Uint8Array;
    this.step();
  }

  reset(ctx: ModuleInitContext): void {
    this.init(ctx);
  }

  step(_ctx?: ModuleStepContext): void {
    const position = this.position;
    const orientation = this.orientation;
    const linear = this.linear;
    const angular = this.angular;
    if (!position || !orientation || !linear || !angular) return;
    if (
      !this.kinetic ||
      !this.potential ||
      !this.linearMomentum ||
      !this.angularMomentum ||
      !this.drift
    )
      return;

    let kinetic = 0;
    let potential = 0;
    let px = 0;
    let py = 0;
    let pz = 0;
    let lx = 0;
    let ly = 0;
    let lz = 0;
    const n = this.mass.length;
    for (let i = 0; i < n; i++) {
      const m = this.mass[i] as number;
      // Centre of mass in world.
      qRotate(this.scratch, 0, orientation, 4 * i, this.com, 3 * i);
      const cx = (this.scratch[0] as number) + (position[3 * i] as number);
      const cy = (this.scratch[1] as number) + (position[3 * i + 1] as number);
      const cz = (this.scratch[2] as number) + (position[3 * i + 2] as number);
      const vx = linear[3 * i] as number;
      const vy = linear[3 * i + 1] as number;
      const vz = linear[3 * i + 2] as number;
      const wx = angular[3 * i] as number;
      const wy = angular[3 * i + 1] as number;
      const wz = angular[3 * i + 2] as number;
      // Angular velocity in the segment frame: conj(R) w.
      this.scratchB[0] = wx;
      this.scratchB[1] = wy;
      this.scratchB[2] = wz;
      conjRotate(this.scratch, orientation, 4 * i, this.scratchB);
      const ox = this.scratch[0] as number;
      const oy = this.scratch[1] as number;
      const oz = this.scratch[2] as number;
      // I w in the segment frame.
      const I = this.inertia;
      const o = 9 * i;
      const hx = (I[o] as number) * ox + (I[o + 1] as number) * oy + (I[o + 2] as number) * oz;
      const hy = (I[o + 3] as number) * ox + (I[o + 4] as number) * oy + (I[o + 5] as number) * oz;
      const hz = (I[o + 6] as number) * ox + (I[o + 7] as number) * oy + (I[o + 8] as number) * oz;
      kinetic += 0.5 * m * (vx * vx + vy * vy + vz * vz) + 0.5 * (ox * hx + oy * hy + oz * hz);
      potential += m * this.gravity * cy;
      px += m * vx;
      py += m * vy;
      pz += m * vz;
      // Angular momentum about the origin: r x m v + R (I w).
      this.scratchB[0] = hx;
      this.scratchB[1] = hy;
      this.scratchB[2] = hz;
      qRotate(this.scratch, 0, orientation, 4 * i, this.scratchB, 0);
      lx += cy * m * vz - cz * m * vy + (this.scratch[0] as number);
      ly += cz * m * vx - cx * m * vz + (this.scratch[1] as number);
      lz += cx * m * vy - cy * m * vx + (this.scratch[2] as number);
    }
    this.kinetic[0] = kinetic;
    this.potential[0] = potential;
    this.linearMomentum[0] = px;
    this.linearMomentum[1] = py;
    this.linearMomentum[2] = pz;
    this.angularMomentum[0] = lx;
    this.angularMomentum[1] = ly;
    this.angularMomentum[2] = lz;

    let drift = 0;
    const m = this.jointParent.length;
    for (let k = 0; k < m; k++) {
      const a = this.jointParent[k] as number;
      const b = this.jointChild[k] as number;
      qRotate(this.scratch, 0, orientation, 4 * a, this.anchorParent, 3 * k);
      const ax = (this.scratch[0] as number) + (position[3 * a] as number);
      const ay = (this.scratch[1] as number) + (position[3 * a + 1] as number);
      const az = (this.scratch[2] as number) + (position[3 * a + 2] as number);
      qRotate(this.scratch, 0, orientation, 4 * b, this.anchorChild, 3 * k);
      const bx = (this.scratch[0] as number) + (position[3 * b] as number);
      const by = (this.scratch[1] as number) + (position[3 * b + 1] as number);
      const bz = (this.scratch[2] as number) + (position[3 * b + 2] as number);
      const d = Math.hypot(ax - bx, ay - by, az - bz);
      if (d > drift) drift = d;
    }
    this.drift[0] = drift;

    const q = this.q;
    if (!q || !this.proximity || !this.margin || !this.violation) return;
    const dofs = this.lower.length;
    for (let i = 0; i < dofs; i++) {
      const lo = this.lower[i] as number;
      const hi = this.upper[i] as number;
      const value = q[ROOT_NQ + i] as number;
      const margin = Math.min(value - lo, hi - value);
      const half = (hi - lo) / 2;
      this.margin[i] = margin;
      this.proximity[i] = half > 0 ? Math.min(1, Math.max(0, 1 - margin / half)) : 1;
      this.violation[i] = margin < 0 ? 1 : 0;
    }
  }
}

/** out = conj(q) * v, for q at `qo` and v in a 3-array. */
function conjRotate(out: Float64Array, q: Float64Array, qo: number, v: Float64Array): void {
  const qx = -(q[qo] as number);
  const qy = -(q[qo + 1] as number);
  const qz = -(q[qo + 2] as number);
  const qw = q[qo + 3] as number;
  const x = v[0] as number;
  const y = v[1] as number;
  const z = v[2] as number;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
}
