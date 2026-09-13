/**
 * Backend conformance -- spec section 13.3.
 *
 * Two backends run the same scenario. They will not agree trajectory for trajectory: a collapse
 * is chaotic, and the solvers differ by design (ADR-002: Rapier is a lossy projection). What they
 * must agree on is the physics before chaos takes over and the outcome after it settles:
 *
 *   - the free-flight prefix, where both integrate the same rigid bodies under gravity: the
 *     centre of mass should match to millimetres;
 *   - the resting outcome: both at rest, with the centre of mass within a hand's width in height,
 *     and comparable energy dissipated.
 *
 * Tolerances are documented next to their reasons and are not to be tuned until green.
 */

import type { Trajectory } from './runner.js';

export interface ConformanceTolerances {
  /** Metres of CoM disagreement during the contact-free prefix. */
  readonly freeFlightCom: number;
  /** Metres of disagreement in the resting CoM height. */
  readonly restComHeight: number;
  /** Joules of kinetic energy both must be under at the end. */
  readonly restKinetic: number;
  /** Fraction of the initial mechanical energy the dissipated amounts may differ by. */
  readonly dissipation: number;
}

/**
 * - freeFlightCom 5 mm: identical initial state, identical gravity, one sample every 20 ms; the
 *   only differences are integration order and floating point.
 * - restComHeight 0.12 m: a collapsed body's CoM height depends on which way it folded, and the
 *   fold is chaotic; but a body that ends standing on one backend and flat on the other would be
 *   a bug, and that is a difference of half a metre.
 * - restKinetic 1 J: as in plausibility.
 * - dissipation 0.25: both should have dissipated most of what the drop released; a quarter of
 *   it is the spread between a soft landing and a hard one.
 */
export const DEFAULT_CONFORMANCE: ConformanceTolerances = {
  freeFlightCom: 0.005,
  restComHeight: 0.12,
  restKinetic: 1,
  dissipation: 0.25,
};

export interface Disagreement {
  readonly check: string;
  readonly message: string;
  readonly value: number;
  readonly limit: number;
}

export function compareTrajectories(
  a: Trajectory,
  b: Trajectory,
  tolerances: ConformanceTolerances,
  options: { readonly expectRest: boolean },
): Disagreement[] {
  const out: Disagreement[] = [];
  if (a.samples.length !== b.samples.length) {
    out.push({
      check: 'samples',
      message: `sample counts differ: ${a.samples.length} vs ${b.samples.length}`,
      value: Math.abs(a.samples.length - b.samples.length),
      limit: 0,
    });
    return out;
  }

  // Free-flight prefix: until either has a contact.
  let worstFree = 0;
  let freeSamples = 0;
  for (let i = 0; i < a.samples.length; i++) {
    const sa = a.samples[i];
    const sb = b.samples[i];
    if (!sa || !sb || sa.contacts > 0 || sb.contacts > 0) break;
    freeSamples++;
    const d = Math.hypot(sa.com.x - sb.com.x, sa.com.y - sb.com.y, sa.com.z - sb.com.z);
    worstFree = Math.max(worstFree, d);
  }
  if (freeSamples > 1 && worstFree > tolerances.freeFlightCom) {
    out.push({
      check: 'free-flight',
      message: `centre of mass differed by ${(worstFree * 1000).toFixed(2)} mm during free flight (${freeSamples} samples)`,
      value: worstFree,
      limit: tolerances.freeFlightCom,
    });
  }

  const la = a.samples[a.samples.length - 1];
  const lb = b.samples[b.samples.length - 1];
  const fa = a.samples[0];
  const fb = b.samples[0];
  if (!la || !lb || !fa || !fb) return out;

  if (options.expectRest) {
    for (const [name, s] of [
      [a.backend, la],
      [b.backend, lb],
    ] as const) {
      if (s.kinetic > tolerances.restKinetic) {
        out.push({
          check: 'rest',
          message: `${name} still has ${s.kinetic.toFixed(2)} J kinetic at the end`,
          value: s.kinetic,
          limit: tolerances.restKinetic,
        });
      }
    }
    const dh = Math.abs(la.com.y - lb.com.y);
    if (dh > tolerances.restComHeight) {
      out.push({
        check: 'rest-height',
        message: `resting centre of mass heights differ by ${(dh * 100).toFixed(1)} cm (${la.com.y.toFixed(3)} vs ${lb.com.y.toFixed(3)})`,
        value: dh,
        limit: tolerances.restComHeight,
      });
    }
    const initial = fa.kinetic + fa.potential;
    const dissA = initial - (la.kinetic + la.potential);
    const dissB = initial - (lb.kinetic + lb.potential);
    const spread = Math.abs(dissA - dissB) / Math.max(1, Math.abs(initial));
    if (spread > tolerances.dissipation) {
      out.push({
        check: 'dissipation',
        message: `dissipated energy differs by ${(spread * 100).toFixed(1)}% of the initial (${dissA.toFixed(1)} vs ${dissB.toFixed(1)} J)`,
        value: spread,
        limit: tolerances.dissipation,
      });
    }
  }
  return out;
}
