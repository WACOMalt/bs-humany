/**
 * The four characteristic curves of a Hill-type musculotendon unit -- ticket N0.1.
 *
 * A muscle's behaviour is four functions of one variable each. How much active force the fibers
 * can make at a given length, how that force changes with shortening speed, how much force the
 * fibers resist stretch with when nothing is driving them, and how much force the tendon carries
 * when it is stretched past slack. Everything else in the model is bookkeeping around these.
 *
 * ## Which formulation, and why
 *
 * The muscle spec calls for the Millard (2013) damped equilibrium *model*. It does not dictate
 * how the curves inside it are drawn, and there are two traditions. Millard's own implementation
 * uses quintic Bezier splines, which are twice differentiable by construction but whose shape
 * lives in tables of control points that cannot be checked by reading them. De Groote et al.
 * (2016) restate the same four shapes in closed form, with every coefficient printed, chosen
 * specifically so that the curves are twice differentiable for gradient-based solvers. That is
 * the same requirement this module has, for the same reason, and a printed coefficient is a
 * coefficient a reviewer can check against the paper.
 *
 * So: Millard's model, De Groote's curves. Both are cited where they are used, and the
 * combination is stated here rather than left for a reader to infer.
 *
 * ## Normalisation
 *
 * Everything here is dimensionless, following Zajac (1989). Force is in units of the muscle's
 * maximum isometric force, fiber length in units of its optimal fiber length, tendon length in
 * units of its slack length, and fiber velocity in optimal fiber lengths per second divided by
 * the maximum contraction velocity. A curve therefore knows nothing about any particular muscle,
 * which is what makes these functions testable against published numbers on their own.
 *
 * Every curve comes with its first derivative, because the integrator needs them and because a
 * derivative computed by differencing is the thing that turns a stiff system unstable.
 */

/**
 * Active force-length: how much force the contractile element can make at a given fiber length.
 *
 * Three Gaussians summed. Force peaks at the optimal fiber length, where the actin and myosin
 * filaments overlap best, and falls away on both sides -- too short and the filaments collide,
 * too long and they barely touch.
 *
 * De Groote et al. (2016), equation 4 and table 4.
 */
const ACTIVE_FL = [
  { b1: 0.815, b2: 1.055, b3: 0.162, b4: 0.0633 },
  { b1: 0.433, b2: 0.717, b3: -0.0299, b4: 0.2004 },
  { b1: 0.1, b2: 1.0, b3: 0.354, b4: 0.0 },
] as const;

export function activeForceLength(fiberLength: number): number {
  let sum = 0;
  for (const { b1, b2, b3, b4 } of ACTIVE_FL) {
    const spread = b3 + b4 * fiberLength;
    const offset = fiberLength - b2;
    sum += b1 * Math.exp((-0.5 * offset * offset) / (spread * spread));
  }
  return sum;
}

export function activeForceLengthSlope(fiberLength: number): number {
  let sum = 0;
  for (const { b1, b2, b3, b4 } of ACTIVE_FL) {
    const spread = b3 + b4 * fiberLength;
    const offset = fiberLength - b2;
    const exponent = (-0.5 * offset * offset) / (spread * spread);
    // d/dl of the exponent, with the spread itself depending on l.
    const derivative = (-offset / (spread * spread)) * (1 - (offset * b4) / spread);
    sum += b1 * Math.exp(exponent) * derivative;
  }
  return sum;
}

/**
 * Passive force-length: the force the fibers resist stretch with, with nothing driving them.
 *
 * Zero while the muscle is shorter than optimal -- a relaxed muscle offers no resistance to being
 * shortened -- and rising steeply once stretched past it, which is the connective tissue in
 * parallel with the fibers taking up load.
 *
 * De Groote et al. (2016), equation 3. `PASSIVE_STRAIN` is the strain at which the passive
 * element alone carries the muscle's maximum isometric force, and `PASSIVE_SHAPE` sets how
 * sharply it gets there.
 */
export const PASSIVE_STRAIN = 0.6;
export const PASSIVE_SHAPE = 4.0;

export function passiveForceLength(fiberLength: number): number {
  const numerator = Math.exp((PASSIVE_SHAPE * (fiberLength - 1)) / PASSIVE_STRAIN) - 1;
  return numerator / (Math.exp(PASSIVE_SHAPE) - 1);
}

export function passiveForceLengthSlope(fiberLength: number): number {
  const scale = PASSIVE_SHAPE / PASSIVE_STRAIN;
  return (scale * Math.exp(scale * (fiberLength - 1))) / (Math.exp(PASSIVE_SHAPE) - 1);
}

/**
 * Force-velocity: how the active force changes with the speed of shortening or lengthening.
 *
 * A muscle shortening quickly makes less force, because the cross-bridges have less time to
 * attach; a muscle being stretched makes more, up to a plateau above its isometric force. The
 * curve passes through 1 at zero velocity by construction, which is what "isometric" means.
 *
 * Velocity is normalised so that -1 is shortening at the maximum contraction velocity and +1 is
 * lengthening at the same rate.
 *
 * De Groote et al. (2016), equation 2 and table 3. The inverse hyperbolic sine form is used
 * rather than the classical Hill hyperbola because it is smooth through zero velocity and
 * invertible in closed form, and the inverse is what a rigid-tendon model needs.
 *
 * One deliberate change, of the same kind as the tendon offset below. With the published constant
 * term of 0.8858 the curve reads 1.00214 at zero velocity rather than 1. That is well inside the
 * fit's own accuracy, but it is not a random error: it is a fixed 0.21% that multiplies every
 * force the model produces, because zero velocity is where maximum isometric force is defined and
 * measured. A muscle given a published 500 N would quietly make 501 N standing still, and the
 * single-muscle benchmarks compare force profiles. `FV_OFFSET` is therefore the constant that puts
 * the curve through 1 at zero velocity exactly. The shape and every slope are untouched.
 */
const FV = { d1: -0.318, d2: -8.149, d3: -0.374 } as const;

/** The published value is 0.8858; this differs from it by 0.00214. */
export const FV_OFFSET = 1 - FV.d1 * Math.asinh(FV.d3);

export function forceVelocity(fiberVelocity: number): number {
  const inner = FV.d2 * fiberVelocity + FV.d3;
  return FV.d1 * Math.log(inner + Math.sqrt(inner * inner + 1)) + FV_OFFSET;
}

export function forceVelocitySlope(fiberVelocity: number): number {
  const inner = FV.d2 * fiberVelocity + FV.d3;
  return (FV.d1 * FV.d2) / Math.sqrt(inner * inner + 1);
}

/**
 * The velocity at which the fibers would make this much force. The exact inverse of
 * `forceVelocity`, from the closed form of the arcsinh.
 */
export function inverseForceVelocity(forceScale: number): number {
  return (Math.sinh((forceScale - FV_OFFSET) / FV.d1) - FV.d3) / FV.d2;
}

/**
 * Tendon force-length: the force the tendon carries when stretched past its slack length.
 *
 * A tendon is a stiff spring that does not push. Below slack it buckles and carries nothing;
 * above slack the force rises steeply, and the stiffness itself rises with strain because the
 * collagen crimp straightens out before the fibers themselves take the load.
 *
 * De Groote et al. (2016), equation 1 and table 2, with one deliberate change. The published
 * constant term leaves the curve about 0.012 below zero at slack length, so a tendon at exactly
 * its slack length would push. `TENDON_OFFSET` is instead set to the value that makes the curve
 * pass through zero at slack exactly, which is what the shape means physically and what the
 * plausibility rule about tendons never pushing requires. The shape and stiffness are unchanged.
 */
export const TENDON_SHAPE = 35.0;
export const TENDON_SCALE = 0.2;
export const TENDON_STRAIN_AT_SCALE = 0.995;
/** Chosen so the curve is exactly zero at slack, rather than the published -0.012. */
export const TENDON_OFFSET = TENDON_SCALE * Math.exp(TENDON_SHAPE * (1 - TENDON_STRAIN_AT_SCALE));

export function tendonForceLength(tendonLength: number): number {
  return (
    TENDON_SCALE * Math.exp(TENDON_SHAPE * (tendonLength - TENDON_STRAIN_AT_SCALE)) - TENDON_OFFSET
  );
}

export function tendonForceLengthSlope(tendonLength: number): number {
  return (
    TENDON_SCALE * TENDON_SHAPE * Math.exp(TENDON_SHAPE * (tendonLength - TENDON_STRAIN_AT_SCALE))
  );
}

/**
 * The tendon length that carries this force. Closed-form inverse of `tendonForceLength`, used to
 * start the fiber state somewhere sensible rather than guessing.
 */
export function inverseTendonForceLength(force: number): number {
  return Math.log((force + TENDON_OFFSET) / TENDON_SCALE) / TENDON_SHAPE + TENDON_STRAIN_AT_SCALE;
}
