/**
 * The physics backend adapter -- spec section 9, ADR-002, ADR-003.
 *
 * Two backends ship in Phase 1 behind this one interface: Rapier for interactive use and MuJoCo
 * for accuracy. The interface is designed to MuJoCo's semantics (HSDL is an MJCF superset), so
 * the Rapier adapter is knowingly a lossy projection and MUST say so through `compile()`'s report.
 * **Silent approximation is forbidden** -- it is the mechanism by which a research-accurate
 * simulator quietly becomes a toy.
 *
 * Hard rules (spec 9.2), restated because each one is easy to violate quietly:
 *   - No allocation in `step` or any `read*`. Buffers are preallocated by the caller and reused.
 *   - `Float64Array` for all state. Float32 is for the render boundary only.
 *   - Index-based hot paths. Name resolution happens at `compile`.
 *   - Segment and DoF ordering come from `CompiledArticulation` and are identical across backends.
 */

import type { Transform, Vec3 } from '@bs-humany/frames';
import type { CompiledArticulation } from './articulation.js';

export type Support = 'native' | 'emulated' | 'approximated' | 'unsupported';

export interface BackendCapabilities {
  readonly reducedCoordinate: boolean;
  readonly equalityConstraints: 'native' | 'approximated' | 'unsupported';
  readonly softJointLimits: 'native' | 'emulated';
  readonly perDofStiffnessDamping: 'native' | 'emulated';
  /** Matters from Phase 3. */
  readonly tendons: 'native' | 'unsupported';
  readonly muscleActuators: 'native' | 'unsupported';
  readonly deterministicAcrossPlatforms: boolean;
  readonly maxRecommendedBodies: number;
  /** Section 14.5 obligation 4: realized, not just commanded, per-DoF force. */
  readonly realizedDofForce: 'native' | 'estimated' | 'unsupported';
}

export type ReportSeverity = 'info' | 'warning' | 'error';

/** One thing the backend dropped, approximated or emulated when compiling. */
export interface CompileNote {
  readonly severity: ReportSeverity;
  /** What HSDL feature was affected. */
  readonly feature: string;
  /** Which element, where it applies. */
  readonly element?: string | undefined;
  readonly message: string;
}

export interface CompileReport {
  readonly backend: string;
  readonly notes: readonly CompileNote[];
  /** Convenience: any note at `warning` or above. The UI MUST surface these (spec 9.3). */
  readonly hasWarnings: boolean;
  readonly segments: number;
  readonly joints: number;
  readonly nv: number;
}

export interface BackendConfig {
  /** Fixed timestep, seconds. Immutable for the session. */
  readonly dt: number;
  /** Solver iterations or substeps, backend-defined. */
  readonly iterations?: number | undefined;
  readonly gravity?: Vec3 | undefined;
  /** Rapier's deterministic mode, where offered. */
  readonly deterministic?: boolean | undefined;
  /**
   * A fixed horizontal ground plane at `height` metres, with the named contact class. Absent
   * means no ground: the articulation falls forever, which is what a free-fall scenario wants.
   */
  readonly ground?:
    | { readonly height: number; readonly contactClass?: string | undefined }
    | undefined;
  /** Fixed boxes in the world: stairs, a seat. Half extents and centre in metres, world frame. */
  readonly staticBoxes?: readonly StaticBox[] | undefined;
}

export interface StaticBox {
  readonly id: string;
  readonly halfExtents: Vec3;
  readonly position: Vec3;
  readonly rotation?: { x: number; y: number; z: number; w: number } | undefined;
  readonly contactClass?: string | undefined;
}

/** SoA output buffers. All `Float64Array`, all preallocated by the caller, all written in place. */
export interface PoseBuffer {
  /** `3 * N` */
  readonly position: Float64Array;
  /** `4 * N`, x y z w */
  readonly orientation: Float64Array;
}

export interface VelocityBuffer {
  /** `3 * N` */
  readonly linear: Float64Array;
  /** `3 * N` */
  readonly angular: Float64Array;
}

export interface JointStateBuffer {
  /** `nq` */
  readonly q: Float64Array;
  /** `nv` */
  readonly qdot: Float64Array;
  /** `nv`: realized generalized force per DoF this step, constraint plus actuation. */
  readonly force: Float64Array;
}

export interface ContactBuffer {
  readonly capacity: number;
  /** `2 * capacity`: segment index pair. */
  readonly pair: Int32Array;
  /** `3 * capacity` */
  readonly point: Float64Array;
  /** `3 * capacity`, from A toward B */
  readonly normal: Float64Array;
  /** `capacity`, normal impulse this step, N*s */
  readonly impulse: Float64Array;
  /** `capacity` */
  readonly depth: Float64Array;
}

export interface MotorTarget {
  readonly position?: number | undefined;
  readonly velocity?: number | undefined;
  readonly stiffness: number;
  readonly damping: number;
  readonly maxForce: number;
}

export interface GrabHandle {
  setTarget(world: Vec3): void;
  /**
   * Also hold the segment's orientation toward this one, in world; `null` to hold position only.
   * A backend without a rotational spring may ignore it.
   */
  setTargetOrientation(world: { x: number; y: number; z: number; w: number } | null): void;
  release(): void;
}

export interface IPhysicsBackend {
  readonly id: 'rapier' | 'mujoco';
  readonly capabilities: BackendCapabilities;

  init(config: BackendConfig): Promise<void>;
  /** Build the solver model. Returns every feature dropped, approximated or emulated. */
  compile(model: CompiledArticulation): Promise<CompileReport>;
  dispose(): void;

  step(substeps: number): void;

  readPose(out: PoseBuffer): void;
  readVelocity(out: VelocityBuffer): void;
  readJointState(out: JointStateBuffer): void;
  /** Writes up to `out.capacity` contacts; returns how many there were, which may exceed it. */
  readContacts(out: ContactBuffer): number;

  /**
   * Set the whole generalized state: root pose and velocity, then every joint coordinate and
   * rate. What makes recompile-and-restore possible (spec 14.5 item 9): a body compiled anew is
   * placed exactly where the old one was, in the coordinates both share.
   */
  writeJointState(q: Float64Array, qdot: Float64Array): void;
  /** Generalized force per DoF, `nv` long, applied this step. */
  applyGeneralizedForce(dofForces: Float64Array): void;
  setJointMotorTarget(dofIndex: number, target: MotorTarget | null): void;
  applyBodyWrench(segmentIndex: number, force: Vec3, torque: Vec3, point?: Vec3): void;

  /** Change the gravity being integrated with, after `init`. */
  setGravity(gravity: Vec3): void;
  /**
   * Turn contact with the ground plane on or off, after `init`.
   *
   * The ground stays in the world either way, so the body's own geometry, the furniture and the
   * solver are untouched; it simply stops taking part in contact.
   */
  setGroundCollision(enabled: boolean): void;
  setKinematic(segmentIndex: number, enabled: boolean): void;
  setPose(segmentIndex: number, transform: Transform): void;
  /**
   * Hold a point on a segment toward a moving world target.
   *
   * `strength` scales the spring: 1 is the backend's default, which can carry a fraction of the
   * whole body's weight. Below 1 a grab slips under load, above it a hand can lift the body.
   */
  createGrabConstraint(
    segmentIndex: number,
    localPoint: Vec3,
    worldTarget: Vec3,
    strength?: number,
  ): GrabHandle;

  snapshot(): Uint8Array;
  restore(snapshot: Uint8Array): void;
}

/** Allocate output buffers sized for an articulation. Call once; never at step rate. */
export function allocateBuffers(model: CompiledArticulation, contactCapacity = 256) {
  const n = model.segments.length;
  return {
    pose: {
      position: new Float64Array(3 * n),
      orientation: new Float64Array(4 * n),
    } satisfies PoseBuffer,
    velocity: {
      linear: new Float64Array(3 * n),
      angular: new Float64Array(3 * n),
    } satisfies VelocityBuffer,
    jointState: {
      q: new Float64Array(model.nq),
      qdot: new Float64Array(model.nv),
      force: new Float64Array(model.nv),
    } satisfies JointStateBuffer,
    contacts: {
      capacity: contactCapacity,
      pair: new Int32Array(2 * contactCapacity),
      point: new Float64Array(3 * contactCapacity),
      normal: new Float64Array(3 * contactCapacity),
      impulse: new Float64Array(contactCapacity),
      depth: new Float64Array(contactCapacity),
    } satisfies ContactBuffer,
  };
}
