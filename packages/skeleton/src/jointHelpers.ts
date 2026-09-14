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
 *   - `centroidMid`: midway between two bones' centroids. Used only for spine joints whose disc
 *     has no marker; the vertebral centroid includes the posterior arch, so the point sits a
 *     little posterior to the disc. Recorded as a limitation on each such joint.
 */
export type Centre =
  | { readonly isb: readonly [bone: string, abbreviation: string] }
  | { readonly virtual: string }
  | { readonly marker: readonly [bone: string, feature: string] }
  | { readonly measured: readonly [bone: string, feature: string] }
  | { readonly centroidMid: readonly [string, string] }
  /**
   * Where two bones' bounds meet along an axis: the proximal bone's far extreme and the distal
   * bone's near extreme averaged, at the distal bone's centroid on the other axes. For the
   * finger and toe joints, whose bones carry no markers.
   */
  | { readonly boundary: readonly [proximal: string, distal: string, axis: 0 | 1 | 2] }
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
  if ('nearest' in c) {
    const bone = packed(c.nearest[0]);
    const toward = packed(c.nearest[1]).centroid;
    return [
      Math.min(Math.max(toward[0], bone.min[0]), bone.max[0]),
      Math.min(Math.max(toward[1], bone.min[1]), bone.max[1]),
      Math.min(Math.max(toward[2], bone.min[2]), bone.max[2]),
    ];
  }
  const [a, b] = c.centroidMid.map((id) => packed(id).centroid) as [P3, P3];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
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
  if ('nearest' in c) return `point of ${c.nearest[0]} bounds nearest ${c.nearest[1]}`;
  return `midpoint of centroids ${c.centroidMid[0]} and ${c.centroidMid[1]}`;
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
