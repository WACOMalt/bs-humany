/**
 * `PassiveJointModule` -- milestone M3.9.
 *
 * Real joints resist continuously; a hard stop alone makes a puppet (spec section 7.3). Each tick
 * this module evaluates every DoF's passive moment -- the double-exponential end-range curve of
 * Riener & Edrich (1999), optional mid-range capsular stiffness, and viscous damping -- and adds it
 * into `actuation.jointTorque`. It runs in the `actuate` phase and reads the previous tick's
 * joint state, which at 500 Hz is 2 ms stale and inconsequential.
 *
 * The passive model MUST be the same whatever the backend, which is why it is a module rather
 * than a backend feature: it depends on nothing but the joint state, so any backend without
 * native per-DoF stiffness -- MuJoCo reports it as `emulated`, and this is the emulation -- gets
 * exactly the same moments, and one that has it natively must leave it switched off.
 *
 * DoFs without curves of their own get a default derived from their range and inertia. That is a
 * recorded gap (OQ-008), not a hidden one: the module lists which DoFs run on the default.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import { ROOT_NQ, ROOT_NV, dofPassiveInertia } from '@bs-humany/compiler';
import { type StiffnessCurve, passiveMoment, provisional } from '@bs-humany/hsdl';
import type {
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  SimModule,
} from '@bs-humany/kernel';
import { ACTUATION_JOINT_TORQUE, BODY_JOINT_STATE, CHANNEL_VERSION } from './channels.js';

export const PASSIVE_JOINT_MODULE_ID = 'bsums.xyz.bs-humany.passive-joint';

/**
 * The default curve's design constants. See OQ-008: chosen for form and scale, not measured.
 */
export const DEFAULT_PASSIVE = {
  /** Radians before each limit over which resistance rises from about 5% to full. */
  softZone: 0.2,
  /** The effective spring frequency at the limit, Hz, for the DoF's own inertia. */
  wallFrequencyHz: 6,
  /** Viscous damping per unit inertia, 1/s: free rotation decays with this time constant. */
  dampingRate: 4,
  source: provisional(
    'riener1999',
    'OQ-008',
    'Double-exponential form after Riener and Edrich; coefficients derived from range and ' +
      'inertia rather than transcribed.',
  ),
} as const;

/**
 * Build the default curve for a DoF from an inertia; the range enters at evaluation. The inertia
 * is the reduced inertia of the two bodies the joint separates (`dofPassiveInertia`): a wall
 * sized to the child segment alone was the thigh's at the hip and a vertebra's at each spinal
 * level, and the trunk sank into those in a fraction of a second.
 */
export function defaultPassiveCurve(inertia: number): StiffnessCurve {
  const rate = 3 / DEFAULT_PASSIVE.softZone;
  const omega = 2 * Math.PI * DEFAULT_PASSIVE.wallFrequencyHz;
  // Wall stiffness d(tau)/dq at the limit is rate * gain; set it to inertia * omega^2.
  const gain = (Math.max(inertia, 1e-6) * omega * omega) / rate;
  return {
    lowerGain: gain,
    lowerRate: rate,
    upperGain: gain,
    upperRate: rate,
    source: DEFAULT_PASSIVE.source,
  };
}

export interface PassiveJointOptions {
  /** Scale every passive moment; 0 switches the model off without unregistering it. */
  readonly gain?: number | undefined;
}

export class PassiveJointModule implements SimModule {
  readonly manifest: ModuleManifest;
  /** DoF indices (into `articulation.dofs`) running on the default curve rather than their own. */
  readonly defaulted: readonly number[];
  private readonly curves: StiffnessCurve[];
  private readonly damping: Float64Array;
  private readonly lower: Float64Array;
  private readonly upper: Float64Array;
  private q: Float64Array | undefined;
  private qdot: Float64Array | undefined;
  private torque: Float64Array | undefined;
  private readonly gain: number;

  constructor(
    readonly articulation: CompiledArticulation,
    options: PassiveJointOptions = {},
  ) {
    this.gain = options.gain ?? 1;
    const defaulted: number[] = [];
    this.curves = articulation.dofs.map((dof) => {
      if (dof.passiveStiffness) return dof.passiveStiffness;
      defaulted.push(dof.index);
      return defaultPassiveCurve(dofPassiveInertia(articulation, dof));
    });
    this.defaulted = defaulted;
    this.damping = Float64Array.from(
      articulation.dofs.map((dof) =>
        dof.passiveDamping > 0
          ? dof.passiveDamping
          : Math.max(dofPassiveInertia(articulation, dof), 1e-6) * DEFAULT_PASSIVE.dampingRate,
      ),
    );
    this.lower = Float64Array.from(articulation.dofs.map((d) => d.range[0]));
    this.upper = Float64Array.from(articulation.dofs.map((d) => d.range[1]));
    this.manifest = {
      id: PASSIVE_JOINT_MODULE_ID,
      version: '1.0.0',
      phase: 'actuate',
      dependsOn: [],
      reads: [{ id: BODY_JOINT_STATE, version: CHANNEL_VERSION }],
      writes: [],
      accumulates: [{ id: ACTUATION_JOINT_TORQUE, version: CHANNEL_VERSION }],
      gives: [],
    };
  }

  init(ctx: ModuleInitContext): void {
    const state = ctx.read(BODY_JOINT_STATE);
    this.q = state.fields.q as Float64Array;
    this.qdot = state.fields.qdot as Float64Array;
    this.torque = ctx.accumulate(ACTUATION_JOINT_TORQUE).fields.torque as Float64Array;
  }

  reset(ctx: ModuleInitContext): void {
    this.init(ctx);
  }

  step(_ctx: ModuleStepContext): void {
    const q = this.q;
    const qdot = this.qdot;
    const torque = this.torque;
    if (!q || !qdot || !torque) return;
    const n = this.curves.length;
    for (let i = 0; i < n; i++) {
      const curve = this.curves[i];
      if (!curve) continue;
      const angle = q[ROOT_NQ + i] as number;
      const speed = qdot[ROOT_NV + i] as number;
      const lo = this.lower[i] as number;
      const hi = this.upper[i] as number;
      const elastic = passiveMomentInto(curve, angle, lo, hi);
      const viscous = -(this.damping[i] as number) * speed;
      torque[ROOT_NV + i] = (torque[ROOT_NV + i] as number) + this.gain * (elastic + viscous);
    }
  }
}

/** `passiveMoment` without the tuple argument, so the step allocates nothing. */
function passiveMomentInto(
  curve: StiffnessCurve,
  angle: number,
  low: number,
  high: number,
): number {
  const lower = curve.lowerGain * Math.exp(-curve.lowerRate * (angle - low));
  const upper = curve.upperGain * Math.exp(curve.upperRate * (angle - high));
  const neutral = curve.linearNeutral ?? 0;
  const linear = (curve.linear ?? 0) * (angle - neutral);
  return lower - upper - linear;
}

export { passiveMoment };
