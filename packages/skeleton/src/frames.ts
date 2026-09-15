/**
 * Bone local frames from landmarks -- milestone M1.3.
 *
 * Each frame is an ISB segment coordinate system (Wu et al. 2002 for the lower limb, Wu et al.
 * 2005 for the thorax and upper limb), expressed as an HSDL `FrameDef`: an origin landmark, a
 * primary axis between two landmarks, and a secondary direction between two landmarks that fixes
 * the roll. The third axis follows by cross product. Nothing here is a hand-authored matrix.
 *
 * ## Orientation policy (OQ-006)
 *
 * ISB defines several axes by a line "pointing to AC" or "pointing to AA" -- lateral on both
 * sides -- with the other axes "pointing forward" and "upward". Followed literally, that yields a
 * right-handed frame on the right and a left-handed one on the left. This project keeps every
 * frame right-handed and applies one rule to both sides: **Z toward the subject's right, X
 * anterior, Y superior** at the anatomical neutral pose. That is what ISB states outright for the
 * pelvis, femur, tibia, humerus and forearm, and it is the OpenSim convention. Where ISB's wording
 * for a left-side bone would give the opposite direction, the landmark pair is reversed so the
 * axis points right, and the departure is recorded here rather than left implicit.
 *
 * ## Sign resolution
 *
 * "Pointing to the right" is resolved from the data: the landmark pair is ordered so that its
 * direction has a positive component along the required world direction at the dataset pose. A
 * definition therefore never carries a sign that was typed by hand -- the one thing about frames
 * this project most wants to avoid (spec section 5.3).
 */

import {
  type Transform,
  type Vec3,
  WORLD,
  anatomicalAxis,
  dot,
  frameFromLandmarkPoints,
  transformPoint,
  vec3,
} from '@bs-humany/frames';
import {
  type Citation,
  type ExprContext,
  type FrameDef,
  type HsdlDocument,
  type LandmarkDef,
  cite,
  evaluate,
  moduleNamespace,
  mul,
  param,
  provisional,
  writeExtension,
} from '@bs-humany/hsdl';
import { DATASET_MANIFEST } from './dataset.js';
import { ISB_LANDMARKS, isbLandmarkWorld, landmarkId } from './landmarks.js';
import { computeWorldTransforms } from './pose.js';

type Direction = 'right' | 'anterior' | 'superior';
type P3 = readonly [number, number, number];

const wu2002 = (locator: string) => cite('wu2002', locator);
const wu2005 = (locator: string) => cite('wu2005', locator);

// ---------------------------------------------------------------------------------------------
// Virtual landmarks: the midpoints ISB defines as points in their own right.
// ---------------------------------------------------------------------------------------------

export interface VirtualLandmark {
  readonly id: string;
  /** Bone the point is attached to; its position is expressed in that bone's frame. */
  readonly bone: string;
  readonly displayName: string;
  readonly a: readonly [string, string];
  readonly b: readonly [string, string];
  readonly source: Citation;
}

function bothSides(make: (s: 'l' | 'r') => VirtualLandmark): VirtualLandmark[] {
  return [make('r'), make('l')];
}

export const VIRTUAL_LANDMARKS: readonly VirtualLandmark[] = [
  ...bothSides((s) => ({
    id: `tibia_${s}__im`,
    bone: `tibia_${s}`,
    displayName: `Inter-malleolar point (IM), ${s === 'r' ? 'right' : 'left'}`,
    a: [`tibia_${s}`, 'MM'],
    b: [`fibula_${s}`, 'LM'],
    source: wu2002('3.2.2, IM: midway between MM and LM'),
  })),
  ...bothSides((s) => ({
    id: `tibia_${s}__ic`,
    bone: `tibia_${s}`,
    displayName: `Inter-condylar point (IC), ${s === 'r' ? 'right' : 'left'}`,
    a: [`tibia_${s}`, 'MC'],
    b: [`tibia_${s}`, 'LC'],
    source: wu2002('3.2.2, IC: midway between MC and LC'),
  })),
  ...bothSides((s) => ({
    id: `femur_${s}__mid_fe`,
    bone: `femur_${s}`,
    displayName: `Midpoint of the femoral epicondyles, ${s === 'r' ? 'right' : 'left'}`,
    a: [`femur_${s}`, 'FE_med'],
    b: [`femur_${s}`, 'FE_lat'],
    source: wu2002('4.4, femoral y-axis: midpoint between the medial and lateral FEs'),
  })),
  ...bothSides((s) => ({
    id: `humerus_${s}__mid_el_em`,
    bone: `humerus_${s}`,
    displayName: `Midpoint of the humeral epicondyles, ${s === 'r' ? 'right' : 'left'}`,
    a: [`humerus_${s}`, 'EL'],
    b: [`humerus_${s}`, 'EM'],
    source: wu2005('2.3.4, Yh1: midpoint of EL and EM'),
  })),
  ...bothSides((s) => ({
    id: `radius_${s}__mid_rs_us`,
    bone: `radius_${s}`,
    displayName: `Midpoint of the styloid processes, ${s === 'r' ? 'right' : 'left'}`,
    a: [`radius_${s}`, 'RS'],
    b: [`ulna_${s}`, 'US'],
    source: provisional(
      'wu2005',
      'OQ-005',
      'Wrist centre taken as the midpoint of RS and US until the hand sections are verified.',
      '3.3, wrist',
    ),
  })),
  ...bothSides((s) => ({
    id: `metatarsal_1_${s}__mid_mt_heads`,
    bone: `metatarsal_1_${s}`,
    displayName: `Midpoint of the first and fifth metatarsal heads, ${s === 'r' ? 'right' : 'left'}`,
    a: [`metatarsal_1_${s}`, 'MT1'],
    b: [`metatarsal_5_${s}`, 'MT5'],
    source: cite(
      'caggiano2022',
      'myo_sim/models/leg/assets/myolegs_chain.xml, body toes: origin at the metatarsal heads',
    ),
  })),
  {
    id: 'sternum__mid_px_t8',
    bone: 'sternum',
    displayName: 'Midpoint between PX and T8',
    a: ['sternum', 'PX'],
    b: ['vertebra_t8', 'T8'],
    source: wu2005('2.3.1, Yt: midpoint between PX and T8'),
  },
  {
    id: 'sternum__mid_ij_c7',
    bone: 'sternum',
    displayName: 'Midpoint between IJ and C7',
    a: ['sternum', 'IJ'],
    b: ['vertebra_c7', 'C7'],
    source: wu2005('2.3.1, Yt: midpoint between IJ and C7'),
  },
  {
    id: 'sacrum__mid_psis',
    bone: 'sacrum',
    displayName: 'Midpoint of the two PSISs',
    a: ['hip_r', 'PSIS'],
    b: ['hip_l', 'PSIS'],
    source: wu2002('4.3, pelvic X-axis: midpoint of the two PSISs'),
  },
  {
    id: 'sacrum__mid_asis',
    bone: 'sacrum',
    displayName: 'Midpoint of the two ASISs',
    a: ['hip_r', 'ASIS'],
    b: ['hip_l', 'ASIS'],
    source: wu2002('4.3, pelvic coordinate system'),
  },
  {
    id: 'sacrum__mid_hjc',
    bone: 'sacrum',
    displayName: 'Midpoint of the two hip joint centres',
    a: ['femur_r', 'HJC'],
    b: ['femur_l', 'HJC'],
    source: wu2002('4.3, pelvic origin at the hip centre; midpoint used for the sacrum'),
  },
];

/** World position of a virtual landmark at the dataset stature. */
export function virtualLandmarkWorld(v: VirtualLandmark): P3 {
  const a = isbLandmarkWorld(v.a[0], v.a[1]);
  const b = isbLandmarkWorld(v.b[0], v.b[1]);
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/** Virtual landmarks as HSDL definitions, so frames can reference them by id. */
export function buildVirtualLandmarks(): LandmarkDef[] {
  const centroids = new Map(DATASET_MANIFEST.bones.map((b) => [b.id, b.centroid]));
  const ns = moduleNamespace('provenance');
  return VIRTUAL_LANDMARKS.map((v) => {
    const centroid = centroids.get(v.bone);
    if (!centroid) throw new Error(`Virtual landmark '${v.id}' is on unpacked bone '${v.bone}'.`);
    const world = virtualLandmarkWorld(v);
    const local = (i: 0 | 1 | 2) => (world[i] - centroid[i]) / DATASET_MANIFEST.subjectStature;
    return {
      id: v.id,
      bone: v.bone,
      displayName: v.displayName,
      position: {
        x: mul(local(0), param('stature')),
        y: mul(local(1), param('stature')),
        z: mul(local(2), param('stature')),
      },
      source: v.source,
      palpable: false,
      ext: writeExtension(undefined, ns, {
        dataset: DATASET_MANIFEST.dataset.name,
        datasetVersion: DATASET_MANIFEST.dataset.version,
        sourceSha256: DATASET_MANIFEST.dataset.sourceSha256,
        locatedBy: `midpoint of ${v.a[0]}/${v.a[1]} and ${v.b[0]}/${v.b[1]}`,
      }),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Frame specifications
// ---------------------------------------------------------------------------------------------

/** A landmark reference: an ISB abbreviation on a bone, or a virtual landmark id. */
export type Ref = readonly [bone: string, abbreviation: string] | { readonly virtual: string };

interface AxisSpec {
  readonly axis: 'x' | 'y' | 'z';
  readonly a: Ref;
  readonly b: Ref;
  /** The world direction the axis must point at the neutral pose; fixes the pair's order. */
  readonly direction: Direction;
}

export interface FrameSpec {
  readonly bone: string;
  readonly origin: Ref;
  readonly primary: AxisSpec;
  readonly secondary: AxisSpec;
  readonly source: Citation;
  /** Which ISB segment system this is, for the inspector. */
  readonly system: string;
}

const V = (id: string): Ref => ({ virtual: id });

function sideSpecs(s: 'l' | 'r'): FrameSpec[] {
  const side = s === 'r' ? 'right' : 'left';
  return [
    {
      // Wu 2002 4.3. Origin at the hip centre; Z along the ASISs to the right; X in the plane of
      // the ASISs and mid-PSIS, anterior.
      bone: `hip_${s}`,
      system: `Pelvis (ISB 2002), ${side}`,
      origin: [`femur_${s}`, 'HJC'],
      primary: { axis: 'z', a: ['hip_l', 'ASIS'], b: ['hip_r', 'ASIS'], direction: 'right' },
      secondary: {
        axis: 'x',
        a: V('sacrum__mid_psis'),
        b: V('sacrum__mid_asis'),
        direction: 'anterior',
      },
      source: wu2002('4.3, pelvic coordinate system'),
    },
    {
      // Wu 2002 4.4. Origin at the hip centre; y from the mid-epicondyle point to the origin,
      // cranial; z in the plane of the origin and the FEs, right.
      bone: `femur_${s}`,
      system: `Femur (ISB 2002), ${side}`,
      origin: [`femur_${s}`, 'HJC'],
      primary: {
        axis: 'y',
        a: V(`femur_${s}__mid_fe`),
        b: [`femur_${s}`, 'HJC'],
        direction: 'superior',
      },
      secondary: {
        axis: 'z',
        a: [`femur_${s}`, 'FE_med'],
        b: [`femur_${s}`, 'FE_lat'],
        direction: 'right',
      },
      source: wu2002('4.4, femoral coordinate system'),
    },
    ...([`tibia_${s}`, `fibula_${s}`, `talus_${s}`, `calcaneus_${s}`] as const).map(
      (bone): FrameSpec => ({
        // Wu 2002 3.3. Origin at IM; Z along MM-LM to the right; X perpendicular to the torsional
        // plane (IC, MM, LM), anterior. 3.4: the calcaneus frame coincides with it at neutral, and
        // the talus is given the same frame for the same reason.
        bone,
        system:
          bone.startsWith('tibia') || bone.startsWith('fibula')
            ? `Tibia/fibula (ISB 2002), ${side}`
            : `Calcaneus, coincident with tibia/fibula at neutral (ISB 2002 3.4), ${side}`,
        origin: V(`tibia_${s}__im`),
        primary: {
          axis: 'z',
          a: [`tibia_${s}`, 'MM'],
          b: [`fibula_${s}`, 'LM'],
          direction: 'right',
        },
        secondary: {
          axis: 'y',
          a: V(`tibia_${s}__im`),
          b: V(`tibia_${s}__ic`),
          direction: 'superior',
        },
        source: wu2002(
          bone.startsWith('tibia') || bone.startsWith('fibula')
            ? '3.3, tibia/fibula coordinate system'
            : '3.4, calcaneus coordinate system',
        ),
      }),
    ),
    {
      // Wu 2005 2.3.2. Origin at SC; Zc from SC to AC; Xc perpendicular to Zc and the thorax Yt,
      // forward. Under the orientation policy Z points right on both sides.
      bone: `clavicle_${s}`,
      system: `Clavicle (ISB 2005), ${side}`,
      origin: [`clavicle_${s}`, 'SC'],
      primary: {
        axis: 'z',
        a: [`clavicle_${s}`, 'SC'],
        b: [`clavicle_${s}`, 'AC'],
        direction: 'right',
      },
      secondary: {
        axis: 'y',
        a: V('sternum__mid_px_t8'),
        b: V('sternum__mid_ij_c7'),
        direction: 'superior',
      },
      source: wu2005('2.3.2, clavicle coordinate system'),
    },
    {
      // Wu 2005 2.3.3. Origin at AA; Zs from TS to AA; Xs perpendicular to the plane (AI, AA, TS),
      // forward. The in-plane direction from AI toward TS fixes the roll.
      bone: `scapula_${s}`,
      system: `Scapula (ISB 2005), ${side}`,
      origin: [`scapula_${s}`, 'AA'],
      primary: {
        axis: 'z',
        a: [`scapula_${s}`, 'TS'],
        b: [`scapula_${s}`, 'AA'],
        direction: 'right',
      },
      secondary: {
        axis: 'y',
        a: [`scapula_${s}`, 'AI'],
        b: [`scapula_${s}`, 'TS'],
        direction: 'superior',
      },
      source: wu2005('2.3.3, scapula coordinate system'),
    },
    {
      // Wu 2005 2.3.4 (option 1). Origin at GH; Yh from the mid-epicondyle point to GH; Xh
      // perpendicular to the plane (EL, EM, GH), forward.
      bone: `humerus_${s}`,
      system: `Humerus, option 1 (ISB 2005), ${side}`,
      origin: [`humerus_${s}`, 'GH'],
      primary: {
        axis: 'y',
        a: V(`humerus_${s}__mid_el_em`),
        b: [`humerus_${s}`, 'GH'],
        direction: 'superior',
      },
      secondary: {
        axis: 'z',
        a: [`humerus_${s}`, 'EM'],
        b: [`humerus_${s}`, 'EL'],
        direction: 'right',
      },
      source: wu2005('2.3.4, humerus (1st option) coordinate system'),
    },
    {
      // Wu 2005 3.3.3. Origin at US; Yu from US to the mid-epicondyle point, proximal; Xu
      // perpendicular to the plane (US, EM, EL), forward. Also the forearm system of 2.3.6.
      bone: `ulna_${s}`,
      system: `Ulna / forearm (ISB 2005), ${side}`,
      origin: [`ulna_${s}`, 'US'],
      primary: {
        axis: 'y',
        a: [`ulna_${s}`, 'US'],
        b: V(`humerus_${s}__mid_el_em`),
        direction: 'superior',
      },
      secondary: {
        axis: 'z',
        a: [`ulna_${s}`, 'US'],
        b: [`radius_${s}`, 'RS'],
        direction: 'right',
      },
      source: wu2005('3.3.3, ulnar coordinate system; 2.3.6, forearm coordinate system'),
    },
    {
      // Wu 2005 3.3.4. Origin at RS; Yr from RS toward EL, proximal; Xr perpendicular to the plane
      // (RS, US, EL), forward.
      bone: `radius_${s}`,
      system: `Radius (ISB 2005), ${side}`,
      origin: [`radius_${s}`, 'RS'],
      primary: {
        axis: 'y',
        a: [`radius_${s}`, 'RS'],
        b: [`humerus_${s}`, 'EL'],
        direction: 'superior',
      },
      secondary: {
        axis: 'z',
        a: [`ulna_${s}`, 'US'],
        b: [`radius_${s}`, 'RS'],
        direction: 'right',
      },
      source: wu2005('3.3.4, radius coordinate system'),
    },
  ];
}

const THORAX_BONES = [
  'sternum',
  ...Array.from({ length: 12 }, (_, i) => [`rib_${i + 1}_l`, `rib_${i + 1}_r`]).flat(),
];

export const FRAME_SPECS: readonly FrameSpec[] = [
  ...sideSpecs('r'),
  ...sideSpecs('l'),
  // Wu 2002 4.3 applied to the sacrum with the origin at the midpoint of the hip centres.
  {
    bone: 'sacrum',
    system: 'Pelvis (ISB 2002), origin at mid-hip',
    origin: V('sacrum__mid_hjc'),
    primary: { axis: 'z', a: ['hip_l', 'ASIS'], b: ['hip_r', 'ASIS'], direction: 'right' },
    secondary: {
      axis: 'x',
      a: V('sacrum__mid_psis'),
      b: V('sacrum__mid_asis'),
      direction: 'anterior',
    },
    source: wu2002('4.3, pelvic coordinate system'),
  },
  // Wu 2005 2.3.1. Origin at IJ; Yt from mid(PX, T8) to mid(IJ, C7), upward; Zt perpendicular to
  // the plane (IJ, C7, mid(PX, T8)), right. The in-plane direction from C7 to IJ fixes the roll.
  ...THORAX_BONES.map(
    (bone): FrameSpec => ({
      bone,
      system: 'Thorax (ISB 2005)',
      origin: ['sternum', 'IJ'],
      primary: {
        axis: 'y',
        a: V('sternum__mid_px_t8'),
        b: V('sternum__mid_ij_c7'),
        direction: 'superior',
      },
      secondary: {
        axis: 'x',
        a: ['vertebra_c7', 'C7'],
        b: ['sternum', 'IJ'],
        direction: 'anterior',
      },
      source: wu2005('2.3.1, thorax coordinate system'),
    }),
  ),
];

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

function refId(ref: Ref): string {
  if ('virtual' in ref) return ref.virtual;
  const isb = ISB_LANDMARKS.find((l) => l.bone === ref[0] && l.abbreviation === ref[1]);
  if (!isb) throw new Error(`No ISB landmark '${ref[1]}' on '${ref[0]}'.`);
  return landmarkId(isb.bone, isb.feature);
}

/**
 * A landmark reference in dataset world coordinates.
 *
 * Exported so that anything placed on a bone's ISB frame -- a wrapping surface, say -- resolves
 * its landmarks the same way the frames do, rather than growing a second copy of the abbreviation
 * table and the virtual-landmark rules that would drift from this one.
 */
export function refWorld(ref: Ref): P3 {
  if ('virtual' in ref) {
    const v = VIRTUAL_LANDMARKS.find((x) => x.id === ref.virtual);
    if (!v) throw new Error(`Unknown virtual landmark '${ref.virtual}'.`);
    return virtualLandmarkWorld(v);
  }
  return isbLandmarkWorld(ref[0], ref[1]);
}

function worldDirection(direction: Direction): Vec3 {
  return anatomicalAxis(direction, WORLD);
}

/**
 * Order a landmark pair so its direction points the required way at the dataset pose.
 *
 * Returns the resolved `[from, to]` ids and how strongly the pair aligns with the direction, so a
 * pair that is nearly perpendicular to what it is meant to indicate can be caught in a test.
 */
function orient(spec: AxisSpec): { from: string; to: string; alignment: number } {
  const a = refWorld(spec.a);
  const b = refWorld(spec.b);
  const d = vec3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const length = Math.hypot(d.x, d.y, d.z);
  const alignment = length === 0 ? 0 : dot(d, worldDirection(spec.direction)) / length;
  return alignment >= 0
    ? { from: refId(spec.a), to: refId(spec.b), alignment }
    : { from: refId(spec.b), to: refId(spec.a), alignment: -alignment };
}

export const FRAME_NS = moduleNamespace('frame');

/** Build the `FrameDef` for every specified bone, keyed by bone id. */
export function buildFrameDefs(): Map<string, FrameDef> {
  const out = new Map<string, FrameDef>();
  for (const spec of FRAME_SPECS) {
    const primary = orient(spec.primary);
    const secondary = orient(spec.secondary);
    out.set(spec.bone, {
      origin: refId(spec.origin),
      primaryFrom: primary.from,
      primaryTo: primary.to,
      primaryAxis: spec.primary.axis,
      secondaryFrom: secondary.from,
      secondaryTo: secondary.to,
      secondaryAxis: spec.secondary.axis,
      source: spec.source,
    });
  }
  return out;
}

/**
 * Evaluate every bone's ISB frame as a world transform at a given morphology.
 *
 * Landmark positions are bone-local; they are carried to world through the bone's rest transform,
 * then the frame is built by Gram-Schmidt in `@bs-humany/frames`, which throws on a degenerate
 * pair rather than returning a silently wrong roll.
 */
export function computeBoneFrames(
  document: Pick<HsdlDocument, 'bones' | 'landmarks'>,
  context: ExprContext,
): Map<string, Transform> {
  const world = computeWorldTransforms(document, context);
  const landmarkById = new Map(document.landmarks.map((l) => [l.id, l]));

  const landmarkWorld = (id: string): Vec3 => {
    const l = landmarkById.get(id);
    if (!l)
      throw new Error(`Frame references landmark '${id}', which the document does not carry.`);
    const bone = world.get(l.bone);
    if (!bone) throw new Error(`Landmark '${id}' is on '${l.bone}', which has no world transform.`);
    const local = vec3(
      evaluate(l.position.x, context),
      evaluate(l.position.y, context),
      evaluate(l.position.z, context),
    );
    return transformPoint(bone, local);
  };

  const out = new Map<string, Transform>();
  for (const bone of document.bones) {
    const f = bone.frame;
    if (!f) continue;
    out.set(
      bone.id,
      frameFromLandmarkPoints({
        origin: landmarkWorld(f.origin),
        primaryFrom: landmarkWorld(f.primaryFrom),
        primaryTo: landmarkWorld(f.primaryTo),
        primaryAxis: f.primaryAxis,
        secondaryFrom: landmarkWorld(f.secondaryFrom),
        secondaryTo: landmarkWorld(f.secondaryTo),
        secondaryAxis: f.secondaryAxis,
      }),
    );
  }
  return out;
}

/** Bones whose frame is world-aligned at the centroid because no ISB system covers them yet. */
export function unframedBones(document: HsdlDocument): string[] {
  return document.bones.filter((b) => !b.frame).map((b) => b.id);
}
