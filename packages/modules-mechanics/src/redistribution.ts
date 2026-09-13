/**
 * Kinematic redistribution -- spec section 4.3, the pure function behind M3.8.
 *
 * A segment that lumps an articulated region keeps its followers rigid, so the bend at its parent
 * joint shows as one crease. Redistribution spreads that joint's deflection along the chain of
 * follower bones between the joint and the segment's anchor: each bone takes the cumulative share
 * of the deflection reached at its level, so a lumbar block flexing 30 degrees at L5/S1 shows a
 * curve of 10, 20 and 30 degrees at L5, L4 and L3 instead of 30 at L5 and nothing after.
 *
 * It is cosmetic. The anchor keeps exactly the pose the solver gave it (its share is 1), mass
 * properties never see it, and it is a pure function of segment poses and joint coordinates, so
 * it can be tested on its own and switched off.
 *
 * Bones on the far side of the anchor, and bones hanging off a chain bone (ribs on a vertebra),
 * take the share of their nearest chain ancestor, or 1 where they have none. The crease between
 * two lumped regions is therefore smoothed on the child segment's side only.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import type { BoneDef, RedistributionWeights } from '@bs-humany/hsdl';
import { qConj, qFromAxisAngle, qMul, qRotate, qSet, tCompose } from './qmath.js';

export interface RedistributionPlan {
  /** Bone ids in output order. */
  readonly bones: readonly string[];
  readonly segmentOf: Int32Array;
  /** Rest transform relative to the segment anchor, 7 per bone (p3 q4). */
  readonly local: Float64Array;
  /** Compiled joint index whose deflection is redistributed onto the bone, or -1. */
  readonly jointOf: Int32Array;
  /** Offset into `shares` of the bone's per-DoF share, or -1. */
  readonly shareOffset: Int32Array;
  /** Cumulative share in [0, 1] of the joint's deflection, per DoF. */
  readonly shares: Float64Array;
  /** Per joint: DoF vectors in the joint frame, 3 per DoF, at `axisOffset[joint]`. */
  readonly axes: Float64Array;
  readonly axisOffset: Int32Array;
  readonly dofCount: Int32Array;
  readonly dofStart: Int32Array;
  readonly parentSegment: Int32Array;
  /** Per joint: frame in the parent segment, 7 scalars. */
  readonly frameInParent: Float64Array;
}

/** Which weight a DoF draws on, by its semantic axis name. */
function weightFor(weights: RedistributionWeights | undefined, axisName: string): number {
  if (!weights) return 1;
  if (axisName.startsWith('flexion') || axisName.endsWith('flexion')) return weights.flexion ?? 1;
  if (axisName.startsWith('lateral_bending')) return weights.lateralBending ?? 1;
  if (axisName.startsWith('axial_rotation')) return weights.axialRotation ?? 1;
  return 1;
}

export function planRedistribution(
  bones: readonly BoneDef[],
  model: CompiledArticulation,
): RedistributionPlan {
  const byId = new Map(bones.map((b) => [b.id, b]));
  const ids = bones.map((b) => b.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const segmentOf = new Int32Array(ids.length).fill(-1);
  const local = new Float64Array(7 * ids.length);
  const jointOf = new Int32Array(ids.length).fill(-1);
  const shareOffset = new Int32Array(ids.length).fill(-1);
  const shares: number[] = [];

  // Joint tables.
  const axisOffset = new Int32Array(model.joints.length);
  const dofCount = new Int32Array(model.joints.length);
  const dofStart = new Int32Array(model.joints.length);
  const parentSegment = new Int32Array(model.joints.length);
  const frameInParent = new Float64Array(7 * model.joints.length);
  const axes: number[] = [];
  model.joints.forEach((j, k) => {
    axisOffset[k] = axes.length;
    dofCount[k] = j.dofs.length;
    dofStart[k] = j.dofStart;
    parentSegment[k] = j.parentSegment;
    for (const d of j.dofs) axes.push(d.vector.x, d.vector.y, d.vector.z);
    const t = j.frameInParent;
    frameInParent.set(
      [
        t.translation.x,
        t.translation.y,
        t.translation.z,
        t.rotation.x,
        t.rotation.y,
        t.rotation.z,
        t.rotation.w,
      ],
      7 * k,
    );
  });
  const parentJointOf = new Map<number, number>();
  model.joints.forEach((j, k) => parentJointOf.set(j.childSegment, k));

  for (const segment of model.segments) {
    const anchorIndex = index.get(segment.anchor);
    if (anchorIndex === undefined)
      throw new Error(`Anchor '${segment.anchor}' is not a document bone.`);
    segmentOf[anchorIndex] = segment.index;
    local.set([0, 0, 0, 0, 0, 0, 1], 7 * anchorIndex);
    for (const f of segment.followers) {
      const bi = index.get(f.bone);
      if (bi === undefined) throw new Error(`Follower '${f.bone}' is not a document bone.`);
      segmentOf[bi] = segment.index;
      const t = f.local;
      local.set(
        [
          t.translation.x,
          t.translation.y,
          t.translation.z,
          t.rotation.x,
          t.rotation.y,
          t.rotation.z,
          t.rotation.w,
        ],
        7 * bi,
      );
    }

    const joint = parentJointOf.get(segment.index);
    if (joint === undefined) continue;
    const compiled = model.joints[joint];
    if (!compiled) continue;
    const jointChild = compiled.childBone;

    // The chain from the joint's child bone up the anatomical tree to the anchor.
    const chain: string[] = [];
    let cursor: string | undefined = segment.anchor;
    const owned = new Set(segment.bones);
    while (cursor !== undefined && owned.has(cursor)) {
      chain.unshift(cursor);
      if (cursor === jointChild) break;
      cursor = byId.get(cursor)?.parent ?? undefined;
    }
    if (chain[0] !== jointChild || chain.length < 2) continue;

    // Cumulative shares per DoF along the chain.
    const n = compiled.dofs.length;
    const chainShare = new Map<string, number[]>();
    const totals = compiled.dofs.map((d) =>
      chain.reduce((sum, id) => sum + weightFor(byId.get(id)?.redistribution, d.axisName), 0),
    );
    const running = new Array<number>(n).fill(0);
    for (const id of chain) {
      const s: number[] = [];
      compiled.dofs.forEach((d, i) => {
        running[i] = (running[i] ?? 0) + weightFor(byId.get(id)?.redistribution, d.axisName);
        const total = totals[i] ?? 0;
        s.push(total > 0 ? (running[i] ?? 0) / total : 1);
      });
      chainShare.set(id, s);
    }

    // Every bone in the segment takes its nearest chain ancestor's share.
    for (const id of segment.bones) {
      let probe: string | undefined = id;
      let share: number[] | undefined;
      while (probe !== undefined) {
        share = chainShare.get(probe);
        if (share) break;
        probe = byId.get(probe)?.parent ?? undefined;
        if (probe !== undefined && !owned.has(probe)) break;
      }
      if (!share || share.every((v) => v >= 1)) continue;
      const bi = index.get(id);
      if (bi === undefined) continue;
      jointOf[bi] = joint;
      shareOffset[bi] = shares.length;
      shares.push(...share);
    }
  }

  const unowned = ids.filter((_, i) => segmentOf[i] === -1);
  if (unowned.length > 0) {
    throw new Error(`Bones outside every segment of '${model.profileId}': ${unowned.join(', ')}.`);
  }

  return {
    bones: ids,
    segmentOf,
    local,
    jointOf,
    shareOffset,
    shares: Float64Array.from(shares),
    axes: Float64Array.from(axes),
    axisOffset,
    dofCount,
    dofStart,
    parentSegment,
    frameInParent,
  };
}

// Scratch for the step function. Module-level so no step allocates.
const anchor = new Float64Array(7);
const jointWorld = new Float64Array(7 * 64);
const fullConj = new Float64Array(4 * 64);
const rq = new Float64Array(4);
const partial = new Float64Array(4);
const delta = new Float64Array(4);
const tmp = new Float64Array(7);
const world = new Float64Array(7);
const rel = new Float64Array(3);

/**
 * Pose every bone from segment poses and joint coordinates.
 *
 * `position`/`orientation` are the `body.pose` fields (3N, 4N); `q` is `body.jointState.q`
 * with the root's seven scalars first; `outPosition`/`outOrientation` receive 3B and 4B values
 * in the plan's bone order. Allocation-free.
 */
export function poseBones(
  plan: RedistributionPlan,
  position: Float64Array,
  orientation: Float64Array,
  q: Float64Array,
  rootNq: number,
  outPosition: Float64Array,
  outOrientation: Float64Array,
  redistribute = true,
): void {
  const joints = plan.dofCount.length;
  if (joints > 64) throw new RangeError('poseBones supports at most 64 joints.');
  // Joint frames in world, and the conjugate of the full joint rotation R(q).
  for (let k = 0; k < joints; k++) {
    const ps = plan.parentSegment[k] as number;
    anchor[0] = position[3 * ps] as number;
    anchor[1] = position[3 * ps + 1] as number;
    anchor[2] = position[3 * ps + 2] as number;
    anchor[3] = orientation[4 * ps] as number;
    anchor[4] = orientation[4 * ps + 1] as number;
    anchor[5] = orientation[4 * ps + 2] as number;
    anchor[6] = orientation[4 * ps + 3] as number;
    tCompose(jointWorld, 7 * k, anchor, 0, plan.frameInParent, 7 * k);
    jointRotation(plan, k, q, rootNq, null, rq);
    qConj(fullConj, 4 * k, rq, 0);
  }

  for (let b = 0; b < plan.bones.length; b++) {
    const s = plan.segmentOf[b] as number;
    anchor[0] = position[3 * s] as number;
    anchor[1] = position[3 * s + 1] as number;
    anchor[2] = position[3 * s + 2] as number;
    anchor[3] = orientation[4 * s] as number;
    anchor[4] = orientation[4 * s + 1] as number;
    anchor[5] = orientation[4 * s + 2] as number;
    anchor[6] = orientation[4 * s + 3] as number;
    tCompose(world, 0, anchor, 0, plan.local, 7 * b);

    const k = plan.jointOf[b] as number;
    if (redistribute && k >= 0) {
      // Rotation to apply about the joint centre, in world: P R(c∘q) R(q)^-1 P^-1.
      jointRotation(plan, k, q, rootNq, plan.shareOffset[b] as number, partial);
      qMul(partial, 0, partial, 0, fullConj, 4 * k);
      qMul(delta, 0, jointWorld, 7 * k + 3, partial, 0);
      qConj(tmp, 0, jointWorld, 7 * k + 3);
      qMul(delta, 0, delta, 0, tmp, 0);
      rel[0] = (world[0] as number) - (jointWorld[7 * k] as number);
      rel[1] = (world[1] as number) - (jointWorld[7 * k + 1] as number);
      rel[2] = (world[2] as number) - (jointWorld[7 * k + 2] as number);
      qRotate(tmp, 0, delta, 0, rel, 0);
      world[0] = (tmp[0] as number) + (jointWorld[7 * k] as number);
      world[1] = (tmp[1] as number) + (jointWorld[7 * k + 1] as number);
      world[2] = (tmp[2] as number) + (jointWorld[7 * k + 2] as number);
      qMul(world, 3, delta, 0, world, 3);
    }

    outPosition[3 * b] = world[0] as number;
    outPosition[3 * b + 1] = world[1] as number;
    outPosition[3 * b + 2] = world[2] as number;
    outOrientation[4 * b] = world[3] as number;
    outOrientation[4 * b + 1] = world[4] as number;
    outOrientation[4 * b + 2] = world[5] as number;
    outOrientation[4 * b + 3] = world[6] as number;
  }
}

/** R(a_1, s_1 q_1) ... R(a_n, s_n q_n) in the joint frame; shares of null mean 1. */
function jointRotation(
  plan: RedistributionPlan,
  joint: number,
  q: Float64Array,
  rootNq: number,
  shareOffset: number | null,
  out: Float64Array,
): void {
  qSet(out, 0, 0, 0, 0, 1);
  const n = plan.dofCount[joint] as number;
  const a = plan.axisOffset[joint] as number;
  const start = plan.dofStart[joint] as number;
  for (let i = 0; i < n; i++) {
    const share = shareOffset === null ? 1 : (plan.shares[shareOffset + i] as number);
    const angle = share * (q[rootNq + start + i] as number);
    qFromAxisAngle(
      tmp,
      0,
      plan.axes[a + 3 * i] as number,
      plan.axes[a + 3 * i + 1] as number,
      plan.axes[a + 3 * i + 2] as number,
      angle,
    );
    qMul(out, 0, out, 0, tmp, 0);
  }
}
