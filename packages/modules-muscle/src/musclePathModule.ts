/**
 * `MusclePathModule` -- ticket N3.1, muscle spec section 10.1.
 *
 * Where every muscle runs this tick, and how fast each one is changing length. It owns a path
 * solver and does nothing but drive it: the geometry lives in `@bs-humany/muscle-path`, which
 * knows nothing about the kernel, and this is the thin layer that hands it the pose and publishes
 * the answer.
 *
 * It runs in `actuate`, before the solve, because the force that comes out of it has to be in
 * this tick's wrench accumulator. That means the pose it reads is last tick's, which is correct
 * and worth stating plainly: a force applied during a tick is computed from the configuration the
 * tick starts in. `muscle.dynamics` depends on this module by id, so the two always run in that
 * order within the phase.
 *
 * ## What it is not
 *
 * The solver it owns is the via-point solver, which cannot wrap. A muscle whose data declares a
 * wrap surface is reported at compile time and its length is then the length of a path that runs
 * straight through whatever it should have gone around -- shorter than the truth, with the moment
 * arm wrong in exactly the region the surface was placed to correct. The compile report says so;
 * nothing here hides it. N1.4 is the fix.
 */

import type { CompiledArticulation, PoseBuffer, VelocityBuffer } from '@bs-humany/compiler';
import type {
  ChannelSpec,
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  SimModule,
} from '@bs-humany/kernel';
import { BODY_POSE, BODY_VELOCITY, CHANNEL_VERSION } from '@bs-humany/modules-mechanics';
import type {
  IMusclePathSolver,
  PathCompileReport,
  PathContactBuffer,
  PathTerminalBuffer,
} from '@bs-humany/muscle-path';
import {
  GeodesicPathSolver,
  createPathContactBuffer,
  createPathTerminalBuffer,
} from '@bs-humany/muscle-path';
import {
  DEFAULT_MUSCLE_CONTACT_CAPACITY,
  MUSCLE_CHANNEL_VERSION,
  MUSCLE_CONTACT,
  MUSCLE_PATH,
  muscleContactSpec,
  musclePathSpec,
} from './channels.js';
import type { CompiledMuscleSet } from './compile.js';

export const MUSCLE_PATH_MODULE_ID = 'bsums.xyz.bs-humany.muscle.path';

export interface MusclePathOptions {
  /** Wrap contacts reportable per tick. Overflow is counted, never dropped silently. */
  readonly contactCapacity?: number;
  /** A solver other than the default via-point one, once there is one. */
  readonly solver?: IMusclePathSolver;
}

export class MusclePathModule implements SimModule {
  readonly manifest: ModuleManifest;

  private readonly solver: IMusclePathSolver;
  private readonly units: number;
  private readonly capacity: number;

  /** What the solver could not represent. Read it after `init`; it is not a per-tick concern. */
  readonly compileReport: PathCompileReport;

  /** Views onto the channels, bound once. */
  private pose: PoseBuffer | undefined;
  private velocity: VelocityBuffer | undefined;
  private length: Float64Array | undefined;
  private rate: Float64Array | undefined;
  private originBody: Int32Array | undefined;
  private insertionBody: Int32Array | undefined;
  private originPoint: Float64Array | undefined;
  private insertionPoint: Float64Array | undefined;
  private originDirection: Float64Array | undefined;
  private insertionDirection: Float64Array | undefined;
  private contactUnit: Int32Array | undefined;
  private contactBody: Int32Array | undefined;
  private contactPoint: Float64Array | undefined;
  private contactDirection: Float64Array | undefined;

  /**
   * Scratch the solver writes into, allocated once.
   *
   * The solver's output shape and the channel's layout are not the same thing, and forcing them to
   * be would tie a geometry package to the kernel's channel format. Copying a handful of numbers
   * per unit per tick is the price of that separation, and it is a small one.
   */
  private readonly terminals: PathTerminalBuffer;
  private readonly contacts: PathContactBuffer;

  /** How many contacts the last tick could not fit. Zero in every case the via-point solver sees. */
  contactOverflow = 0;

  constructor(
    readonly articulation: CompiledArticulation,
    readonly muscles: CompiledMuscleSet,
    options: MusclePathOptions = {},
  ) {
    this.units = muscles.units.length;
    this.capacity = options.contactCapacity ?? DEFAULT_MUSCLE_CONTACT_CAPACITY;
    this.solver = options.solver ?? new GeodesicPathSolver(muscles.resolver);
    this.compileReport = this.solver.compile(muscles.paths, muscles.surfaces);
    this.terminals = createPathTerminalBuffer(this.units);
    this.contacts = createPathContactBuffer(this.capacity);

    this.manifest = {
      id: MUSCLE_PATH_MODULE_ID,
      version: '1.0.0',
      // Before the solve: the force this feeds has to reach this tick's wrench accumulator.
      phase: 'actuate',
      dependsOn: [],
      reads: [
        { id: BODY_POSE, version: CHANNEL_VERSION },
        { id: BODY_VELOCITY, version: CHANNEL_VERSION },
      ],
      writes: [
        { id: MUSCLE_PATH, version: MUSCLE_CHANNEL_VERSION },
        { id: MUSCLE_CONTACT, version: MUSCLE_CHANNEL_VERSION },
      ],
      accumulates: [],
      gives: [musclePathSpec(this.units), muscleContactSpec(this.capacity)] satisfies ChannelSpec[],
    };
  }

  init(ctx: ModuleInitContext): void {
    this.bind(ctx);
  }

  /** Rebinding after a restore. The solver holds no per-tick state, so there is nothing to clear. */
  reset(ctx: ModuleInitContext): void {
    this.bind(ctx);
  }

  private bind(ctx: ModuleInitContext): void {
    const pose = ctx.read(BODY_POSE);
    this.pose = {
      position: pose.fields.position as Float64Array,
      orientation: pose.fields.orientation as Float64Array,
    };
    const velocity = ctx.read(BODY_VELOCITY);
    this.velocity = {
      linear: velocity.fields.linear as Float64Array,
      angular: velocity.fields.angular as Float64Array,
    };

    const out = ctx.write(MUSCLE_PATH);
    this.length = out.fields.length as Float64Array;
    this.rate = out.fields.velocity as Float64Array;
    this.originBody = out.fields.originBody as Int32Array;
    this.insertionBody = out.fields.insertionBody as Int32Array;
    this.originPoint = out.fields.originPoint as Float64Array;
    this.insertionPoint = out.fields.insertionPoint as Float64Array;
    this.originDirection = out.fields.originDirection as Float64Array;
    this.insertionDirection = out.fields.insertionDirection as Float64Array;

    const contacts = ctx.write(MUSCLE_CONTACT);
    this.contactUnit = contacts.fields.unit as Int32Array;
    this.contactBody = contacts.fields.body as Int32Array;
    this.contactPoint = contacts.fields.point as Float64Array;
    this.contactDirection = contacts.fields.direction as Float64Array;
  }

  step(_ctx: ModuleStepContext): void {
    const pose = this.pose;
    const velocity = this.velocity;
    const length = this.length;
    const rate = this.rate;
    if (!pose || !velocity || !length || !rate) return;
    const originBody = this.originBody;
    const insertionBody = this.insertionBody;
    const originPoint = this.originPoint;
    const insertionPoint = this.insertionPoint;
    const originDirection = this.originDirection;
    const insertionDirection = this.insertionDirection;
    if (!originBody || !insertionBody || !originPoint || !insertionPoint) return;
    if (!originDirection || !insertionDirection) return;

    const terminals = this.terminals;
    this.solver.solve(pose, velocity, length, rate, this.contacts, terminals);

    const n = this.units;
    for (let i = 0; i < n; i++) {
      originBody[i] = terminals.originBody[i] as number;
      insertionBody[i] = terminals.insertionBody[i] as number;
      for (let axis = 0; axis < 3; axis++) {
        const at = 3 * i + axis;
        originPoint[at] = terminals.originPoint[at] as number;
        insertionPoint[at] = terminals.insertionPoint[at] as number;
        originDirection[at] = terminals.originDirection[at] as number;
        insertionDirection[at] = terminals.insertionDirection[at] as number;
      }
    }

    this.publishContacts();
  }

  /** Copy the solver's contacts out, and say how many did not fit rather than losing them quietly. */
  private publishContacts(): void {
    const unit = this.contactUnit;
    const body = this.contactBody;
    const point = this.contactPoint;
    const direction = this.contactDirection;
    if (!unit || !body || !point || !direction) return;

    const written = Math.min(this.contacts.count, this.capacity);
    this.contactOverflow = this.contacts.count - written;
    for (let i = 0; i < written; i++) {
      unit[i] = this.contacts.path[i] as number;
      body[i] = this.contacts.body[i] as number;
      for (let axis = 0; axis < 3; axis++) {
        point[3 * i + axis] = this.contacts.point[3 * i + axis] as number;
        direction[3 * i + axis] = this.contacts.direction[3 * i + axis] as number;
      }
    }
    // A stale contact is worse than no contact: section 8.2 would apply last tick's reaction
    // force to a body that is no longer being pushed.
    for (let i = written; i < this.capacity; i++) unit[i] = -1;
  }

  /** How many contacts the last solve reported. Zero until a wrapping solver exists. */
  get contactCount(): number {
    return Math.min(this.contacts.count, this.capacity);
  }
}
