/**
 * Moment arm by virtual work -- ticket N1.8, muscle spec 8.3.
 *
 * The moment arm is not a distance that gets measured. It is the derivative of path length with
 * respect to a joint coordinate, and calling it an arm is a convenience that happens to be exact
 * for a simple hinge and merely suggestive for anything else. Virtual work is the definition:
 * a tension `F` acting along a path whose length shortens by `dL` as the coordinate advances by
 * `dq` does work `-F dL`, so the generalized force it produces is
 *
 *     tau = -F * dL/dq,   and therefore   r = -dL/dq
 *
 * The negative sign is the whole content of the convention, and it is the right way round: a
 * muscle whose path gets *shorter* as the coordinate increases is pulling the joint in the
 * positive direction, so it has a positive moment arm.
 *
 * ## Why this is output only
 *
 * M-ADR-003: muscle force reaches the simulation as wrenches on bodies, never as a joint torque
 * computed from a moment arm. Doing it the other way would make the moment arm a load-bearing
 * approximation and would silently discard the joint reaction force, which is a large part of
 * what a muscle actually does to a skeleton. The moment arm exists here to be compared against
 * published cadaver measurements (section 13.2), and for nothing else.
 *
 * ## Analytic, not differenced, where it can be
 *
 * For a revolute joint, every path point on the distal side sweeps a circle about the axis, so
 * its velocity under a unit rate of the coordinate is `axis x (point - centre)` exactly. Summing
 * the projection of those onto the segment directions gives `dL/dq` with no step size to choose
 * and no cancellation to worry about. The central-difference form is kept for solvers whose path
 * has no closed-form derivative, and it exists mostly so the analytic form can be checked against
 * something that shares none of its assumptions.
 */

import type { Vec3 } from './types.js';

/**
 * A revolute degree of freedom, described in world coordinates at the current pose.
 *
 * `movesWith` answers whether a body is carried by this coordinate. For a joint in a tree that is
 * every body distal to it; the caller owns the articulation and therefore owns that question.
 */
export interface RevoluteCoordinate {
  /** World, unit length. Positive rotation is right-handed about it. */
  readonly axis: Vec3;
  /** Any world point on the axis. */
  readonly centre: Vec3;
  readonly movesWith: (body: number) => boolean;
}

function dot(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return ax * bx + ay * by + az * bz;
}

/**
 * `dL/dq` for one path about one revolute coordinate.
 *
 * `points` and `bodies` are the path's world points and their owning bodies, in path order, as
 * `ViaPointPathSolver.worldPoints` and `.bodiesOf` return them.
 */
export function pathLengthDerivative(
  points: readonly Vec3[],
  bodies: readonly number[],
  coordinate: RevoluteCoordinate,
): number {
  const { axis, centre } = coordinate;
  let derivative = 0;

  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Vec3;
    const b = points[i + 1] as Vec3;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const segment = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (segment <= 0) continue;
    const ux = dx / segment;
    const uy = dy / segment;
    const uz = dz / segment;

    // Velocity of each endpoint under a unit rate of the coordinate: axis x (point - centre) for
    // a point that this coordinate carries, and zero for one it does not.
    let rate = 0;
    if (coordinate.movesWith(bodies[i + 1] as number)) {
      const px = b.x - centre.x;
      const py = b.y - centre.y;
      const pz = b.z - centre.z;
      rate += dot(
        ux,
        uy,
        uz,
        axis.y * pz - axis.z * py,
        axis.z * px - axis.x * pz,
        axis.x * py - axis.y * px,
      );
    }
    if (coordinate.movesWith(bodies[i] as number)) {
      const px = a.x - centre.x;
      const py = a.y - centre.y;
      const pz = a.z - centre.z;
      rate -= dot(
        ux,
        uy,
        uz,
        axis.y * pz - axis.z * py,
        axis.z * px - axis.x * pz,
        axis.x * py - axis.y * px,
      );
    }
    derivative += rate;
  }

  return derivative;
}

/**
 * The moment arm, in metres. Positive when the muscle's tension drives the coordinate positive.
 *
 * A sign change across a joint's range where published data shows none is a hard failure of the
 * validation harness (section 13.2), because it means the path has fallen to the wrong side of
 * something and the muscle has changed from a flexor into an extensor.
 */
export function momentArm(
  points: readonly Vec3[],
  bodies: readonly number[],
  coordinate: RevoluteCoordinate,
): number {
  return -pathLengthDerivative(points, bodies, coordinate);
}

/**
 * The step used by `momentArmByDifference`, in radians.
 *
 * Documented because the spec requires it to be (section 8.3), and chosen rather than guessed. A
 * central difference has two error terms pulling in opposite directions: truncation falling as
 * `h^2` and round-off rising as `eps/h`. They meet near the cube root of machine epsilon times
 * the scale of the coordinate, which for radians is about 6e-6. A step of 1e-4 sits a little
 * above that, trading a negligible amount of the optimum for a wide margin against paths whose
 * length is not quite as smooth in `q` as this one is.
 */
export const DIFFERENCE_STEP = 1e-4;

/**
 * Moment arm by central difference, for solvers with no closed-form path derivative.
 *
 * `lengthAt` must return the solved path length with the coordinate displaced by the given
 * amount. It is the caller's job to make that a real re-solve: a wrapping path whose contact
 * points are held fixed while the coordinate moves will report the moment arm of a via-point
 * path that happens to pass through them.
 */
export function momentArmByDifference(
  lengthAt: (delta: number) => number,
  step = DIFFERENCE_STEP,
): number {
  return -(lengthAt(step) - lengthAt(-step)) / (2 * step);
}
