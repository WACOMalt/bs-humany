/**
 * The Rapier backend -- milestone M3.6.
 *
 * ADR-003: Rapier is the interactive default and, per ADR-002, a knowingly lossy projection of
 * HSDL's MuJoCo-shaped semantics. What is lossy here is declared, in `capabilities` and in the
 * compile report, rather than discovered later as a bug (spec section 9.4):
 *
 *   - **Maximal coordinates.** Rapier's impulse joints constrain free bodies; nothing reports a
 *     joint angle. Every step, generalized coordinates are recovered from body poses by
 *     `jointSolver`, which is what the limits, the passive model and the diagnostics consume.
 *   - **Emulated limits and passive terms.** Multi-DoF joints get their range stops as stiff
 *     torsional springs computed here, in the recovered coordinate space, so an oblique axis
 *     (the subtalar joint) limits correctly. One-DoF joints additionally carry Rapier's native
 *     revolute limit, which holds under load where a spring would yield.
 *   - **Emulated motors.** PD torques in generalized coordinates, clamped to `maxForce`.
 *   - **Equality constraints unsupported** until the soft corrective module of section 7.4 lands.
 *   - **Realized force is an estimate**: the sum of what was commanded and what the emulations
 *     added. Rapier does not expose joint constraint impulses.
 *
 * Step-rate code allocates nothing: every Rapier getter is called with a preallocated target,
 * callbacks are created once, and the state lives in typed arrays sized at compile.
 */

import type {
  BackendCapabilities,
  BackendConfig,
  CompileNote,
  CompileReport,
  CompiledArticulation,
  CompiledDof,
  CompiledJoint,
  ContactBuffer,
  GrabHandle,
  IPhysicsBackend,
  JointStateBuffer,
  MotorTarget,
  PoseBuffer,
  VelocityBuffer,
} from '@bs-humany/compiler';
import { ROOT_NQ, ROOT_NV, dofAxisInertia, forwardKinematics } from '@bs-humany/compiler';
import {
  type Transform,
  type Vec3,
  cross,
  dot,
  fromColumns,
  multiplyQuat,
  normalize,
  quatFromMat3,
  rotate,
  vec3,
} from '@bs-humany/frames';
import RAPIER from '@dimforge/rapier3d-compat';
import type {
  Collider,
  ColliderDesc,
  ColliderHandle,
  JointData,
  PhysicsHooks,
  RevoluteImpulseJoint,
  RigidBody,
  RigidBodyHandle,
  TempContactManifold,
  World,
} from '@dimforge/rapier3d-compat';
import { principalAxes } from './eigen.js';
import {
  type JointSolverState,
  createJointSolverState,
  solveJointAngles,
  solveJointVelocities,
} from './jointSolver.js';

/** Natural frequency of the emulated range stop, Hz. Stiff enough to hold, soft enough to solve. */
export const LIMIT_STOP_FREQUENCY_HZ = 30;
/**
 * A grab is a spring that can pull with at most `GRAB_FORCE_FRACTION` of the body's weight when
 * stretched by `GRAB_LEASH` metres. The GrabModule keeps the target within the leash, so that is
 * the largest force a grab ever applies -- enough to drag the whole body about, not enough to
 * tear an impulse joint apart.
 */
export const GRAB_LEASH = 0.3;
export const GRAB_FORCE_FRACTION = 0.8;
const STANDARD_GRAVITY_MAGNITUDE = 9.80665;
const DEFAULT_ITERATIONS = 4;

const CAPABILITIES: BackendCapabilities = {
  reducedCoordinate: false,
  equalityConstraints: 'unsupported',
  softJointLimits: 'emulated',
  perDofStiffnessDamping: 'emulated',
  tendons: 'unsupported',
  muscleActuators: 'unsupported',
  deterministicAcrossPlatforms: false,
  maxRecommendedBodies: 60,
  realizedDofForce: 'estimated',
};

interface JointRuntime {
  readonly compiled: CompiledJoint;
  readonly solver: JointSolverState;
  handle: number;
  /** Stiffness and damping of the emulated stop per DoF. */
  readonly stopStiffness: Float64Array;
  readonly stopDamping: Float64Array;
}

class RapierGrab implements GrabHandle {
  constructor(
    private readonly backend: RapierBackend,
    readonly bodyHandle: RigidBodyHandle,
    readonly jointHandle: number,
  ) {}
  setTarget(world: Vec3): void {
    this.backend.moveGrab(this, world);
  }
  /** A kinematic anchor on a spherical joint holds a point; orientation is not something it has. */
  setTargetOrientation(): void {}
  release(): void {
    this.backend.releaseGrab(this);
  }
}

export interface RapierOptions {
  /** Native per-axis limits on two-DoF generic joints, behind the emulated stops. */
  readonly twoDofNativeLimits?: 'both' | 'first' | 'none' | 'legacy' | undefined;
  /**
   * Rounding radius added to every convex hull proxy, metres. A sharp-edged hull landing on
   * an edge gives the impulse solver a contact that jumps between faces from step to step; a
   * rounded one (the hull grown by this radius, as a capsule is a rounded segment) gives it a
   * continuous one. The hull grows by the radius, which is recorded as a limitation.
   */
  readonly hullRounding?: number | undefined;
  /**
   * Speculative contact distance, metres: pairs closer than this get a contact before they
   * touch, so a fast, thin hull piece is caught rather than resolved from deep inside another.
   * Rapier's default is two millimetres.
   */
  readonly predictionDistance?: number | undefined;
  /**
   * Natural frequency of the contact spring, Hz. Lower is softer: a deep penetration is
   * resolved over more steps with less energy injected. Rapier's default is 30.
   */
  readonly contactNaturalFrequency?: number | undefined;
  /** Solver iterations, overriding the profile's request. For tuning and tests. */
  readonly solverIterations?: number | undefined;
}

/** Default hull rounding: a few millimetres, below the fit of the hulls themselves. */
export const DEFAULT_HULL_ROUNDING = 0.003;

export class RapierBackend implements IPhysicsBackend {
  readonly id = 'rapier' as const;
  readonly capabilities = CAPABILITIES;
  private readonly twoDofNativeLimits: 'both' | 'first' | 'none' | 'legacy';
  private readonly hullRounding: number;
  private groundCollider: Collider | undefined;
  private readonly options: RapierOptions;

  private config: BackendConfig | undefined;
  private model: CompiledArticulation | undefined;
  private world: World | undefined;
  private bodies: RigidBody[] = [];
  private bodyHandles: RigidBodyHandle[] = [];
  private colliders: Collider[] = [];
  private colliderHandles: ColliderHandle[] = [];
  private colliderSegment = new Int32Array(0);
  private segmentOfBody = new Map<RigidBodyHandle, number>();
  private joints: JointRuntime[] = [];
  private excludedBodyPairs = new Set<string>();
  private grabs = new Set<RapierGrab>();

  // Generalized state, `nv` long; positions `nq` long.
  private q = new Float64Array(0);
  private qdot = new Float64Array(0);
  private commanded = new Float64Array(0);
  private realized = new Float64Array(0);
  private motors: (MotorTarget | null)[] = [];

  // Scratch, allocated once.
  private readonly v3 = new RAPIER.Vector3(0, 0, 0);
  private readonly v3b = new RAPIER.Vector3(0, 0, 0);
  private readonly quat = new RAPIER.Quaternion(0, 0, 0, 1);
  private readonly quatB = new RAPIER.Quaternion(0, 0, 0, 1);
  private readonly rel = new Float64Array(4);
  private readonly hooks: PhysicsHooks;
  private contactOut: ContactBuffer | undefined;
  private contactCount = 0;
  private contactColliderIndex = 0;
  private readonly onPairCollider: (other: Collider) => void;
  private readonly onManifold: (manifold: TempContactManifold, flipped: boolean) => void;

  constructor(options: RapierOptions = {}) {
    this.twoDofNativeLimits = options.twoDofNativeLimits ?? 'both';
    this.hullRounding = options.hullRounding ?? DEFAULT_HULL_ROUNDING;
    this.options = options;
    this.hooks = {
      filterContactPair: (_c1, _c2, b1, b2) =>
        this.excludedBodyPairs.has(pairKey(b1, b2)) ? null : RAPIER.SolverFlags.COMPUTE_IMPULSE,
      filterIntersectionPair: () => true,
    };
    this.onManifold = (manifold, flipped) => this.collectManifold(manifold, flipped);
    this.onPairCollider = (other) => this.collectPair(other);
  }

  private configureWorld(world: World, config: BackendConfig): void {
    world.numSolverIterations =
      this.options.solverIterations ?? config.iterations ?? DEFAULT_ITERATIONS;
    const p = world.integrationParameters;
    if (this.options.predictionDistance !== undefined) {
      p.normalizedPredictionDistance = this.options.predictionDistance / p.lengthUnit;
    }
    if (this.options.contactNaturalFrequency !== undefined) {
      p.contact_natural_frequency = this.options.contactNaturalFrequency;
    }
  }

  async init(config: BackendConfig): Promise<void> {
    await RAPIER.init();
    this.config = config;
  }

  async compile(model: CompiledArticulation): Promise<CompileReport> {
    const config = this.config;
    if (!config) throw new Error('RapierBackend.compile called before init.');
    this.disposeWorld();
    const notes: CompileNote[] = [];
    const g = config.gravity ?? model.gravity;
    const world = new RAPIER.World(new RAPIER.Vector3(g.x, g.y, g.z));
    world.timestep = config.dt;
    this.configureWorld(world, config);
    this.world = world;
    this.model = model;

    // Bodies.
    this.bodies = [];
    this.bodyHandles = [];
    this.segmentOfBody.clear();
    for (const segment of model.segments) {
      const t = segment.restWorld;
      const desc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(t.translation.x, t.translation.y, t.translation.z)
        .setRotation(t.rotation)
        .setCanSleep(false);
      const body = world.createRigidBody(desc);
      const principal = principalAxes(segment.inertia);
      body.setAdditionalMassProperties(
        segment.mass,
        segment.com,
        principal.moments,
        principal.rotation,
        true,
      );
      this.bodies.push(body);
      this.bodyHandles.push(body.handle);
      this.segmentOfBody.set(body.handle, segment.index);
    }

    // Colliders. The pair filter hook runs in JavaScript for every candidate pair of a flagged
    // collider, so only bodies with an exclusion the joints do not already cover carry the
    // flag; at L0 and L1 that is nobody or the arms, and the hook costs nothing elsewhere.
    const joined = new Set(
      model.joints.map(
        (j) =>
          `${Math.min(j.parentSegment, j.childSegment)}|${Math.max(j.parentSegment, j.childSegment)}`,
      ),
    );
    const hooked = new Set<number>();
    for (const [a, b] of model.excludedPairs) {
      if (joined.has(`${a}|${b}`)) continue;
      hooked.add(a);
      hooked.add(b);
    }
    this.colliders = [];
    this.colliderHandles = [];
    this.colliderSegment = new Int32Array(model.proxies.length);
    for (const proxy of model.proxies) {
      const shape = proxy.shape;
      let desc: ColliderDesc | null;
      if (shape.kind === 'capsule')
        desc = RAPIER.ColliderDesc.capsule(shape.length / 2, shape.radius);
      else if (shape.kind === 'sphere') desc = RAPIER.ColliderDesc.ball(shape.radius);
      else if (shape.kind === 'box')
        desc = RAPIER.ColliderDesc.cuboid(
          shape.halfExtents.x,
          shape.halfExtents.y,
          shape.halfExtents.z,
        );
      else {
        const points = new Float32Array(shape.vertices.length * 3);
        shape.vertices.forEach((v, i) => {
          points[3 * i] = v.x;
          points[3 * i + 1] = v.y;
          points[3 * i + 2] = v.z;
        });
        desc =
          this.hullRounding > 0
            ? RAPIER.ColliderDesc.roundConvexHull(points, this.hullRounding)
            : RAPIER.ColliderDesc.convexHull(points);
        if (!desc) {
          notes.push({
            severity: 'warning',
            feature: 'collisionProxy',
            element: proxy.id,
            message: `Convex hull '${proxy.id}' is degenerate and was dropped.`,
          });
          continue;
        }
      }
      const cls = model.contactClasses[proxy.contactClass];
      desc
        .setTranslation(
          proxy.transform.translation.x,
          proxy.transform.translation.y,
          proxy.transform.translation.z,
        )
        .setRotation(proxy.transform.rotation)
        .setMass(0)
        .setFriction(cls?.friction ?? 0.5)
        .setRestitution(cls?.restitution ?? 0)
        .setActiveHooks(
          hooked.has(proxy.segment)
            ? RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS
            : RAPIER.ActiveHooks.NONE,
        );
      const body = this.bodies[proxy.segment];
      if (!body)
        throw new Error(`Proxy '${proxy.id}' names segment ${proxy.segment}, which has no body.`);
      const collider = world.createCollider(desc, body);
      this.colliderSegment[this.colliders.length] = proxy.segment;
      this.colliders.push(collider);
      this.colliderHandles.push(collider.handle);
    }

    // Exclusions, by body handle pair.
    this.excludedBodyPairs.clear();
    for (const [a, b] of model.excludedPairs) {
      const ha = this.bodyHandles[a];
      const hb = this.bodyHandles[b];
      if (ha !== undefined && hb !== undefined) this.excludedBodyPairs.add(pairKey(ha, hb));
    }

    // Joints.
    this.joints = [];
    let emulatedLimits = 0;
    let nativeBackstops = 0;
    for (const joint of model.joints) {
      const parent = this.bodies[joint.parentSegment];
      const child = this.bodies[joint.childSegment];
      if (!parent || !child) throw new Error(`Joint '${joint.id}' references a missing body.`);
      const a1 = joint.frameInParent.translation;
      const a2 = joint.frameInChild.translation;
      const n = joint.dofs.length;
      let data: JointData;
      let lockedInParent: Vec3 | undefined;
      if (n === 0) {
        data = RAPIER.JointData.fixed(
          a1,
          joint.frameInParent.rotation,
          a2,
          joint.frameInChild.rotation,
        );
      } else if (n === 1) {
        const axis = joint.dofs[0]?.vector ?? vec3(0, 0, 1);
        data = RAPIER.JointData.revoluteWithAxes(
          a1,
          a2,
          rotate(joint.frameInParent.rotation, axis),
          rotate(joint.frameInChild.rotation, axis),
        );
      } else if (n === 2) {
        const [d0, d1] = joint.dofs;
        if (!d0 || !d1) throw new Error('unreachable');
        const lockedAxis = normalize(cross(d0.vector, d1.vector));
        lockedInParent = rotate(joint.frameInParent.rotation, lockedAxis);
        data = RAPIER.JointData.generic(
          a1,
          a2,
          lockedInParent,
          RAPIER.JointAxesMask.LinX |
            RAPIER.JointAxesMask.LinY |
            RAPIER.JointAxesMask.LinZ |
            RAPIER.JointAxesMask.AngX,
        );
        emulatedLimits += 2;
      } else {
        data = RAPIER.JointData.spherical(a1, a2);
        emulatedLimits += n;
        if (n > 3) {
          notes.push({
            severity: 'warning',
            feature: 'joint',
            element: joint.id,
            message: `Joint '${joint.id}' declares ${n} DoFs; Rapier constrains only the first three.`,
          });
        }
      }
      const impulseJoint = world.createImpulseJoint(data, parent, child, true);
      impulseJoint.setContactsEnabled(false);
      if (n === 1) {
        const dof = joint.dofs[0];
        if (dof) {
          (impulseJoint as RevoluteImpulseJoint).setLimits(
            dof.range[0] - dof.neutral,
            dof.range[1] - dof.neutral,
          );
        }
      } else if (n === 2 && lockedInParent && this.twoDofNativeLimits !== 'legacy') {
        // Give the generic joint an explicit frame: X on the locked axis, Z on the first DoF, Y
        // completing it. Rapier's own frame would have an arbitrary roll about the locked axis,
        // which is what made the ankle's dorsiflexion axis oblique to it. With the frame fixed,
        // the first DoF always has a native limit; the second does when it is Y (the wrist), and
        // only the emulated stop when it is oblique (the subtalar axis).
        const [d0, d1] = joint.dofs;
        if (!d0 || !d1) throw new Error('unreachable');
        const x = normalize(cross(d0.vector, d1.vector));
        const z = normalize(d0.vector);
        const y = cross(z, x);
        const local = quatFromMat3(fromColumns(x, y, z));
        impulseJoint.setFrameX1(multiplyQuat(joint.frameInParent.rotation, local));
        impulseJoint.setFrameX2(multiplyQuat(joint.frameInChild.rotation, local));
        const backstop = (dof: CompiledDof, rawAxis: RawAxis, sign: 1 | -1) => {
          const lo = (dof.range[0] - dof.neutral) * sign;
          const hi = (dof.range[1] - dof.neutral) * sign;
          world.impulseJoints.raw.jointSetLimits(
            impulseJoint.handle,
            rawAxis,
            Math.min(lo, hi),
            Math.max(lo, hi),
          );
          nativeBackstops += 1;
        };
        if (this.twoDofNativeLimits !== 'none') backstop(d0, ANG_Z, 1);
        const dy = dot(normalize(d1.vector), y);
        if (this.twoDofNativeLimits === 'both' && Math.abs(Math.abs(dy) - 1) < 1e-6) {
          backstop(d1, ANG_Y, dy > 0 ? 1 : -1);
        }
      } else if (n === 3) {
        // Rapier's spherical joint can limit rotation about each of the parent body's axes. Where
        // a DoF vector lands on one of them at rest, that native limit backs up the emulated
        // stop; it holds under load where a spring would yield. Rapier decomposes the relative
        // rotation its own way, so this is a backstop, not the definition of the range.
        for (const dof of joint.dofs) {
          const inParent = rotate(joint.frameInParent.rotation, dof.vector);
          const axis = canonicalAxis(inParent);
          if (!axis) continue;
          const [rawAxis, sign] = axis;
          const lo = (dof.range[0] - dof.neutral) * sign;
          const hi = (dof.range[1] - dof.neutral) * sign;
          world.impulseJoints.raw.jointSetLimits(
            impulseJoint.handle,
            rawAxis,
            Math.min(lo, hi),
            Math.max(lo, hi),
          );
          nativeBackstops += 1;
        }
      }

      const stopStiffness = new Float64Array(n);
      const stopDamping = new Float64Array(n);
      const omega = 2 * Math.PI * LIMIT_STOP_FREQUENCY_HZ;
      joint.dofs.forEach((dof, i) => {
        // Child inertia about the DoF axis at rest sets the stop stiffness, so every joint stops
        // at the same frequency.
        const inertia = Math.max(dofAxisInertia(model, dof), 1e-6);
        const k = inertia * omega * omega;
        stopStiffness[i] = k;
        stopDamping[i] = 2 * Math.sqrt(k * inertia);
      });
      this.joints.push({
        compiled: joint,
        solver: createJointSolverState(joint),
        handle: impulseJoint.handle,
        stopStiffness,
        stopDamping,
      });
    }
    if (emulatedLimits > 0) {
      notes.push({
        severity: 'warning',
        feature: 'jointLimits',
        message:
          `${emulatedLimits} DoF range stops on multi-DoF joints are emulated as stiff torsional ` +
          `springs at ${LIMIT_STOP_FREQUENCY_HZ} Hz in recovered joint coordinates, ` +
          `${nativeBackstops} of them backed by a native per-axis limit in Rapier's own ` +
          'decomposition. They yield under sufficient load; one-DoF joints use native limits.',
      });
    }
    if (model.dofs.some((d) => d.armature > 0)) {
      notes.push({
        severity: 'info',
        feature: 'armature',
        message:
          'Per-DoF armature does not apply to impulse joints and is ignored; the joint solver ' +
          'regularises singular sequences toward neutral instead.',
      });
    }
    if (model.dofs.some((d) => d.passiveStiffness || d.passiveDamping > 0)) {
      notes.push({
        severity: 'warning',
        feature: 'passiveStiffness',
        message:
          'Per-DoF passive stiffness and damping are not applied by this backend; the ' +
          'PassiveJointModule must supply them through actuation.jointTorque.',
      });
    }
    const couplings = model.constraints.filter((c) => c.kind.type === 'jointCoupling').length;
    if (couplings > 0) {
      notes.push({
        severity: 'warning',
        feature: 'constraint',
        message:
          `${couplings} joint coupling(s) are not solved by Rapier; the CouplingModule enforces ` +
          'them as soft corrective torques (spec 7.4), so they can be violated under load.',
      });
    }
    for (const c of model.constraints) {
      if (c.kind.type === 'jointCoupling') continue;
      notes.push({
        severity: 'warning',
        feature: 'constraint',
        element: c.id,
        message: `Constraint '${c.id}' (${c.kind.type}) is not supported by the Rapier backend and was dropped.`,
      });
    }

    // Ground.
    if (config.ground) {
      const cls = model.contactClasses[config.ground.contactClass ?? 'bone_on_ground'];
      const ground = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(0, config.ground.height - 0.5, 0),
      );
      this.groundCollider = world.createCollider(
        RAPIER.ColliderDesc.cuboid(50, 0.5, 50)
          .setFriction(cls?.friction ?? 0.8)
          .setRestitution(cls?.restitution ?? 0),
        ground,
      );
      this.segmentOfBody.set(ground.handle, -1);
    }

    for (const box of config.staticBoxes ?? []) {
      const cls = model.contactClasses[box.contactClass ?? 'bone_on_ground'];
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(box.position.x, box.position.y, box.position.z)
          .setRotation(box.rotation ?? { x: 0, y: 0, z: 0, w: 1 }),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(box.halfExtents.x, box.halfExtents.y, box.halfExtents.z)
          .setFriction(cls?.friction ?? 0.8)
          .setRestitution(cls?.restitution ?? 0),
        body,
      );
      this.segmentOfBody.set(body.handle, -1);
    }

    // State.
    this.q = new Float64Array(model.nq);
    this.qdot = new Float64Array(model.nv);
    this.commanded = new Float64Array(model.nv);
    this.realized = new Float64Array(model.nv);
    this.motors = model.dofs.map(() => null);
    this.recoverJointState();

    return {
      backend: this.id,
      notes,
      hasWarnings: notes.some((n) => n.severity !== 'info'),
      segments: model.segments.length,
      joints: model.joints.length,
      nv: model.nv,
    };
  }

  dispose(): void {
    this.disposeWorld();
    this.model = undefined;
  }

  private disposeWorld(): void {
    if (this.world) {
      this.world.free();
      this.world = undefined;
    }
    this.bodies = [];
    this.colliders = [];
    this.joints = [];
    this.grabs.clear();
  }

  // --- Stepping ---------------------------------------------------------------------------------

  step(substeps: number): void {
    const world = this.requireWorld();
    const dt = this.config?.dt ?? world.timestep;
    const n = Math.max(1, substeps | 0);
    world.timestep = dt / n;
    for (let s = 0; s < n; s++) {
      this.recoverJointState();
      this.applyGeneralizedForces();
      world.step(undefined, this.hooks);
      for (const body of this.bodies) {
        body.resetForces(false);
        body.resetTorques(false);
      }
    }
    world.timestep = dt;
    this.recoverJointState();
  }

  /** Recover q and qdot for every joint from the current body poses. */
  private recoverJointState(): void {
    const model = this.model;
    if (!model) return;
    const root = this.bodies[model.root];
    if (root) {
      const t = root.translation(this.v3);
      const r = root.rotation(this.quat);
      this.q[0] = t.x;
      this.q[1] = t.y;
      this.q[2] = t.z;
      this.q[3] = r.x;
      this.q[4] = r.y;
      this.q[5] = r.z;
      this.q[6] = r.w;
      const lv = root.linvel(this.v3);
      this.qdot[0] = lv.x;
      this.qdot[1] = lv.y;
      this.qdot[2] = lv.z;
      const av = root.angvel(this.v3);
      this.qdot[3] = av.x;
      this.qdot[4] = av.y;
      this.qdot[5] = av.z;
    }
    for (const joint of this.joints) {
      const c = joint.compiled;
      const parent = this.bodies[c.parentSegment];
      const child = this.bodies[c.childSegment];
      if (!parent || !child) continue;
      // Joint-parent frame orientation P = R_parent * R_fip; joint-child frame C = R_child * R_fic.
      const rp = parent.rotation(this.quat);
      const rc = child.rotation(this.quatB);
      const fip = c.frameInParent.rotation;
      const fic = c.frameInChild.rotation;
      // P = rp * fip
      const px = rp.w * fip.x + rp.x * fip.w + rp.y * fip.z - rp.z * fip.y;
      const py = rp.w * fip.y - rp.x * fip.z + rp.y * fip.w + rp.z * fip.x;
      const pz = rp.w * fip.z + rp.x * fip.y - rp.y * fip.x + rp.z * fip.w;
      const pw = rp.w * fip.w - rp.x * fip.x - rp.y * fip.y - rp.z * fip.z;
      // C = rc * fic
      const cx = rc.w * fic.x + rc.x * fic.w + rc.y * fic.z - rc.z * fic.y;
      const cy = rc.w * fic.y - rc.x * fic.z + rc.y * fic.w + rc.z * fic.x;
      const cz = rc.w * fic.z + rc.x * fic.y - rc.y * fic.x + rc.z * fic.w;
      const cw = rc.w * fic.w - rc.x * fic.x - rc.y * fic.y - rc.z * fic.z;
      // rel = conj(P) * C
      this.rel[0] = pw * cx - px * cw - py * cz + pz * cy;
      this.rel[1] = pw * cy + px * cz - py * cw - pz * cx;
      this.rel[2] = pw * cz - px * cy + py * cx - pz * cw;
      this.rel[3] = pw * cw + px * cx + py * cy + pz * cz;
      solveJointAngles(joint.solver, this.rel);
      for (let i = 0; i < joint.solver.n; i++) {
        this.q[ROOT_NQ + c.dofStart + i] = joint.solver.q[i] as number;
      }
      // Relative angular velocity in the joint-parent frame: conj(P) * (w_child - w_parent).
      const wp = parent.angvel(this.v3);
      const wx0 = wp.x;
      const wy0 = wp.y;
      const wz0 = wp.z;
      const wc = child.angvel(this.v3b);
      const dx = wc.x - wx0;
      const dy = wc.y - wy0;
      const dz = wc.z - wz0;
      // rotate by conj(P): q = (-px, -py, -pz, pw)
      const tx = 2 * (-py * dz + pz * dy);
      const ty = 2 * (-pz * dx + px * dz);
      const tz = 2 * (-px * dy + py * dx);
      const ox = dx + pw * tx + (-py * tz + pz * ty);
      const oy = dy + pw * ty + (-pz * tx + px * tz);
      const oz = dz + pw * tz + (-px * ty + py * tx);
      solveJointVelocities(joint.solver, ox, oy, oz, this.qdot, ROOT_NV + c.dofStart);
    }
  }

  /** Commanded forces plus emulated stops and motors, applied to the bodies for this substep. */
  private applyGeneralizedForces(): void {
    const model = this.model;
    if (!model) return;
    const root = this.bodies[model.root];
    if (root) {
      this.v3.x = this.commanded[0] as number;
      this.v3.y = this.commanded[1] as number;
      this.v3.z = this.commanded[2] as number;
      root.addForce(this.v3, true);
      this.v3.x = this.commanded[3] as number;
      this.v3.y = this.commanded[4] as number;
      this.v3.z = this.commanded[5] as number;
      root.addTorque(this.v3, true);
      for (let i = 0; i < ROOT_NV; i++) this.realized[i] = this.commanded[i] as number;
    }
    for (const joint of this.joints) {
      const c = joint.compiled;
      const parent = this.bodies[c.parentSegment];
      const child = this.bodies[c.childSegment];
      if (!parent || !child) continue;
      const rp = parent.rotation(this.quat);
      const fip = c.frameInParent.rotation;
      const px = rp.w * fip.x + rp.x * fip.w + rp.y * fip.z - rp.z * fip.y;
      const py = rp.w * fip.y - rp.x * fip.z + rp.y * fip.w + rp.z * fip.x;
      const pz = rp.w * fip.z + rp.x * fip.y - rp.y * fip.x + rp.z * fip.w;
      const pw = rp.w * fip.w - rp.x * fip.x - rp.y * fip.y - rp.z * fip.z;
      for (let i = 0; i < joint.solver.n; i++) {
        const g = ROOT_NV + c.dofStart + i;
        const dof = c.dofs[i];
        if (!dof) continue;
        const qi = joint.solver.q[i] as number;
        const qd = this.qdot[g] as number;
        let f = this.commanded[g] as number;
        // Emulated range stop: only where the native revolute limit does not already act.
        if (joint.solver.n > 1) {
          const k = joint.stopStiffness[i] as number;
          const d = joint.stopDamping[i] as number;
          // A spring beyond the stop, damped on the way out only. Damping the rebound too makes
          // stops sticky under load (the stairs and the hang fail plausibility); without the
          // passive module's own damping the rebound can accumulate, which is why a run without
          // the PassiveJointModule is a degenerate configuration (spec 7.3), not a supported one.
          if (qi < dof.range[0]) f += -k * (qi - dof.range[0]) - (qd < 0 ? d * qd : 0);
          else if (qi > dof.range[1]) f += -k * (qi - dof.range[1]) - (qd > 0 ? d * qd : 0);
        }
        const motor = this.motors[c.dofStart + i];
        if (motor) {
          let m = 0;
          if (motor.position !== undefined) m += motor.stiffness * (motor.position - qi);
          m += motor.damping * ((motor.velocity ?? 0) - qd);
          f += Math.max(-motor.maxForce, Math.min(motor.maxForce, m));
        }
        this.realized[g] = f;
        if (f === 0) continue;
        // World axis: P * jacobian column i.
        const jx = joint.solver.jacobian[3 * i] as number;
        const jy = joint.solver.jacobian[3 * i + 1] as number;
        const jz = joint.solver.jacobian[3 * i + 2] as number;
        const tx = 2 * (py * jz - pz * jy);
        const ty = 2 * (pz * jx - px * jz);
        const tz = 2 * (px * jy - py * jx);
        const ax = jx + pw * tx + (py * tz - pz * ty);
        const ay = jy + pw * ty + (pz * tx - px * tz);
        const az = jz + pw * tz + (px * ty - py * tx);
        this.v3.x = ax * f;
        this.v3.y = ay * f;
        this.v3.z = az * f;
        child.addTorque(this.v3, true);
        this.v3.x = -ax * f;
        this.v3.y = -ay * f;
        this.v3.z = -az * f;
        parent.addTorque(this.v3, true);
      }
    }
  }

  // --- Reads ------------------------------------------------------------------------------------

  readPose(out: PoseBuffer): void {
    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      if (!body) continue;
      const t = body.translation(this.v3);
      out.position[3 * i] = t.x;
      out.position[3 * i + 1] = t.y;
      out.position[3 * i + 2] = t.z;
      const r = body.rotation(this.quat);
      out.orientation[4 * i] = r.x;
      out.orientation[4 * i + 1] = r.y;
      out.orientation[4 * i + 2] = r.z;
      out.orientation[4 * i + 3] = r.w;
    }
  }

  readVelocity(out: VelocityBuffer): void {
    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      if (!body) continue;
      const lv = body.linvel(this.v3);
      out.linear[3 * i] = lv.x;
      out.linear[3 * i + 1] = lv.y;
      out.linear[3 * i + 2] = lv.z;
      const av = body.angvel(this.v3);
      out.angular[3 * i] = av.x;
      out.angular[3 * i + 1] = av.y;
      out.angular[3 * i + 2] = av.z;
    }
  }

  readJointState(out: JointStateBuffer): void {
    out.q.set(this.q);
    out.qdot.set(this.qdot);
    out.force.set(this.realized);
  }

  readContacts(out: ContactBuffer): number {
    const world = this.requireWorld();
    this.contactOut = out;
    this.contactCount = 0;
    for (let i = 0; i < this.colliders.length; i++) {
      const collider = this.colliders[i];
      if (!collider) continue;
      this.contactColliderIndex = i;
      world.contactPairsWith(collider, this.onPairCollider);
    }
    this.contactOut = undefined;
    return this.contactCount;
  }

  private collectPair(other: Collider): void {
    const world = this.world;
    const mine = this.colliders[this.contactColliderIndex];
    if (!world || !mine) return;
    // Each body pair is visited from both sides; keep the visit from the lower handle. The ground
    // has no index among the articulation's colliders and is always taken.
    const otherIndex = this.colliderHandles.indexOf(other.handle);
    if (otherIndex !== -1 && otherIndex < this.contactColliderIndex) return;
    const otherBody = other.parent();
    this.pendingOtherSegment = otherBody ? this.segmentOf(otherBody.handle) : -1;
    world.contactPair(mine, other, this.onManifold);
  }

  private collectManifold(manifold: TempContactManifold, flipped: boolean): void {
    const out = this.contactOut;
    const world = this.world;
    if (!out || !world) return;
    const mineSegment = this.colliderSegment[this.contactColliderIndex] ?? -1;
    // The other body's segment, or -1 for the ground and anything else outside the model.
    const otherSegment = this.pendingOtherSegment;
    const n = manifold.numSolverContacts();
    const normal = manifold.normal(this.v3);
    const sign = flipped ? -1 : 1;
    for (let i = 0; i < n; i++) {
      const slot = this.contactCount++;
      if (slot >= out.capacity) continue;
      const p = manifold.solverContactPoint(i, this.v3b);
      out.pair[2 * slot] = mineSegment;
      out.pair[2 * slot + 1] = otherSegment;
      out.point[3 * slot] = p?.x ?? 0;
      out.point[3 * slot + 1] = p?.y ?? 0;
      out.point[3 * slot + 2] = p?.z ?? 0;
      out.normal[3 * slot] = normal.x * sign;
      out.normal[3 * slot + 1] = normal.y * sign;
      out.normal[3 * slot + 2] = normal.z * sign;
      out.impulse[slot] = manifold.contactImpulse(Math.min(i, manifold.numContacts() - 1));
      out.depth[slot] = -manifold.solverContactDist(i);
    }
  }

  private pendingOtherSegment = -1;

  writeJointState(q: Float64Array, qdot: Float64Array): void {
    const model = this.model;
    if (!model) throw new Error('No compiled model.');
    const n = model.segments.length;
    // allocation-ok: a restore is a session event, not a step.
    const state = {
      position: new Float64Array(3 * n),
      orientation: new Float64Array(4 * n),
      linear: new Float64Array(3 * n),
      angular: new Float64Array(3 * n),
    };
    forwardKinematics(model, q, qdot, state);
    for (let i = 0; i < n; i++) {
      const body = this.bodies[i];
      if (!body) continue;
      this.v3.x = state.position[3 * i] as number;
      this.v3.y = state.position[3 * i + 1] as number;
      this.v3.z = state.position[3 * i + 2] as number;
      body.setTranslation(this.v3, true);
      this.quat.x = state.orientation[4 * i] as number;
      this.quat.y = state.orientation[4 * i + 1] as number;
      this.quat.z = state.orientation[4 * i + 2] as number;
      this.quat.w = state.orientation[4 * i + 3] as number;
      body.setRotation(this.quat, true);
      this.v3.x = state.linear[3 * i] as number;
      this.v3.y = state.linear[3 * i + 1] as number;
      this.v3.z = state.linear[3 * i + 2] as number;
      body.setLinvel(this.v3, true);
      this.v3.x = state.angular[3 * i] as number;
      this.v3.y = state.angular[3 * i + 1] as number;
      this.v3.z = state.angular[3 * i + 2] as number;
      body.setAngvel(this.v3, true);
    }
    // Warm-start the angle solver at the coordinates just written, then recover the rest.
    for (const joint of this.joints) {
      for (let i = 0; i < joint.solver.n; i++) {
        joint.solver.q[i] = q[ROOT_NQ + joint.compiled.dofStart + i] as number;
      }
    }
    this.recoverJointState();
  }

  // --- Actuation --------------------------------------------------------------------------------

  applyGeneralizedForce(dofForces: Float64Array): void {
    const n = Math.min(dofForces.length, this.commanded.length);
    for (let i = 0; i < n; i++) this.commanded[i] = dofForces[i] as number;
  }

  setJointMotorTarget(dofIndex: number, target: MotorTarget | null): void {
    if (dofIndex < 0 || dofIndex >= this.motors.length) {
      throw new RangeError(`DoF index ${dofIndex} is out of range (${this.motors.length} DoFs).`);
    }
    this.motors[dofIndex] = target;
  }

  applyBodyWrench(segmentIndex: number, force: Vec3, torque: Vec3, point?: Vec3): void {
    const body = this.requireBody(segmentIndex);
    this.v3.x = force.x;
    this.v3.y = force.y;
    this.v3.z = force.z;
    if (point) {
      this.v3b.x = point.x;
      this.v3b.y = point.y;
      this.v3b.z = point.z;
      body.addForceAtPoint(this.v3, this.v3b, true);
    } else {
      body.addForce(this.v3, true);
    }
    this.v3.x = torque.x;
    this.v3.y = torque.y;
    this.v3.z = torque.z;
    body.addTorque(this.v3, true);
  }

  // --- Direct manipulation ----------------------------------------------------------------------

  setGroundCollision(enabled: boolean): void {
    const collider = this.groundCollider;
    if (!collider) return;
    // An empty membership takes the ground out of every pair; the collider itself stays put.
    collider.setCollisionGroups(enabled ? 0xffffffff : 0);
  }

  setGravity(gravity: Vec3): void {
    const world = this.requireWorld();
    world.gravity = new RAPIER.Vector3(gravity.x, gravity.y, gravity.z);
  }

  setKinematic(segmentIndex: number, enabled: boolean): void {
    const body = this.requireBody(segmentIndex);
    body.setBodyType(
      enabled ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic,
      true,
    );
  }

  setPose(segmentIndex: number, transform: Transform): void {
    const body = this.requireBody(segmentIndex);
    this.v3.x = transform.translation.x;
    this.v3.y = transform.translation.y;
    this.v3.z = transform.translation.z;
    this.quat.x = transform.rotation.x;
    this.quat.y = transform.rotation.y;
    this.quat.z = transform.rotation.z;
    this.quat.w = transform.rotation.w;
    if (body.isKinematic()) {
      body.setNextKinematicTranslation(this.v3);
      body.setNextKinematicRotation(this.quat);
    } else {
      body.setTranslation(this.v3, true);
      body.setRotation(this.quat, true);
    }
  }

  createGrabConstraint(
    segmentIndex: number,
    localPoint: Vec3,
    worldTarget: Vec3,
    strength = 1,
  ): GrabHandle {
    const world = this.requireWorld();
    const body = this.requireBody(segmentIndex);
    const handleBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        worldTarget.x,
        worldTarget.y,
        worldTarget.z,
      ),
    );
    const total = this.model?.totalMass ?? body.mass();
    const stiffness =
      (strength * GRAB_FORCE_FRACTION * total * STANDARD_GRAVITY_MAGNITUDE) / GRAB_LEASH;
    // Critically damped for an eighth of the body, which is about what a limb chain weighs.
    const damping = 2 * Math.sqrt(stiffness * Math.max(body.mass(), total / 8));
    const joint = world.createImpulseJoint(
      RAPIER.JointData.spring(0, stiffness, damping, localPoint, vec3(0, 0, 0)),
      body,
      handleBody,
      true,
    );
    const grab = new RapierGrab(this, handleBody.handle, joint.handle);
    this.grabs.add(grab);
    return grab;
  }

  /** @internal */
  moveGrab(grab: RapierGrab, target: Vec3): void {
    const world = this.world;
    if (!world || !this.grabs.has(grab)) return;
    this.v3.x = target.x;
    this.v3.y = target.y;
    this.v3.z = target.z;
    world.getRigidBody(grab.bodyHandle).setNextKinematicTranslation(this.v3);
  }

  /** @internal */
  releaseGrab(grab: RapierGrab): void {
    const world = this.world;
    if (!world || !this.grabs.delete(grab)) return;
    world.removeImpulseJoint(world.getImpulseJoint(grab.jointHandle), true);
    world.removeRigidBody(world.getRigidBody(grab.bodyHandle));
  }

  // --- Determinism ------------------------------------------------------------------------------

  /**
   * Rapier's world bytes followed by the backend's own state: the joint solvers' warm-start
   * coordinates, the commanded forces, and the recovered q and qdot. All of it feeds the next
   * step, and none of it is re-derived on restore: re-running the solver would take extra
   * iterations the original trajectory never took, and the emulated stops would then differ by
   * a few ulps, and after that by everything.
   */
  snapshot(): Uint8Array {
    const world = this.requireWorld().takeSnapshot();
    const extra = new Float64Array(this.extraWords());
    let k = 0;
    for (const joint of this.joints) {
      for (let i = 0; i < joint.solver.n; i++) extra[k++] = joint.solver.q[i] as number;
    }
    extra.set(this.commanded, k);
    k += this.commanded.length;
    extra.set(this.q, k);
    k += this.q.length;
    extra.set(this.qdot, k);
    const out = new Uint8Array(4 + world.byteLength + extra.byteLength);
    new DataView(out.buffer).setUint32(0, world.byteLength, true);
    out.set(world, 4);
    out.set(new Uint8Array(extra.buffer), 4 + world.byteLength);
    return out;
  }

  restore(snapshot: Uint8Array): void {
    const model = this.model;
    const config = this.config;
    if (!model || !config) throw new Error('RapierBackend.restore called before compile.');
    const worldLength = new DataView(snapshot.buffer, snapshot.byteOffset).getUint32(0, true);
    const worldBytes = snapshot.subarray(4, 4 + worldLength);
    const extraBytes = snapshot.slice(4 + worldLength);
    const extra = new Float64Array(
      extraBytes.buffer,
      extraBytes.byteOffset,
      extraBytes.byteLength / 8,
    );
    if (extra.length !== this.extraWords()) {
      throw new Error('Snapshot does not belong to this compiled articulation.');
    }
    // A live grab's handle body and spring are inside the snapshot; the JS handles would dangle.
    for (const grab of [...this.grabs]) grab.release();
    this.world?.free();
    const world = RAPIER.World.restoreSnapshot(worldBytes);
    world.timestep = config.dt;
    this.configureWorld(world, config);
    this.world = world;
    this.bodies = this.bodyHandles.map((h) => world.getRigidBody(h));
    this.colliders = this.colliderHandles.map((h) => world.getCollider(h));
    let k = 0;
    for (const joint of this.joints) {
      for (let i = 0; i < joint.solver.n; i++) joint.solver.q[i] = extra[k++] as number;
    }
    this.commanded.set(extra.subarray(k, k + this.commanded.length));
    k += this.commanded.length;
    this.q.set(extra.subarray(k, k + this.q.length));
    k += this.q.length;
    this.qdot.set(extra.subarray(k, k + this.qdot.length));
  }

  private extraWords(): number {
    return this.solverWords() + this.commanded.length + this.q.length + this.qdot.length;
  }

  private solverWords(): number {
    let n = 0;
    for (const joint of this.joints) n += joint.solver.n;
    return n;
  }

  // --- Helpers ----------------------------------------------------------------------------------

  private requireWorld(): World {
    if (!this.world) throw new Error('RapierBackend has no compiled world.');
    return this.world;
  }

  private requireBody(segmentIndex: number): RigidBody {
    const body = this.bodies[segmentIndex];
    if (!body) throw new RangeError(`Segment index ${segmentIndex} has no body.`);
    return body;
  }

  /** Segment index of a Rapier body, or -1 for the ground and other foreign bodies. */
  segmentOf(handle: RigidBodyHandle): number {
    return this.segmentOfBody.get(handle) ?? -1;
  }
}

/** Rapier's angular joint axes, numbered as its `JointAxis` enum: AngX = 3, AngY = 4, AngZ = 5. */
type RawAxis = Parameters<World['impulseJoints']['raw']['jointSetLimits']>[1];
const ANG_X = RAPIER.JointAxis.AngX as unknown as RawAxis;
const ANG_Y = RAPIER.JointAxis.AngY as unknown as RawAxis;
const ANG_Z = RAPIER.JointAxis.AngZ as unknown as RawAxis;

/** The Rapier axis a unit vector lies on, with its sign, or undefined when it is oblique. */
function canonicalAxis(v: Vec3): [RawAxis, 1 | -1] | undefined {
  const tolerance = 1e-6;
  if (Math.abs(Math.abs(v.x) - 1) < tolerance) return [ANG_X, v.x > 0 ? 1 : -1];
  if (Math.abs(Math.abs(v.y) - 1) < tolerance) return [ANG_Y, v.y > 0 ? 1 : -1];
  if (Math.abs(Math.abs(v.z) - 1) < tolerance) return [ANG_Z, v.z > 0 ? 1 : -1];
  return undefined;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
