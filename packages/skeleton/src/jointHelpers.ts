/**
 * Shared vocabulary of the joint tables: citation shorthands, joint-centre resolution and the
 * spec shapes. Split from `joints.ts` so the L1/L2 table and the L3 table can share it without
 * one importing the other.
 */

import { type Citation, type JointDef, cite } from '@bs-humany/hsdl';
import { DATASET_MANIFEST } from './dataset.js';
import { VIRTUAL_LANDMARKS, virtualLandmarkWorld } from './frames.js';
import {
  ISB_LANDMARKS,
  isbLandmarkWorld,
  landmarkId,
  markerWorld,
  measuredWorld,
} from './landmarks.js';

export type Side = 'l' | 'r';
export type P3 = readonly [number, number, number];

// ---------------------------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------------------------

export const LEG = 'myo_sim/models/leg/assets/myolegs_chain.xml';
export const ARM = 'myo_sim/models/arm/assets/myoarm_r_chain.xml';
export const TORSO = 'myo_sim/models/torso/assets/myotorso_chain.xml';
export const HEAD = 'myo_sim/models/head/assets/myohead_rigid_chain.xml';

export const myo = (file: string, joint: string) => cite('caggiano2022', `${file}, joint ${joint}`);
export const wu2002 = (locator: string) => cite('wu2002', locator);
export const wu2005 = (locator: string) => cite('wu2005', locator);
export const dataset = (locator: string) => cite('kervyn2021', locator);

// ---------------------------------------------------------------------------------------------
// Joint centres
// ---------------------------------------------------------------------------------------------

/**
 * Where a joint centre comes from.
 *
 *   - `isb`: an ISB landmark by abbreviation.
 *   - `virtual`: a midpoint landmark defined in `frames.ts`.
 *   - `marker`: a raw dataset marker that has no ISB name.
 *   - `measured`: a centre measured from the meshes -- a fitted articular sphere or the contact
 *     between two bones (see `articularCentres.ts`). A marker marks a surface feature and is a
 *     poor stand-in for a rotation centre, so a joint that needs one says so here.
 *
 * There was a `centroidMid` -- midway between two bones' centroids -- and every spinal joint used
 * it. A vertebra's centroid is not in its body: the arch, the transverse processes and the spinous
 * process drag it back, 30 mm for a lumbar vertebra whose body is 35 mm deep. The kind carried
 * that as a limitation, "a little posterior to the disc", which understated it by an order of
 * magnitude and let it stand for as long as it did. Every one of those joints takes `between` now,
 * across the two endplates, and the kind is gone so it cannot be reached for again.
 */
export type Centre =
  | { readonly isb: readonly [bone: string, abbreviation: string] }
  | { readonly virtual: string }
  | { readonly marker: readonly [bone: string, feature: string] }
  | { readonly measured: readonly [bone: string, feature: string] }
  /**
   * Where two bones' bounds meet along an axis: the proximal bone's far extreme and the distal
   * bone's near extreme averaged, at the distal bone's centroid on the other axes.
   *
   * Only as good as that last clause, which is the whole trouble with it: on the two axes it does
   * not choose, the joint lands at the middle of the *distal bone*. For a bone that runs along the
   * chosen axis that is nearly right. For a finger, which points down and forward at once, it is
   * not: the third metacarpophalangeal came out 13 mm palmar and 4 mm lateral of the metacarpal's
   * head, which put the joint on the palmar side of its own flexor tendons and made them
   * extensors. Prefer `between`, which needs no axis and no centroid.
   */
  | { readonly boundary: readonly [proximal: string, distal: string, axis: 0 | 1 | 2] }
  /**
   * Midway between two measured landmarks: a joint whose two bones each say where they meet.
   *
   * What the digits use. Every bone in every finger and toe carries a measured base and head
   * (`tools/ingest/src/derived.ts`), and a joint is between the proximal bone's head and the
   * distal bone's base -- which come out 1.2 to 7.6 mm apart down every digit, a joint space. No
   * axis to choose and no centroid to fall back on.
   */
  | { readonly between: readonly [readonly [string, string], readonly [string, string]] }
  /** The point of one bone's bounds nearest another bone's centroid: a rib head at its vertebra. */
  | { readonly nearest: readonly [bone: string, toward: string] }
  | { readonly centroid: string };

function packed(id: string) {
  const bone = DATASET_MANIFEST.bones.find((x) => x.id === id);
  if (!bone) throw new Error(`Joint centre references unpacked bone '${id}'.`);
  return bone;
}

export function centreWorld(c: Centre): P3 {
  if ('isb' in c) return isbLandmarkWorld(c.isb[0], c.isb[1]);
  if ('marker' in c) return markerWorld(c.marker[0], c.marker[1]);
  if ('measured' in c) return measuredWorld(c.measured[0], c.measured[1]);
  if ('virtual' in c) {
    const v = VIRTUAL_LANDMARKS.find((x) => x.id === c.virtual);
    if (!v) throw new Error(`Joint centre references unknown virtual landmark '${c.virtual}'.`);
    return virtualLandmarkWorld(v);
  }
  if ('centroid' in c) return packed(c.centroid).centroid;
  if ('boundary' in c) {
    const [proximalId, distalId, axis] = c.boundary;
    const proximal = packed(proximalId);
    const distal = packed(distalId);
    // The distal bone lies on the side of the proximal bone that its centroid is on.
    const sign = Math.sign(distal.centroid[axis] - proximal.centroid[axis]) || 1;
    const proximalFar = sign > 0 ? proximal.max[axis] : proximal.min[axis];
    const distalNear = sign > 0 ? distal.min[axis] : distal.max[axis];
    const out: [number, number, number] = [...distal.centroid];
    out[axis] = (proximalFar + distalNear) / 2;
    return out;
  }
  if ('between' in c) {
    const [a, b] = c.between.map(([bone, feature]) => measuredWorld(bone, feature)) as [P3, P3];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  }
  const bone = packed(c.nearest[0]);
  const toward = packed(c.nearest[1]).centroid;
  return [
    Math.min(Math.max(toward[0], bone.min[0]), bone.max[0]),
    Math.min(Math.max(toward[1], bone.min[1]), bone.max[1]),
    Math.min(Math.max(toward[2], bone.min[2]), bone.max[2]),
  ];
}

/** How the centre was located, for the provenance extension. */
export function centreLocator(c: Centre): string {
  if ('isb' in c) {
    const l = ISB_LANDMARKS.find((x) => x.bone === c.isb[0] && x.abbreviation === c.isb[1]);
    return l ? `landmark ${landmarkId(l.bone, l.feature)}` : `landmark ${c.isb.join('/')}`;
  }
  if ('marker' in c) return `landmark ${landmarkId(c.marker[0], c.marker[1])}`;
  if ('measured' in c) return `landmark ${landmarkId(c.measured[0], c.measured[1])}`;
  if ('virtual' in c) return `landmark ${c.virtual}`;
  if ('centroid' in c) return `centroid of ${c.centroid}`;
  if ('boundary' in c)
    return `bounds boundary of ${c.boundary[0]} and ${c.boundary[1]} along ${'xyz'[c.boundary[2]]}`;
  if ('between' in c)
    return (
      `midway between landmarks ${landmarkId(...c.between[0])} and ` +
      `${landmarkId(...c.between[1])}`
    );
  return `point of ${c.nearest[0]} bounds nearest ${c.nearest[1]}`;
}

// ---------------------------------------------------------------------------------------------
// Specifications
// ---------------------------------------------------------------------------------------------

export interface DofSpec {
  readonly axis: string;
  /** In the joint frame, right side. Normalised on build; the left side is mirrored on build. */
  readonly vector: readonly [number, number, number];
  readonly range: readonly [number, number];
  readonly romSource: Citation;
  /**
   * Undo another joint's degree of freedom.
   *
   * A kinematic tree makes a child inherit its parent's rotation, and sometimes that is not what
   * the anatomy does: the scapula travels with the clavicle but does not turn with it, because
   * the muscles that hold it against the rib cage keep its own orientation. The source model
   * expresses that with a phantom body carrying the parent joint's axes and the opposite
   * coupling, and this is the same thing without the extra body.
   *
   * The axis is resolved on build -- the named joint's axis, expressed in this joint's frame,
   * which needs both frames and so cannot be written as a literal. `vector` is ignored, and the
   * left side is not mirrored again because both frames are already that side's own. Such a DoF
   * is meaningless unless a constraint drives it with the negated coefficient, and the
   * counter-rotations must come first in the list, in the reverse of the source's order.
   */
  readonly counterRotates?: { readonly joint: string; readonly dof: number } | undefined;
}

export interface JointSpec {
  readonly id: string;
  readonly displayName: string;
  readonly parentBone: string;
  readonly childBone: string;
  readonly type: JointDef['type'];
  readonly centre: Centre;
  readonly centreSource: Citation;
  readonly dofs: readonly DofSpec[];
  readonly reportingOrder?: JointDef['reportingOrder'];
  readonly limitations?: readonly string[];
  /**
   * The joint below this one and the joint above, when the frame should lean with the chain.
   *
   * A joint's frame is its parent bone's ISB frame, and a vertebra has none, so every joint in the
   * spine fell back on the canonical world frame. That is a defensible convention for reporting
   * three rotations and a poor description of a spine: a disc at the bottom of the thoracic
   * kyphosis is tilted fifteen degrees out of the horizontal and one at the top twenty-three the
   * other way, and a frame that ignores it reports axial rotation about the vertical rather than
   * about the spine, and draws every disc flat.
   *
   * Given these, the frame is turned by the shortest rotation until its up-axis lies along the
   * line from the joint below to the joint above -- the spine's own direction there. Nothing else
   * changes: the local axes keep the convention every DoF vector is written in, and the turn goes
   * on top. Naming itself as one end gives a one-sided difference, which is what the two ends of
   * the chain have to take.
   *
   * Why the chain and not the bone. The obvious answer is the vertebral body's own axis, or the
   * chord across the two bodies the disc lies between, and both were measured and are noise: the
   * two-body chord runs 1.9, 0.4, -1.5, -2.9, -1.9, -1.5, 0.9, 0.8, 5.5 degrees up the lumbar and
   * lower thoracic spine, wandering either side of zero with no pattern, because a single
   * endplate's centre is only located to a millimetre or two and differencing two of them 25 mm
   * apart makes an angle out of that error. A joint centre is the midpoint of two endplates and
   * averages half of it away; the line between two joint centres spans 60 mm and averages the
   * rest. It comes out smooth and it comes out right -- lordosis, kyphosis, lordosis, with the
   * turning points where a spine's are.
   */
  readonly upAxis?: readonly [below: string, above: string];
  /** Which side's sign policy applies; midline joints have none. */
  readonly side?: Side;
}

export const sideName = (s: Side) => (s === 'r' ? 'right' : 'left');

/** Halve a range: the arithmetic behind the L1 region joints, kept in one place. */
export const half = (r: readonly [number, number]): [number, number] => [r[0] / 2, r[1] / 2];

/** Flip the sign convention of a source that counts extension as positive. */
export const flexionPositive = (r: readonly [number, number]): [number, number] => [-r[1], -r[0]];

export const SUBTALAR_AXIS = [0.78718, 0.604747, -0.120949] as const;
export const MTP_AXIS = [-0.580954, 0, 0.813936] as const;
