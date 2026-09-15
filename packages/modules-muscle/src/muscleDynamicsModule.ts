/**
 * `MuscleDynamicsModule` -- ticket N3.2, muscle spec sections 7, 8 and 10.1.
 *
 * Turns motor drive into force on bone. Each tick, for every unit: advance activation toward the
 * excitation it is being given, solve the musculotendon equilibrium at the path length the path
 * module published, advance the fiber, and push on the two bodies the muscle attaches to.
 *
 * ## Force reaches the solver as wrenches, never as joint torque
 *
 * M-ADR-003, and it is the decision this module is shaped by. A muscle does two things to a
 * skeleton: it turns joints, and it squeezes them together. Computing a joint torque from a
 * moment arm captures the first and throws away the second, and the second is most of the load a
 * hip or a shoulder actually carries. So the force goes on at the points the tendon actually
 * pulls, as a force and a torque on each body, and the solver works out the joint torque itself.
 * The moment arm exists in this module's world only as a diagnostic that something else computes.
 *
 * ## Why the torque term is not optional
 *
 * `actuation.bodyWrench` is a force and a torque per body, and its torque is about that body's
 * centre of mass -- that is what the physics module hands the backend. A tendon does not pull at
 * the centre of mass; it pulls at an attachment site somewhere on the bone. So the offset from
 * the centre of mass to the attachment, crossed into the force, is the torque, and leaving it out
 * would give a muscle that translated bones without turning them.
 *
 * ## Wrap reactions
 *
 * Section 8.2 step 4: a muscle that wraps a bone pushes on that bone, and without the reaction
 * the joint force is wrong. It is the step implementations skip. This module applies it for every
 * contact `muscle.contact` reports -- which is none of them until a wrapping solver exists, but
 * the code is here and tested against synthetic contacts, so N1.4 does not have to remember.
 *
 * ## What it is not
 *
 * One activation per unit. A real muscle is driven by recruiting motor units one pool at a time,
 * and this is the standard simplification: adequate for a reflex loop, not adequate for
 * simulating electromyography. Section 14 records it as a known limitation and open question 4
 * asks whether a motor unit pool is ever worth building.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import type {
  ChannelSpec,
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  SimModule,
} from '@bs-humany/kernel';
import { ACTUATION_BODY_WRENCH, BODY_POSE, CHANNEL_VERSION } from '@bs-humany/modules-mechanics';
import {
  type MusculotendonParameters,
  equilibriumFiberLength,
  solveEquilibrium,
  stepActivation,
} from '@bs-humany/muscle-model';
import {
  EFFERENT_ALPHA_MOTOR,
  MUSCLE_CHANNEL_VERSION,
  MUSCLE_CONTACT,
  MUSCLE_EQUILIBRIUM_FAILED,
  MUSCLE_FIBER_OUT_OF_RANGE,
  MUSCLE_PATH,
  MUSCLE_STATE,
  efferentAlphaMotorSpec,
  efferentGammaMotorSpec,
  muscleStateSpec,
} from './channels.js';
import type { CompiledMuscleSet } from './compile.js';
import { MUSCLE_PATH_MODULE_ID } from './musclePathModule.js';

export const MUSCLE_DYNAMICS_MODULE_ID = 'bsums.xyz.bs-humany.muscle.dynamics';

/** Fiber lengths outside this are held, and the tick is flagged, rather than left to diverge. */
const FIBER_FLOOR = 0.1;
const FIBER_CEILING = 2.0;

export class MuscleDynamicsModule implements SimModule {
  readonly manifest: ModuleManifest;

  private readonly units: number;
  /** Parameters as flat arrays: `step` walks them and an array of objects would chase pointers. */
  private readonly maxForce: Float64Array;
  private readonly optimalFiber: Float64Array;
  private readonly tendonSlack: Float64Array;
  private readonly pennation: Float64Array;
  private readonly maxVelocity: Float64Array;
  private readonly damping: Float64Array;
  private readonly activationTime: Float64Array;
  private readonly deactivationTime: Float64Array;

  /** Fiber length per unit, in optimal fiber lengths. The one piece of state that must persist. */
  private readonly fiberLength: Float64Array;
  private primed = false;

  /**
   * Scratch reused every tick.
   *
   * `solveEquilibrium` takes a parameter object and a state object. Building either in `step`
   * would be an allocation per unit per tick -- eighty muscles at 500 Hz is forty thousand
   * objects a second, all immediately garbage. These two are mutated in place instead.
   */
  private readonly scratchParameters: {
    maxIsometricForce: number;
    optimalFiberLength: number;
    tendonSlackLength: number;
    pennationAngle: number;
    maxContractionVelocity: number;
    damping: number;
  };
  private readonly scratchState: { activation: number; fiberLength: number };
  private readonly scratchActivation: { activationTime: number; deactivationTime: number };

  private length: Float64Array | undefined;
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
  private contactCapacity = 0;
  private excitation: Float64Array | undefined;
  private outActivation: Float64Array | undefined;
  private outFiberLength: Float64Array | undefined;
  private outFiberVelocity: Float64Array | undefined;
  private outTendonForce: Float64Array | undefined;
  private outFiberForce: Float64Array | undefined;
  private outDiagnostic: Int32Array | undefined;
  private wrenchForce: Float64Array | undefined;
  private wrenchTorque: Float64Array | undefined;
  private posePosition: Float64Array | undefined;
  private poseOrientation: Float64Array | undefined;

  /** Segment centres of mass in their own frames, flattened: the wrench torque is about these. */
  private readonly com: Float64Array;

  constructor(
    readonly articulation: CompiledArticulation,
    readonly muscles: CompiledMuscleSet,
  ) {
    const n = muscles.units.length;
    this.units = n;
    this.maxForce = new Float64Array(n);
    this.optimalFiber = new Float64Array(n);
    this.tendonSlack = new Float64Array(n);
    this.pennation = new Float64Array(n);
    this.maxVelocity = new Float64Array(n);
    this.damping = new Float64Array(n);
    this.activationTime = new Float64Array(n);
    this.deactivationTime = new Float64Array(n);
    this.fiberLength = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      const unit = muscles.units[i] as CompiledMuscleSet['units'][number];
      const p = unit.parameters;
      this.maxForce[i] = p.maxIsometricForce;
      this.optimalFiber[i] = p.optimalFiberLength;
      this.tendonSlack[i] = p.tendonSlackLength;
      this.pennation[i] = p.pennationAngle;
      this.maxVelocity[i] = p.maxContractionVelocity;
      this.damping[i] = p.damping;
      this.activationTime[i] = unit.activationTime;
      this.deactivationTime[i] = unit.deactivationTime;
    }

    this.com = new Float64Array(3 * articulation.segments.length);
    for (const segment of articulation.segments) {
      this.com[3 * segment.index] = segment.com.x;
      this.com[3 * segment.index + 1] = segment.com.y;
      this.com[3 * segment.index + 2] = segment.com.z;
    }

    // Not-a-number rather than plausible defaults. Every field is overwritten before it is read,
    // and if that ever stops being true a NaN says so on the first tick, where a stand-in value
    // would instead give a muscle that quietly made one newton of force and looked fine.
    this.scratchParameters = {
      maxIsometricForce: Number.NaN,
      optimalFiberLength: Number.NaN,
      tendonSlackLength: Number.NaN,
      pennationAngle: Number.NaN,
      maxContractionVelocity: Number.NaN,
      damping: Number.NaN,
    };
    this.scratchState = { activation: Number.NaN, fiberLength: Number.NaN };
    this.scratchActivation = { activationTime: Number.NaN, deactivationTime: Number.NaN };

    this.manifest = {
      id: MUSCLE_DYNAMICS_MODULE_ID,
      version: '1.0.0',
      phase: 'actuate',
      // By id rather than by channel: the path has to be this tick's, and depending on the module
      // is the only thing that says so within a phase.
      dependsOn: [{ id: MUSCLE_PATH_MODULE_ID, version: '1.0.0' }],
      reads: [
        { id: MUSCLE_PATH, version: MUSCLE_CHANNEL_VERSION },
        { id: MUSCLE_CONTACT, version: MUSCLE_CHANNEL_VERSION },
        { id: EFFERENT_ALPHA_MOTOR, version: MUSCLE_CHANNEL_VERSION },
        // For the centre of mass each body's wrench torque is taken about.
        { id: BODY_POSE, version: CHANNEL_VERSION },
      ],
      writes: [{ id: MUSCLE_STATE, version: MUSCLE_CHANNEL_VERSION }],
      accumulates: [{ id: ACTUATION_BODY_WRENCH, version: CHANNEL_VERSION }],
      gives: [
        muscleStateSpec(n),
        efferentAlphaMotorSpec(n),
        efferentGammaMotorSpec(n),
      ] satisfies ChannelSpec[],
    };
  }

  init(ctx: ModuleInitContext): void {
    this.bind(ctx);
    this.primed = false;
  }

  /**
   * Rebinding after a restore, and forgetting the fiber lengths.
   *
   * They belong to a configuration that no longer precedes this one. Rather than carrying them
   * across, the next tick re-solves each fiber to the length that balances the forces at whatever
   * pose we have landed in, which is the same thing `init` does and for the same reason: a muscle
   * that starts out of equilibrium twitches, and nothing asked it to.
   */
  reset(ctx: ModuleInitContext): void {
    this.bind(ctx);
    this.primed = false;
  }

  private bind(ctx: ModuleInitContext): void {
    const path = ctx.read(MUSCLE_PATH);
    this.length = path.fields.length as Float64Array;
    this.originBody = path.fields.originBody as Int32Array;
    this.insertionBody = path.fields.insertionBody as Int32Array;
    this.originPoint = path.fields.originPoint as Float64Array;
    this.insertionPoint = path.fields.insertionPoint as Float64Array;
    this.originDirection = path.fields.originDirection as Float64Array;
    this.insertionDirection = path.fields.insertionDirection as Float64Array;

    const contact = ctx.read(MUSCLE_CONTACT);
    this.contactUnit = contact.fields.unit as Int32Array;
    this.contactBody = contact.fields.body as Int32Array;
    this.contactPoint = contact.fields.point as Float64Array;
    this.contactDirection = contact.fields.direction as Float64Array;
    this.contactCapacity = this.contactUnit.length;

    this.excitation = ctx.read(EFFERENT_ALPHA_MOTOR).fields.excitation as Float64Array;

    const out = ctx.write(MUSCLE_STATE);
    this.outActivation = out.fields.activation as Float64Array;
    this.outFiberLength = out.fields.fiberLength as Float64Array;
    this.outFiberVelocity = out.fields.fiberVelocity as Float64Array;
    this.outTendonForce = out.fields.tendonForce as Float64Array;
    this.outFiberForce = out.fields.fiberForce as Float64Array;
    this.outDiagnostic = out.fields.diagnostic as Int32Array;

    const wrench = ctx.accumulate(ACTUATION_BODY_WRENCH);
    this.wrenchForce = wrench.fields.force as Float64Array;
    this.wrenchTorque = wrench.fields.torque as Float64Array;

    const pose = ctx.read(BODY_POSE);
    this.posePosition = pose.fields.position as Float64Array;
    this.poseOrientation = pose.fields.orientation as Float64Array;
  }

  step(ctx: ModuleStepContext): void {
    const length = this.length;
    const excitation = this.excitation;
    const activationOut = this.outActivation;
    const fiberLengthOut = this.outFiberLength;
    const fiberVelocityOut = this.outFiberVelocity;
    const tendonForceOut = this.outTendonForce;
    const fiberForceOut = this.outFiberForce;
    const diagnostic = this.outDiagnostic;
    if (!length || !excitation || !activationOut || !fiberLengthOut) return;
    if (!fiberVelocityOut || !tendonForceOut || !fiberForceOut || !diagnostic) return;

    const parameters = this.scratchParameters;
    const state = this.scratchState;
    const dt = ctx.dt;
    const n = this.units;

    for (let i = 0; i < n; i++) {
      parameters.maxIsometricForce = this.maxForce[i] as number;
      parameters.optimalFiberLength = this.optimalFiber[i] as number;
      parameters.tendonSlackLength = this.tendonSlack[i] as number;
      parameters.pennationAngle = this.pennation[i] as number;
      parameters.maxContractionVelocity = this.maxVelocity[i] as number;
      parameters.damping = this.damping[i] as number;

      const unitLength = length[i] as number;

      // The first tick after init or a restore: put each fiber where the forces already balance,
      // so the muscle does not twitch at t = 0 on a transient nobody asked for.
      if (!this.primed) {
        this.fiberLength[i] = equilibriumFiberLength(
          activationOut[i] as number,
          unitLength,
          parameters as MusculotendonParameters,
        );
      }

      const activationParameters = this.scratchActivation;
      activationParameters.activationTime = this.activationTime[i] as number;
      activationParameters.deactivationTime = this.deactivationTime[i] as number;
      const activation = stepActivation(
        activationOut[i] as number,
        excitation[i] as number,
        dt,
        activationParameters,
      );

      state.activation = activation;
      state.fiberLength = this.fiberLength[i] as number;
      const solution = solveEquilibrium(state, unitLength, parameters as MusculotendonParameters);

      // Semi-implicit: the fiber advances on the activation this tick produced, not last tick's.
      const advanced =
        state.fiberLength + solution.fiberVelocity * parameters.maxContractionVelocity * dt;
      const outOfRange = advanced < FIBER_FLOOR || advanced > FIBER_CEILING;
      this.fiberLength[i] =
        advanced < FIBER_FLOOR ? FIBER_FLOOR : advanced > FIBER_CEILING ? FIBER_CEILING : advanced;

      const force = solution.tendonForce * parameters.maxIsometricForce;
      activationOut[i] = activation;
      fiberLengthOut[i] = this.fiberLength[i] as number;
      fiberVelocityOut[i] = solution.fiberVelocity;
      tendonForceOut[i] = force;
      fiberForceOut[i] = solution.fiberForce * parameters.maxIsometricForce;
      diagnostic[i] =
        (solution.failed ? MUSCLE_EQUILIBRIUM_FAILED : 0) |
        (outOfRange ? MUSCLE_FIBER_OUT_OF_RANGE : 0);

      this.applyTerminalForce(i, force);
    }

    this.primed = true;
    this.applyWrapReactions(tendonForceOut);
  }

  /**
   * Pull the origin and the insertion toward each other along the path.
   *
   * Equal and opposite by construction for a straight unit, because the two directions are
   * opposites; for a path with via points each end is pulled along its own segment, and the
   * difference between the two is carried by whatever the path is routed over. Until wrapping
   * exists, the via points are on bones and the bones take it.
   */
  private applyTerminalForce(unit: number, force: number): void {
    if (force === 0) return;
    const originBody = this.originBody;
    const insertionBody = this.insertionBody;
    const originPoint = this.originPoint;
    const insertionPoint = this.insertionPoint;
    const originDirection = this.originDirection;
    const insertionDirection = this.insertionDirection;
    if (!originBody || !insertionBody || !originPoint || !insertionPoint) return;
    if (!originDirection || !insertionDirection) return;

    this.push(
      originBody[unit] as number,
      originPoint[3 * unit] as number,
      originPoint[3 * unit + 1] as number,
      originPoint[3 * unit + 2] as number,
      force * (originDirection[3 * unit] as number),
      force * (originDirection[3 * unit + 1] as number),
      force * (originDirection[3 * unit + 2] as number),
    );
    this.push(
      insertionBody[unit] as number,
      insertionPoint[3 * unit] as number,
      insertionPoint[3 * unit + 1] as number,
      insertionPoint[3 * unit + 2] as number,
      force * (insertionDirection[3 * unit] as number),
      force * (insertionDirection[3 * unit + 1] as number),
      force * (insertionDirection[3 * unit + 2] as number),
    );
  }

  /**
   * Section 8.2 step 4, the step implementations skip.
   *
   * The path solver reports, for each wrap, the world point and the direction the reaction acts
   * along -- the resultant of the two adjacent segment directions. The magnitude is the tendon
   * force, because the tendon is a single string under one tension along its whole length.
   */
  private applyWrapReactions(tendonForce: Float64Array): void {
    const unit = this.contactUnit;
    const body = this.contactBody;
    const point = this.contactPoint;
    const direction = this.contactDirection;
    if (!unit || !body || !point || !direction) return;

    for (let c = 0; c < this.contactCapacity; c++) {
      const which = unit[c] as number;
      if (which < 0) break;
      const force = tendonForce[which] as number;
      if (force === 0) continue;
      this.push(
        body[c] as number,
        point[3 * c] as number,
        point[3 * c + 1] as number,
        point[3 * c + 2] as number,
        force * (direction[3 * c] as number),
        force * (direction[3 * c + 1] as number),
        force * (direction[3 * c + 2] as number),
      );
    }
  }

  /**
   * Accumulate a world force acting at a world point onto a body.
   *
   * The channel's torque is about the body's centre of mass, so the offset from the centre of
   * mass to the point of application, crossed into the force, is what makes this a pull on a bone
   * rather than a push on a point mass.
   */
  private push(
    body: number,
    px: number,
    py: number,
    pz: number,
    fx: number,
    fy: number,
    fz: number,
  ): void {
    const force = this.wrenchForce;
    const torque = this.wrenchTorque;
    const position = this.posePosition;
    const orientation = this.poseOrientation;
    if (!force || !torque || !position || !orientation) return;
    if (body < 0) return;

    // Centre of mass in the world: the segment frame's origin plus its rotated local offset.
    const lx = this.com[3 * body] as number;
    const ly = this.com[3 * body + 1] as number;
    const lz = this.com[3 * body + 2] as number;
    const qx = orientation[4 * body] as number;
    const qy = orientation[4 * body + 1] as number;
    const qz = orientation[4 * body + 2] as number;
    const qw = orientation[4 * body + 3] as number;
    const tx = 2 * (qy * lz - qz * ly);
    const ty = 2 * (qz * lx - qx * lz);
    const tz = 2 * (qx * ly - qy * lx);
    const cx = (position[3 * body] as number) + lx + qw * tx + (qy * tz - qz * ty);
    const cy = (position[3 * body + 1] as number) + ly + qw * ty + (qz * tx - qx * tz);
    const cz = (position[3 * body + 2] as number) + lz + qw * tz + (qx * ty - qy * tx);

    const rx = px - cx;
    const ry = py - cy;
    const rz = pz - cz;

    force[3 * body] = (force[3 * body] as number) + fx;
    force[3 * body + 1] = (force[3 * body + 1] as number) + fy;
    force[3 * body + 2] = (force[3 * body + 2] as number) + fz;
    torque[3 * body] = (torque[3 * body] as number) + (ry * fz - rz * fy);
    torque[3 * body + 1] = (torque[3 * body + 1] as number) + (rz * fx - rx * fz);
    torque[3 * body + 2] = (torque[3 * body + 2] as number) + (rx * fy - ry * fx);
  }
}
