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

/**
 * `dL/dq` for one path about one revolute coordinate, from flat buffers and scalars.
 *
 * This is the one implementation of the derivative; the `Vec3` form below and the kernel's moment
 * module both come here. It takes the shape the kernel's channels already have -- `point` holds
 * xyz triples and `body` the body carrying each, and the path is the `count` points starting at
 * point `from` -- so the module can call it every tick without building anything. Nothing in it
 * allocates: no array literal to loop over the two ends of a segment, no closure, no object.
 *
 * Whether the coordinate carries a body is `carries[maskOffset + body] === 1`: one mask per
 * coordinate, laid end to end in one buffer, with `maskOffset` saying where this coordinate's
 * starts. A negative body -- a point fixed to nothing -- is carried by no coordinate. `axis` is
 * unit length in world coordinates, and `centre` is any world point on it.
 *
 * Each end of a segment contributes the velocity it would have under a unit rate of the
 * coordinate, `axis x (point - centre)`, projected on the segment's own direction; an end the
 * coordinate does not carry contributes nothing. A zero-length segment has no direction and is
 * skipped rather than producing a NaN, which a path with two coincident points would otherwise do.
 */
export function pathLengthDerivativeFlat(
  point: Float64Array,
  body: Int32Array,
  from: number,
  count: number,
  axisX: number,
  axisY: number,
  axisZ: number,
  centreX: number,
  centreY: number,
  centreZ: number,
  carries: Uint8Array,
  maskOffset: number,
): number {
  let derivative = 0;

  for (let i = 0; i + 1 < count; i++) {
    const a = 3 * (from + i);
    const b = a + 3;
    const ax = point[a] as number;
    const ay = point[a + 1] as number;
    const az = point[a + 2] as number;
    const bx = point[b] as number;
    const by = point[b + 1] as number;
    const bz = point[b + 2] as number;
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const segment = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (segment <= 0) continue;
    const ux = dx / segment;
    const uy = dy / segment;
    const uz = dz / segment;

    // The two ends written out rather than looped over, because a loop over `[0, 1]` builds that
    // array on every segment of every path of every tick.
    let rate = 0;
    const far = body[from + i + 1] as number;
    if (far >= 0 && carries[maskOffset + far] === 1) {
      const px = bx - centreX;
      const py = by - centreY;
      const pz = bz - centreZ;
      rate +=
        ux * (axisY * pz - axisZ * py) +
        uy * (axisZ * px - axisX * pz) +
        uz * (axisX * py - axisY * px);
    }
    const near = body[from + i] as number;
    if (near >= 0 && carries[maskOffset + near] === 1) {
      const px = ax - centreX;
      const py = ay - centreY;
      const pz = az - centreZ;
      rate -=
        ux * (axisY * pz - axisZ * py) +
        uy * (axisZ * px - axisX * pz) +
        uz * (axisX * py - axisY * px);
    }
    derivative += rate;
  }

  return derivative;
}

/**
 * `dL/dq` for one path about one revolute coordinate.
 *
 * `points` and `bodies` are the path's world points and their owning bodies, in path order, as
 * `ViaPointPathSolver.worldPoints` and `.bodiesOf` return them.
 *
 * A convenience over `pathLengthDerivativeFlat` for callers holding objects rather than channel
 * buffers -- tests, the validation harness. It packs its arguments into the flat form and asks
 * `movesWith` about each body on the path, so it allocates on every call; that is why the kernel module does
 * not use it, and why it is not a second implementation of anything.
 */
export function pathLengthDerivative(
  points: readonly Vec3[],
  bodies: readonly number[],
  coordinate: RevoluteCoordinate,
): number {
  const { axis, centre } = coordinate;
  const point = new Float64Array(3 * points.length);
  const body = new Int32Array(points.length);
  let highest = -1;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Vec3;
    point[3 * i] = p.x;
    point[3 * i + 1] = p.y;
    point[3 * i + 2] = p.z;
    const b = bodies[i] as number;
    body[i] = b;
    if (b > highest) highest = b;
  }
  const carries = new Uint8Array(highest + 1);
  for (const b of bodies) if (b >= 0) carries[b] = coordinate.movesWith(b) ? 1 : 0;

  return pathLengthDerivativeFlat(
    point,
    body,
    0,
    points.length,
    axis.x,
    axis.y,
    axis.z,
    centre.x,
    centre.y,
    centre.z,
    carries,
    0,
  );
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
