/**
 * Collision proxies and default exclusion pairs -- milestones M3.3 and M5.8.
 *
 * ADR-006: collision geometry is never anatomical geometry. Every segment of every profile gets
 * the convex decomposition of the bones it owns, computed offline by `tools/ingest` (CoACD) and
 * read from the assets package's hull table: a long bone is a piece or two plus its head, a
 * pelvis or a rib cage is a dozen pieces. The pieces are the bones' own vertices, so they follow
 * an oblique bone's orientation and scale with stature exactly as the bone placement does.
 * Nothing here reads a mesh at runtime.
 *
 * A segment whose bone set has no entry in the hull table (a profile edited since the table was
 * generated) falls back to one primitive fitted to the bones' measured bounds -- a capsule where
 * the segment is elongated, a box otherwise -- and says so in its provenance, so the fallback
 * cannot pass for the real thing.
 *
 * ## Exclusion pairs
 *
 * Adjacent segments interpenetrate at their joint by design and the compiler excludes every
 * parent/child pair itself. This module generates the *other* exclusions: pairs of segments that
 * are not joined but whose proxies already overlap in the rest pose -- scapula against ribs, the
 * ulna's distal end inside the hand box. Each is found by measurement at the dataset pose, not
 * typed by hand, and the overlap depth is recorded on the rule so the list can be audited.
 */

import { type Quat, fromAxisAngle, vec3 } from '@bs-humany/frames';
import {
  type CollisionProxy,
  type ContactRuleDef,
  type JointDef,
  type ScalarExpr,
  type SegmentationDef,
  moduleNamespace,
  mul,
  param,
  writeExtension,
} from '@bs-humany/hsdl';
import { DATASET_MANIFEST } from './dataset.js';
import { HULL_GROUPS, HULL_TABLE, type HullGroup, hullGroupKey } from './hulls.js';

type P3 = readonly [number, number, number];
type Axis = 0 | 1 | 2;

export const PROXY_NS = moduleNamespace('proxy');

/**
 * Longest-to-next extent ratio above which a segment is a capsule rather than a box. Limb
 * segments sit well above it, the trunk, hands and feet well below; nothing measured is near it.
 */
export const CAPSULE_ASPECT = 1.6;

/**
 * Segments that are boxes whatever their aspect: the plates of the hands and feet. A foot is
 * elongated enough to pass the capsule test, but a capsule foot stands on a ridge and rolls; the
 * ground wants a face.
 */
export const BOX_SEGMENTS = /^(hand|foot|toes|hindfoot|midfoot|forefoot)_[lr]$/;

export interface ProxyProvenance {
  /** Profiles whose segment of this id shares exactly this bone set. */
  readonly profiles: readonly string[];
  readonly segment: string;
  readonly bones: readonly string[];
  /** World-axis-aligned bounds at the dataset pose, metres. */
  readonly min: P3;
  readonly max: P3;
  readonly rule: string;
  /** Present on a convex-hull piece: which piece of how many, and its vertex count. */
  readonly hull?: { readonly index: number; readonly count: number; readonly vertices: number };
}

interface Bounds {
  readonly min: P3;
  readonly max: P3;
}

const packed = new Map(DATASET_MANIFEST.bones.map((b) => [b.id, b]));

/** Union bounds of a segment's packed bones; bones the pack lacks (the ossicles) do not count. */
function segmentBounds(bones: readonly string[]): Bounds | undefined {
  let min: [number, number, number] | undefined;
  let max: [number, number, number] | undefined;
  for (const id of bones) {
    const b = packed.get(id);
    if (!b) continue;
    if (!min || !max) {
      min = [...b.min];
      max = [...b.max];
      continue;
    }
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i] ?? 0, b.min[i] ?? 0);
      max[i] = Math.max(max[i] ?? 0, b.max[i] ?? 0);
    }
  }
  return min && max ? { min, max } : undefined;
}

const ofStature = (metres: number): ScalarExpr =>
  mul(metres / DATASET_MANIFEST.subjectStature, param('stature'));

/** Rotation taking the proxy's local +Y (the capsule axis) onto a world axis. */
function axisRotation(axis: Axis): Quat {
  if (axis === 1) return { x: 0, y: 0, z: 0, w: 1 };
  return axis === 0
    ? fromAxisAngle(vec3(0, 0, 1), -Math.PI / 2)
    : fromAxisAngle(vec3(1, 0, 0), Math.PI / 2);
}

/** A segment's fitted proxies plus the world-space bounds they occupy, for the overlap test. */
interface Fitted {
  readonly proxies: CollisionProxy[];
  readonly occupies: Bounds;
}

/** The hull pieces of a group as proxies in the anchor frame, scaled by stature at compile. */
function hullProxies(
  id: string,
  segment: SegmentationDef['segments'][number],
  group: HullGroup,
  bounds: Bounds,
  anchor: { readonly centroid: P3 },
): Fitted {
  const min: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  const { maxVertices } = HULL_TABLE.parameters;
  const proxies = group.hulls.map((flat, k) => {
    const vertices: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i + 2 < flat.length; i += 3) {
      const v = { x: flat[i] ?? 0, y: flat[i + 1] ?? 0, z: flat[i + 2] ?? 0 };
      vertices.push(v);
      const world = [v.x + anchor.centroid[0], v.y + anchor.centroid[1], v.z + anchor.centroid[2]];
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a] ?? 0, world[a] ?? 0);
        max[a] = Math.max(max[a] ?? 0, world[a] ?? 0);
      }
    }
    const provenance: ProxyProvenance = {
      profiles: [],
      segment: segment.id,
      bones: segment.bones,
      min: bounds.min,
      max: bounds.max,
      rule:
        group.settings === 'hull-per-bone'
          ? `convex hull ${k + 1} of ${group.hulls.length}: one hull per bone, CoACD overran ` +
            `its time limit on this group (at most ${maxVertices} vertices per piece)`
          : `convex hull ${k + 1} of ${group.hulls.length}: CoACD decomposition of the ` +
            `segment's bones, ${group.settings} settings (at most ${maxVertices} vertices per piece)`,
      hull: { index: k, count: group.hulls.length, vertices: vertices.length },
    };
    return {
      id: `${id}_hull${k + 1}`,
      transform: { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      shape: { kind: 'convexHull' as const, vertices, scale: ofStature(1) },
      ext: writeExtension(undefined, PROXY_NS, provenance),
    };
  });
  return { proxies, occupies: { min, max } };
}

function fitProxy(
  id: string,
  segment: SegmentationDef['segments'][number],
  profiles: readonly string[],
): Fitted | undefined {
  const bounds = segmentBounds(segment.bones);
  const anchor = packed.get(segment.anchor);
  if (!bounds || !anchor) return undefined;
  const group = HULL_GROUPS.get(
    hullGroupKey(
      segment.anchor,
      segment.bones.filter((b) => packed.has(b)),
    ),
  );
  if (group) return hullProxies(id, segment, group, bounds, anchor);

  const extent = [0, 1, 2].map((i) => (bounds.max[i] ?? 0) - (bounds.min[i] ?? 0)) as [
    number,
    number,
    number,
  ];
  const centre = [0, 1, 2].map((i) => ((bounds.max[i] ?? 0) + (bounds.min[i] ?? 0)) / 2) as [
    number,
    number,
    number,
  ];
  const order = ([0, 1, 2] as Axis[]).sort((a, b) => extent[b] - extent[a]);
  const longest = order[0] as Axis;
  const second = order[1] as Axis;
  const aspect = extent[longest] / extent[second];

  // Placement in the anchor bone's local frame, which is world-aligned at its centroid.
  const local = [0, 1, 2].map((i) => (centre[i] ?? 0) - (anchor.centroid[i] ?? 0));
  const translation = {
    x: ofStature(local[0] ?? 0),
    y: ofStature(local[1] ?? 0),
    z: ofStature(local[2] ?? 0),
  };

  let shape: CollisionProxy['shape'];
  let rotation: Quat;
  let rule: string;
  let occupies: Bounds;
  if (aspect >= CAPSULE_ASPECT && !BOX_SEGMENTS.test(segment.id)) {
    const radius = extent[second] / 2;
    const length = Math.max(extent[longest] - 2 * radius, 0);
    shape = { kind: 'capsule', radius: ofStature(radius), length: ofStature(length) };
    rotation = axisRotation(longest);
    rule = `no hull group; fallback capsule along ${'xyz'[longest]}: aspect ${aspect.toFixed(2)} >= ${CAPSULE_ASPECT}`;
    const half = [0, 1, 2].map((i) => (i === longest ? extent[longest] / 2 : radius));
    occupies = {
      min: [0, 1, 2].map((i) => (centre[i] ?? 0) - (half[i] ?? 0)) as unknown as P3,
      max: [0, 1, 2].map((i) => (centre[i] ?? 0) + (half[i] ?? 0)) as unknown as P3,
    };
  } else {
    shape = {
      kind: 'box',
      halfExtents: {
        x: ofStature(extent[0] / 2),
        y: ofStature(extent[1] / 2),
        z: ofStature(extent[2] / 2),
      },
    };
    rotation = { x: 0, y: 0, z: 0, w: 1 };
    rule = BOX_SEGMENTS.test(segment.id)
      ? `no hull group; fallback box: plate segment, aspect ${aspect.toFixed(2)}`
      : `no hull group; fallback box: aspect ${aspect.toFixed(2)} < ${CAPSULE_ASPECT}`;
    occupies = bounds;
  }

  const provenance: ProxyProvenance = {
    profiles,
    segment: segment.id,
    bones: segment.bones,
    min: bounds.min,
    max: bounds.max,
    rule,
  };
  return {
    proxies: [
      {
        id,
        transform: { translation, rotation },
        shape,
        ext: writeExtension(undefined, PROXY_NS, provenance),
      },
    ],
    occupies,
  };
}

// ---------------------------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------------------------

export interface ExclusionProvenance {
  readonly pair: readonly [string, string];
  /** Profiles in which both segments exist and are not joined. */
  readonly profiles: readonly string[];
  /** Smallest axis overlap of the two proxies at the dataset pose, metres. */
  readonly overlap: number;
}

/** Positive when two bounds overlap on every axis; the value is the smallest axis overlap. */
function overlapDepth(a: Bounds, b: Bounds): number {
  let depth = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const d = Math.min(a.max[i] ?? 0, b.max[i] ?? 0) - Math.max(a.min[i] ?? 0, b.min[i] ?? 0);
    if (d <= 0) return 0;
    depth = Math.min(depth, d);
  }
  return depth;
}

export interface CollisionSetup {
  readonly proxies: CollisionProxy[];
  /** Profiles with each segment's `proxies` list filled in. */
  readonly profiles: SegmentationDef[];
  readonly exclude: [string, string][];
  readonly exclusions: ExclusionProvenance[];
}

/**
 * Fit every segment's proxies across all profiles, and find the non-adjacent overlapping pairs.
 *
 * Segments with the same id and the same bone set in several profiles share their proxies. A
 * segment whose bone set differs between profiles (`foot_r` with and without the toes) gets
 * proxies per variant, suffixed with the profile id.
 */
export function buildCollisionSetup(
  profiles: readonly SegmentationDef[],
  joints: readonly JointDef[],
): CollisionSetup {
  const byBoneSet = new Map<string, { id: string; fitted: Fitted; profiles: string[] }>();
  const idsUsed = new Set<string>();
  const proxies: CollisionProxy[] = [];
  const perProfile = new Map<string, Map<string, Fitted>>();

  const outProfiles = profiles.map((profile) => {
    const fittedHere = new Map<string, Fitted>();
    perProfile.set(profile.id, fittedHere);
    const segments = profile.segments.map((segment) => {
      const key = `${segment.id}|${[...segment.bones].sort().join(',')}`;
      let entry = byBoneSet.get(key);
      if (!entry) {
        const base = `proxy_${segment.id}`;
        const id = idsUsed.has(base) ? `${base}_${profile.id}` : base;
        const fitted = fitProxy(id, segment, []);
        if (!fitted) throw new Error(`Segment '${segment.id}' has no packed bones to fit.`);
        entry = { id, fitted, profiles: [] };
        byBoneSet.set(key, entry);
        idsUsed.add(id);
        proxies.push(...fitted.proxies);
      }
      entry.profiles.push(profile.id);
      fittedHere.set(segment.id, entry.fitted);
      return { ...segment, proxies: entry.fitted.proxies.map((p) => p.id) };
    });
    return { ...profile, segments };
  });

  // Provenance is written once the profile list per proxy is complete.
  for (const entry of byBoneSet.values()) {
    for (const proxy of entry.fitted.proxies) {
      const p = proxy.ext?.[PROXY_NS] as ProxyProvenance | undefined;
      if (p) proxy.ext = writeExtension(undefined, PROXY_NS, { ...p, profiles: entry.profiles });
    }
  }

  // Overlapping, unjoined pairs.
  const jointsById = new Map(joints.map((j) => [j.id, j]));
  const found = new Map<string, ExclusionProvenance>();
  for (const profile of outProfiles) {
    const fittedHere = perProfile.get(profile.id);
    if (!fittedHere) continue;
    const segmentOf = new Map<string, string>();
    for (const s of profile.segments) for (const b of s.bones) segmentOf.set(b, s.id);
    const joined = new Set<string>();
    for (const id of profile.joints ?? []) {
      const j = jointsById.get(id);
      if (!j) continue;
      const a = segmentOf.get(j.parentBone);
      const b = segmentOf.get(j.childBone);
      if (a && b && a !== b) joined.add([a, b].sort().join('|'));
    }
    const ids = profile.segments.map((s) => s.id);
    for (let i = 0; i < ids.length; i++) {
      for (let k = i + 1; k < ids.length; k++) {
        const a = ids[i] as string;
        const b = ids[k] as string;
        const pairKey = [a, b].sort().join('|');
        if (joined.has(pairKey)) continue;
        const fa = fittedHere.get(a);
        const fb = fittedHere.get(b);
        if (!fa || !fb) continue;
        const overlap = overlapDepth(fa.occupies, fb.occupies);
        if (overlap <= 0) continue;
        const existing = found.get(pairKey);
        if (existing) {
          found.set(pairKey, {
            ...existing,
            profiles: [...existing.profiles, profile.id],
            overlap: Math.max(existing.overlap, overlap),
          });
        } else {
          found.set(pairKey, {
            pair: [a, b].sort() as [string, string],
            profiles: [profile.id],
            overlap,
          });
        }
      }
    }
  }

  const exclusions = [...found.values()].sort((x, y) => x.pair.join().localeCompare(y.pair.join()));
  return {
    proxies,
    profiles: outProfiles,
    exclude: exclusions.map((e) => [e.pair[0], e.pair[1]]),
    exclusions,
  };
}

/** Contact rules with the generated exclusions and their provenance attached. */
export function buildContactRules(setup: CollisionSetup): ContactRuleDef {
  return {
    exclude: setup.exclude,
    classes: {
      bone_on_ground: { friction: 0.85, restitution: 0.02 },
      bone_on_bone: { friction: 0.3, restitution: 0.0 },
    },
    defaultClass: 'bone_on_ground',
    ext: writeExtension(undefined, PROXY_NS, { exclusions: setup.exclusions }),
  };
}
