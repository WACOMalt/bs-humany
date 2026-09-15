/**
 * The rigid-tendon musculotendon variant -- ticket N0.6, for tier `M2-fast`.
 *
 * The elastic model spends its time answering one question: how is the unit's length divided
 * between fiber and tendon? This variant refuses the question. It declares the tendon
 * inextensible, always exactly its slack length, which leaves the fiber length fully determined
 * by geometry and turns the whole step into arithmetic -- no equilibrium, no iteration, no state
 * of its own to integrate.
 *
 * That is the entire speed argument, and it is a real one: Millard et al. (2013) measure the
 * rigid-tendon fiber step at roughly 2x to 54x the speed of the elastic one.
 *
 * ## What it costs
 *
 * A tendon is not inextensible, and pretending it is puts the error straight into the fiber
 * length -- every millimetre the tendon should have stretched is a millimetre the fiber is
 * wrongly assumed to have moved instead. So the approximation is good exactly when the tendon is
 * short compared with the fibers and poor when it is long, which is why it is offered as a tier
 * rather than as the default. Millard reports the error reaching about 20.9%.
 *
 * The user interface has to show that band alongside the tier, per section 12 of the muscle spec:
 * a user choosing speed is entitled to see what they gave up.
 *
 * ## The geometry
 *
 * With the tendon fixed and the fibers keeping their width (Zajac 1989), everything follows from
 * a right triangle whose base is what the tendon left over:
 *
 *     base = lMT - lTs,   height = lopt * sin(alpha0),   fiber = sqrt(base^2 + height^2)
 *
 * Differentiating that gives the fiber velocity directly from the path velocity, which is the
 * other thing this variant gets for free: the elastic model has to solve for it.
 */

import { activeForceLength, forceVelocity, passiveForceLength } from './curves.js';
import { type MusculotendonParameters, pennationAt } from './fiber.js';

export interface RigidTendonSolution {
  /** Fiber length in optimal fiber lengths, fixed by the path rather than integrated. */
  readonly fiberLength: number;
  /** Normalised fiber velocity, over the maximum contraction velocity. */
  readonly fiberVelocity: number;
  /** Total fiber force along the fiber, in maximum isometric forces. */
  readonly fiberForce: number;
  /** Tendon force, in maximum isometric forces. Never negative. */
  readonly tendonForce: number;
  readonly pennation: number;
  /**
   * True when the unit is shorter than its own tendon.
   *
   * The elastic model answers this by letting the tendon buckle. A rigid tendon has no such
   * answer: the geometry it is built on has run out, and the numbers past that point are an
   * extrapolation rather than a result. Reported rather than hidden, as the spec requires.
   */
  readonly outOfRange: boolean;
}

/**
 * Force in a rigid-tendon unit, in one pass.
 *
 * `pathVelocity` is the rate of change of the whole unit's length, in metres per second. It comes
 * from the path solver analytically rather than from differencing successive lengths, because a
 * differenced velocity would feed the force-velocity curve a step's worth of noise.
 */
export function solveRigidTendon(
  activation: number,
  musculotendonLength: number,
  pathVelocity: number,
  parameters: MusculotendonParameters,
): RigidTendonSolution {
  const height = parameters.optimalFiberLength * Math.sin(parameters.pennationAngle);
  const base = musculotendonLength - parameters.tendonSlackLength;
  const outOfRange = base < 0;

  const fiberAbsolute = Math.sqrt(base * base + height * height);
  const fiberLength = fiberAbsolute / parameters.optimalFiberLength;
  // cos(alpha) = base / fiber. Guard the degenerate unit that is exactly its tendon's length,
  // where the fibers would be standing at a right angle to it and pulling on nothing.
  const cosine = fiberAbsolute > 0 ? base / fiberAbsolute : 0;

  // d/dt sqrt(base^2 + height^2) with the height constant.
  const fiberRate = cosine * pathVelocity;
  const fiberVelocity =
    fiberRate / (parameters.optimalFiberLength * parameters.maxContractionVelocity);

  const active = activation * activeForceLength(fiberLength) * forceVelocity(fiberVelocity);
  const passive = passiveForceLength(fiberLength);
  const fiberForce = active + passive + parameters.damping * fiberVelocity;

  // A tendon does not push. In the elastic model that is the buckling branch; here it is a clamp,
  // because the damping term alone can drive the sum negative during a fast shortening and there
  // is no tendon state left to absorb it.
  const tendonForce = Math.max(cosine * fiberForce, 0);

  return {
    fiberLength,
    fiberVelocity,
    fiberForce,
    tendonForce,
    pennation: pennationAt(fiberLength, Math.sin(parameters.pennationAngle)),
    outOfRange,
  };
}

/**
 * How much of the unit's length the tendon accounts for.
 *
 * The one number that predicts whether the rigid approximation is usable for a given muscle: the
 * error it introduces is the tendon strain it refuses to model, so a muscle whose tendon is a
 * small share of its length loses little and one whose tendon dominates loses a great deal. A
 * caller choosing a tier per muscle rather than globally should read this first.
 */
export function tendonShare(parameters: MusculotendonParameters): number {
  const { tendonSlackLength, optimalFiberLength, pennationAngle } = parameters;
  return tendonSlackLength / (tendonSlackLength + optimalFiberLength * Math.cos(pennationAngle));
}
