/**
 * Activation dynamics -- ticket N0.3.
 *
 * A nerve does not switch a muscle on. Excitation arrives, calcium floods the fiber, and force
 * follows some tens of milliseconds later; when the excitation stops, the calcium has to be
 * pumped back, which takes longer still. So activation lags excitation, and it lags asymmetrically:
 * a muscle turns on faster than it turns off.
 *
 * The model is first order with two time constants, the form Thelen (2003) and Millard et al.
 * (2013) both use. The spec requires both to be per-muscle parameters with citations rather than
 * global constants, so they are arguments here and this module holds only the defaults and the
 * arithmetic.
 */

import { type Citation, cite } from '@bs-humany/hsdl';

/**
 * Default time constants, seconds: 10 ms to activate and 40 ms to relax. A muscle whose own values
 * are known should pass its own.
 *
 * These are Millard et al.'s (2013) defaults, and that is where they are cited from, because it is
 * the paper that prints them. They used to be credited to Thelen (2003), and the mistake is an
 * inherited one: Millard cites Thelen for them, but Thelen's own young-adult values are 15 ms and
 * 50 ms (methods, and table 1 for the deactivation constant), and those are what OpenSim's
 * Thelen2003Muscle defaults to. Both pairs are ordinary published values, and the spec's own
 * "typical" pair is this one, so the values stay; only the credit moves.
 *
 * Both papers also scale the time constant with activation (Millard's equation 3), so that a muscle
 * already working hard is slower to rise further and quicker to fall. This module does not: the
 * spec asks for the plain first-order model, and the constants are used here as constants.
 */
export const DEFAULT_ACTIVATION_TIME = 0.01;
export const DEFAULT_DEACTIVATION_TIME = 0.04;

/**
 * Where `DEFAULT_ACTIVATION_TIME` and `DEFAULT_DEACTIVATION_TIME` come from.
 *
 * Kept beside the values rather than inside `ActivationParameters`, because those parameters are
 * the per-muscle numbers a muscle table supplies and carries its own citation for; this is the
 * citation for the fallback, for anything that reports where a muscle's numbers came from.
 */
export const DEFAULT_ACTIVATION_SOURCE: Citation = cite(
  'millard2013',
  'Section 2.1, equation 3: activation and deactivation time constants of 10 ms and 40 ms by default',
);

/**
 * The lowest activation a muscle is allowed to hold.
 *
 * Not physiology: arithmetic. Several published fiber formulations divide by activation, and a
 * muscle at exactly zero makes them singular. The damped equilibrium model this project uses
 * does not have that problem (M-ADR-001 and the damping term are exactly what removes it), so
 * this floor exists only to keep activation away from the boundary of its own valid range where
 * an integrator could otherwise step it slightly negative. It is small enough to be invisible in
 * force: a muscle at this activation carries a thousandth of its isometric force.
 */
export const MINIMUM_ACTIVATION = 0.001;

export interface ActivationParameters {
  /** Seconds. Time constant while excitation exceeds activation. */
  readonly activationTime: number;
  /** Seconds. Time constant while it does not. */
  readonly deactivationTime: number;
}

export const DEFAULT_ACTIVATION_PARAMETERS: ActivationParameters = {
  activationTime: DEFAULT_ACTIVATION_TIME,
  deactivationTime: DEFAULT_DEACTIVATION_TIME,
};

/**
 * Rate of change of activation, per second.
 *
 * The time constant switches on whether the muscle is rising or falling toward the excitation it
 * is being given, which is the asymmetry described above.
 */
export function activationRate(
  activation: number,
  excitation: number,
  parameters: ActivationParameters = DEFAULT_ACTIVATION_PARAMETERS,
): number {
  const difference = excitation - activation;
  const timeConstant = difference > 0 ? parameters.activationTime : parameters.deactivationTime;
  return difference / timeConstant;
}

/**
 * Advance activation by one step, implicitly.
 *
 * The explicit form of this equation goes unstable when the step is long compared with the time
 * constant, and 10 ms is only five steps at 500 Hz, so that is not a hypothetical. Solving
 * `a' = a + dt * (u - a') / tau` for the new activation costs one division and is stable at any
 * step length, which is worth more than the accuracy an explicit step would have kept.
 */
export function stepActivation(
  activation: number,
  excitation: number,
  dt: number,
  parameters: ActivationParameters = DEFAULT_ACTIVATION_PARAMETERS,
): number {
  const clampedExcitation = clamp(excitation, 0, 1);
  const timeConstant =
    clampedExcitation > activation ? parameters.activationTime : parameters.deactivationTime;
  const next = (activation + (dt / timeConstant) * clampedExcitation) / (1 + dt / timeConstant);
  return clamp(next, MINIMUM_ACTIVATION, 1);
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
