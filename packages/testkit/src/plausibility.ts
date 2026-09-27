/**
 * Physical plausibility assertions -- spec section 13.4.
 *
 * Automated, on every scenario. Each check names its tolerance and why it is what it is; a
 * failure is a finding with the number that failed, so a tolerance is never quietly widened to
 * make a run green.
 */

import { ROOT_NQ, dofPassiveInertia } from '@bs-humany/compiler';
import { defaultPassiveCurve } from '@bs-humany/modules-mechanics';
import type { Sample, Trajectory } from './runner.js';

/**
 * Elastic energy stored in the joints at a sample: the passive curves' potential, in the closed
 * form of the double exponential. Without this term a limb rebounding off the end of its range
 * reads as energy appearing from nowhere. MuJoCo's native range limits are soft constraints, not
 * springs with an energy of their own, so nothing else is stored.
 */
export function elasticEnergy(
  trajectory: Trajectory,
  sample: Sample,
  options: { readonly passiveJoints: boolean },
): number {
  if (!options.passiveJoints) return 0;
  const model = trajectory.articulation;
  let energy = 0;
  for (const dof of model.dofs) {
    const q = sample.q[ROOT_NQ + dof.index] ?? 0;
    const [lo, hi] = dof.range;
    const curve = dof.passiveStiffness ?? defaultPassiveCurve(dofPassiveInertia(model, dof));
    energy += (curve.lowerGain / curve.lowerRate) * Math.exp(-curve.lowerRate * (q - lo));
    energy += (curve.upperGain / curve.upperRate) * Math.exp(curve.upperRate * (q - hi));
    if (curve.linear) energy += 0.5 * curve.linear * (q - (curve.linearNeutral ?? 0)) ** 2;
  }
  return energy;
}

export interface PlausibilityTolerances {
  /** Joules a passive system's mechanical energy may rise between samples, from integration. */
  readonly energyRisePerSample: number;
  /** Radians past a hard range stop. */
  readonly rangeViolation: number;
  /** Metres of penetration. */
  readonly penetration: number;
  /** Joules of kinetic energy that count as at rest. */
  readonly restKinetic: number;
  /** Metres of joint separation. */
  readonly drift: number;
  /** Relative error of the CoM's vertical acceleration against g during free flight. */
  readonly ballistic: number;
}

/**
 * Defaults and their reasons, for MuJoCo, the only backend. Rapier ran to looser ones (20 J,
 * 0.5 rad, 4 cm) until it was deleted; `docs/validation/conformance.md` keeps its figures.
 *
 * - energyRisePerSample 2 J: kinetic plus gravitational plus the elastic energy of the passive
 *   curves, less the work of emulated couplings, should never rise in a passive system. What
 *   remains is the contacts' work at impacts (a soft contact's impedance is not conservative)
 *   and the one-tick lag of the actuate phase. A 70 kg body landing at a few metres per second,
 *   with 100 to 250 J of kinetic energy in play, stays within 2 J over a 20 ms sample; the number
 *   scales with the sample interval.
 * - rangeViolation 0.2 rad: native limits at a 10 ms impedance time constant yield about
 *   0.15 rad under the whole body's weight -- the ankles in a standing collapse, a shoulder
 *   hanging from its wrist.
 * - penetration 0.03 m: contacts at the same impedance stay under three centimetres, a hard
 *   landing on a box edge (the stairs) included.
 * - restKinetic 1 J: a 70 kg body with a joule of kinetic energy is twitching, not moving.
 * - drift 0.05 m: in reduced coordinates a joint cannot separate, and none does (0.0 mm in every
 *   scenario); five centimetres is visible, so a reading near it is a broken pose readout.
 * - ballistic 0.15: the CoM under free flight should fall at g; contacts start before a full
 *   parabola is available, so the fit is short and coarse.
 */
export const DEFAULT_TOLERANCES: PlausibilityTolerances = {
  energyRisePerSample: 2,
  rangeViolation: 0.2,
  penetration: 0.03,
  restKinetic: 1,
  drift: 0.05,
  ballistic: 0.15,
};

export interface Finding {
  readonly check: string;
  readonly message: string;
  readonly value: number;
  readonly limit: number;
}

export function checkPlausibility(
  trajectory: Trajectory,
  tolerances: PlausibilityTolerances,
  options: {
    readonly passiveSystem: boolean;
    readonly expectRest: boolean;
    readonly passiveJoints: boolean;
  },
): Finding[] {
  const findings: Finding[] = [];
  const samples = trajectory.samples;

  // No NaN or Inf, ever.
  for (const s of samples) {
    for (let i = 0; i < s.position.length; i++) {
      if (!Number.isFinite(s.position[i])) {
        findings.push({
          check: 'finite',
          message: `non-finite position at t=${s.time}`,
          value: Number.NaN,
          limit: 0,
        });
        return findings;
      }
    }
  }

  // Energy never increases in a passive system beyond tolerance.
  if (options.passiveSystem) {
    let worst = 0;
    let at = 0;
    // Energy balance: kinetic, gravitational and elastic, less the work emulated couplings did.
    const total = (s: Sample) =>
      s.kinetic + s.potential + elasticEnergy(trajectory, s, options) - s.couplingWork;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      if (!a || !b) continue;
      const rise = total(b) - total(a);
      if (rise > worst) {
        worst = rise;
        at = b.time;
      }
    }
    if (worst > tolerances.energyRisePerSample) {
      findings.push({
        check: 'energy',
        message: `mechanical energy rose by ${worst.toFixed(2)} J between samples at t=${at.toFixed(2)} s`,
        value: worst,
        limit: tolerances.energyRisePerSample,
      });
    }
  }

  // Range stops.
  let violation = 0;
  for (const s of samples) violation = Math.max(violation, s.maxViolation);
  if (violation > tolerances.rangeViolation) {
    findings.push({
      check: 'range',
      message: `a DoF went ${violation.toFixed(3)} rad past its stop`,
      value: violation,
      limit: tolerances.rangeViolation,
    });
  }

  // Penetration.
  let penetration = 0;
  for (const s of samples) penetration = Math.max(penetration, s.maxPenetration);
  if (penetration > tolerances.penetration) {
    findings.push({
      check: 'penetration',
      message: `contact penetration reached ${(penetration * 1000).toFixed(1)} mm`,
      value: penetration,
      limit: tolerances.penetration,
    });
  }

  // Drift.
  let drift = 0;
  for (const s of samples) drift = Math.max(drift, s.drift);
  if (drift > tolerances.drift) {
    findings.push({
      check: 'drift',
      message: `joint separation reached ${(drift * 1000).toFixed(1)} mm`,
      value: drift,
      limit: tolerances.drift,
    });
  }

  // Comes to rest.
  const last = samples[samples.length - 1];
  if (options.expectRest && last && last.kinetic > tolerances.restKinetic) {
    findings.push({
      check: 'rest',
      message: `still moving at the end: ${last.kinetic.toFixed(2)} J kinetic`,
      value: last.kinetic,
      limit: tolerances.restKinetic,
    });
  }

  // Ballistic CoM during free flight: fit y(t) over the contact-free prefix.
  const free = [];
  for (const s of samples) {
    if (s.contacts > 0) break;
    free.push(s);
  }
  if (free.length >= 4 && options.passiveSystem) {
    // Second finite difference of the CoM height should be -g.
    const g = Math.hypot(
      trajectory.articulation.gravity.x,
      trajectory.articulation.gravity.y,
      trajectory.articulation.gravity.z,
    );
    let worst = 0;
    for (let i = 2; i < free.length; i++) {
      const a = free[i - 2];
      const b = free[i - 1];
      const c = free[i];
      if (!a || !b || !c) continue;
      const h = b.time - a.time;
      const accel = (c.com.y - 2 * b.com.y + a.com.y) / (h * h);
      worst = Math.max(worst, Math.abs(accel + g) / g);
    }
    if (worst > tolerances.ballistic) {
      findings.push({
        check: 'ballistic',
        message: `centre of mass acceleration in free flight was off g by ${(worst * 100).toFixed(1)}%`,
        value: worst,
        limit: tolerances.ballistic,
      });
    }
  }

  return findings;
}
