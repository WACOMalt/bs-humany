/**
 * The MuJoCo backend -- milestone M3.15.
 *
 * ADR-003: the accuracy backend. MuJoCo is reduced-coordinate, so joints are satisfied
 * structurally rather than iteratively, limits and equality constraints are native, and the
 * generalized coordinates are the simulation state rather than something recovered from body
 * poses. The compiled articulation becomes MJCF (`emitMjcf`), so what MuJoCo runs is exactly what
 * the emitter round-trip test checks.
 *
 * What is emulated here, declared per spec section 9.3:
 *   - **Motors** are PD torques in generalized coordinates, like the Rapier backend's, so a
 *     motor target means the same thing on both.
 *   - **Grabs** are springs applied as body wrenches at the held point.
 *   - **Per-DoF passive terms** are deliberately not emitted: the PassiveJointModule applies them
 *     identically on both backends (spec section 7.3), and doing so natively as well would count
 *     them twice.
 *   - **Kinematic switching and non-root pose setting** are unsupported: MuJoCo has no per-body
 *     dynamic/kinematic toggle without declaring mocap bodies at compile, and a segment's pose is
 *     not free in reduced coordinates. Both throw rather than approximate.
 *
 * Conventions bridged: MuJoCo quaternions are w x y z; a free joint's rotational velocity and
 * generalized force are in the body's local frame; `cvel` is a spatial velocity at the tree's
 * subtree centre of mass, so the linear velocity at a body's centre of mass is recovered from it.
 */

import type {
  BackendCapabilities,
  BackendConfig,
  CompileNote,
  CompileReport,
  CompiledArticulation,
  ContactBuffer,
  GrabHandle,
  IPhysicsBackend,
  JointStateBuffer,
  MotorTarget,
  PoseBuffer,
  VelocityBuffer,
} from '@bs-humany/compiler';
import { ROOT_NQ, ROOT_NV, emitMjcf } from '@bs-humany/compiler';
import type { Transform, Vec3 } from '@bs-humany/frames';
import type { MainModule, MjData, MjModel } from '@mujoco/mujoco';
import loadMujoco from '@mujoco/mujoco';

/** Grab spring sizing, shared with the Rapier backend by value: same leash, same force fraction. */
export const GRAB_LEASH = 0.3;
export const GRAB_FORCE_FRACTION = 0.8;
/**
 * The rotational spring's sizing: the linear stiffness acting at this lever, and a hand's worth
 * of angle it may lead by before the torque stops growing -- a twist beyond that is a twist the
 * body is refusing, and the spring is not there to win.
 */
export const GRAB_LEVER = 0.1;
export const GRAB_ANGULAR_LEASH = 1.0;
const STANDARD_GRAVITY_MAGNITUDE = 9.80665;
const OBJ_BODY = 1;
const OBJ_GEOM = 5;
const OBJ_JOINT = 3;

const CAPABILITIES: BackendCapabilities = {
  reducedCoordinate: true,
  equalityConstraints: 'native',
  softJointLimits: 'native',
  perDofStiffnessDamping: 'emulated',
  tendons: 'native',
  muscleActuators: 'native',
  deterministicAcrossPlatforms: true,
  maxRecommendedBodies: 200,
  realizedDofForce: 'native',
};

interface Grab {
  readonly segment: number;
  readonly local: Vec3;
  readonly target: { x: number; y: number; z: number };
  readonly stiffness: number;
  readonly damping: number;
  /** World orientation to hold the segment toward, or null for a point grab. */
  readonly orientation: { x: number; y: number; z: number; w: number };
  holdsOrientation: boolean;
  readonly angularStiffness: number;
  readonly angularDamping: number;
}

class MujocoGrab implements GrabHandle {
  constructor(
    private readonly backend: MujocoBackend,
    readonly grab: Grab,
  ) {}
  setTarget(world: Vec3): void {
    this.grab.target.x = world.x;
    this.grab.target.y = world.y;
    this.grab.target.z = world.z;
  }
  setTargetOrientation(world: { x: number; y: number; z: number; w: number } | null): void {
    this.grab.holdsOrientation = world !== null;
    if (world) {
      this.grab.orientation.x = world.x;
      this.grab.orientation.y = world.y;
      this.grab.orientation.z = world.z;
      this.grab.orientation.w = world.w;
    }
  }
  release(): void {
    this.backend.releaseGrab(this);
  }
}

/** Live typed-array views over a data's fields; refreshed whenever the heap may have moved. */
interface DataViews {
  qpos: Float64Array;
  qvel: Float64Array;
  qacc_warmstart: Float64Array;
  qfrc_applied: Float64Array;
  qfrc_constraint: Float64Array;
  qfrc_passive: Float64Array;
  xfrc_applied: Float64Array;
  xpos: Float64Array;
  xquat: Float64Array;
  xipos: Float64Array;
  cvel: Float64Array;
  subtree_com: Float64Array;
  efc_force: Float64Array;
}

export class MujocoBackend implements IPhysicsBackend {
  readonly id = 'mujoco' as const;
  readonly capabilities = CAPABILITIES;

  private mujoco: MainModule | undefined;
  private config: BackendConfig | undefined;
  private model: CompiledArticulation | undefined;
  private mjModel: MjModel | undefined;
  private mjData: MjData | undefined;
  private views: DataViews | undefined;
  /** MuJoCo body id per segment. */
  private bodyOf = new Int32Array(0);
  /** Segment per MuJoCo body, -1 for the world and joint-frame bodies. */
  private segmentOfBody = new Int32Array(0);
  private geomBody = new Int32Array(0);
  private bodyRoot = new Int32Array(0);
  /** MuJoCo dof and qpos addresses per articulation DoF. */
  private dofAdr = new Int32Array(0);
  private qposAdr = new Int32Array(0);
  private commanded = new Float64Array(0);
  private realized = new Float64Array(0);
  private motors: (MotorTarget | null)[] = [];
  private wrench = new Float64Array(0);
  private grabs = new Set<MujocoGrab>();
  private substepTimestep = 0;

  async init(config: BackendConfig): Promise<void> {
    this.mujoco = await loadMujoco();
    this.config = config;
  }

  async compile(model: CompiledArticulation): Promise<CompileReport> {
    const mujoco = this.mujoco;
    const config = this.config;
    if (!mujoco || !config) throw new Error('MujocoBackend.compile called before init.');
    this.disposeModel();
    const notes: CompileNote[] = [];
    const emitted = emitMjcf(model, {
      ground: config.ground,
      staticBoxes: config.staticBoxes,
      timestep: config.dt,
      passive: 'module',
    });
    notes.push(...emitted.notes);
    let mjModel: MjModel;
    try {
      mjModel = mujoco.MjModel.from_xml_string(emitted.xml);
    } catch (error) {
      throw new Error(
        `MuJoCo rejected the emitted MJCF: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (config.gravity) {
      const g = mjModel.opt.gravity as Float64Array;
      g[0] = config.gravity.x;
      g[1] = config.gravity.y;
      g[2] = config.gravity.z;
    }
    const mjData = new mujoco.MjData(mjModel);
    this.mjModel = mjModel;
    this.mjData = mjData;
    this.model = model;
    this.substepTimestep = config.dt;

    // Name resolution, once.
    this.bodyOf = new Int32Array(model.segments.length);
    this.segmentOfBody = new Int32Array(mjModel.nbody).fill(-1);
    model.segments.forEach((s, i) => {
      const id = mujoco.mj_name2id(mjModel, OBJ_BODY, s.id);
      if (id < 0) throw new Error(`MuJoCo model has no body '${s.id}'.`);
      this.bodyOf[i] = id;
      this.segmentOfBody[id] = i;
    });
    this.geomBody = Int32Array.from(mjModel.geom_bodyid as Int32Array);
    this.bodyRoot = Int32Array.from(mjModel.body_rootid as Int32Array);
    const jntDofAdr = mjModel.jnt_dofadr as Int32Array;
    const jntQposAdr = mjModel.jnt_qposadr as Int32Array;
    this.dofAdr = new Int32Array(model.dofs.length);
    this.qposAdr = new Int32Array(model.dofs.length);
    emitted.jointNames.forEach((name, i) => {
      const jid = mujoco.mj_name2id(mjModel, OBJ_JOINT, name);
      if (jid < 0) throw new Error(`MuJoCo model has no joint '${name}'.`);
      this.dofAdr[i] = jntDofAdr[jid] as number;
      this.qposAdr[i] = jntQposAdr[jid] as number;
    });
    if (mjModel.nv !== model.nv || mjModel.nq !== model.nq) {
      throw new Error(
        `MuJoCo model has nq=${mjModel.nq}, nv=${mjModel.nv}; the articulation has ` +
          `nq=${model.nq}, nv=${model.nv}.`,
      );
    }

    this.commanded = new Float64Array(model.nv);
    this.realized = new Float64Array(model.nv);
    this.motors = model.dofs.map(() => null);
    this.wrench = new Float64Array(6 * model.segments.length);
    this.grabs.clear();
    this.refreshViews();
    mujoco.mj_forward(mjModel, mjData);

    notes.push({
      severity: 'info',
      feature: 'motors',
      message: 'Joint motors are PD torques in generalized coordinates, as on the Rapier backend.',
    });
    notes.push({
      severity: 'info',
      feature: 'kinematic',
      message:
        'setKinematic and non-root setPose are unsupported on the MuJoCo backend and throw; ' +
        'mocap bodies would need declaring at compile.',
    });
    return {
      backend: this.id,
      notes,
      hasWarnings: notes.some((n) => n.severity !== 'info'),
      segments: model.segments.length,
      joints: model.joints.length,
      nv: model.nv,
    };
  }

  private refreshViews(): void {
    const d = this.mjData;
    if (!d) return;
    // Each property access builds a fresh view over the WASM heap; hold one set and refresh it
    // only when the heap may have moved.
    this.views = {
      qpos: d.qpos as Float64Array,
      qvel: d.qvel as Float64Array,
      qacc_warmstart: d.qacc_warmstart as Float64Array,
      qfrc_applied: d.qfrc_applied as Float64Array,
      qfrc_constraint: d.qfrc_constraint as Float64Array,
      qfrc_passive: d.qfrc_passive as Float64Array,
      xfrc_applied: d.xfrc_applied as Float64Array,
      xpos: d.xpos as Float64Array,
      xquat: d.xquat as Float64Array,
      xipos: d.xipos as Float64Array,
      cvel: d.cvel as Float64Array,
      subtree_com: d.subtree_com as Float64Array,
      efc_force: d.efc_force as Float64Array,
    };
  }

  private live(): DataViews {
    const v = this.views;
    if (!v || v.qpos.buffer.byteLength === 0) {
      this.refreshViews();
      if (!this.views) throw new Error('MujocoBackend has no compiled model.');
      return this.views;
    }
    return v;
  }

  dispose(): void {
    this.disposeModel();
    this.model = undefined;
  }

  private disposeModel(): void {
    this.mjData?.delete();
    this.mjModel?.delete();
    this.mjData = undefined;
    this.mjModel = undefined;
    this.views = undefined;
    this.grabs.clear();
  }

  // --- Stepping ---------------------------------------------------------------------------------

  step(substeps: number): void {
    const mujoco = this.mujoco;
    const mjModel = this.mjModel;
    const mjData = this.mjData;
    const model = this.model;
    const config = this.config;
    if (!mujoco || !mjModel || !mjData || !model || !config) {
      throw new Error('No compiled model.'); // allocation-ok: error path, never taken at step rate
    }
    const n = Math.max(1, substeps | 0);
    const dt = config.dt / n;
    if (dt !== this.substepTimestep) {
      mjModel.opt.timestep = dt;
      this.substepTimestep = dt;
    }
    for (let s = 0; s < n; s++) {
      this.applyForces();
      mujoco.mj_step(mjModel, mjData);
    }
    // mj_step integrates after computing poses, so xpos and cvel describe the state before the
    // last integration. Bring the derived quantities up to the integrated qpos; contacts and
    // efc_force stay those of the last solve, which is what the step's impulses were.
    mujoco.mj_kinematics(mjModel, mjData);
    mujoco.mj_comPos(mjModel, mjData);
    mujoco.mj_comVel(mjModel, mjData);
    // efc_force after the step belongs to the last substep; leave the applied forces in place
    // for the realized readout, they are rewritten next step.
    this.wrench.fill(0);
  }

  /** Commanded generalized forces, emulated motors, grab springs and body wrenches. */
  private applyForces(): void {
    const model = this.model;
    const v = this.live();
    if (!model) return;
    const qfrc = v.qfrc_applied;
    const xfrc = v.xfrc_applied;
    // Root: linear force in world, torque rotated into the root body frame.
    const rootBody = this.bodyOf[model.root] as number;
    const qw = v.xquat[4 * rootBody] as number;
    const qx = v.xquat[4 * rootBody + 1] as number;
    const qy = v.xquat[4 * rootBody + 2] as number;
    const qz = v.xquat[4 * rootBody + 3] as number;
    qfrc[0] = this.commanded[0] as number;
    qfrc[1] = this.commanded[1] as number;
    qfrc[2] = this.commanded[2] as number;
    const tx = this.commanded[3] as number;
    const ty = this.commanded[4] as number;
    const tz = this.commanded[5] as number;
    // conj(q) * t
    const cx = -qx;
    const cy = -qy;
    const cz = -qz;
    const ux = 2 * (cy * tz - cz * ty);
    const uy = 2 * (cz * tx - cx * tz);
    const uz = 2 * (cx * ty - cy * tx);
    qfrc[3] = tx + qw * ux + (cy * uz - cz * uy);
    qfrc[4] = ty + qw * uy + (cz * ux - cx * uz);
    qfrc[5] = tz + qw * uz + (cx * uy - cy * ux);
    for (let i = 0; i < ROOT_NV; i++) this.realized[i] = this.commanded[i] as number;

    for (let i = 0; i < model.dofs.length; i++) {
      const g = ROOT_NV + i;
      let f = this.commanded[g] as number;
      const motor = this.motors[i];
      if (motor) {
        const q = v.qpos[this.qposAdr[i] as number] as number;
        const qd = v.qvel[this.dofAdr[i] as number] as number;
        let m = 0;
        if (motor.position !== undefined) m += motor.stiffness * (motor.position - q);
        m += motor.damping * ((motor.velocity ?? 0) - qd);
        f += Math.max(-motor.maxForce, Math.min(motor.maxForce, m));
      }
      qfrc[this.dofAdr[i] as number] = f;
      this.realized[g] = f;
    }

    // Body wrenches: pending user wrenches plus grab springs, at the body's centre of mass.
    xfrc.fill(0);
    for (let s = 0; s < model.segments.length; s++) {
      const b = this.bodyOf[s] as number;
      for (let k = 0; k < 6; k++) xfrc[6 * b + k] = this.wrench[6 * s + k] as number;
    }
    for (const handle of this.grabs) {
      const grab = handle.grab;
      const b = this.bodyOf[grab.segment] as number;
      // Held point in world.
      const bw = v.xquat[4 * b] as number;
      const bx = v.xquat[4 * b + 1] as number;
      const by = v.xquat[4 * b + 2] as number;
      const bz = v.xquat[4 * b + 3] as number;
      const lx = grab.local.x;
      const ly = grab.local.y;
      const lz = grab.local.z;
      const rx = 2 * (by * lz - bz * ly);
      const ry = 2 * (bz * lx - bx * lz);
      const rz = 2 * (bx * ly - by * lx);
      const px = (v.xpos[3 * b] as number) + lx + bw * rx + (by * rz - bz * ry);
      const py = (v.xpos[3 * b + 1] as number) + ly + bw * ry + (bz * rx - bx * rz);
      const pz = (v.xpos[3 * b + 2] as number) + lz + bw * rz + (bx * ry - by * rx);
      // Velocity of the held point from the body's spatial velocity.
      const root = this.bodyRoot[b] as number;
      const ox = v.cvel[6 * b] as number;
      const oy = v.cvel[6 * b + 1] as number;
      const oz = v.cvel[6 * b + 2] as number;
      const dx = px - (v.subtree_com[3 * root] as number);
      const dy = py - (v.subtree_com[3 * root + 1] as number);
      const dz = pz - (v.subtree_com[3 * root + 2] as number);
      const vx = (v.cvel[6 * b + 3] as number) + (oy * dz - oz * dy);
      const vy = (v.cvel[6 * b + 4] as number) + (oz * dx - ox * dz);
      const vz = (v.cvel[6 * b + 5] as number) + (ox * dy - oy * dx);
      const fx = grab.stiffness * (grab.target.x - px) - grab.damping * vx;
      const fy = grab.stiffness * (grab.target.y - py) - grab.damping * vy;
      const fz = grab.stiffness * (grab.target.z - pz) - grab.damping * vz;
      // Force at the point equals force at the CoM plus its moment about the CoM.
      const ax = px - (v.xipos[3 * b] as number);
      const ay = py - (v.xipos[3 * b + 1] as number);
      const az = pz - (v.xipos[3 * b + 2] as number);
      xfrc[6 * b] = (xfrc[6 * b] as number) + fx;
      xfrc[6 * b + 1] = (xfrc[6 * b + 1] as number) + fy;
      xfrc[6 * b + 2] = (xfrc[6 * b + 2] as number) + fz;
      xfrc[6 * b + 3] = (xfrc[6 * b + 3] as number) + (ay * fz - az * fy);
      xfrc[6 * b + 4] = (xfrc[6 * b + 4] as number) + (az * fx - ax * fz);
      xfrc[6 * b + 5] = (xfrc[6 * b + 5] as number) + (ax * fy - ay * fx);
      if (grab.holdsOrientation) {
        // The rotation still to make: target * conj(current), as an axis times an angle, leashed.
        const t = grab.orientation;
        // conj(current) is (bw, -bx, -by, -bz); product q = t * conj(current).
        const qw = t.w * bw + t.x * bx + t.y * by + t.z * bz;
        let qx = -t.w * bx + t.x * bw - t.y * bz + t.z * by;
        let qy = -t.w * by + t.x * bz + t.y * bw - t.z * bx;
        let qz = -t.w * bz - t.x * by + t.y * bx + t.z * bw;
        // The shorter way round.
        const sign = qw < 0 ? -1 : 1;
        qx *= sign;
        qy *= sign;
        qz *= sign;
        const sinHalf = Math.hypot(qx, qy, qz);
        const angle = 2 * Math.atan2(sinHalf, Math.abs(qw));
        if (sinHalf > 1e-9) {
          const lead = Math.min(angle, GRAB_ANGULAR_LEASH) / sinHalf;
          const tx = grab.angularStiffness * qx * lead - grab.angularDamping * ox;
          const ty = grab.angularStiffness * qy * lead - grab.angularDamping * oy;
          const tz = grab.angularStiffness * qz * lead - grab.angularDamping * oz;
          xfrc[6 * b + 3] = (xfrc[6 * b + 3] as number) + tx;
          xfrc[6 * b + 4] = (xfrc[6 * b + 4] as number) + ty;
          xfrc[6 * b + 5] = (xfrc[6 * b + 5] as number) + tz;
        } else {
          xfrc[6 * b + 3] = (xfrc[6 * b + 3] as number) - grab.angularDamping * ox;
          xfrc[6 * b + 4] = (xfrc[6 * b + 4] as number) - grab.angularDamping * oy;
          xfrc[6 * b + 5] = (xfrc[6 * b + 5] as number) - grab.angularDamping * oz;
        }
      }
    }
  }

  // --- Reads ------------------------------------------------------------------------------------

  readPose(out: PoseBuffer): void {
    const v = this.live();
    const n = this.bodyOf.length;
    for (let i = 0; i < n; i++) {
      const b = this.bodyOf[i] as number;
      out.position[3 * i] = v.xpos[3 * b] as number;
      out.position[3 * i + 1] = v.xpos[3 * b + 1] as number;
      out.position[3 * i + 2] = v.xpos[3 * b + 2] as number;
      out.orientation[4 * i] = v.xquat[4 * b + 1] as number;
      out.orientation[4 * i + 1] = v.xquat[4 * b + 2] as number;
      out.orientation[4 * i + 2] = v.xquat[4 * b + 3] as number;
      out.orientation[4 * i + 3] = v.xquat[4 * b] as number;
    }
  }

  readVelocity(out: VelocityBuffer): void {
    const v = this.live();
    const n = this.bodyOf.length;
    for (let i = 0; i < n; i++) {
      const b = this.bodyOf[i] as number;
      const root = this.bodyRoot[b] as number;
      const ox = v.cvel[6 * b] as number;
      const oy = v.cvel[6 * b + 1] as number;
      const oz = v.cvel[6 * b + 2] as number;
      // cvel's linear part is at the subtree centre of mass; move it to the body's own CoM.
      const dx = (v.xipos[3 * b] as number) - (v.subtree_com[3 * root] as number);
      const dy = (v.xipos[3 * b + 1] as number) - (v.subtree_com[3 * root + 1] as number);
      const dz = (v.xipos[3 * b + 2] as number) - (v.subtree_com[3 * root + 2] as number);
      out.angular[3 * i] = ox;
      out.angular[3 * i + 1] = oy;
      out.angular[3 * i + 2] = oz;
      out.linear[3 * i] = (v.cvel[6 * b + 3] as number) + (oy * dz - oz * dy);
      out.linear[3 * i + 1] = (v.cvel[6 * b + 4] as number) + (oz * dx - ox * dz);
      out.linear[3 * i + 2] = (v.cvel[6 * b + 5] as number) + (ox * dy - oy * dx);
    }
  }

  readJointState(out: JointStateBuffer): void {
    const v = this.live();
    const model = this.model;
    if (!model) return;
    // Root: position, then quaternion reordered to x y z w.
    out.q[0] = v.qpos[0] as number;
    out.q[1] = v.qpos[1] as number;
    out.q[2] = v.qpos[2] as number;
    out.q[3] = v.qpos[4] as number;
    out.q[4] = v.qpos[5] as number;
    out.q[5] = v.qpos[6] as number;
    out.q[6] = v.qpos[3] as number;
    out.qdot[0] = v.qvel[0] as number;
    out.qdot[1] = v.qvel[1] as number;
    out.qdot[2] = v.qvel[2] as number;
    // Angular velocity from the body frame to world: q * w.
    const qw = v.qpos[3] as number;
    const qx = v.qpos[4] as number;
    const qy = v.qpos[5] as number;
    const qz = v.qpos[6] as number;
    const wx = v.qvel[3] as number;
    const wy = v.qvel[4] as number;
    const wz = v.qvel[5] as number;
    const tx = 2 * (qy * wz - qz * wy);
    const ty = 2 * (qz * wx - qx * wz);
    const tz = 2 * (qx * wy - qy * wx);
    out.qdot[3] = wx + qw * tx + (qy * tz - qz * ty);
    out.qdot[4] = wy + qw * ty + (qz * tx - qx * tz);
    out.qdot[5] = wz + qw * tz + (qx * ty - qy * tx);
    for (let i = 0; i < ROOT_NV; i++) {
      out.force[i] =
        (v.qfrc_applied[i] as number) +
        (v.qfrc_constraint[i] as number) +
        (v.qfrc_passive[i] as number);
    }
    for (let i = 0; i < model.dofs.length; i++) {
      const qa = this.qposAdr[i] as number;
      const da = this.dofAdr[i] as number;
      out.q[ROOT_NQ + i] = v.qpos[qa] as number;
      out.qdot[ROOT_NV + i] = v.qvel[da] as number;
      out.force[ROOT_NV + i] =
        (v.qfrc_applied[da] as number) +
        (v.qfrc_constraint[da] as number) +
        (v.qfrc_passive[da] as number);
    }
  }

  readContacts(out: ContactBuffer): number {
    const mjData = this.mjData;
    const config = this.config;
    if (!mjData || !config) return 0;
    const v = this.live();
    const n = mjData.ncon;
    const contacts = mjData.contact;
    for (let i = 0; i < n; i++) {
      if (i >= out.capacity) break;
      // allocation-ok: the bindings hand out a handle per contact; there is no indexed view.
      const c = contacts.get(i);
      if (!c) continue;
      const b1 = this.geomBody[c.geom1] as number;
      const b2 = this.geomBody[c.geom2] as number;
      let first = this.segmentOfBody[b1] ?? -1;
      let second = this.segmentOfBody[b2] ?? -1;
      // A segment comes first and the foreign body (the ground) second, as on every backend;
      // the normal points from the first toward the second.
      let sign = 1;
      if (first === -1 && second !== -1) {
        first = second;
        second = -1;
        sign = -1;
      }
      out.pair[2 * i] = first;
      out.pair[2 * i + 1] = second;
      const pos = c.pos as Float64Array;
      const frame = c.frame as Float64Array;
      out.point[3 * i] = pos[0] as number;
      out.point[3 * i + 1] = pos[1] as number;
      out.point[3 * i + 2] = pos[2] as number;
      out.normal[3 * i] = (frame[0] as number) * sign;
      out.normal[3 * i + 1] = (frame[1] as number) * sign;
      out.normal[3 * i + 2] = (frame[2] as number) * sign;
      // The first constraint row of a contact is its normal force.
      const force = c.efc_address >= 0 ? (v.efc_force[c.efc_address] as number) : 0;
      out.impulse[i] = force * this.substepTimestep;
      out.depth[i] = -c.dist;
      (c as { delete?: () => void }).delete?.();
    }
    return n;
  }

  writeJointState(q: Float64Array, qdot: Float64Array): void {
    const model = this.model;
    const mujoco = this.mujoco;
    const mjModel = this.mjModel;
    const mjData = this.mjData;
    if (!model || !mujoco || !mjModel || !mjData) throw new Error('No compiled model.');
    const v = this.live();
    v.qpos[0] = q[0] as number;
    v.qpos[1] = q[1] as number;
    v.qpos[2] = q[2] as number;
    // x y z w -> w x y z
    v.qpos[3] = q[6] as number;
    v.qpos[4] = q[3] as number;
    v.qpos[5] = q[4] as number;
    v.qpos[6] = q[5] as number;
    v.qvel[0] = qdot[0] as number;
    v.qvel[1] = qdot[1] as number;
    v.qvel[2] = qdot[2] as number;
    // Angular velocity from world into the root body frame: conj(q) * w.
    const qw = q[6] as number;
    const qx = -(q[3] as number);
    const qy = -(q[4] as number);
    const qz = -(q[5] as number);
    const wx = qdot[3] as number;
    const wy = qdot[4] as number;
    const wz = qdot[5] as number;
    const tx = 2 * (qy * wz - qz * wy);
    const ty = 2 * (qz * wx - qx * wz);
    const tz = 2 * (qx * wy - qy * wx);
    v.qvel[3] = wx + qw * tx + (qy * tz - qz * ty);
    v.qvel[4] = wy + qw * ty + (qz * tx - qx * tz);
    v.qvel[5] = wz + qw * tz + (qx * ty - qy * tx);
    for (let i = 0; i < model.dofs.length; i++) {
      v.qpos[this.qposAdr[i] as number] = q[ROOT_NQ + i] as number;
      v.qvel[this.dofAdr[i] as number] = qdot[ROOT_NV + i] as number;
    }
    v.qacc_warmstart.fill(0);
    mujoco.mj_forward(mjModel, mjData);
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
    if (segmentIndex < 0 || segmentIndex >= this.bodyOf.length) {
      throw new RangeError(`Segment index ${segmentIndex} has no body.`);
    }
    const w = this.wrench;
    const o = 6 * segmentIndex;
    w[o] = (w[o] as number) + force.x;
    w[o + 1] = (w[o + 1] as number) + force.y;
    w[o + 2] = (w[o + 2] as number) + force.z;
    let tx = torque.x;
    let ty = torque.y;
    let tz = torque.z;
    if (point) {
      const v = this.live();
      const b = this.bodyOf[segmentIndex] as number;
      const ax = point.x - (v.xipos[3 * b] as number);
      const ay = point.y - (v.xipos[3 * b + 1] as number);
      const az = point.z - (v.xipos[3 * b + 2] as number);
      tx += ay * force.z - az * force.y;
      ty += az * force.x - ax * force.z;
      tz += ax * force.y - ay * force.x;
    }
    w[o + 3] = (w[o + 3] as number) + tx;
    w[o + 4] = (w[o + 4] as number) + ty;
    w[o + 5] = (w[o + 5] as number) + tz;
  }

  // --- Direct manipulation ----------------------------------------------------------------------

  setGravity(gravity: Vec3): void {
    const model = this.mjModel;
    if (!model) throw new Error('No compiled model.');
    const g = model.opt.gravity as Float64Array;
    g[0] = gravity.x;
    g[1] = gravity.y;
    g[2] = gravity.z;
  }

  setGroundCollision(enabled: boolean): void {
    const mujoco = this.mujoco;
    const model = this.mjModel;
    if (!mujoco || !model) throw new Error('No compiled model.');
    const id = mujoco.mj_name2id(model, OBJ_GEOM, 'ground');
    if (id < 0) return;
    // MuJoCo pairs a geom with another when either one's type matches the other's affinity;
    // zeroing both takes the plane out of every pair without moving or deleting it.
    (model.geom_contype as Int32Array)[id] = enabled ? 1 : 0;
    (model.geom_conaffinity as Int32Array)[id] = enabled ? 1 : 0;
  }

  setKinematic(_segmentIndex: number, _enabled: boolean): void {
    throw new Error(
      'MujocoBackend does not support switching a segment kinematic; declare a mocap body at ' +
        'compile instead. Reported as unsupported rather than approximated.',
    );
  }

  setPose(segmentIndex: number, transform: Transform): void {
    const model = this.model;
    const mujoco = this.mujoco;
    const mjModel = this.mjModel;
    const mjData = this.mjData;
    if (!model || !mujoco || !mjModel || !mjData) throw new Error('No compiled model.');
    if (segmentIndex !== model.root) {
      throw new Error(
        'MujocoBackend can only set the root pose: a non-root segment has no free coordinates.',
      );
    }
    const v = this.live();
    v.qpos[0] = transform.translation.x;
    v.qpos[1] = transform.translation.y;
    v.qpos[2] = transform.translation.z;
    v.qpos[3] = transform.rotation.w;
    v.qpos[4] = transform.rotation.x;
    v.qpos[5] = transform.rotation.y;
    v.qpos[6] = transform.rotation.z;
    for (let i = 0; i < ROOT_NV; i++) v.qvel[i] = 0;
    mujoco.mj_forward(mjModel, mjData);
  }

  createGrabConstraint(
    segmentIndex: number,
    localPoint: Vec3,
    worldTarget: Vec3,
    strength = 1,
  ): GrabHandle {
    const model = this.model;
    if (!model) throw new Error('No compiled model.');
    const segment = model.segments[segmentIndex];
    if (!segment) throw new RangeError(`Segment index ${segmentIndex} has no body.`);
    const stiffness =
      (strength * GRAB_FORCE_FRACTION * model.totalMass * STANDARD_GRAVITY_MAGNITUDE) / GRAB_LEASH;
    const damping = 2 * Math.sqrt(stiffness * Math.max(segment.mass, model.totalMass / 8));
    // The same spring at a hand's lever, and critically damped against a segment's worth of
    // inertia at that lever.
    const angularStiffness = stiffness * GRAB_LEVER * GRAB_LEVER;
    const inertia = Math.max(segment.mass, model.totalMass / 8) * GRAB_LEVER * GRAB_LEVER;
    const angularDamping = 2 * Math.sqrt(angularStiffness * inertia);
    const handle = new MujocoGrab(this, {
      segment: segmentIndex,
      local: { x: localPoint.x, y: localPoint.y, z: localPoint.z },
      target: { x: worldTarget.x, y: worldTarget.y, z: worldTarget.z },
      stiffness,
      damping,
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      holdsOrientation: false,
      angularStiffness,
      angularDamping,
    });
    this.grabs.add(handle);
    return handle;
  }

  /** @internal */
  releaseGrab(handle: MujocoGrab): void {
    this.grabs.delete(handle);
  }

  // --- Determinism ------------------------------------------------------------------------------

  /** time, qpos, qvel, qacc_warmstart, commanded: everything the next step reads. */
  snapshot(): Uint8Array {
    const mjData = this.mjData;
    const mjModel = this.mjModel;
    if (!mjData || !mjModel) throw new Error('No compiled model.');
    const v = this.live();
    const out = new Float64Array(1 + mjModel.nq + 2 * mjModel.nv + this.commanded.length);
    let k = 0;
    out[k++] = mjData.time;
    out.set(v.qpos.subarray(0, mjModel.nq), k);
    k += mjModel.nq;
    out.set(v.qvel.subarray(0, mjModel.nv), k);
    k += mjModel.nv;
    out.set(v.qacc_warmstart.subarray(0, mjModel.nv), k);
    k += mjModel.nv;
    out.set(this.commanded, k);
    return new Uint8Array(out.buffer);
  }

  restore(snapshot: Uint8Array): void {
    const mjData = this.mjData;
    const mjModel = this.mjModel;
    const mujoco = this.mujoco;
    if (!mjData || !mjModel || !mujoco) throw new Error('No compiled model.');
    const bytes = snapshot.slice();
    const src = new Float64Array(bytes.buffer, 0, bytes.byteLength / 8);
    const expected = 1 + mjModel.nq + 2 * mjModel.nv + this.commanded.length;
    if (src.length !== expected)
      throw new Error('Snapshot does not belong to this compiled model.');
    const v = this.live();
    let k = 0;
    mjData.time = src[k++] as number;
    v.qpos.set(src.subarray(k, k + mjModel.nq));
    k += mjModel.nq;
    v.qvel.set(src.subarray(k, k + mjModel.nv));
    k += mjModel.nv;
    v.qacc_warmstart.set(src.subarray(k, k + mjModel.nv));
    k += mjModel.nv;
    this.commanded.set(src.subarray(k, k + this.commanded.length));
    this.grabs.clear();
    mujoco.mj_forward(mjModel, mjData);
  }
}
