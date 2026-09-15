/**
 * The muscle path domain model -- muscle spec sections 4.2 to 4.4, ticket N1.1.
 *
 * A muscle's line of action is a polyline from origin to insertion, passing through whatever the
 * anatomy makes it pass through. Everything here describes that polyline before it is solved: the
 * points it is pinned to, the surfaces it slides over, and the order they come in.
 *
 * The one idea that shapes all of it: **every point is bone-local**. A path is not a list of world
 * coordinates that something updates each tick; it is a list of offsets in named bones' frames,
 * and the world polyline is derived from the pose. That is what makes the path move with the
 * skeleton for free, and what makes an attachment site a citable anatomical fact rather than a
 * number that drifts when the pose changes.
 */

/** A point in metres, in some named frame. */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Where a muscle is pinned to the skeleton.
 *
 * `bone` is a bone id, not a body index. Base spec ADR-009 made bone ids the stable public
 * interface precisely so that data like this survives a change of fidelity profile: at a profile
 * where the bone is not its own solver body, the site resolves through the follower transform of
 * whichever segment owns it, and the anatomy does not have to be re-authored.
 *
 * The citation is not optional and it must not come from clicking on licensed mesh geometry
 * (muscle spec 4.2, base spec ADR-009).
 */
export interface AttachmentSite {
  readonly bone: string;
  /** Bone-local, metres. */
  readonly point: Vec3;
}

export type WrapSurfaceType = 'sphere' | 'cylinder' | 'ellipsoid' | 'torus';

/**
 * A rigid primitive a path slides over: bone, cartilage, or another muscle.
 *
 * `preferredSide` is not a detail. A path that is free to fall either side of a surface will
 * occasionally swap between ticks, and the moment arm changes sign when it does -- the muscle
 * flips from flexor to extensor for one tick and the simulation destabilises. Declaring the side
 * once removes the choice (muscle spec 4.3).
 */
export interface WrapSurface {
  readonly id: string;
  readonly bone: string;
  readonly type: WrapSurfaceType;
  /** Bone-local position of the surface centre, metres. */
  readonly position: Vec3;
  /** Bone-local orientation, xyzw. Identity when omitted. */
  readonly orientation?: readonly [number, number, number, number];
  /** Sphere and cylinder radius, metres. */
  readonly radius?: number;
  /** Cylinder half-length, metres. A finite cylinder the native solver cannot represent. */
  readonly halfLength?: number;
  /** Ellipsoid semi-axes, metres. */
  readonly semiAxes?: Vec3;
  /**
   * Which side of the surface the path stays on, as a bone-local direction. The solver keeps the
   * wrap on this side rather than choosing per tick.
   */
  readonly preferredSide: Vec3;
}

/** A point the path passes through unconditionally. */
export interface ViaPointElement {
  readonly kind: 'viaPoint';
  readonly site: AttachmentSite;
}

/**
 * A via point that exists only over part of a joint's range.
 *
 * Common in published models, and a discontinuity wherever it switches. The spec requires the
 * transition to be blended across a band rather than thrown at a threshold, which is ticket N1.3;
 * the shape is declared here so the data can be authored before the solver handles it.
 */
export interface ConditionalViaPointElement {
  readonly kind: 'conditionalViaPoint';
  readonly site: AttachmentSite;
  /** The generalized coordinate the condition is on. */
  readonly coordinate: string;
  /** Radians or metres, depending on the coordinate. Active inside this range. */
  readonly range: readonly [number, number];
  /** Width of the blend band at each end of the range, in the coordinate's own units. */
  readonly blend: number;
}

export interface WrapElement {
  readonly kind: 'wrap';
  readonly surface: string;
}

export type PathElement = ViaPointElement | ConditionalViaPointElement | WrapElement;

/** One line of action: origin, ordered elements between, insertion. */
export interface MusclePath {
  readonly id: string;
  readonly origin: AttachmentSite;
  readonly elements: readonly PathElement[];
  readonly insertion: AttachmentSite;
}

export interface PathSolverCapabilities {
  readonly surfaceTypes: readonly WrapSurfaceType[];
  readonly maxSurfacesPerPath: number;
  readonly finiteCylinders: boolean;
  readonly requiresSiteBetweenWraps: boolean;
  /**
   * Whether the moment arm this solver produces is continuous in the joint angle. False for any
   * solver that switches via points at a threshold, and the moment arm validation harness has to
   * know, because a discontinuity there is otherwise indistinguishable from a bad measurement.
   */
  readonly continuousMomentArm: boolean;
}

/** What a solver could not represent, reported once at compile time rather than per tick. */
export interface PathCompileProblem {
  readonly path: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
}

export interface PathCompileReport {
  readonly pathCount: number;
  readonly pointCount: number;
  /**
   * Points a polyline buffer needs to hold every path at once.
   *
   * Computed rather than guessed: the solver knows how many attachment points each path has and
   * how many of its spans can wrap, so the exact figure is available at compile time and a caller
   * never has to pick a capacity and hope.
   */
  readonly polylineCapacity: number;
  readonly problems: readonly PathCompileProblem[];
}

/**
 * Wrap reaction points, for section 8.2 step 4 -- the step implementations skip.
 *
 * A muscle that wraps a bone pushes on that bone. Leaving the reaction out does not just lose a
 * small force, it makes the joint reaction force wrong, so the buffer for reporting it exists
 * from the start even while the only solver in the package produces no contacts.
 */
export interface PathContactBuffer {
  readonly capacity: number;
  /** How many contacts were written this solve. */
  count: number;
  /** `capacity`, index of the path each contact belongs to. */
  readonly path: Int32Array;
  /** `capacity`, index of the body the wrapped surface is attached to. */
  readonly body: Int32Array;
  /** `3 * capacity`, world metres. */
  readonly point: Float64Array;
  /** `3 * capacity`, the resultant direction the reaction acts along, unit length. */
  readonly direction: Float64Array;
}

/**
 * Where each unit's two ends are, and which way they pull, after a solve.
 *
 * Section 8.2 applies the tendon force at the origin along the first segment and at the insertion
 * along the last. A consumer therefore needs four things per unit that the length alone does not
 * carry: the two world points, the two directions, and the two bodies to push. The solver has all
 * of it in hand while it walks the path, and recomputing it downstream would mean a second module
 * resolving poses the path solver has already resolved.
 *
 * It is a separate buffer from the length and velocity because those two are what the *fiber*
 * model needs and these six are what the *force application* needs. A solver fills both; a
 * consumer that only integrates fibers can ignore this one.
 */
export interface PathTerminalBuffer {
  /** `N`, index of the body the origin is fixed to. */
  readonly originBody: Int32Array;
  /** `N`, index of the body the insertion is fixed to. */
  readonly insertionBody: Int32Array;
  /** `3 * N`, world metres. */
  readonly originPoint: Float64Array;
  /** `3 * N`, world metres. */
  readonly insertionPoint: Float64Array;
  /** `3 * N`, unit, from the origin toward the next point on the path. */
  readonly originDirection: Float64Array;
  /** `3 * N`, unit, from the insertion toward the previous point on the path. */
  readonly insertionDirection: Float64Array;
}

export function createPathTerminalBuffer(units: number): PathTerminalBuffer {
  return {
    originBody: new Int32Array(units),
    insertionBody: new Int32Array(units),
    originPoint: new Float64Array(3 * units),
    insertionPoint: new Float64Array(3 * units),
    originDirection: new Float64Array(3 * units),
    insertionDirection: new Float64Array(3 * units),
  };
}

/**
 * How finely a wrapped arc is sampled when a solver is asked for the polyline.
 *
 * Twelve segments is smooth at the scale a muscle is drawn and cheap enough that nothing needed
 * to be made optional to afford it. It affects drawing only: the length the fiber model uses is
 * the exact arc length, never a sum of these chords.
 */
export const ARC_SAMPLES = 12;

/**
 * The whole path of every unit, point by point, for anything that needs to draw it or reason
 * about where it runs rather than just how long it is.
 *
 * Separate from the terminal buffer because the two answer different questions and have different
 * costs. Force application needs six numbers per unit and gets them every tick; a drawing needs
 * the entire polyline, which is an order of magnitude more data and is of no use to the solver.
 * A caller that does not pass one of these is not charged for it.
 */
export interface PathPolylineBuffer {
  readonly capacity: number;
  /** `N`, where each path's points begin in `point`. */
  readonly start: Int32Array;
  /** `N`, how many points each path wrote. */
  readonly count: Int32Array;
  /** `3 * capacity`, world metres. */
  readonly point: Float64Array;
  /**
   * `capacity`, the body each point is carried by.
   *
   * An attachment point moves with the bone it is pinned to; a point on an arc moves with the
   * bone whose surface it lies on. Without this a reader has the shape of the path but not what
   * moves it, and cannot work out a moment arm -- which is the derivative of the length with
   * respect to a coordinate, and so entirely a question of which points that coordinate carries.
   */
  readonly body: Int32Array;
}

export function createPathPolylineBuffer(units: number, capacity: number): PathPolylineBuffer {
  return {
    capacity,
    start: new Int32Array(units),
    count: new Int32Array(units),
    point: new Float64Array(3 * capacity),
    body: new Int32Array(capacity),
  };
}

export function createPathContactBuffer(capacity: number): PathContactBuffer {
  return {
    capacity,
    count: 0,
    path: new Int32Array(capacity),
    body: new Int32Array(capacity),
    point: new Float64Array(3 * capacity),
    direction: new Float64Array(3 * capacity),
  };
}
