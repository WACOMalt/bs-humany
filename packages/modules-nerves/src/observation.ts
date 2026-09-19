/**
 * What the nerves can feel: the observation a policy sees, built each control step from the
 * channels the body already publishes.
 *
 * Nothing here is invented for the controller; every number is one the simulation carries
 * anyway. Joint angles and rates are proprioception. The pelvis's sense of down and of its own
 * motion is what the otoliths and canals give, taken from the pelvis rather than the head so
 * that standing has a stable reference. The feet's contact is the sole. The muscles' activation
 * and fibre length are the spindles and Golgi organs, roughly. And the goal -- what the person
 * wants the body doing -- is appended, so one policy can be told to stand or to walk.
 *
 * Everything is scaled to land within a few units of zero, because a network is trained more
 * easily when its inputs are.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import type { ChannelView } from '@bs-humany/kernel';
import type { CompiledMuscleSet } from '@bs-humany/modules-muscle';

/** Which segments are feet, by id, for the contact features. */
export interface Feet {
  readonly left: readonly string[];
  readonly right: readonly string[];
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

  constructor(
    articulation: CompiledArticulation,
    muscles: CompiledMuscleSet,
    feet: Feet,
    goalSize: number,
    groups: readonly { readonly id: string; readonly units: readonly { readonly id: string }[] }[],
  ) {
    const index = new Map(articulation.segments.map((s) => [s.id, s.index]));
    this.pelvis = index.get('pelvis') ?? 0;
    this.head = index.get('head') ?? this.pelvis;
    this.leftFeet = feet.left.map((id) => index.get(id) ?? -1).filter((i) => i >= 0);
    this.rightFeet = feet.right.map((id) => index.get(id) ?? -1).filter((i) => i >= 0);
    this.goalSize = goalSize;
    const unitIndex = new Map(muscles.units.map((u, i) => [u.id, i]));
    this.groupIds = groups.map((g) => g.id);
    this.groupUnits = groups.map((g) =>
      Int32Array.from(g.units.map((u) => unitIndex.get(u.id) ?? -1).filter((i) => i >= 0)),
    );
    this.optimal = Float64Array.from(muscles.units, (u) => u.parameters.optimalFiberLength || 0.1);
  }

  bind(channels: ObservationChannels): void {
    this.channels = channels;
    const nq = (channels.joints.fields.q as Float64Array).length;
    const nv = (channels.joints.fields.qdot as Float64Array).length;
    const names: string[] = [];
    for (let i = ROOT_NQ; i < nq; i++) names.push(`q[${i}]`);
    for (let i = ROOT_NV; i < nv; i++) names.push(`qdot[${i}]`);
    names.push('pelvis.down.x', 'pelvis.down.y', 'pelvis.down.z');
    names.push('pelvis.spin.x', 'pelvis.spin.y', 'pelvis.spin.z');
    names.push('pelvis.velocity.x', 'pelvis.velocity.y', 'pelvis.velocity.z');
    names.push('pelvis.height', 'head.height');
    names.push('foot.left.contacts', 'foot.left.load', 'foot.right.contacts', 'foot.right.load');
    for (const id of this.groupIds) names.push(`activation:${id}`);
    for (const id of this.groupIds) names.push(`stretch:${id}`);
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
    for (let g = 0; g < this.goalSize; g++) out[at++] = goal[g] ?? 0;
  }
}
