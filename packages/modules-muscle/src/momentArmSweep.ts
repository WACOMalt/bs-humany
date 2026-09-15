/**
 * Sweeping a joint and recording what leverage each muscle has -- ticket N1.9, muscle spec 13.2.
 *
 * "For each muscle that crosses a joint, sweep the joint through its range and record the moment
 * arm." A moment arm read at one pose says almost nothing: the straight-line triceps was right at
 * full extension and reversed sign at two radians, and it took a sweep to see that. So this poses
 * the body at a series of angles and reads `diagnostics.momentArm` at each.
 *
 * ## Posing rather than simulating
 *
 * The body is placed at each angle by writing the generalized state, not by driving it there.
 * Gravity is off and the muscles are undriven, so nothing accelerates; the pose is re-imposed
 * before every tick anyway, which makes the sweep independent of how the dynamics behave and of
 * any drift between one angle and the next. Each angle is held for a few ticks because the path
 * and moment modules run at a tenth of the physics rate -- the pose has to survive long enough to
 * be measured.
 *
 * ## The backend comes from the caller
 *
 * A sweep needs a physics backend, and this package does not depend on one. The caller passes a
 * factory, which keeps the dependency where it already is (the tests and the validation tool both
 * have MuJoCo) and lets the same sweep run against any backend the project grows.
 */

import type { CompiledArticulation, IPhysicsBackend } from '@bs-humany/compiler';
import { allocateBuffers } from '@bs-humany/compiler';
import { Kernel } from '@bs-humany/kernel';
import { PhysicsModule } from '@bs-humany/modules-mechanics';
import { DIAGNOSTICS_MOMENT_ARM } from './channels.js';
import type { CompiledMuscleSet } from './compile.js';
import { MuscleDynamicsModule } from './muscleDynamicsModule.js';
import { type MomentPair, MuscleMomentModule } from './muscleMomentModule.js';
import { MusclePathModule } from './musclePathModule.js';

/** How many root coordinates come before the joint coordinates in the generalized state. */
const ROOT_NQ = 7;

/**
 * Ticks held at each angle.
 *
 * The moment module runs at a tenth of the physics rate, so ten ticks is the least that
 * guarantees it sees the pose; twelve leaves the path module a tick either side of it.
 */
const TICKS_PER_POSE = 12;

export interface MomentArmSweepRequest {
  readonly articulation: CompiledArticulation;
  readonly muscles: CompiledMuscleSet;
  /** Makes the backend to pose. Called once. */
  readonly backend: () => IPhysicsBackend;
  /** Which joint to sweep, by its id in the articulation. */
  readonly jointId: string;
  /** Which of that joint's coordinates, by axis name. */
  readonly axisName: string;
  /** The angles to sample, radians. */
  readonly angles: readonly number[];
  /**
   * Coordinates to hold at a value other than zero while sweeping, by joint id and axis name.
   *
   * The elbow flexors' leverage depends on forearm rotation as much as on flexion -- the biceps
   * insertion is on the radius, which turns -- so a sweep that does not say where the forearm was
   * is not reproducible.
   */
  readonly hold?: readonly { jointId: string; axisName: string; value: number }[];
}

export interface MomentArmSweep {
  /** One entry per muscle-coordinate pair the moment module found. */
  readonly pairs: readonly MomentPair[];
  readonly angles: readonly number[];
  /** `arms[pair][angle]`, metres. */
  readonly arms: readonly Float64Array[];
}

/** Find a coordinate's index in the articulation, or throw naming what is missing. */
export function coordinateIndex(
  articulation: CompiledArticulation,
  jointId: string,
  axisName: string,
): number {
  const index = articulation.dofs.findIndex(
    (dof) => articulation.joints[dof.joint]?.id === jointId && dof.axisName === axisName,
  );
  if (index < 0) throw new Error(`No coordinate '${axisName}' on joint '${jointId}'.`);
  return index;
}

/** Pose the body at each angle in turn and record every muscle's moment arm there. */
export async function sweepMomentArms(request: MomentArmSweepRequest): Promise<MomentArmSweep> {
  const { articulation, muscles, angles } = request;
  const swept = coordinateIndex(articulation, request.jointId, request.axisName);
  const held = (request.hold ?? []).map((h) => ({
    index: coordinateIndex(articulation, h.jointId, h.axisName),
    value: h.value,
  }));

  const backend = request.backend();
  const kernel = new Kernel({ rateHz: 500, seed: 1 });
  // Gravity off: the pose is imposed rather than balanced, and a body falling between the ticks
  // of one angle would make the sweep depend on how long each angle was held.
  kernel.register(new PhysicsModule(backend, articulation, { gravity: { x: 0, y: 0, z: 0 } }));
  kernel.register(new MusclePathModule(articulation, muscles));
  kernel.register(new MuscleDynamicsModule(articulation, muscles));
  const moment = new MuscleMomentModule(articulation, muscles);
  kernel.register(moment);
  await kernel.init();

  const buffers = allocateBuffers(articulation);
  backend.readJointState(buffers.jointState);
  const q = buffers.jointState.q;
  const qdot = buffers.jointState.qdot;
  qdot.fill(0);
  for (const hold of held) q[ROOT_NQ + hold.index] = hold.value;

  const arm = kernel.channels.storage(DIAGNOSTICS_MOMENT_ARM).fields.arm as Float64Array;
  const arms = moment.pairs.map(() => new Float64Array(angles.length));

  for (let a = 0; a < angles.length; a++) {
    for (let tick = 0; tick < TICKS_PER_POSE; tick++) {
      q[ROOT_NQ + swept] = angles[a] as number;
      qdot.fill(0);
      backend.writeJointState(q, qdot);
      kernel.run(1);
    }
    for (let p = 0; p < moment.pairs.length; p++) {
      (arms[p] as Float64Array)[a] = arm[p] as number;
    }
  }

  kernel.dispose();
  return { pairs: moment.pairs, angles, arms };
}

/** Degrees to radians, for callers stating a sweep the way published data states one. */
export function degrees(...values: number[]): number[] {
  return values.map((v) => (v * Math.PI) / 180);
}

/** A regular sweep from `from` to `to` degrees inclusive, in `step` degree increments. */
export function degreeRange(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let d = from; d <= to + 1e-9; d += step) out.push((d * Math.PI) / 180);
  return out;
}
