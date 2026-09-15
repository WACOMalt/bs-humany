/**
 * Single-surface geodesic wrapping -- ticket N1.4.
 *
 * A muscle does not run through bone. Where the straight line from one attachment to the next
 * would pass inside a surface, the real tendon lies against it: a straight run to a tangent point,
 * the shortest path across the surface, and a straight run off the far side. That shortest path
 * is a geodesic, and for the two shapes here it has a closed form, so this file is trigonometry
 * rather than iteration.
 *
 * ## Why sphere and cylinder, and not the ellipsoid the ticket also names
 *
 * A geodesic on a sphere is a great circle and on a cylinder a helix; both give exact tangent
 * points and an exact arc length in a few lines. An ellipsoid has no closed-form geodesic at all
 * -- it needs an iterative solve, and the natural home for that is the Natural Geodesic Variations
 * machinery of N1.5, which already parameterises a geodesic by its start point, start direction
 * and length and solves numerically. Building a second, worse iterative solver here to be thrown
 * away there would be waste.
 *
 * It also has no consumer. MuJoCo's tendon wrapping supports spheres and cylinders and nothing
 * else, so the reference arm model's wrap geometry is entirely spheres and cylinders -- the geoms
 * with "ellipsoid" in their names carry no type attribute, which makes them MuJoCo's default,
 * a sphere. Recorded as OQ-016.
 *
 * ## The envelope property, which everything downstream leans on
 *
 * The tangent points are where they are because the path length is *stationary* with respect to
 * sliding them along the surface. That is what makes a geodesic a geodesic, and it has a
 * consequence worth stating once here rather than rediscovering later: the rate of change of a
 * wrapped path's length depends only on how its two free endpoints move relative to the surface,
 * never on how the tangent points slide. So path velocity through a wrap is no harder than path
 * velocity through a straight segment, as long as the endpoint velocities are taken in the
 * surface's own frame.
 *
 * ## No allocation
 *
 * Every function writes into a caller-owned result. These run inside `solve`, which runs inside a
 * kernel `step`, where allocation is forbidden.
 */

/** Why a wrap did or did not happen. */
export type WrapStatus =
  /** The straight line misses the surface. Use it as it is. */
  | 'clear'
  /** The path wraps; the result carries the tangent points and the arc. */
  | 'wrapped'
  /** An endpoint is inside the surface. The geometry has no answer; the caller must report it. */
  | 'inside'
  /** The wrap would leave the ends of a finite cylinder, so the surface does not constrain it. */
  | 'offEnd';

export interface WrapResult {
  status: WrapStatus;
  /** Total length from the first point to the second, following the surface. */
  length: number;
  /** Arc length on the surface alone. Zero when clear. */
  arcLength: number;
  /** First tangent point, in the surface's frame. */
  ax: number;
  ay: number;
  az: number;
  /** Second tangent point, in the surface's frame. */
  bx: number;
  by: number;
  bz: number;
  /**
   * Where the resultant of the surface's reaction acts, in the surface's frame.
   *
   * For a sphere this is exact: every normal along the arc points at the centre, so the resultant
   * passes through it. For a cylinder the normals are radial and pass through the axis, so the
   * resultant's line of action meets the axis -- at the centre of pressure, which this
   * approximates by the midpoint of the two tangent points' heights. The error is a torque about
   * the axis-perpendicular directions and it vanishes as the helix's pitch does.
   */
  px: number;
  py: number;
  pz: number;
}

export function createWrapResult(): WrapResult {
  return {
    status: 'clear',
    length: 0,
    arcLength: 0,
    ax: 0,
    ay: 0,
    az: 0,
    bx: 0,
    by: 0,
    bz: 0,
    px: 0,
    py: 0,
    pz: 0,
  };
}

/** Below this the two points are treated as coincident and no wrap is attempted. */
const EPSILON = 1e-12;

function clearResult(out: WrapResult, length: number): void {
  out.status = 'clear';
  out.length = length;
  out.arcLength = 0;
}

/**
 * Shortest path from one point to another around a sphere centred at the origin.
 *
 * Both points are in the sphere's frame. The geodesic lies in the plane through the two points
 * and the centre, because a great circle is the shortest path on a sphere and the tangent
 * segments lie in that same plane, so the whole problem is two dimensional once the plane is
 * found.
 *
 * `side` decides which way round, and it decides every time rather than only in the degenerate
 * case. Taking the shorter arc instead looks obviously right and is wrong: as the straight line
 * sweeps across the centre the shorter side changes hands, so the path jumps to the other side of
 * the bone and the moment arm reverses sign for a tick. Anatomy does not offer the tendon that
 * choice, and neither does this (muscle spec 4.3). The side also settles the one case where the
 * plane itself is undetermined -- three collinear points, where the path could fall anywhere
 * around the sphere.
 */
export function wrapSphere(
  px: number,
  py: number,
  pz: number,
  qx: number,
  qy: number,
  qz: number,
  radius: number,
  sideX: number,
  sideY: number,
  sideZ: number,
  out: WrapResult,
): void {
  const dx = qx - px;
  const dy = qy - py;
  const dz = qz - pz;
  const straight = Math.sqrt(dx * dx + dy * dy + dz * dz);

  const dP = Math.sqrt(px * px + py * py + pz * pz);
  const dQ = Math.sqrt(qx * qx + qy * qy + qz * qz);
  if (dP <= radius || dQ <= radius) {
    out.status = 'inside';
    out.length = straight;
    out.arcLength = 0;
    return;
  }
  if (straight <= EPSILON) {
    clearResult(out, straight);
    return;
  }

  // Does the straight segment come within the radius? Only the closest approach *between* the
  // endpoints counts: a segment that passes near the sphere's far side does not touch it.
  const t = -(px * dx + py * dy + pz * dz) / (straight * straight);
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = px + dx * clamped;
  const cy = py + dy * clamped;
  const cz = pz + dz * clamped;
  if (cx * cx + cy * cy + cz * cz >= radius * radius) {
    clearResult(out, straight);
    return;
  }

  // The plane through P, Q and the centre. Collinear points leave it undetermined, and the
  // declared side settles it.
  let nx = py * qz - pz * qy;
  let ny = pz * qx - px * qz;
  let nz = px * qy - py * qx;
  let n = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (n <= EPSILON * dP * dQ) {
    nx = py * sideZ - pz * sideY;
    ny = pz * sideX - px * sideZ;
    nz = px * sideY - py * sideX;
    n = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (n <= EPSILON) {
      // The declared side is parallel to the line as well. There is no principled answer left,
      // and guessing one would be the silent side-flip this parameter exists to prevent.
      out.status = 'inside';
      out.length = straight;
      out.arcLength = 0;
      return;
    }
  }
  nx /= n;
  ny /= n;
  nz /= n;

  const tangentP = Math.sqrt(dP * dP - radius * radius);
  const tangentQ = Math.sqrt(dQ * dQ - radius * radius);
  const alphaP = Math.acos(radius / dP);
  const alphaQ = Math.acos(radius / dQ);

  let cosine = (px * qx + py * qy + pz * qz) / (dP * dQ);
  cosine = cosine < -1 ? -1 : cosine > 1 ? 1 : cosine;
  const between = Math.acos(cosine);
  const arc = between - alphaP - alphaQ;
  if (arc <= 0) {
    // The tangents already reach past each other: the surface is not in the way after all.
    clearResult(out, straight);
    return;
  }

  // An orthonormal frame in that plane, with the first axis along P, so that P sits at angle
  // zero and Q at angle `between`.
  const e1x = px / dP;
  const e1y = py / dP;
  const e1z = pz / dP;
  const e2x = ny * e1z - nz * e1y;
  const e2y = nz * e1x - nx * e1z;
  const e2z = nx * e1y - ny * e1x;

  // Two ways round, exactly as on a cylinder. The shorter one is the geodesic, but which one is
  // shorter changes hands as the straight line sweeps across the centre -- and at that moment the
  // path would jump to the other side of the bone, reversing the moment arm's sign for a tick.
  // A tendon does not do that: anatomy holds it on one side. So the declared side decides, and
  // the long way round is taken when that is the side the tendon is on.
  const sweepForward = positiveAngle(between - alphaQ - alphaP);
  const sweepBack = positiveAngle(-alphaP - (between + alphaQ));
  const midForward = alphaP + sweepForward / 2;
  const midBack = -alphaP - sweepBack / 2;
  const onSide = (angle: number) =>
    (Math.cos(angle) * e1x + Math.sin(angle) * e2x) * sideX +
    (Math.cos(angle) * e1y + Math.sin(angle) * e2y) * sideY +
    (Math.cos(angle) * e1z + Math.sin(angle) * e2z) * sideZ;
  const forward = onSide(midForward) >= onSide(midBack);

  const sweep = forward ? sweepForward : sweepBack;
  const angleA = forward ? alphaP : -alphaP;
  const angleB = forward ? between - alphaQ : between + alphaQ;
  const ca = Math.cos(angleA);
  const sa = Math.sin(angleA);
  const cb = Math.cos(angleB);
  const sb = Math.sin(angleB);

  out.status = 'wrapped';
  out.arcLength = radius * sweep;
  out.length = tangentP + out.arcLength + tangentQ;
  out.ax = radius * (ca * e1x + sa * e2x);
  out.ay = radius * (ca * e1y + sa * e2y);
  out.az = radius * (ca * e1z + sa * e2z);
  out.bx = radius * (cb * e1x + sb * e2x);
  out.by = radius * (cb * e1y + sb * e2y);
  out.bz = radius * (cb * e1z + sb * e2z);
  // Every normal along a sphere's arc points at the centre, so the resultant does too.
  out.px = 0;
  out.py = 0;
  out.pz = 0;
}

/** Wraps an angle into [0, 2 pi). */
function positiveAngle(angle: number): number {
  const twoPi = 2 * Math.PI;
  const wrapped = angle % twoPi;
  return wrapped < 0 ? wrapped + twoPi : wrapped;
}

/**
 * Shortest path around a cylinder whose axis is the surface frame's Z, centred at the origin.
 *
 * Seen down the axis the problem is the two-dimensional one of a line round a circle, and the
 * geodesic is the helix that unrolls to a straight line: so the height is shared out along the
 * path in proportion to the distance covered in that two-dimensional view, and the whole path's
 * length is the hypotenuse of the flattened length and the rise.
 *
 * `halfLength` is respected, which the native MuJoCo solver cannot do. A tangent point past the
 * end of the cylinder means the tendon would have slipped off it, and a surface the tendon has
 * slipped off does not constrain the path -- so the answer is the straight line, reported as
 * `offEnd` so the caller knows the declared surface did nothing.
 */
export function wrapCylinder(
  px: number,
  py: number,
  pz: number,
  qx: number,
  qy: number,
  qz: number,
  radius: number,
  halfLength: number,
  sideX: number,
  sideY: number,
  out: WrapResult,
): void {
  const straight = Math.sqrt((qx - px) * (qx - px) + (qy - py) * (qy - py) + (qz - pz) * (qz - pz));

  const rP = Math.sqrt(px * px + py * py);
  const rQ = Math.sqrt(qx * qx + qy * qy);
  if (rP <= radius || rQ <= radius) {
    out.status = 'inside';
    out.length = straight;
    out.arcLength = 0;
    return;
  }

  // Closest approach of the flattened segment to the axis.
  const fx = qx - px;
  const fy = qy - py;
  const flat = Math.sqrt(fx * fx + fy * fy);
  if (flat <= EPSILON) {
    clearResult(out, straight);
    return;
  }
  const t = -(px * fx + py * fy) / (flat * flat);
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const nx = px + fx * clamped;
  const ny = py + fy * clamped;
  if (nx * nx + ny * ny >= radius * radius) {
    clearResult(out, straight);
    return;
  }

  const tangentP = Math.sqrt(rP * rP - radius * radius);
  const tangentQ = Math.sqrt(rQ * rQ - radius * radius);
  const alphaP = Math.acos(radius / rP);
  const alphaQ = Math.acos(radius / rQ);
  const thetaP = Math.atan2(py, px);
  const thetaQ = Math.atan2(qy, qx);

  // Two ways round. The declared side decides, rather than the shorter arc, because "shorter"
  // changes hands as the bones move and the path would swap sides mid-motion.
  const sweepCcw = positiveAngle(thetaQ - alphaQ - (thetaP + alphaP));
  const sweepCw = positiveAngle(thetaP - alphaP - (thetaQ + alphaQ));

  const midCcw = thetaP + alphaP + sweepCcw / 2;
  const midCw = thetaP - alphaP - sweepCw / 2;
  const preferCcw =
    Math.cos(midCcw) * sideX + Math.sin(midCcw) * sideY >=
    Math.cos(midCw) * sideX + Math.sin(midCw) * sideY;

  const sweep = preferCcw ? sweepCcw : sweepCw;
  const angleA = preferCcw ? thetaP + alphaP : thetaP - alphaP;
  const angleB = preferCcw ? thetaQ - alphaQ : thetaQ + alphaQ;

  const arcFlat = radius * sweep;
  const totalFlat = tangentP + arcFlat + tangentQ;
  if (totalFlat <= EPSILON) {
    clearResult(out, straight);
    return;
  }

  // Unrolled, the whole path is one straight line, so the rise is shared out in proportion to the
  // distance covered flat. That is what makes the arc a geodesic and not merely a circle.
  const rise = qz - pz;
  const az = pz + (rise * tangentP) / totalFlat;
  const bz = pz + (rise * (tangentP + arcFlat)) / totalFlat;

  if (Math.abs(az) > halfLength || Math.abs(bz) > halfLength) {
    out.status = 'offEnd';
    out.length = straight;
    out.arcLength = 0;
    return;
  }

  out.status = 'wrapped';
  out.length = Math.sqrt(totalFlat * totalFlat + rise * rise);
  // The arc's own share of that hypotenuse.
  out.arcLength = (out.length * arcFlat) / totalFlat;
  out.ax = radius * Math.cos(angleA);
  out.ay = radius * Math.sin(angleA);
  out.az = az;
  out.bx = radius * Math.cos(angleB);
  out.by = radius * Math.sin(angleB);
  out.bz = bz;
  // Radial normals meet the axis; the height is the centre of pressure, approximated by the
  // midpoint of the two tangent heights.
  out.px = 0;
  out.py = 0;
  out.pz = (az + bz) / 2;
}
