/**
 * `IMusclePathSolver` and the via-point solver -- tickets N1.1 and N1.2.
 *
 * ## Why path velocity is computed and not differenced
 *
 * The fiber model's force depends on how fast the path is changing length, and the obvious way to
 * get that is to subtract last tick's length from this one. The spec forbids it (section 5.3) for
 * two reasons that compound. A difference is a tick behind, so the force-velocity curve is always
 * answering the previous question; and differencing amplifies whatever noise is in the length,
 * which at 500 Hz is division of a small difference by a small step. Feeding that into a curve
 * whose slope near zero velocity is steep produces force noise that looks like physics.
 *
 * The analytic alternative is no harder. Every path point is fixed in a body's frame, so its world
 * velocity is the body's linear velocity plus the angular velocity crossed into the lever arm, and
 * the rate of change of a straight segment's length is the relative velocity of its endpoints
 * projected on its own direction:
 *
 *     dL/dt = sum over segments of  u_hat . (v_next - v_prev)
 *
 * Exact, one tick current, and no more expensive than the length itself.
 *
 * ## Structure of arrays, and no allocation in solve
 *
 * `compile` flattens every path into one contiguous point list with an offset table, so `solve`
 * walks two typed arrays and writes into caller-owned buffers. The kernel module contract forbids
 * allocation in `step`, and this solver is called from inside one.
 */

import type { PoseBuffer, VelocityBuffer } from '@bs-humany/compiler';
import type {
  MusclePath,
  PathCompileProblem,
  PathCompileReport,
  PathContactBuffer,
  PathPolylineBuffer,
  PathSolverCapabilities,
  PathTerminalBuffer,
  Vec3,
  WrapSurface,
} from './types.js';

export interface IMusclePathSolver {
  readonly id: string;
  readonly capabilities: PathSolverCapabilities;
  compile(paths: readonly MusclePath[], surfaces: readonly WrapSurface[]): PathCompileReport;
  /**
   * Writes path length and path velocity for every unit, and where each end pulls. No allocation.
   *
   * The muscle spec's sketch of this interface (section 5.1) names only length, velocity and
   * contacts. `outTerminals` is the fourth output, and it is here because section 8.2 needs it and
   * the module contract will not let the consumer go and get it: a module reads channels, never
   * another module, so everything force application needs has to leave the solver through an
   * output buffer and reach the channel. The solver already has these six numbers in hand while
   * it walks the path, so producing them costs nothing beyond the write.
   */
  solve(
    pose: PoseBuffer,
    velocity: VelocityBuffer,
    outLength: Float64Array,
    outVelocity: Float64Array,
    outContacts: PathContactBuffer,
    outTerminals: PathTerminalBuffer,
    /** Optional. Given one, the solver also writes where every path runs, point by point. */
    outPolyline?: PathPolylineBuffer,
  ): void;
}

/**
 * How a bone id becomes a body index and a body-local offset.
 *
 * The indirection is the point of base spec ADR-009. Muscle data names bones, the solver needs
 * bodies, and which bones are their own bodies changes with the fidelity profile -- so the mapping
 * belongs to the compiled articulation and not to the anatomy.
 */
export interface BoneResolver {
  /** Index into the pose and velocity buffers, or -1 when the bone is not in this articulation. */
  bodyOf(bone: string): number;
  /** The same point expressed in the owning body's frame, through the follower transform. */
  toBodyLocal(bone: string, point: Vec3): Vec3;
}

/**
 * The straight-path and via-point solver.
 *
 * Handles the paths that are a polyline through fixed bone-local points, which is most of a
 * published model and all of the elbow. Wrap elements compile to a reported problem rather than
 * to a silent approximation: a solver that quietly ignores a wrap surface produces a path that is
 * plausible, shorter than the truth, and wrong about the moment arm in exactly the region the
 * surface was placed to fix.
 */
export class ViaPointPathSolver implements IMusclePathSolver {
  readonly id = 'via-point';

  readonly capabilities: PathSolverCapabilities = {
    surfaceTypes: [],
    maxSurfacesPerPath: 0,
    finiteCylinders: false,
    requiresSiteBetweenWraps: false,
    // Straight segments between fixed points vary smoothly with the pose, so the moment arm does
    // too. Conditional via points (N1.3) will be the first thing that can make this false.
    continuousMomentArm: true,
  };

  /** `pathStart[i]` to `pathStart[i + 1]`: the points of path `i`. Length `paths + 1`. */
  private pathStart = new Int32Array(1);
  private pointBody = new Int32Array(0);
  /** `3 * points`, body-local metres. */
  private pointLocal = new Float64Array(0);
  /** Scratch for one path's worth of world points and velocities. Sized at compile time. */
  private world = new Float64Array(0);
  private worldVelocity = new Float64Array(0);
  private pathIds: string[] = [];

  constructor(private readonly resolver: BoneResolver) {}

  compile(paths: readonly MusclePath[], surfaces: readonly WrapSurface[]): PathCompileReport {
    const problems: PathCompileProblem[] = [];
    const bodies: number[] = [];
    const locals: number[] = [];
    const starts: number[] = [0];
    this.pathIds = [];

    const known = new Set(surfaces.map((s) => s.id));
    let longest = 0;

    for (const path of paths) {
      this.pathIds.push(path.id);
      const sites = [path.origin];
      for (const element of path.elements) {
        if (element.kind === 'viaPoint') {
          sites.push(element.site);
        } else if (element.kind === 'conditionalViaPoint') {
          problems.push({
            path: path.id,
            severity: 'warning',
            message:
              `conditional via point on '${element.coordinate}' is treated as unconditional by ` +
              'the via-point solver, which shifts the moment arm outside the range it was ' +
              'authored for. N1.3 adds the blended transition.',
          });
          sites.push(element.site);
        } else {
          problems.push({
            path: path.id,
            severity: 'error',
            message: known.has(element.surface)
              ? `wrap surface '${element.surface}' cannot be represented by the via-point ` +
                'solver. Use the geodesic solver for this path, or the length is wrong.'
              : `wrap element names surface '${element.surface}', which is not declared.`,
          });
        }
      }
      sites.push(path.insertion);

      for (const site of sites) {
        const body = this.resolver.bodyOf(site.bone);
        if (body < 0) {
          problems.push({
            path: path.id,
            severity: 'error',
            message:
              `attachment on bone '${site.bone}', which this articulation does not contain. ` +
              'A path pinned to a bone that is not there cannot be solved at all.',
          });
        }
        const local = this.resolver.toBodyLocal(site.bone, site.point);
        bodies.push(body);
        locals.push(local.x, local.y, local.z);
      }
      longest = Math.max(longest, sites.length);
      starts.push(bodies.length);
    }

    this.pathStart = Int32Array.from(starts);
    this.pointBody = Int32Array.from(bodies);
    this.pointLocal = Float64Array.from(locals);
    this.world = new Float64Array(3 * longest);
    this.worldVelocity = new Float64Array(3 * longest);

    return {
      pathCount: paths.length,
      pointCount: bodies.length,
      // Straight lines throughout, so a path needs exactly its attachment points.
      polylineCapacity: bodies.length,
      problems,
    };
  }

  solve(
    pose: PoseBuffer,
    velocity: VelocityBuffer,
    outLength: Float64Array,
    outVelocity: Float64Array,
    outContacts: PathContactBuffer,
    outTerminals: PathTerminalBuffer,
    outPolyline?: PathPolylineBuffer,
  ): void {
    // The via-point solver never wraps, so it reports no contacts -- but it must still say so,
    // rather than leaving whatever the previous solver wrote for section 8.2 to apply again.
    outContacts.count = 0;
    let written = 0;

    const count = this.pathStart.length - 1;
    for (let p = 0; p < count; p++) {
      const from = this.pathStart[p] as number;
      const to = this.pathStart[p + 1] as number;
      const n = to - from;

      for (let i = 0; i < n; i++) {
        const body = this.pointBody[from + i] as number;
        const lx = this.pointLocal[3 * (from + i)] as number;
        const ly = this.pointLocal[3 * (from + i) + 1] as number;
        const lz = this.pointLocal[3 * (from + i) + 2] as number;

        // Rotate the body-local offset into the world: r = q * l * q^-1, written out so that no
        // intermediate quaternion or vector is allocated.
        const qx = pose.orientation[4 * body] as number;
        const qy = pose.orientation[4 * body + 1] as number;
        const qz = pose.orientation[4 * body + 2] as number;
        const qw = pose.orientation[4 * body + 3] as number;
        const tx = 2 * (qy * lz - qz * ly);
        const ty = 2 * (qz * lx - qx * lz);
        const tz = 2 * (qx * ly - qy * lx);
        const rx = lx + qw * tx + (qy * tz - qz * ty);
        const ry = ly + qw * ty + (qz * tx - qx * tz);
        const rz = lz + qw * tz + (qx * ty - qy * tx);

        this.world[3 * i] = (pose.position[3 * body] as number) + rx;
        this.world[3 * i + 1] = (pose.position[3 * body + 1] as number) + ry;
        this.world[3 * i + 2] = (pose.position[3 * body + 2] as number) + rz;

        // v_point = v_body + omega x r. The lever arm is the rotated offset, not the local one.
        const wx = velocity.angular[3 * body] as number;
        const wy = velocity.angular[3 * body + 1] as number;
        const wz = velocity.angular[3 * body + 2] as number;
        this.worldVelocity[3 * i] = (velocity.linear[3 * body] as number) + (wy * rz - wz * ry);
        this.worldVelocity[3 * i + 1] =
          (velocity.linear[3 * body + 1] as number) + (wz * rx - wx * rz);
        this.worldVelocity[3 * i + 2] =
          (velocity.linear[3 * body + 2] as number) + (wx * ry - wy * rx);
      }

      let length = 0;
      let rate = 0;
      for (let i = 0; i + 1 < n; i++) {
        const dx = (this.world[3 * i + 3] as number) - (this.world[3 * i] as number);
        const dy = (this.world[3 * i + 4] as number) - (this.world[3 * i + 1] as number);
        const dz = (this.world[3 * i + 5] as number) - (this.world[3 * i + 2] as number);
        const segment = Math.sqrt(dx * dx + dy * dy + dz * dz);
        length += segment;
        // A zero-length segment has no direction, so it contributes no rate. Two coincident via
        // points are degenerate data rather than a reason to produce a NaN.
        if (segment <= 0) continue;
        const ux = dx / segment;
        const uy = dy / segment;
        const uz = dz / segment;
        rate +=
          ux * ((this.worldVelocity[3 * i + 3] as number) - (this.worldVelocity[3 * i] as number)) +
          uy *
            ((this.worldVelocity[3 * i + 4] as number) -
              (this.worldVelocity[3 * i + 1] as number)) +
          uz *
            ((this.worldVelocity[3 * i + 5] as number) - (this.worldVelocity[3 * i + 2] as number));
      }

      outLength[p] = length;
      outVelocity[p] = rate;

      // A straight-line path is its own polyline: the attachment points, in order.
      if (outPolyline !== undefined) {
        outPolyline.start[p] = written;
        outPolyline.count[p] = n;
        for (let i = 0; i < n && written < outPolyline.capacity; i++, written++) {
          outPolyline.point[3 * written] = this.world[3 * i] as number;
          outPolyline.point[3 * written + 1] = this.world[3 * i + 1] as number;
          outPolyline.point[3 * written + 2] = this.world[3 * i + 2] as number;
          outPolyline.body[written] = this.pointBody[from + i] as number;
        }
      }

      // Where the two ends are and which way they pull, for section 8.2. The origin pulls toward
      // the next point on the path and the insertion toward the previous one, which for a
      // straight unit is each toward the other.
      outTerminals.originBody[p] = this.pointBody[from] as number;
      outTerminals.insertionBody[p] = this.pointBody[to - 1] as number;
      const last = n - 1;
      for (let axis = 0; axis < 3; axis++) {
        outTerminals.originPoint[3 * p + axis] = this.world[axis] as number;
        outTerminals.insertionPoint[3 * p + axis] = this.world[3 * last + axis] as number;
      }
      writeUnit(outTerminals.originDirection, p, this.world, 0, Math.min(1, last));
      writeUnit(outTerminals.insertionDirection, p, this.world, last, Math.max(0, last - 1));
    }
  }

  /** Path ids in solve order, so a caller can map an index back to a muscle. */
  get order(): readonly string[] {
    return this.pathIds;
  }

  /**
   * World positions of one path's points, for the moment arm computation and for drawing.
   *
   * Allocates, and is therefore not for the tick loop -- `solve` writes the two numbers the fiber
   * model needs and nothing else.
   */
  worldPoints(index: number, pose: PoseBuffer): Vec3[] {
    const from = this.pathStart[index] as number;
    const to = this.pathStart[index + 1] as number;
    const points: Vec3[] = [];
    for (let i = from; i < to; i++) {
      const body = this.pointBody[i] as number;
      const l = {
        x: this.pointLocal[3 * i] as number,
        y: this.pointLocal[3 * i + 1] as number,
        z: this.pointLocal[3 * i + 2] as number,
      };
      const q = {
        x: pose.orientation[4 * body] as number,
        y: pose.orientation[4 * body + 1] as number,
        z: pose.orientation[4 * body + 2] as number,
        w: pose.orientation[4 * body + 3] as number,
      };
      const tx = 2 * (q.y * l.z - q.z * l.y);
      const ty = 2 * (q.z * l.x - q.x * l.z);
      const tz = 2 * (q.x * l.y - q.y * l.x);
      points.push({
        x: (pose.position[3 * body] as number) + l.x + q.w * tx + (q.y * tz - q.z * ty),
        y: (pose.position[3 * body + 1] as number) + l.y + q.w * ty + (q.z * tx - q.x * tz),
        z: (pose.position[3 * body + 2] as number) + l.z + q.w * tz + (q.x * ty - q.y * tx),
      });
    }
    return points;
  }

  /** Body index of each point of a path, in order. Needed to know what a joint moves. */
  bodiesOf(index: number): number[] {
    const from = this.pathStart[index] as number;
    const to = this.pathStart[index + 1] as number;
    return Array.from(this.pointBody.slice(from, to));
  }
}

/**
 * Writes the unit vector from point `from` toward point `toward` into slot `index`.
 *
 * A degenerate segment -- two coincident via points, or a one-point path that cannot happen but
 * would be a zero vector if it did -- writes zeros rather than NaNs. A zero direction applies no
 * force, which is the right answer for a segment with no direction; a NaN would reach the solver
 * and take the whole simulation with it.
 */
function writeUnit(
  out: Float64Array,
  index: number,
  points: Float64Array,
  from: number,
  toward: number,
): void {
  const dx = (points[3 * toward] as number) - (points[3 * from] as number);
  const dy = (points[3 * toward + 1] as number) - (points[3 * from + 1] as number);
  const dz = (points[3 * toward + 2] as number) - (points[3 * from + 2] as number);
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const scale = length > 0 ? 1 / length : 0;
  out[3 * index] = dx * scale;
  out[3 * index + 1] = dy * scale;
  out[3 * index + 2] = dz * scale;
}
