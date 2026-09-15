/**
 * `GeodesicPathSolver` -- ticket N1.4, the single-surface half of muscle spec section 5.2.
 *
 * The via-point solver runs a muscle in straight lines between fixed points and reports any wrap
 * surface it meets as something it cannot represent. This one honours them: between each pair of
 * consecutive attachment points it may route the path around one sphere or one cylinder, using
 * the closed-form geodesics in `wrap.ts`.
 *
 * ## One surface per span, and why that is a real limit rather than a simplification
 *
 * Two surfaces sharing a span interact: the tangent point on each depends on where the path
 * leaves the other, so they have to be solved together. That is the Natural Geodesic Variations
 * problem of N1.5, with a global error function and a banded Jacobian. Pretending to handle it
 * here by wrapping each surface in turn would give a path that is not the shortest one and is not
 * even continuous as the surfaces move past each other. So a span with two wraps is refused at
 * compile time, with `requiresSiteBetweenWraps` saying so in the capabilities.
 *
 * ## Path velocity through a wrap
 *
 * Still analytic, still not differenced. The trick is the envelope property: a geodesic's length
 * is stationary with respect to sliding its tangent points along the surface, so those points
 * contribute nothing to the rate of change. What is left depends only on how the two free ends
 * move *relative to the surface*. Work in the surface's own frame, where it is not moving at all,
 * and the wrapped span's derivative has exactly the form the straight one does:
 *
 *     dL/dt = -u_A . v_A - u_B . v_B
 *
 * with each `u` the unit vector from that end toward its own tangent point and each `v` that
 * end's velocity relative to the surface, both in the surface's frame.
 *
 * ## Contacts
 *
 * Section 8.2 step 4 needs the reaction a wrapped tendon puts on the bone it lies against. For a
 * massless string under tension `F`, equilibrium of the arc gives the reaction directly: the
 * surface pushes the string with `-F (u_A + u_B)`, so the string pushes the bone with
 * `F (u_A + u_B)` where each `u` points from a tangent point toward its free end. That resultant
 * is reported as the contact direction -- deliberately not normalised, because its magnitude
 * carries the geometry of how sharply the tendon turns. A tendon that barely grazes a bone
 * presses on it barely.
 */

import type { PoseBuffer, VelocityBuffer } from '@bs-humany/compiler';
import type { BoneResolver, IMusclePathSolver } from './solver.js';
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
import { ARC_SAMPLES } from './types.js';
import {
  type WrapResult,
  createWrapResult,
  sampleWrapArc,
  wrapCylinder,
  wrapSphere,
} from './wrap.js';

/** No surface on this span. */
const NO_SURFACE = -1;

const SPHERE = 0;
const CYLINDER = 1;

export class GeodesicPathSolver implements IMusclePathSolver {
  readonly id = 'geodesic';

  readonly capabilities: PathSolverCapabilities = {
    surfaceTypes: ['sphere', 'cylinder'],
    maxSurfacesPerPath: Number.POSITIVE_INFINITY,
    // The cylinder's half-length is respected, which is the thing the native solver cannot do.
    finiteCylinders: true,
    // One surface per span: see the header.
    requiresSiteBetweenWraps: true,
    continuousMomentArm: true,
  };

  /** Points, flattened across all paths. */
  private pathStart = new Int32Array(1);
  private pointBody = new Int32Array(0);
  private pointLocal = new Float64Array(0);
  /** One entry per span: an index into the surface tables, or `NO_SURFACE`. */
  private spanStart = new Int32Array(1);
  private spanSurface = new Int32Array(0);

  /** Surfaces, flattened. Positions and orientations are in their owning body's frame. */
  private surfaceBody = new Int32Array(0);
  private surfaceKind = new Int32Array(0);
  private surfaceOffset = new Float64Array(0);
  private surfaceQuat = new Float64Array(0);
  private surfaceRadius = new Float64Array(0);
  private surfaceHalfLength = new Float64Array(0);
  /** The declared side, already rotated into the surface's own frame. */
  private surfaceSide = new Float64Array(0);

  private world = new Float64Array(0);
  private worldVelocity = new Float64Array(0);
  private readonly wrap: WrapResult = createWrapResult();
  private pathIds: string[] = [];

  constructor(private readonly resolver: BoneResolver) {}

  compile(paths: readonly MusclePath[], surfaces: readonly WrapSurface[]): PathCompileReport {
    const problems: PathCompileProblem[] = [];
    const bodies: number[] = [];
    const locals: number[] = [];
    const starts: number[] = [0];
    const spans: number[] = [];
    const spanStarts: number[] = [0];
    let wrappable = 0;
    this.pathIds = [];

    const index = new Map(surfaces.map((s, i) => [s.id, i]));
    this.packSurfaces(surfaces, problems);

    let longest = 0;
    for (const path of paths) {
      this.pathIds.push(path.id);
      // Walk the elements accumulating sites, and attach each wrap to the span it opens.
      const sites = [path.origin];
      const perSpan: number[] = [];
      let pending = NO_SURFACE;

      const closeSpan = () => {
        perSpan.push(pending);
        pending = NO_SURFACE;
      };

      for (const element of path.elements) {
        if (element.kind === 'wrap') {
          const found = index.get(element.surface);
          if (found === undefined) {
            problems.push({
              path: path.id,
              severity: 'error',
              message: `wrap element names surface '${element.surface}', which is not declared.`,
            });
            continue;
          }
          if (pending !== NO_SURFACE) {
            problems.push({
              path: path.id,
              severity: 'error',
              message:
                'two wrap surfaces in a row, with no attachment point between them. Solving ' +
                'them together is the multi-surface problem of N1.5; this solver takes one ' +
                'surface per span, and reports it rather than routing round each in turn, ' +
                'which would not give the shortest path.',
            });
            continue;
          }
          pending = found;
          continue;
        }
        if (element.kind === 'conditionalViaPoint') {
          problems.push({
            path: path.id,
            severity: 'warning',
            message:
              `conditional via point on '${element.coordinate}' is treated as unconditional. ` +
              'N1.3 adds the blended transition.',
          });
        }
        sites.push(element.site);
        closeSpan();
      }
      sites.push(path.insertion);
      closeSpan();

      for (const site of sites) {
        const body = this.resolver.bodyOf(site.bone);
        if (body < 0) {
          problems.push({
            path: path.id,
            severity: 'error',
            message: `attachment on bone '${site.bone}', which this articulation does not contain.`,
          });
        }
        const local = this.resolver.toBodyLocal(site.bone, site.point);
        bodies.push(body);
        locals.push(local.x, local.y, local.z);
      }
      for (const surface of perSpan) {
        spans.push(surface);
        if (surface !== NO_SURFACE) wrappable++;
      }
      longest = Math.max(longest, sites.length);
      starts.push(bodies.length);
      spanStarts.push(spans.length);
    }

    this.pathStart = Int32Array.from(starts);
    this.pointBody = Int32Array.from(bodies);
    this.pointLocal = Float64Array.from(locals);
    this.spanStart = Int32Array.from(spanStarts);
    this.spanSurface = Int32Array.from(spans);
    this.world = new Float64Array(3 * longest);
    this.worldVelocity = new Float64Array(3 * longest);

    return {
      pathCount: paths.length,
      pointCount: bodies.length,
      // Every attachment point, plus what a wrap adds where one is declared: two tangent points
      // and the samples between them. Counting the spans that *could* wrap rather than those that
      // do means the buffer is right whatever the pose.
      polylineCapacity: bodies.length + wrappable * (ARC_SAMPLES + 1),
      problems,
    };
  }

  /** Flatten the surfaces, rotating each declared side into its own surface's frame. */
  private packSurfaces(surfaces: readonly WrapSurface[], problems: PathCompileProblem[]): void {
    const n = surfaces.length;
    this.surfaceBody = new Int32Array(n);
    this.surfaceKind = new Int32Array(n);
    this.surfaceOffset = new Float64Array(3 * n);
    this.surfaceQuat = new Float64Array(4 * n);
    this.surfaceRadius = new Float64Array(n);
    this.surfaceHalfLength = new Float64Array(n);
    this.surfaceSide = new Float64Array(3 * n);

    for (let i = 0; i < n; i++) {
      const surface = surfaces[i] as WrapSurface;
      const body = this.resolver.bodyOf(surface.bone);
      if (body < 0) {
        problems.push({
          path: surface.id,
          severity: 'error',
          message: `wrap surface is attached to bone '${surface.bone}', which is not present.`,
        });
      }
      if (surface.type !== 'sphere' && surface.type !== 'cylinder') {
        problems.push({
          path: surface.id,
          severity: 'error',
          message:
            `wrap surface is a '${surface.type}', which this solver cannot represent. An ` +
            'ellipsoid has no closed-form geodesic; see OQ-016 and ticket N1.5.',
        });
      }
      const radius = surface.radius ?? 0;
      if (!(radius > 0)) {
        problems.push({
          path: surface.id,
          severity: 'error',
          message: 'wrap surface has no positive radius, so there is nothing to wrap around.',
        });
      }

      this.surfaceBody[i] = body;
      this.surfaceKind[i] = surface.type === 'cylinder' ? CYLINDER : SPHERE;
      this.surfaceRadius[i] = radius;
      this.surfaceHalfLength[i] = surface.halfLength ?? Number.POSITIVE_INFINITY;

      const local = this.resolver.toBodyLocal(surface.bone, surface.position);
      this.surfaceOffset[3 * i] = local.x;
      this.surfaceOffset[3 * i + 1] = local.y;
      this.surfaceOffset[3 * i + 2] = local.z;

      const q = surface.orientation ?? [0, 0, 0, 1];
      for (let k = 0; k < 4; k++) this.surfaceQuat[4 * i + k] = q[k] as number;

      // The declared side arrives in bone coordinates; the wrap maths wants it in the surface's.
      const side = surface.preferredSide;
      const sx = q[0] as number;
      const sy = q[1] as number;
      const sz = q[2] as number;
      const sw = q[3] as number;
      const tx = 2 * (sy * side.z - sz * side.y);
      const ty = 2 * (sz * side.x - sx * side.z);
      const tz = 2 * (sx * side.y - sy * side.x);
      // Inverse rotation: conjugate the quaternion, which flips the sign of the vector part.
      this.surfaceSide[3 * i] = side.x - sw * tx + (sy * tz - sz * ty);
      this.surfaceSide[3 * i + 1] = side.y - sw * ty + (sz * tx - sx * tz);
      this.surfaceSide[3 * i + 2] = side.z - sw * tz + (sx * ty - sy * tx);
    }
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
    outContacts.count = 0;
    this.polyline = outPolyline;
    this.written = 0;
    const count = this.pathStart.length - 1;

    for (let p = 0; p < count; p++) {
      const from = this.pathStart[p] as number;
      const to = this.pathStart[p + 1] as number;
      const n = to - from;
      this.resolvePoints(pose, velocity, from, n);

      let length = 0;
      let rate = 0;
      const spanBase = this.spanStart[p] as number;
      if (outPolyline !== undefined) {
        outPolyline.start[p] = this.written;
        outPolyline.count[p] = 0;
        // Every span writes the point it starts from, so the last point of the path is added once
        // at the end rather than twice at the seam between spans.
        this.emit(p, 3 * 0, this.pointBody[from] as number);
      }

      for (let i = 0; i + 1 < n; i++) {
        const surface = this.spanSurface[spanBase + i] as number;
        const wrapped =
          surface === NO_SURFACE
            ? false
            : this.solveWrappedSpan(p, i, surface, pose, velocity, outContacts);
        if (wrapped) {
          length += this.wrap.length;
          rate += this.spanRate;
          // The arc, then the point the span ends at: the straight run off the surface to the
          // next attachment. Without it the drawing stops on the bone.
          this.emitArc(p, this.surfaceBody[surface] as number);
          this.emit(p, 3 * (i + 1), this.pointBody[from + i + 1] as number);
          if (i === 0) this.copyDirection(outTerminals.originDirection, p, this.spanFirstDirection);
          if (i + 2 === n) {
            this.copyDirection(outTerminals.insertionDirection, p, this.spanLastDirection);
          }
          continue;
        }

        // Straight, either because no surface was declared or because the surface is not in the
        // way. Both are ordinary answers, and the second is most of the range of most muscles.
        const ax = this.world[3 * i] as number;
        const ay = this.world[3 * i + 1] as number;
        const az = this.world[3 * i + 2] as number;
        const bx = this.world[3 * i + 3] as number;
        const by = this.world[3 * i + 4] as number;
        const bz = this.world[3 * i + 5] as number;
        const dx = bx - ax;
        const dy = by - ay;
        const dz = bz - az;
        const segment = Math.sqrt(dx * dx + dy * dy + dz * dz);
        length += segment;
        if (segment > 0) {
          const ux = dx / segment;
          const uy = dy / segment;
          const uz = dz / segment;
          rate +=
            ux *
              ((this.worldVelocity[3 * i + 3] as number) - (this.worldVelocity[3 * i] as number)) +
            uy *
              ((this.worldVelocity[3 * i + 4] as number) -
                (this.worldVelocity[3 * i + 1] as number)) +
            uz *
              ((this.worldVelocity[3 * i + 5] as number) -
                (this.worldVelocity[3 * i + 2] as number));
          if (i === 0) {
            outTerminals.originDirection[3 * p] = ux;
            outTerminals.originDirection[3 * p + 1] = uy;
            outTerminals.originDirection[3 * p + 2] = uz;
          }
          this.emit(p, 3 * (i + 1), this.pointBody[from + i + 1] as number);
          if (i + 2 === n) {
            outTerminals.insertionDirection[3 * p] = -ux;
            outTerminals.insertionDirection[3 * p + 1] = -uy;
            outTerminals.insertionDirection[3 * p + 2] = -uz;
          }
          // A zero-length segment still has an endpoint, and a polyline that skipped it would be
          // a point short of the attachments it is supposed to join.
        } else {
          this.emit(p, 3 * (i + 1), this.pointBody[from + i + 1] as number);
          if (i === 0) {
            this.zeroDirection(outTerminals.originDirection, p);
            this.zeroDirection(outTerminals.insertionDirection, p);
          }
        }
      }

      outLength[p] = length;
      outVelocity[p] = rate;
      outTerminals.originBody[p] = this.pointBody[from] as number;
      outTerminals.insertionBody[p] = this.pointBody[to - 1] as number;
      const last = n - 1;
      for (let axis = 0; axis < 3; axis++) {
        outTerminals.originPoint[3 * p + axis] = this.world[axis] as number;
        outTerminals.insertionPoint[3 * p + axis] = this.world[3 * last + axis] as number;
      }
    }
  }

  /** Where the polyline is going this solve, and how far into it we are. */
  private polyline: PathPolylineBuffer | undefined;
  private written = 0;
  /** The surface frame of the span being wrapped, for turning arc samples back into the world. */
  private readonly spanFrame = new Float64Array(7);

  /** Copy one already-resolved world point into the polyline, with the body that carries it. */
  private emit(path: number, at: number, body: number): void {
    const out = this.polyline;
    if (out === undefined || this.written >= out.capacity) return;
    out.point[3 * this.written] = this.world[at] as number;
    out.point[3 * this.written + 1] = this.world[at + 1] as number;
    out.point[3 * this.written + 2] = this.world[at + 2] as number;
    out.body[this.written] = body;
    this.written++;
    out.count[path] = (out.count[path] as number) + 1;
  }

  /**
   * Walk the arc of the span just solved into the polyline, in world coordinates.
   *
   * The first tangent point is written, then the samples, then the second -- the two straight runs
   * either side are the segments the caller writes, so the whole path joins up. Sampling is the
   * only thing in `solve` that exists purely for a reader: the fiber model never sees these
   * points, and a caller that passes no buffer never computes them.
   */
  private emitArc(path: number, body: number): void {
    const out = this.polyline;
    if (out === undefined) return;
    for (let i = 0; i <= ARC_SAMPLES; i++) {
      if (this.written >= out.capacity) return;
      sampleWrapArc(this.wrap, i / ARC_SAMPLES, this.arcScratch, 0);
      this.rotateInto(
        this.spanFrame[0] as number,
        this.spanFrame[1] as number,
        this.spanFrame[2] as number,
        this.spanFrame[3] as number,
        this.arcScratch[0] as number,
        this.arcScratch[1] as number,
        this.arcScratch[2] as number,
        this.spanFirstScratch,
      );
      out.point[3 * this.written] =
        (this.spanFrame[4] as number) + (this.spanFirstScratch[0] as number);
      out.point[3 * this.written + 1] =
        (this.spanFrame[5] as number) + (this.spanFirstScratch[1] as number);
      out.point[3 * this.written + 2] =
        (this.spanFrame[6] as number) + (this.spanFirstScratch[2] as number);
      // An arc point is carried by the bone whose surface it lies on, not by either attachment.
      out.body[this.written] = body;
      this.written++;
      out.count[path] = (out.count[path] as number) + 1;
    }
  }

  private readonly arcScratch = new Float64Array(3);

  /** Scratch carried between `solveWrappedSpan` and its caller, to avoid returning an object. */
  private spanRate = 0;
  private readonly spanFirstDirection = new Float64Array(3);
  private readonly spanLastDirection = new Float64Array(3);
  private readonly local = new Float64Array(12);

  /**
   * Route one span around one surface, if the surface is in the way.
   *
   * Returns false when it is not, which leaves the caller to treat the span as straight -- the
   * common case for most muscles over most of their range.
   */
  private solveWrappedSpan(
    path: number,
    i: number,
    surface: number,
    pose: PoseBuffer,
    velocity: VelocityBuffer,
    outContacts: PathContactBuffer,
  ): boolean {
    const body = this.surfaceBody[surface] as number;
    if (body < 0) return false;

    // World pose of the surface frame: the body's pose composed with the surface's offset.
    const bqx = pose.orientation[4 * body] as number;
    const bqy = pose.orientation[4 * body + 1] as number;
    const bqz = pose.orientation[4 * body + 2] as number;
    const bqw = pose.orientation[4 * body + 3] as number;
    const ox = this.surfaceOffset[3 * surface] as number;
    const oy = this.surfaceOffset[3 * surface + 1] as number;
    const oz = this.surfaceOffset[3 * surface + 2] as number;
    const tx = 2 * (bqy * oz - bqz * oy);
    const ty = 2 * (bqz * ox - bqx * oz);
    const tz = 2 * (bqx * oy - bqy * ox);
    const originX = (pose.position[3 * body] as number) + ox + bqw * tx + (bqy * tz - bqz * ty);
    const originY = (pose.position[3 * body + 1] as number) + oy + bqw * ty + (bqz * tx - bqx * tz);
    const originZ = (pose.position[3 * body + 2] as number) + oz + bqw * tz + (bqx * ty - bqy * tx);

    // Surface orientation in the world: body quaternion times the surface's local one.
    const sqx = this.surfaceQuat[4 * surface] as number;
    const sqy = this.surfaceQuat[4 * surface + 1] as number;
    const sqz = this.surfaceQuat[4 * surface + 2] as number;
    const sqw = this.surfaceQuat[4 * surface + 3] as number;
    const qx = bqw * sqx + bqx * sqw + bqy * sqz - bqz * sqy;
    const qy = bqw * sqy - bqx * sqz + bqy * sqw + bqz * sqx;
    const qz = bqw * sqz + bqx * sqy - bqy * sqx + bqz * sqw;
    const qw = bqw * sqw - bqx * sqx - bqy * sqy - bqz * sqz;

    // Both ends, and both ends' velocities relative to the surface's body, in the surface frame.
    const wx = velocity.angular[3 * body] as number;
    const wy = velocity.angular[3 * body + 1] as number;
    const wz = velocity.angular[3 * body + 2] as number;
    for (let end = 0; end < 2; end++) {
      const at = 3 * (i + end);
      const px = (this.world[at] as number) - originX;
      const py = (this.world[at + 1] as number) - originY;
      const pz = (this.world[at + 2] as number) - originZ;
      this.rotateInverse(qx, qy, qz, qw, px, py, pz, 6 * end);

      // Velocity relative to the surface's body, at this point.
      const rx = (this.world[at] as number) - (pose.position[3 * body] as number);
      const ry = (this.world[at + 1] as number) - (pose.position[3 * body + 1] as number);
      const rz = (this.world[at + 2] as number) - (pose.position[3 * body + 2] as number);
      const vx =
        (this.worldVelocity[at] as number) -
        ((velocity.linear[3 * body] as number) + (wy * rz - wz * ry));
      const vy =
        (this.worldVelocity[at + 1] as number) -
        ((velocity.linear[3 * body + 1] as number) + (wz * rx - wx * rz));
      const vz =
        (this.worldVelocity[at + 2] as number) -
        ((velocity.linear[3 * body + 2] as number) + (wx * ry - wy * rx));
      this.rotateInverse(qx, qy, qz, qw, vx, vy, vz, 6 * end + 3);
    }

    const radius = this.surfaceRadius[surface] as number;
    const ax = this.local[0] as number;
    const ay = this.local[1] as number;
    const az = this.local[2] as number;
    const bx = this.local[6] as number;
    const by = this.local[7] as number;
    const bz = this.local[8] as number;

    if (this.surfaceKind[surface] === CYLINDER) {
      wrapCylinder(
        ax,
        ay,
        az,
        bx,
        by,
        bz,
        radius,
        this.surfaceHalfLength[surface] as number,
        this.surfaceSide[3 * surface] as number,
        this.surfaceSide[3 * surface + 1] as number,
        this.wrap,
      );
    } else {
      wrapSphere(
        ax,
        ay,
        az,
        bx,
        by,
        bz,
        radius,
        this.surfaceSide[3 * surface] as number,
        this.surfaceSide[3 * surface + 1] as number,
        this.surfaceSide[3 * surface + 2] as number,
        this.wrap,
      );
    }
    if (this.wrap.status !== 'wrapped') return false;

    // Remember the surface's world frame so the arc samples can be turned back out into it.
    this.spanFrame[0] = qx;
    this.spanFrame[1] = qy;
    this.spanFrame[2] = qz;
    this.spanFrame[3] = qw;
    this.spanFrame[4] = originX;
    this.spanFrame[5] = originY;
    this.spanFrame[6] = originZ;

    // Unit vectors from each end toward its own tangent point, in the surface frame.
    let ux = this.wrap.ax - ax;
    let uy = this.wrap.ay - ay;
    let uz = this.wrap.az - az;
    let norm = Math.sqrt(ux * ux + uy * uy + uz * uz);
    let scale = norm > 0 ? 1 / norm : 0;
    ux *= scale;
    uy *= scale;
    uz *= scale;

    let vx = this.wrap.bx - bx;
    let vy = this.wrap.by - by;
    let vz = this.wrap.bz - bz;
    norm = Math.sqrt(vx * vx + vy * vy + vz * vz);
    scale = norm > 0 ? 1 / norm : 0;
    vx *= scale;
    vy *= scale;
    vz *= scale;

    // The envelope property: the tangent points contribute nothing, so only these two terms
    // remain, and both are already in the frame where the surface does not move.
    this.spanRate =
      -(
        ux * (this.local[3] as number) +
        uy * (this.local[4] as number) +
        uz * (this.local[5] as number)
      ) -
      (vx * (this.local[9] as number) +
        vy * (this.local[10] as number) +
        vz * (this.local[11] as number));

    // The first span's outgoing direction and the last span's incoming one, back in the world.
    this.rotateInto(qx, qy, qz, qw, ux, uy, uz, this.spanFirstDirection);
    this.rotateInto(qx, qy, qz, qw, vx, vy, vz, this.spanLastDirection);

    this.reportContact(
      path,
      body,
      qx,
      qy,
      qz,
      qw,
      originX,
      originY,
      originZ,
      ux,
      uy,
      uz,
      vx,
      vy,
      vz,
      outContacts,
    );
    return true;
  }

  /**
   * Record the reaction this wrap puts on the bone.
   *
   * The direction is the resultant `-(u_A + u_B)` turned into the world -- negated because `u_A`
   * and `u_B` point from the tangent points toward the free ends, and the force on the bone is
   * along the sum of the vectors from the free ends toward the tangent points. It is not
   * normalised: its magnitude is how sharply the tendon turns, so a tendon that grazes a bone
   * presses on it lightly and one that doubles back presses twice as hard as its tension.
   */
  private reportContact(
    path: number,
    body: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    originX: number,
    originY: number,
    originZ: number,
    ux: number,
    uy: number,
    uz: number,
    vx: number,
    vy: number,
    vz: number,
    out: PathContactBuffer,
  ): void {
    if (out.count >= out.capacity) {
      // Counted past capacity so the caller can report the overflow rather than lose it.
      out.count++;
      return;
    }
    const at = out.count;
    out.path[at] = path;
    out.body[at] = body;

    this.rotateInto(
      qx,
      qy,
      qz,
      qw,
      this.wrap.px,
      this.wrap.py,
      this.wrap.pz,
      this.spanFirstScratch,
    );
    out.point[3 * at] = originX + (this.spanFirstScratch[0] as number);
    out.point[3 * at + 1] = originY + (this.spanFirstScratch[1] as number);
    out.point[3 * at + 2] = originZ + (this.spanFirstScratch[2] as number);

    this.rotateInto(qx, qy, qz, qw, -(ux + vx), -(uy + vy), -(uz + vz), this.spanFirstScratch);
    out.direction[3 * at] = this.spanFirstScratch[0] as number;
    out.direction[3 * at + 1] = this.spanFirstScratch[1] as number;
    out.direction[3 * at + 2] = this.spanFirstScratch[2] as number;
    out.count++;
  }

  private readonly spanFirstScratch = new Float64Array(3);

  /** World points and world velocities of one path's attachment points. */
  private resolvePoints(pose: PoseBuffer, velocity: VelocityBuffer, from: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const body = this.pointBody[from + i] as number;
      const lx = this.pointLocal[3 * (from + i)] as number;
      const ly = this.pointLocal[3 * (from + i) + 1] as number;
      const lz = this.pointLocal[3 * (from + i) + 2] as number;
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
      const wx = velocity.angular[3 * body] as number;
      const wy = velocity.angular[3 * body + 1] as number;
      const wz = velocity.angular[3 * body + 2] as number;
      this.worldVelocity[3 * i] = (velocity.linear[3 * body] as number) + (wy * rz - wz * ry);
      this.worldVelocity[3 * i + 1] =
        (velocity.linear[3 * body + 1] as number) + (wz * rx - wx * rz);
      this.worldVelocity[3 * i + 2] =
        (velocity.linear[3 * body + 2] as number) + (wx * ry - wy * rx);
    }
  }

  /** Rotate a world vector into a frame, writing three numbers at `at` in the local scratch. */
  private rotateInverse(
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    x: number,
    y: number,
    z: number,
    at: number,
  ): void {
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    this.local[at] = x - qw * tx + (qy * tz - qz * ty);
    this.local[at + 1] = y - qw * ty + (qz * tx - qx * tz);
    this.local[at + 2] = z - qw * tz + (qx * ty - qy * tx);
  }

  /** Rotate a local vector out into the world. */
  private rotateInto(
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    x: number,
    y: number,
    z: number,
    out: Float64Array,
  ): void {
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    out[0] = x + qw * tx + (qy * tz - qz * ty);
    out[1] = y + qw * ty + (qz * tx - qx * tz);
    out[2] = z + qw * tz + (qx * ty - qy * tx);
  }

  private copyDirection(out: Float64Array, p: number, from: Float64Array): void {
    out[3 * p] = from[0] as number;
    out[3 * p + 1] = from[1] as number;
    out[3 * p + 2] = from[2] as number;
  }

  private zeroDirection(out: Float64Array, p: number): void {
    out[3 * p] = 0;
    out[3 * p + 1] = 0;
    out[3 * p + 2] = 0;
  }

  /** Path ids in solve order. */
  get order(): readonly string[] {
    return this.pathIds;
  }

  /** World positions of one path's attachment points. Allocates; not for the tick loop. */
  worldPoints(index: number, pose: PoseBuffer): Vec3[] {
    const from = this.pathStart[index] as number;
    const to = this.pathStart[index + 1] as number;
    this.resolvePoints(
      pose,
      { linear: new Float64Array(this.world.length), angular: new Float64Array(this.world.length) },
      from,
      to - from,
    );
    const points: Vec3[] = [];
    for (let i = 0; i < to - from; i++) {
      points.push({
        x: this.world[3 * i] as number,
        y: this.world[3 * i + 1] as number,
        z: this.world[3 * i + 2] as number,
      });
    }
    return points;
  }
}
