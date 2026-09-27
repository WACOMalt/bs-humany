/**
 * The connective tissue as geometry: what the overlay draws and the export writes.
 *
 * Everything in the simulation that is neither bone nor muscle has a shape here, derived from
 * the compiled articulation alone so the overlay, the replay and the Blender export agree:
 *
 * - a **disc** at every joint held by a `jointHold` on more than one axis (a spinal level), a
 *   flat cylinder in the joint frame, rigid in the parent segment;
 * - a **bead** at a one-axis hold (a costovertebral hinge), a small sphere, rigid in the parent;
 * - a **bar** of cartilage for every weld, between the two segments' nearest hull points at rest,
 *   one end rigid in each segment -- for a rib and the sternum that is the rib's front end and
 *   the sternum's edge, where the cartilage is.
 *
 * A disc or a bead moves with one segment, so it is a mesh on that segment's node. A bar moves
 * with two, so it is a skinned mesh with one end bound to each: the same shape the overlay
 * draws each frame from the two segments' poses. Couplings are constraints between joints, not
 * tissue, and the overlay draws them as threads; they are not exported.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import { type Quat, type Transform, type Vec3, rotate, transformPoint } from '@bs-humany/frames';

export const DISC_RADIUS = 0.014;
export const DISC_HEIGHT = 0.005;
export const BEAD_RADIUS = 0.006;
export const BAR_RADIUS = 0.004;

export interface TissueDisc {
  readonly kind: 'disc' | 'bead';
  readonly joint: number;
  /** The joint frame in its parent segment: where the disc sits and how it is turned. */
  readonly parentSegment: number;
  readonly frameInParent: Transform;
}

export interface TissueBar {
  readonly id: string;
  readonly a: number;
  readonly b: number;
  /** The ends, in each segment's own frame. */
  readonly onA: Vec3;
  readonly onB: Vec3;
}

export interface Tissue {
  readonly discs: readonly TissueDisc[];
  readonly bars: readonly TissueBar[];
}

const conjugate = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const distance2 = (a: Vec3, b: Vec3) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

/** The point of segment `a`'s hulls nearest segment `b`'s centre at rest, in `a`'s frame. */
function nearestHullPoint(model: CompiledArticulation, a: number, b: number): Vec3 {
  const segA = model.segments[a];
  const segB = model.segments[b];
  if (!segA || !segB) return { x: 0, y: 0, z: 0 };
  const targetWorld = transformPoint(segB.restWorld, segB.com);
  const target = rotate(
    conjugate(segA.restWorld.rotation),
    sub(targetWorld, segA.restWorld.translation),
  );
  let best: Vec3 | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const index of segA.proxyIndices) {
    const proxy = model.proxies[index];
    if (!proxy || proxy.shape.kind !== 'convexHull') continue;
    for (const v of proxy.shape.vertices) {
      const local = transformPoint(proxy.transform, v);
      const d = distance2(local, target);
      if (d < bestDistance) {
        bestDistance = d;
        best = local;
      }
    }
  }
  return best ?? segA.com;
}

/** The tissue of a compiled body. */
export function tissueOf(model: CompiledArticulation): Tissue {
  const held = new Map<number, number>();
  for (const c of model.constraints) {
    if (c.kind.type !== 'jointHold') continue;
    const joint = model.dofs[c.kind.dof]?.joint;
    if (joint !== undefined) held.set(joint, (held.get(joint) ?? 0) + 1);
  }
  const discs: TissueDisc[] = [];
  for (const [joint, count] of held) {
    const j = model.joints[joint];
    if (!j) continue;
    discs.push({
      kind: count > 1 ? 'disc' : 'bead',
      joint,
      parentSegment: j.parentSegment,
      frameInParent: j.frameInParent,
    });
  }
  const bars: TissueBar[] = [];
  for (const c of model.constraints) {
    if (c.kind.type !== 'weld') continue;
    const { segmentA, segmentB } = c.kind;
    bars.push({
      id: c.id,
      a: segmentA,
      b: segmentB,
      onA: nearestHullPoint(model, segmentA, segmentB),
      onB: nearestHullPoint(model, segmentB, segmentA),
    });
  }
  return { discs, bars };
}

// --- The table for the bridge -----------------------------------------------------------------

/** The tissue as the pose bridge's status carries it: every frame named by its anchor bone. */
export interface TissueTable {
  readonly discs: readonly {
    readonly bone: string;
    readonly kind: 'disc' | 'bead';
    readonly position: readonly [number, number, number];
    readonly rotation: readonly [number, number, number, number];
  }[];
  readonly bars: readonly {
    readonly boneA: string;
    readonly localA: readonly [number, number, number];
    readonly boneB: string;
    readonly localB: readonly [number, number, number];
  }[];
}

/**
 * The tissue in the terms a headset has: bone names rather than segment indices, since a
 * segment's frame is its anchor bone's, and the pose bridge names bones.
 */
export function tissueTable(model: CompiledArticulation): TissueTable {
  const tissue = tissueOf(model);
  return {
    discs: tissue.discs.map((d) => ({
      bone: model.segments[d.parentSegment]?.anchor ?? '',
      kind: d.kind,
      position: [
        d.frameInParent.translation.x,
        d.frameInParent.translation.y,
        d.frameInParent.translation.z,
      ],
      rotation: [
        d.frameInParent.rotation.x,
        d.frameInParent.rotation.y,
        d.frameInParent.rotation.z,
        d.frameInParent.rotation.w,
      ],
    })),
    bars: tissue.bars.map((b) => ({
      boneA: model.segments[b.a]?.anchor ?? '',
      localA: [b.onA.x, b.onA.y, b.onA.z],
      boneB: model.segments[b.b]?.anchor ?? '',
      localB: [b.onB.x, b.onB.y, b.onB.z],
    })),
  };
}

// --- Meshes ------------------------------------------------------------------------------------
//
// These shapes are the ones the overlay draws on screen with three.js (`overlays.ts` builds its
// disc and bead from the same radii, sides and rings), written out for the export, and the headset
// builds them again in `apps/xr-viewer/src/tissue.rs`. The three must change together: a disc
// given more sides here and not there is a joint that looks one way in the studio, another in the
// room and a third in Blender. They stay private copies, with their own small vector helpers
// below, because the Rust one cannot import these and a shared module would hide that mirror.

export interface TissueMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/** A closed cylinder along local Y, centred at the origin. */
export function cylinderMesh(radius: number, height: number, sides = 16): TissueMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const h = height / 2;
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    positions.push(radius * Math.cos(a), h, radius * Math.sin(a));
    positions.push(radius * Math.cos(a), -h, radius * Math.sin(a));
  }
  const top = positions.length / 3;
  positions.push(0, h, 0);
  const bottom = top + 1;
  positions.push(0, -h, 0);
  for (let i = 0; i < sides; i++) {
    const n = (i + 1) % sides;
    const a0 = 2 * i;
    const a1 = 2 * i + 1;
    const b0 = 2 * n;
    const b1 = 2 * n + 1;
    indices.push(a0, b0, a1, b0, b1, a1);
    indices.push(top, b0, a0);
    indices.push(bottom, a1, b1);
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** A sphere centred at the origin. */
export function sphereMesh(radius: number, rings = 6, sides = 8): TissueMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (Math.PI * r) / rings;
    for (let s = 0; s <= sides; s++) {
      const theta = (2 * Math.PI * s) / sides;
      positions.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta),
      );
    }
  }
  const row = sides + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < sides; s++) {
      const a = r * row + s;
      const b = a + row;
      // Outward: round the ring, then down to the next one.
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/**
 * A bar between two points: a thin prism whose first `sides` vertices are at one end and the
 * next `sides` at the other, so a skin can bind each end to its own segment.
 */
export function barMesh(from: Vec3, to: Vec3, radius = BAR_RADIUS, sides = 6): TissueMesh {
  const axis = sub(to, from);
  const length = Math.hypot(axis.x, axis.y, axis.z) || 1;
  const n = { x: axis.x / length, y: axis.y / length, z: axis.z / length };
  // Two directions across the bar.
  const pick = Math.abs(n.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = normalize(cross(n, pick));
  const v = cross(n, u);
  const positions: number[] = [];
  for (const end of [from, to]) {
    for (let i = 0; i < sides; i++) {
      const a = (2 * Math.PI * i) / sides;
      const c = Math.cos(a) * radius;
      const s = Math.sin(a) * radius;
      positions.push(
        end.x + u.x * c + v.x * s,
        end.y + u.y * c + v.y * s,
        end.z + u.z * c + v.z * s,
      );
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    // Outward: round the near end, then along to the far one.
    indices.push(i, j, sides + i, j, sides + j, sides + i);
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize(a: Vec3): Vec3 {
  const n = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / n, y: a.y / n, z: a.z / n };
}
