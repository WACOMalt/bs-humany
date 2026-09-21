/**
 * What the nerves can feel: the observation a policy sees, built each control step from the
 * channels the body already publishes.
 *
 * Nothing here is invented for the controller; every number is one the simulation carries
 * anyway. Joint angles and rates are proprioception. The pelvis's sense of down and of its own
 * motion is the body's stable reference for standing, and the head's is the vestibular one --
 * the otoliths and the canals sit in the skull, and the balance task is scored on the head, so
 * the controller is given the quantity it is graded on. The feet's contact is the sole.
 *
 * The muscles give the three afferents section 14.1 of the specification names. Fibre length
 * past optimal is the spindle's group II, length-sensitive. Fibre velocity is its group Ia,
 * velocity-sensitive, and it is the damping term a feedback law needs: without it a controller
 * can know it is leaning but not how fast. Tendon force is the Golgi organ's Ib, the sense of
 * load, which is how a body knows it is bearing weight. Activation is not an afferent at all --
 * it is efference copy, what was last asked of the muscle.
 *
 * And the goal -- what the person wants the body doing -- is appended, so one policy can be
 * told to stand or to walk.
 *
 * Everything is scaled to land within a few units of zero, because a network is trained more
 * easily when its inputs are.
 *
 * Every sense has a name, and the joint senses are named by joint and axis rather than by slot,
 * because the slots move between fidelity profiles and the names mostly do not: a lumbar joint
 * at L1 is the same lumbar joint at L3, with a few more vertebrae beside it. A policy is matched
 * to a body by these names, so one trained on a lower profile carries onto a higher one and the
 * senses the higher one adds start from nothing. The feet are found the same way, by name, so
 * that a foot split into talus and toes still reads as a foot.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import type { ChannelView } from '@bs-humany/kernel';
import type { CompiledMuscleSet } from '@bs-humany/modules-muscle';

/** Which segments are feet, by id, for the contact features. */
export interface Feet {
  readonly left: readonly string[];
  readonly right: readonly string[];
}

/**
 * The segments of each foot, whatever the profile: a segment is a foot if it, or a segment
 * above it, is the foot itself (L0 to L2) or the talus (L3, where the foot is several bones).
 */
export function feetOf(articulation: CompiledArticulation): Feet {
  const segments = articulation.segments;
  const side = (id: string): 'l' | 'r' | undefined =>
    /^(foot|talus)_l$/.test(id) ? 'l' : /^(foot|talus)_r$/.test(id) ? 'r' : undefined;
  const left: string[] = [];
  const right: string[] = [];
  for (const segment of segments) {
    let at: number = segment.index;
    let found: 'l' | 'r' | undefined;
    while (at >= 0 && !found) {
      const s = segments[at];
      if (!s) break;
      found = side(s.id);
      at = s.parent;
    }
    if (found === 'l') left.push(segment.id);
    else if (found === 'r') right.push(segment.id);
  }
  return { left, right };
}

export interface ObservationChannels {
  readonly pose: ChannelView;
  readonly velocity: ChannelView;
  readonly joints: ChannelView;
  readonly contacts: ChannelView;
  readonly muscles: ChannelView;
}

/** Root free joint first in `q` (3 + 4) and `qdot` (3 + 3), as the compiler emits it. */
const ROOT_NQ = 7;
const ROOT_NV = 6;

export class ObservationBuilder {
  /** Known once bound: the joints' count is the backend's. */
  names: string[] = [];
  size = 0;
  private readonly pelvis: number;
  private readonly head: number;
  private readonly leftFeet: number[];
  private readonly rightFeet: number[];
  private readonly goalSize: number;
  private channels: ObservationChannels | undefined;

  /** Per group: the unit indices in it; and every unit's optimal fibre length. */
  private readonly groupUnits: Int32Array[];
  private readonly groupIds: readonly string[];
  private readonly optimal: Float64Array;
  /** Per unit: the force at which the tendon reads 1, and the speed at which velocity reads 1. */
  private readonly maxForce: Float64Array;
  /** Every joint degree of freedom by name, in slot order: `<joint>:<axis>`. */
  private readonly dofNames: readonly string[];

  constructor(
    articulation: CompiledArticulation,
    muscles: CompiledMuscleSet,
    feet: Feet | undefined,
    goalSize: number,
    groups: readonly { readonly id: string; readonly units: readonly { readonly id: string }[] }[],
  ) {
    const index = new Map(articulation.segments.map((s) => [s.id, s.index]));
    this.pelvis = index.get('pelvis') ?? 0;
    this.head = index.get('head') ?? this.pelvis;
    const soles = feet ?? feetOf(articulation);
    this.leftFeet = soles.left.map((id) => index.get(id) ?? -1).filter((i) => i >= 0);
    this.rightFeet = soles.right.map((id) => index.get(id) ?? -1).filter((i) => i >= 0);
    const dofs: string[] = [];
    for (const joint of articulation.joints) {
      for (const dof of joint.dofs) dofs[dof.index] = `${joint.id}:${dof.axisName}`;
    }
    this.dofNames = dofs;
    this.goalSize = goalSize;
    const unitIndex = new Map(muscles.units.map((u, i) => [u.id, i]));
    this.groupIds = groups.map((g) => g.id);
    this.groupUnits = groups.map((g) =>
      Int32Array.from(g.units.map((u) => unitIndex.get(u.id) ?? -1).filter((i) => i >= 0)),
    );
    this.optimal = Float64Array.from(muscles.units, (u) => u.parameters.optimalFiberLength || 0.1);
    this.maxForce = Float64Array.from(muscles.units, (u) => u.parameters.maxIsometricForce || 1);
  }

  bind(channels: ObservationChannels): void {
    this.channels = channels;
    const nq = (channels.joints.fields.q as Float64Array).length;
    const nv = (channels.joints.fields.qdot as Float64Array).length;
    if (nq - ROOT_NQ !== this.dofNames.length || nv - ROOT_NV !== this.dofNames.length) {
      throw new Error(
        `The body has ${this.dofNames.length} joint degrees of freedom but publishes q of ${nq} and qdot of ${nv}.`,
      );
    }
    const names: string[] = [];
    for (const dof of this.dofNames) names.push(`angle:${dof}`);
    for (const dof of this.dofNames) names.push(`rate:${dof}`);
    names.push('pelvis.down.x', 'pelvis.down.y', 'pelvis.down.z');
    names.push('pelvis.spin.x', 'pelvis.spin.y', 'pelvis.spin.z');
    names.push('pelvis.velocity.x', 'pelvis.velocity.y', 'pelvis.velocity.z');
    names.push('pelvis.height', 'head.height');
    // The vestibular sense proper, in the head's own frame: where down is, and how the skull
    // turns. The canals report rotation and the otoliths the pull of gravity; both are here.
    names.push('head.down.x', 'head.down.y', 'head.down.z');
    names.push('head.spin.x', 'head.spin.y', 'head.spin.z');
    names.push('foot.left.contacts', 'foot.left.load', 'foot.right.contacts', 'foot.right.load');
    for (const id of this.groupIds) names.push(`activation:${id}`);
    for (const id of this.groupIds) names.push(`stretch:${id}`);
    for (const id of this.groupIds) names.push(`shorten:${id}`);
    for (const id of this.groupIds) names.push(`load:${id}`);
    for (let g = 0; g < this.goalSize; g++) names.push(`goal[${g}]`);
    this.names = names;
    this.size = names.length;
  }

  /** Fill `out` (of `size`) from the channels as they stand, with `goal` appended. */
  fill(out: Float64Array, goal: ArrayLike<number>): void {
    const c = this.channels;
    if (!c) throw new Error('ObservationBuilder.fill before bind.');
    let at = 0;
    const q = c.joints.fields.q as Float64Array;
    const qdot = c.joints.fields.qdot as Float64Array;
    for (let i = ROOT_NQ; i < q.length; i++) out[at++] = q[i] as number;
    for (let i = ROOT_NV; i < qdot.length; i++) out[at++] = 0.1 * (qdot[i] as number);

    // The pelvis: world down, its angular and linear velocity, all in its own frame.
    const position = c.pose.fields.position as Float64Array;
    const orientation = c.pose.fields.orientation as Float64Array;
    const linear = c.velocity.fields.linear as Float64Array;
    const angular = c.velocity.fields.angular as Float64Array;
    const p = this.pelvis;
    const qx = orientation[4 * p] as number;
    const qy = orientation[4 * p + 1] as number;
    const qz = orientation[4 * p + 2] as number;
    const qw = orientation[4 * p + 3] as number;
    const into = (vx: number, vy: number, vz: number): [number, number, number] => {
      // conj(q) * v * q
      const ix = qw * vx - qy * vz + qz * vy;
      const iy = qw * vy - qz * vx + qx * vz;
      const iz = qw * vz - qx * vy + qy * vx;
      const iw = qx * vx + qy * vy + qz * vz;
      return [
        ix * qw + iw * qx - iy * qz + iz * qy,
        iy * qw + iw * qy - iz * qx + ix * qz,
        iz * qw + iw * qz - ix * qy + iy * qx,
      ];
    };
    const down = into(0, -1, 0);
    const spin = into(
      angular[3 * p] as number,
      angular[3 * p + 1] as number,
      angular[3 * p + 2] as number,
    );
    const move = into(
      linear[3 * p] as number,
      linear[3 * p + 1] as number,
      linear[3 * p + 2] as number,
    );
    out[at++] = down[0];
    out[at++] = down[1];
    out[at++] = down[2];
    out[at++] = 0.2 * spin[0];
    out[at++] = 0.2 * spin[1];
    out[at++] = 0.2 * spin[2];
    out[at++] = move[0];
    out[at++] = move[1];
    out[at++] = move[2];
    out[at++] = position[3 * p + 1] as number;
    out[at++] = position[3 * this.head + 1] as number;

    // The vestibular sense: down and spin in the head's frame, by the head's own quaternion.
    const h0 = this.head;
    const hqx = orientation[4 * h0] as number;
    const hqy = orientation[4 * h0 + 1] as number;
    const hqz = orientation[4 * h0 + 2] as number;
    const hqw = orientation[4 * h0 + 3] as number;
    const intoHead = (vx: number, vy: number, vz: number): [number, number, number] => {
      const ix = hqw * vx - hqy * vz + hqz * vy;
      const iy = hqw * vy - hqz * vx + hqx * vz;
      const iz = hqw * vz - hqx * vy + hqy * vx;
      const iw = hqx * vx + hqy * vy + hqz * vz;
      return [
        ix * hqw + iw * hqx - iy * hqz + iz * hqy,
        iy * hqw + iw * hqy - iz * hqx + ix * hqz,
        iz * hqw + iw * hqz - ix * hqy + iy * hqx,
      ];
    };
    const headDown = intoHead(0, -1, 0);
    const headSpin = intoHead(
      angular[3 * h0] as number,
      angular[3 * h0 + 1] as number,
      angular[3 * h0 + 2] as number,
    );
    out[at++] = headDown[0];
    out[at++] = headDown[1];
    out[at++] = headDown[2];
    out[at++] = 0.2 * headSpin[0];
    out[at++] = 0.2 * headSpin[1];
    out[at++] = 0.2 * headSpin[2];

    // The feet: how many contacts each has, and the impulse they carry, scaled.
    const pair = c.contacts.fields.pair as Int32Array;
    const impulse = c.contacts.fields.impulse as Float64Array;
    let leftCount = 0;
    let leftLoad = 0;
    let rightCount = 0;
    let rightLoad = 0;
    // The channel is dynamic: its count is live and its arrays are its capacity. A count past
    // the capacity, or an impulse the backend left unset, must not become a NaN in the brain.
    const contacts = Math.min(c.contacts.count, impulse.length, pair.length >> 1);
    for (let i = 0; i < contacts; i++) {
      const a = pair[2 * i] as number;
      const b = pair[2 * i + 1] as number;
      const raw = impulse[i] as number;
      const j = Number.isFinite(raw) ? raw : 0;
      if (this.leftFeet.includes(a) || this.leftFeet.includes(b)) {
        leftCount += 1;
        leftLoad += j;
      }
      if (this.rightFeet.includes(a) || this.rightFeet.includes(b)) {
        rightCount += 1;
        rightLoad += j;
      }
    }
    out[at++] = Math.min(1, leftCount / 8);
    out[at++] = Math.min(2, leftLoad);
    out[at++] = Math.min(1, rightCount / 8);
    out[at++] = Math.min(2, rightLoad);

    // Muscles by group: the mean activation, and the mean stretch past optimal, of the units in
    // each. A stretch of 0 is a fibre at its optimal length; 0.5 is half again as long. Per
    // group rather than per unit, because a hundred and forty-eight of each swamped the rest,
    // and fibre lengths scaled tenfold saturated the first policy before it sensed anything.
    const activation = c.muscles.fields.activation as Float64Array;
    const fibre = c.muscles.fields.fiberLength as Float64Array;
    for (const units of this.groupUnits) {
      let sum = 0;
      for (let k = 0; k < units.length; k++) sum += activation[units[k] as number] as number;
      out[at++] = units.length ? sum / units.length : 0;
    }
    for (const units of this.groupUnits) {
      let sum = 0;
      for (let k = 0; k < units.length; k++) {
        const u = units[k] as number;
        sum += (fibre[u] as number) / (this.optimal[u] as number) - 1;
      }
      out[at++] = units.length ? Math.max(-1, Math.min(2, sum / units.length)) : 0;
    }
    // Ia: how fast the fibres are changing length, already in optimal lengths a second over the
    // maximum contraction velocity, so it lands near [-1, 1]. Negative is shortening.
    const speed = c.muscles.fields.fiberVelocity as Float64Array | undefined;
    for (const units of this.groupUnits) {
      let sum = 0;
      if (speed) {
        for (let k = 0; k < units.length; k++) {
          const raw = speed[units[k] as number] as number;
          sum += Number.isFinite(raw) ? raw : 0;
        }
      }
      out[at++] = units.length ? Math.max(-2, Math.min(2, sum / units.length)) : 0;
    }
    // Ib: the load the tendon carries, as a share of what the unit makes fully activated at its
    // optimal length. Past 1 is a tendon pulled harder than the fibres could pull it.
    const pull = c.muscles.fields.tendonForce as Float64Array | undefined;
    for (const units of this.groupUnits) {
      let sum = 0;
      if (pull) {
        for (let k = 0; k < units.length; k++) {
          const u = units[k] as number;
          const raw = (pull[u] as number) / (this.maxForce[u] as number);
          sum += Number.isFinite(raw) ? raw : 0;
        }
      }
      out[at++] = units.length ? Math.max(-1, Math.min(3, sum / units.length)) : 0;
    }
    for (let g = 0; g < this.goalSize; g++) out[at++] = goal[g] ?? 0;
  }
}
