/**
 * The compiled articulation -- the dynamic layer of ADR-001, ready for a solver.
 *
 * A `CompiledArticulation` is what a fidelity profile turns the anatomical document into: N rigid
 * segments with mass properties, M joints with an ordered list of degrees of freedom, collision
 * proxies, and exclusion pairs. Everything is index-addressed. Names resolve once, here; step-rate
 * code never touches a string (spec 9.2).
 *
 * **Segment and DoF ordering is part of the contract.** Spec 9.2: it MUST be identical across
 * backends for the same model and profile, because that is what lets the conformance harness
 * compare two solvers element by element. The order is fixed by the compiler, not by any backend:
 * segments in the profile's declared order, joints in document order among those whose two bones
 * land in different segments, DoFs in each joint's declared order. Registration order of anything
 * plays no part.
 */

import type { Mat3, Quat, Transform, Vec3 } from '@bs-humany/frames';
import type { StiffnessCurve } from '@bs-humany/hsdl';

export interface CompiledSegment {
  readonly index: number;
  readonly id: string;
  readonly displayName: string;
  /** Anchor bone; the segment frame is this bone's frame. */
  readonly anchor: string;
  /** Every bone the segment owns, anchor first. */
  readonly bones: readonly string[];
  /** Parent segment index in the dynamic tree, or -1 for the root. */
  readonly parent: number;
  /** World transform of the segment frame in the rest pose. */
  readonly restWorld: Transform;
  /** Kilograms. */
  readonly mass: number;
  /** Centre of mass in the segment frame, metres. */
  readonly com: Vec3;
  /** Inertia tensor about the centre of mass, in the segment frame, kg*m^2. */
  readonly inertia: Mat3;
  /** Indices into `proxies`. */
  readonly proxyIndices: readonly number[];
  /** Follower bones' transforms relative to the anchor, for the pose module. */
  readonly followers: readonly { readonly bone: string; readonly local: Transform }[];
}

export interface CompiledDof {
  /**
   * Global DoF index among the hinge and slide DoFs, contiguous across joints in joint order.
   * The root's free joint comes first in the state vectors, so this DoF's slot in `q` is
   * `ROOT_NQ + index` and its slot in `qdot` and `force` is `ROOT_NV + index`.
   */
  readonly index: number;
  readonly joint: number;
  readonly axisName: string;
  readonly kind: 'hinge' | 'slide';
  /** Unit axis in the joint frame. */
  readonly vector: Vec3;
  readonly range: readonly [number, number];
  readonly neutral: number;
  readonly passiveStiffness?: StiffnessCurve | undefined;
  readonly passiveDamping: number;
  readonly armature: number;
  readonly frictionLoss: number;
}

export interface CompiledJoint {
  readonly index: number;
  readonly id: string;
  readonly displayName: string;
  readonly parentSegment: number;
  readonly childSegment: number;
  /** Joint frame in the parent segment's frame. */
  readonly frameInParent: Transform;
  /** Joint frame in the child segment's frame, at the neutral pose. */
  readonly frameInChild: Transform;
  /** Ordered. Global DoF indices are contiguous from `dofStart`. */
  readonly dofs: readonly CompiledDof[];
  readonly dofStart: number;
  readonly type: string;
}

export interface CompiledProxy {
  readonly index: number;
  readonly id: string;
  readonly segment: number;
  readonly transform: Transform;
  readonly shape:
    | { readonly kind: 'capsule'; readonly radius: number; readonly length: number }
    | { readonly kind: 'sphere'; readonly radius: number }
    | { readonly kind: 'box'; readonly halfExtents: Vec3 }
    | { readonly kind: 'convexHull'; readonly vertices: readonly Vec3[] };
  readonly group: number;
  readonly mask: number;
  readonly contactClass: string;
}

export interface CompiledContactClass {
  readonly friction: number;
  readonly restitution: number;
  readonly softness: number;
}

export interface CompiledConstraint {
  readonly index: number;
  readonly id: string;
  readonly kind:
    | {
        readonly type: 'jointCoupling';
        readonly dependent: number;
        readonly drivers: readonly { readonly dof: number; readonly coefficient: number }[];
        readonly offset: number;
      }
    | { readonly type: 'weld'; readonly segmentA: number; readonly segmentB: number };
  readonly soft: boolean;
}

export interface CompiledArticulation {
  /** Which document and profile produced this, so a snapshot can say what it belongs to. */
  readonly documentId: string;
  readonly profileId: string;
  /** Hash of the morphology inputs, so two compilations can be told apart. */
  readonly morphologyKey: string;
  readonly segments: readonly CompiledSegment[];
  readonly joints: readonly CompiledJoint[];
  /** Flat, in global DoF order. Length is `nv`. */
  readonly dofs: readonly CompiledDof[];
  readonly proxies: readonly CompiledProxy[];
  readonly contactClasses: Readonly<Record<string, CompiledContactClass>>;
  /** Segment index pairs that never collide. Includes every parent/child pair. */
  readonly excludedPairs: readonly (readonly [number, number])[];
  readonly constraints: readonly CompiledConstraint[];
  /** Number of generalized velocities: one per hinge or slide DoF, plus 6 for the free root. */
  readonly nv: number;
  /** Number of generalized positions: as `nv`, but the root's orientation is a quaternion (+1). */
  readonly nq: number;
  /** Index of the root segment, which carries the 6-DoF free joint. */
  readonly root: number;
  readonly gravity: Vec3;
  readonly totalMass: number;
}

/** Generalized positions used by the root's free joint: translation plus a unit quaternion. */
export const ROOT_NQ = 7;
/** Generalized velocities used by the root's free joint. */
export const ROOT_NV = 6;

/** Identity orientation, for readability at call sites. */
export const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };
