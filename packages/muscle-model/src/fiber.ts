/**
 * The damped equilibrium musculotendon model -- ticket N0.4.
 *
 * A musculotendon unit is a contractile element and a passive spring side by side, set at an
 * angle to a tendon in series with them. The whole thing spans a known distance between two
 * bones. What it has to work out, every tick, is how that distance is divided between fiber and
 * tendon, because that division is what sets the force.
 *
 * ## The equilibrium
 *
 * The tendon pulls on the fibers and the fibers pull back. Along the tendon's line:
 *
 *     fT(lT) = cos(alpha) * [ a * fL(lM) * fV(vM) + fPE(lM) + beta * vM ]
 *
 * Everything on the right is known at a given fiber length except the fiber velocity, so the
 * equation is really a question about velocity: how fast must the fibers be changing length for
 * the forces to balance right now? Answer that, and integrating the answer moves the state
 * forward.
 *
 * ## Why the damping term is not decoration
 *
 * `beta * vM` is the damped part of "damped equilibrium", and it is the reason this model was
 * chosen over the plain equilibrium model (M-ADR-001). Without it, the velocity only enters
 * through `a * fL * fV`, so at zero activation the equation stops depending on velocity at all
 * and has no solution to find -- implementations paper over this by clamping activation away from
 * zero. With it, the right-hand side is strictly increasing in velocity whatever the activation
 * is, so there is always exactly one answer and it can be found reliably. A relaxed body is the
 * common case, so the case the undamped model handles worst is the case that matters most.
 *
 * Millard et al. (2013) report a damping coefficient of 0.1 and measure the damped model running
 * 29 times faster than the undamped one at low activation for the same accuracy.
 *
 * ## Pennation
 *
 * Fibers that run at an angle to the tendon pull on it by the cosine of that angle. As a muscle
 * shortens the angle steepens, because the fibers keep their width while their length changes:
 * Zajac's (1989) constant-width assumption, which fixes the angle at every length once it is
 * known at one.
 */

import {
  activeForceLength,
  forceVelocity,
  forceVelocitySlope,
  passiveForceLength,
  tendonForceLength,
} from './curves.js';

/**
 * Fiber damping, dimensionless, in units of maximum isometric force per maximum contraction
 * velocity. Millard et al. (2013) give 0.1 as the working value.
 */
export const DEFAULT_FIBER_DAMPING = 0.1;

/** Maximum contraction velocity, optimal fiber lengths per second. Zajac (1989). */
export const DEFAULT_MAX_CONTRACTION_VELOCITY = 10;

/**
 * How far the normalised fiber length may be driven before the model reports it as out of range.
 *
 * Not a clamp on the physics: a fiber this short has no active force left and one this long is
 * carrying many times its isometric force passively. Reaching either means the step was too long
 * or the path is wrong, and the muscle spec requires that to be reported rather than hidden.
 */
export const FIBER_LENGTH_MINIMUM = 0.1;
export const FIBER_LENGTH_MAXIMUM = 2.0;

export interface MusculotendonParameters {
  /** Newtons the fibers make at optimal length, fully activated, held still. */
  readonly maxIsometricForce: number;
  /** Metres. The fiber length at which active force peaks. */
  readonly optimalFiberLength: number;
  /** Metres. The tendon length below which the tendon carries nothing. */
  readonly tendonSlackLength: number;
  /** Radians, at the optimal fiber length. */
  readonly pennationAngle: number;
  /** Optimal fiber lengths per second. */
  readonly maxContractionVelocity: number;
  /** Dimensionless. */
  readonly damping: number;
}

export const DEFAULT_MUSCULOTENDON: Omit<
  MusculotendonParameters,
  'maxIsometricForce' | 'optimalFiberLength' | 'tendonSlackLength' | 'pennationAngle'
> = {
  maxContractionVelocity: DEFAULT_MAX_CONTRACTION_VELOCITY,
  damping: DEFAULT_FIBER_DAMPING,
};

/**
 * The constant the fibers keep as they shorten: the width of the pennation triangle, in optimal
 * fiber lengths. Zero for a muscle whose fibers run straight along the tendon.
 */
export function fiberWidth(pennationAngle: number): number {
  return Math.sin(pennationAngle);
}

/** Pennation angle at a normalised fiber length, from the constant-width assumption. */
export function pennationAt(fiberLength: number, width: number): number {
  if (width <= 0) return 0;
  // A fiber shorter than its own width cannot exist; the angle would be past a right angle and
  // the muscle would be pulling sideways. Report the limit rather than returning a NaN.
  const sine = Math.min(width / Math.max(fiberLength, 1e-9), 1);
  return Math.asin(sine);
}

/** Cosine of the pennation angle, which is the fraction of fiber force the tendon feels. */
export function pennationCosine(fiberLength: number, width: number): number {
  if (width <= 0) return 1;
  const sine = Math.min(width / Math.max(fiberLength, 1e-9), 1);
  return Math.sqrt(Math.max(1 - sine * sine, 0));
}

export interface FiberState {
  /** 0 to 1. */
  readonly activation: number;
  /** Fiber length in optimal fiber lengths. */
  readonly fiberLength: number;
}

export interface FiberSolution {
  /** Fiber velocity in optimal fiber lengths per second, over the maximum contraction velocity. */
  readonly fiberVelocity: number;
  /** Tendon force, in maximum isometric forces. Never negative. */
  readonly tendonForce: number;
  /** Total fiber force along the fiber, in maximum isometric forces. */
  readonly fiberForce: number;
  /** Tendon length, in tendon slack lengths. */
  readonly tendonLength: number;
  readonly pennation: number;
  /** True when the equilibrium could not be solved and the fallback was used. */
  readonly failed: boolean;
}

/** Iterations the equilibrium solve may take before it gives up and reports failure. */
export const EQUILIBRIUM_ITERATIONS = 24;
/** Residual, in maximum isometric forces, below which the equilibrium counts as solved. */
export const EQUILIBRIUM_TOLERANCE = 1e-10;
/**
 * Normalised velocities beyond which the force-velocity curve is not defined.
 *
 * The curve's own argument is bounded: shortening faster than the maximum contraction velocity
 * is not something a muscle does, and the arcsinh form keeps rising rather than saturating, so
 * the search is bracketed rather than allowed to wander into a region with no physical meaning.
 */
export const VELOCITY_BRACKET = 10;

/**
 * Work out how fast the fibers must be changing length for the forces to balance.
 *
 * The residual is strictly increasing in fiber velocity -- the force-velocity curve rises with
 * it and so does the damping term -- so there is exactly one root and bisection cannot fail to
 * find it. Newton's method does the work, and a bracket catches it when the curvature sends a
 * step somewhere useless. That safeguarded pairing is what makes this solve reportable rather
 * than hopeful: a failure here is a diagnostic, not a NaN travelling into the solver.
 */
export function solveEquilibrium(
  state: FiberState,
  musculotendonLength: number,
  parameters: MusculotendonParameters,
): FiberSolution {
  const width = fiberWidth(parameters.pennationAngle);
  const cosine = pennationCosine(state.fiberLength, width);
  const pennation = pennationAt(state.fiberLength, width);

  // What is left of the unit's length once the fibers have taken their share along the line.
  const fiberAlongTendon = state.fiberLength * parameters.optimalFiberLength * cosine;
  const tendonLength = (musculotendonLength - fiberAlongTendon) / parameters.tendonSlackLength;
  // A tendon shorter than slack has buckled and carries nothing; it does not push back.
  const tendonForce = tendonLength <= 1 ? 0 : tendonForceLength(tendonLength);

  const active = state.activation * activeForceLength(state.fiberLength);
  const passive = passiveForceLength(state.fiberLength);

  /** Tendon force the fibers would produce at this velocity, less the force it must match. */
  const residual = (velocity: number) =>
    cosine * (active * forceVelocity(velocity) + passive + parameters.damping * velocity) -
    tendonForce;
  const slope = (velocity: number) =>
    cosine * (active * forceVelocitySlope(velocity) + parameters.damping);

  let low = -VELOCITY_BRACKET;
  let high = VELOCITY_BRACKET;
  const residualLow = residual(low);
  const residualHigh = residual(high);
  let failed = false;
  let velocity: number;
  if (residualLow > 0) {
    // Even shortening as fast as the bracket allows, the fibers make more force than the tendon
    // is carrying. The fibers are shortening at least this fast; hold at the bracket and say so.
    velocity = low;
    failed = true;
  } else if (residualHigh < 0) {
    velocity = high;
    failed = true;
  } else {
    velocity = 0;
    for (let i = 0; i < EQUILIBRIUM_ITERATIONS; i++) {
      const value = residual(velocity);
      if (Math.abs(value) < EQUILIBRIUM_TOLERANCE) break;
      if (value > 0) high = velocity;
      else low = velocity;
      const derivative = slope(velocity);
      const newton = derivative > 0 ? velocity - value / derivative : Number.NaN;
      velocity =
        Number.isFinite(newton) && newton > low && newton < high ? newton : (low + high) / 2;
    }
    failed = Math.abs(residual(velocity)) > 1e-6;
  }

  const fiberForce = active * forceVelocity(velocity) + passive + parameters.damping * velocity;
  return {
    fiberVelocity: velocity,
    tendonForce,
    fiberForce,
    tendonLength,
    pennation,
    failed,
  };
}

export interface FiberStep {
  readonly state: FiberState;
  readonly solution: FiberSolution;
  /** True when the fiber length left the range the model is valid over. */
  readonly outOfRange: boolean;
}

/**
 * Advance activation and fiber length by one fixed step.
 *
 * Semi-implicit, as the muscle spec requires: activation is solved implicitly for itself, and
 * the fiber length is then advanced with the velocity that balances the forces at the *new*
 * activation rather than the old one. The fiber dynamics are stiffest at the ends of the
 * force-length curve, which is exactly where an explicit step would overshoot and oscillate.
 */
export function stepFiber(
  state: FiberState,
  musculotendonLength: number,
  activation: number,
  dt: number,
  parameters: MusculotendonParameters,
): FiberStep {
  const solution = solveEquilibrium(
    { activation, fiberLength: state.fiberLength },
    musculotendonLength,
    parameters,
  );
  const rate = solution.fiberVelocity * parameters.maxContractionVelocity;
  const next = state.fiberLength + rate * dt;
  const outOfRange = next < FIBER_LENGTH_MINIMUM || next > FIBER_LENGTH_MAXIMUM;
  const clamped = Math.min(Math.max(next, FIBER_LENGTH_MINIMUM), FIBER_LENGTH_MAXIMUM);
  return {
    state: { activation, fiberLength: clamped },
    solution,
    outOfRange,
  };
}

/**
 * A fiber length that balances the forces at a given activation and unit length, for starting a
 * muscle off without a transient.
 *
 * Bisection on the velocity the equilibrium would need: too short a fiber leaves the tendon
 * slack and the fibers shortening, too long and the tendon drags them out. The length where the
 * balance needs no velocity at all is the static one.
 */
export function equilibriumFiberLength(
  activation: number,
  musculotendonLength: number,
  parameters: MusculotendonParameters,
  iterations = 60,
): number {
  let low = FIBER_LENGTH_MINIMUM;
  let high = FIBER_LENGTH_MAXIMUM;
  for (let i = 0; i < iterations; i++) {
    const middle = (low + high) / 2;
    const solution = solveEquilibrium(
      { activation, fiberLength: middle },
      musculotendonLength,
      parameters,
    );
    // A positive velocity here means the tendon is pulling the fibers longer than this guess.
    if (solution.fiberVelocity > 0) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}
