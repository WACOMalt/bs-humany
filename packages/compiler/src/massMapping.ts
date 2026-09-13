/**
 * Mapping de Leva's segments onto the reference skeleton.
 *
 * de Leva (1996) gives inertial parameters for eleven segments defined between anatomical
 * endpoints -- the head from vertex to cervicale, the thigh from hip centre to knee centre. This
 * module says which bones of the reference skeleton belong to each of those segments and where its
 * endpoints are, so a fidelity profile's segments can be given mass by combining de Leva parts
 * (spec section 6.4 step 4). The mapping is the compiler's, not the anthropometry package's, because
 * it names bones and joints of one specific skeleton.
 *
 * ## Whole and partial parts
 *
 * A profile segment that owns every bone of a de Leva segment takes the whole thing: mass, a
 * centre of mass placed along the endpoint axis at de Leva's fraction, and the radii-of-gyration
 * inertia oriented along that axis. A profile segment that owns only *some* of a de Leva segment's
 * bones (per-level lumbar vertebrae, toes split from the foot) takes a share proportional to the
 * bulk of the bones it owns, measured as the volume of their dataset bounds, with the centre of
 * mass at the centre of that bulk. That is an approximation and the compile report says so for
 * every segment it applies to.
 */

import type { DeLevaSegment } from '@bs-humany/anthropometry';
import { type Vec3, vec3 } from '@bs-humany/frames';
import type { BoneDef } from '@bs-humany/hsdl';
import { landmarkId } from '@bs-humany/skeleton';

/** What an endpoint resolver can ask for. Positions are world-space at the compiled morphology. */
export interface EndpointEnv {
  landmark(id: string): Vec3;
  /** World position of a joint's centre, whether or not the profile activates it. */
  joint(id: string): Vec3;
  /** Axis-aligned bounds of a set of bones, in world space at the compiled morphology. */
  bounds(bones: readonly string[]): { readonly min: Vec3; readonly max: Vec3 };
}

export interface DeLevaMapping {
  readonly segment: DeLevaSegment;
  readonly side?: 'l' | 'r';
  readonly bones: (bone: BoneDef) => boolean;
  readonly proximal: (env: EndpointEnv, bones: readonly string[]) => Vec3;
  readonly distal: (env: EndpointEnv, bones: readonly string[]) => Vec3;
  /** How the endpoints relate to de Leva's, where they are not the same point. */
  readonly note?: string;
}

const thoracicLevel = (id: string): number | undefined => {
  const m = /^vertebra_t(\d+)$/.exec(id);
  return m ? Number(m[1]) : undefined;
};
const ribLevel = (id: string): number | undefined => {
  const m = /^rib_(\d+)_[lr]$/.exec(id);
  return m ? Number(m[1]) : undefined;
};
const lumbarLevel = (id: string): number | undefined => {
  const m = /^vertebra_l(\d)$/.exec(id);
  return m ? Number(m[1]) : undefined;
};

const C7 = landmarkId('vertebra_c7', 'Spinous_process_tip');
const XIPHOID = landmarkId('sternum', 'Xiphoid_tip');
const MID_HJC = 'sacrum__mid_hjc';
const MID_ASIS = 'sacrum__mid_asis';

/** Midline point at the height of L4: de Leva's omphalion, which no bone carries. */
function omphalion(env: EndpointEnv): Vec3 {
  const l4 = env.bounds(['vertebra_l4']);
  const asis = env.landmark(MID_ASIS);
  return vec3(0, (l4.min.y + l4.max.y) / 2, asis.z);
}

function limb(
  segment: DeLevaSegment,
  side: 'l' | 'r',
  bones: (bone: BoneDef) => boolean,
  proximal: DeLevaMapping['proximal'],
  distal: DeLevaMapping['distal'],
  note?: string,
): DeLevaMapping {
  return { segment, side, bones, proximal, distal, ...(note ? { note } : {}) };
}

function bothSides(make: (s: 'l' | 'r') => DeLevaMapping): DeLevaMapping[] {
  return [make('r'), make('l')];
}

export const DE_LEVA_MAPPINGS: readonly DeLevaMapping[] = [
  {
    segment: 'head',
    bones: (b) => b.region === 'skull' || b.region === 'cervical',
    proximal: (env, bones) => {
      const skull = env.bounds(bones);
      return vec3(0, skull.max.y, (skull.min.z + skull.max.z) / 2);
    },
    distal: (env) => env.landmark(C7),
    note: 'Vertex taken as the top of the skull bounds on the midline.',
  },
  {
    segment: 'upperTrunk',
    bones: (b) =>
      (thoracicLevel(b.id) ?? 99) <= 8 ||
      (ribLevel(b.id) ?? 99) <= 8 ||
      b.id === 'sternum' ||
      b.region === 'shoulder_girdle',
    proximal: (env) => env.landmark(C7),
    distal: (env) => env.landmark(XIPHOID),
  },
  {
    segment: 'midTrunk',
    bones: (b) =>
      (thoracicLevel(b.id) ?? 0) >= 9 ||
      (ribLevel(b.id) ?? 0) >= 9 ||
      (lumbarLevel(b.id) ?? 9) <= 3,
    proximal: (env) => env.landmark(XIPHOID),
    distal: omphalion,
    note: 'Omphalion taken as the midline point at L4 height, at the ASIS plane.',
  },
  {
    segment: 'lowerTrunk',
    bones: (b) => (lumbarLevel(b.id) ?? 0) >= 4 || b.region === 'sacral' || b.region === 'pelvis',
    proximal: omphalion,
    distal: (env) => env.landmark(MID_HJC),
    note: 'Omphalion taken as the midline point at L4 height, at the ASIS plane.',
  },
  ...bothSides((s) =>
    limb(
      'upperArm',
      s,
      (b) => b.id === `humerus_${s}`,
      (env) => env.joint(`glenohumeral_${s}`),
      (env) => env.joint(`elbow_${s}`),
    ),
  ),
  ...bothSides((s) =>
    limb(
      'forearm',
      s,
      (b) => b.id === `ulna_${s}` || b.id === `radius_${s}`,
      (env) => env.joint(`elbow_${s}`),
      (env) => env.joint(`wrist_${s}`),
    ),
  ),
  ...bothSides((s) =>
    limb(
      'hand',
      s,
      (b) => b.region === 'hand' && b.id.endsWith(`_${s}`),
      (env) => env.joint(`wrist_${s}`),
      (env) => {
        // de Leva's hand runs from the wrist centre to the tip of the middle finger. With the
        // hand hanging in the anatomical pose, the tip is the lowest point of the distal phalanx.
        const tip = env.bounds([`phalanx_distal_3_${s}`]);
        return vec3((tip.min.x + tip.max.x) / 2, tip.min.y, (tip.min.z + tip.max.z) / 2);
      },
      'Fingertip taken as the lowest point of the third distal phalanx in the hanging pose.',
    ),
  ),
  ...bothSides((s) =>
    limb(
      'thigh',
      s,
      (b) => b.id === `femur_${s}` || b.id === `patella_${s}`,
      (env) => env.joint(`hip_${s}`),
      (env) => env.joint(`knee_${s}`),
    ),
  ),
  ...bothSides((s) =>
    limb(
      'shank',
      s,
      (b) => b.id === `tibia_${s}` || b.id === `fibula_${s}`,
      (env) => env.joint(`knee_${s}`),
      (env) => env.joint(`ankle_${s}`),
    ),
  ),
  ...bothSides((s) =>
    limb(
      'foot',
      s,
      (b) => b.region === 'foot' && b.id.endsWith(`_${s}`),
      (env) => env.landmark(landmarkId(`calcaneus_${s}`, 'Posterior_calcaneal_tuberosity_point')),
      (env, bones) => {
        const heel = env.landmark(
          landmarkId(`calcaneus_${s}`, 'Posterior_calcaneal_tuberosity_point'),
        );
        // Anterior is -Z; the toe tip is the anterior extreme of the foot's bounds.
        return vec3(heel.x, heel.y, env.bounds(bones).min.z);
      },
      'Toe tip taken as the anterior extreme of the foot bounds at heel height.',
    ),
  ),
];
