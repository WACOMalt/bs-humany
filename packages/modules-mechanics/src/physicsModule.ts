/**
 * `PhysicsModule` -- milestone M3.7.
 *
 * The `solve` phase's only module and the exclusive writer of `body.*` and `contact.manifolds`
 * (spec section 10.4). It owns a compiled backend and does three things per tick: hand the
 * accumulated actuation to the backend, step it, and read its state straight into the channel
 * buffers. The channel fields *are* the backend's output buffers -- no copy sits between the
 * solver and the transport.
 *
 * The backend is initialised and compiled inside `init`, which the kernel awaits, so a module
 * user never sees a half-built backend. Its compile report is kept for the UI to surface (spec
 * section 9.3: warnings MUST be shown).
 */

import type {
  CompileReport,
  CompiledArticulation,
  ContactBuffer,
  IPhysicsBackend,
  JointStateBuffer,
  PoseBuffer,
  VelocityBuffer,
} from '@bs-humany/compiler';
import { type Vec3, vec3 } from '@bs-humany/frames';
import type {
  ChannelView,
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  SimModule,
  Stateful,
} from '@bs-humany/kernel';
import {
  ACTUATION_BODY_WRENCH,
  ACTUATION_JOINT_TORQUE,
  BODY_JOINT_STATE,
  BODY_POSE,
  BODY_VELOCITY,
  CHANNEL_VERSION,
  CONTACT_MANIFOLDS,
  actuationBodyWrenchSpec,
  actuationJointTorqueSpec,
  bodyJointStateSpec,
  bodyPoseSpec,
  bodyVelocitySpec,
  contactManifoldsSpec,
} from './channels.js';

export const PHYSICS_MODULE_ID = 'bsums.xyz.bs-humany.physics';

export interface PhysicsModuleOptions {
  /** Substeps per kernel tick. Defaults to 1. */
  readonly substeps?: number | undefined;
  /** Solver iterations handed to the backend. */
  readonly iterations?: number | undefined;
  /** Ground plane, as the backend understands it. */
  readonly ground?:
    | { readonly height: number; readonly contactClass?: string | undefined }
    | undefined;
  readonly gravity?: Vec3 | undefined;
  readonly contactCapacity?: number | undefined;
}

export class PhysicsModule implements SimModule, Stateful {
  readonly manifest: ModuleManifest;
  /** The backend's compile report, available after `init`. */
  report: CompileReport | undefined;
  /** Contacts the last step produced, which may exceed the channel's capacity. */
  contactsSeen = 0;

  private pose: PoseBuffer | undefined;
  private velocity: VelocityBuffer | undefined;
  private jointState: JointStateBuffer | undefined;
  private contacts: ContactBuffer | undefined;
  private contactView: ChannelView | undefined;
  private torque: Float64Array | undefined;
  private wrenchForce: Float64Array | undefined;
  private wrenchTorque: Float64Array | undefined;
  private readonly substeps: number;
  private readonly force = vec3(0, 0, 0);
  private readonly moment = vec3(0, 0, 0);

  constructor(
    readonly backend: IPhysicsBackend,
    readonly articulation: CompiledArticulation,
    private readonly options: PhysicsModuleOptions = {},
  ) {
    this.substeps = Math.max(1, options.substeps ?? 1);
    const capacity = options.contactCapacity;
    this.manifest = {
      id: PHYSICS_MODULE_ID,
      version: '1.0.0',
      phase: 'solve',
      dependsOn: [],
      reads: [
        { id: ACTUATION_JOINT_TORQUE, version: CHANNEL_VERSION },
        { id: ACTUATION_BODY_WRENCH, version: CHANNEL_VERSION },
      ],
      writes: [
        { id: BODY_POSE, version: CHANNEL_VERSION },
        { id: BODY_VELOCITY, version: CHANNEL_VERSION },
        { id: BODY_JOINT_STATE, version: CHANNEL_VERSION },
        { id: CONTACT_MANIFOLDS, version: CHANNEL_VERSION },
      ],
      accumulates: [],
      gives: [
        bodyPoseSpec(articulation),
        bodyVelocitySpec(articulation),
        bodyJointStateSpec(articulation),
        contactManifoldsSpec(capacity),
        actuationJointTorqueSpec(articulation),
        actuationBodyWrenchSpec(articulation),
      ],
    };
  }

  async init(ctx: ModuleInitContext): Promise<void> {
    await this.backend.init({
      dt: ctx.dt / this.substeps,
      iterations: this.options.iterations,
      gravity: this.options.gravity,
      ground: this.options.ground,
    });
    this.report = await this.backend.compile(this.articulation);
    this.bind(ctx);
    this.publish();
  }

  reset(ctx: ModuleInitContext): void {
    this.bind(ctx);
  }

  private bind(ctx: ModuleInitContext): void {
    const pose = ctx.write(BODY_POSE);
    this.pose = {
      position: field(pose, 'position'),
      orientation: field(pose, 'orientation'),
    };
    const velocity = ctx.write(BODY_VELOCITY);
    this.velocity = { linear: field(velocity, 'linear'), angular: field(velocity, 'angular') };
    const joint = ctx.write(BODY_JOINT_STATE);
    this.jointState = {
      q: field(joint, 'q'),
      qdot: field(joint, 'qdot'),
      force: field(joint, 'force'),
    };
    const contacts = ctx.write(CONTACT_MANIFOLDS);
    this.contactView = contacts;
    const pair = contacts.fields.pair;
    if (!(pair instanceof Int32Array)) throw new Error('contact.manifolds.pair must be i32.');
    this.contacts = {
      capacity: contacts.spec.capacity ?? 0,
      pair,
      point: field(contacts, 'point'),
      normal: field(contacts, 'normal'),
      impulse: field(contacts, 'impulse'),
      depth: field(contacts, 'depth'),
    };
    this.torque = field(ctx.read(ACTUATION_JOINT_TORQUE), 'torque');
    const wrench = ctx.read(ACTUATION_BODY_WRENCH);
    this.wrenchForce = field(wrench, 'force');
    this.wrenchTorque = field(wrench, 'torque');
  }

  step(_ctx: ModuleStepContext): void {
    const torque = this.torque;
    const wf = this.wrenchForce;
    const wt = this.wrenchTorque;
    if (!torque || !wf || !wt) return;
    this.backend.applyGeneralizedForce(torque);
    const n = this.articulation.segments.length;
    for (let i = 0; i < n; i++) {
      const fx = wf[3 * i] as number;
      const fy = wf[3 * i + 1] as number;
      const fz = wf[3 * i + 2] as number;
      const tx = wt[3 * i] as number;
      const ty = wt[3 * i + 1] as number;
      const tz = wt[3 * i + 2] as number;
      if (fx === 0 && fy === 0 && fz === 0 && tx === 0 && ty === 0 && tz === 0) continue;
      this.force.x = fx;
      this.force.y = fy;
      this.force.z = fz;
      this.moment.x = tx;
      this.moment.y = ty;
      this.moment.z = tz;
      this.backend.applyBodyWrench(i, this.force, this.moment);
    }
    this.backend.step(this.substeps);
    this.publish();
  }

  /** Read the backend's state into the channels. */
  private publish(): void {
    if (!this.pose || !this.velocity || !this.jointState || !this.contacts || !this.contactView)
      return;
    this.backend.readPose(this.pose);
    this.backend.readVelocity(this.velocity);
    this.backend.readJointState(this.jointState);
    this.contactsSeen = this.backend.readContacts(this.contacts);
    this.contactView.count = Math.min(this.contactsSeen, this.contacts.capacity);
  }

  getState(): unknown {
    return this.backend.snapshot();
  }

  setState(state: unknown): void {
    if (!(state instanceof Uint8Array))
      throw new Error('PhysicsModule state must be a Uint8Array.');
    this.backend.restore(state);
    this.publish();
  }

  dispose(): void {
    this.backend.dispose();
  }
}

function field(view: ChannelView, name: string): Float64Array {
  const f = view.fields[name];
  if (!(f instanceof Float64Array)) {
    throw new Error(`Channel '${view.spec.id}' field '${name}' is missing or not f64.`);
  }
  return f;
}
