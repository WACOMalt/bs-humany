/**
 * Attachment sites for major muscles -- milestone M5.3, spec section 14.5 item 2.
 *
 * Each site is a bony feature the dataset carries as a marker, named as a muscle's origin or
 * insertion by Gray (1918). The marker gives the location on this subject; Gray gives the
 * anatomical statement. Nothing here is used by Phase 1 dynamics: the sites exist so that a
 * Phase 2 muscle module has cited points to bind to, through `ext`, rather than inventing them.
 *
 * Coverage is the major superficial and deep muscles of the limbs and trunk whose attachments
 * the dataset's markers can locate. Muscles whose features the dataset does not mark (the jaw,
 * most of the hand and foot intrinsics) are left out and listed by `attachmentGaps`.
 */

import landmarksJson from '@bs-humany/assets-anatomical/data/landmarks.json' with { type: 'json' };
import { type AttachmentSiteDef, cite, mul, param, writeExtension } from '@bs-humany/hsdl';
import { DATASET_MANIFEST } from './dataset.js';
import { PROVENANCE_NS, landmarkId } from './landmarks.js';
import { MUSCLE_VIA_POINTS } from './muscleViaPoints.js';

type Table = Record<string, Record<string, [number, number, number]>>;
const RAW: Table = landmarksJson as unknown as Table;

const gray = (section: string) => cite('gray1918', `Part IV, Myology: ${section}`);

interface MuscleSpec {
  readonly id: string;
  readonly muscle: string;
  readonly section: string;
  /** `[bone, marker]` pairs; a `$` in the bone name takes the side. */
  readonly origins: ReadonlyArray<readonly [string, string]>;
  readonly insertions: ReadonlyArray<readonly [string, string]>;
  /** Ligament attachments, where the muscle reaches bone through one. */
  readonly ligaments?: ReadonlyArray<readonly [string, string]>;
  readonly bilateral: boolean;
}

const MUSCLES: readonly MuscleSpec[] = [
  {
    id: 'deltoid',
    muscle: 'Deltoideus',
    section: 'The Deltoideus',
    bilateral: true,
    origins: [
      ['scapula_$', 'Spine_of_scapula'],
      ['scapula_$', 'Acromion'],
      ['clavicle_$', 'Acromial_end'],
    ],
    insertions: [['humerus_$', 'Deltoid_tuberosity']],
  },
  {
    id: 'pectoralis_major',
    muscle: 'Pectoralis major',
    section: 'The Pectoralis major',
    bilateral: true,
    origins: [
      ['clavicle_$', 'Sternal_end'],
      ['sternum', 'Manubrium_of_sternum'],
    ],
    insertions: [['humerus_$', 'Crest_of_greater_tubercle']],
  },
  {
    id: 'latissimus_dorsi',
    muscle: 'Latissimus dorsi',
    section: 'The Latissimus dorsi',
    bilateral: true,
    origins: [
      ['sacrum', 'Median_sacral_crest'],
      ['hip_$', 'Iliac_crest'],
    ],
    insertions: [['humerus_$', 'Intertubercular_sulcus']],
  },
  {
    id: 'trapezius',
    muscle: 'Trapezius',
    section: 'The Trapezius',
    bilateral: true,
    origins: [
      ['occipital', 'External_occipital_protuberance'],
      ['vertebra_c7', 'Spinous_process_tip'],
    ],
    insertions: [
      ['clavicle_$', 'Acromial_end'],
      ['scapula_$', 'Acromion'],
      ['scapula_$', 'Spine_of_scapula'],
    ],
  },
  {
    id: 'supraspinatus',
    muscle: 'Supraspinatus',
    section: 'The Supraspinatus',
    bilateral: true,
    origins: [['scapula_$', 'Supraspinous_fossa']],
    insertions: [['humerus_$', 'Greater_tubercle']],
  },
  {
    id: 'infraspinatus',
    muscle: 'Infraspinatus',
    section: 'The Infraspinatus',
    bilateral: true,
    origins: [['scapula_$', 'Infraspinous_fossa']],
    insertions: [['humerus_$', 'Greater_tubercle']],
  },
  {
    id: 'subscapularis',
    muscle: 'Subscapularis',
    section: 'The Subscapularis',
    bilateral: true,
    origins: [['scapula_$', 'Subscapular_fossa']],
    insertions: [['humerus_$', 'Lesser_tubercle']],
  },
  {
    id: 'teres_major',
    muscle: 'Teres major',
    section: 'The Teres major',
    bilateral: true,
    origins: [['scapula_$', 'Inferior_angle_of_scapula']],
    insertions: [['humerus_$', 'Crest_of_lesser_tubercle']],
  },
  {
    id: 'teres_minor',
    muscle: 'Teres minor',
    section: 'The Teres minor',
    bilateral: true,
    origins: [['scapula_$', 'Lateral_border_of_scapula']],
    insertions: [['humerus_$', 'Greater_tubercle']],
  },
  {
    id: 'coracobrachialis',
    muscle: 'Coracobrachialis',
    section: 'The Coracobrachialis',
    bilateral: true,
    origins: [['scapula_$', 'Coracoid_process']],
    insertions: [['humerus_$', 'Medial_border_of_humerus']],
  },
  {
    id: 'biceps_brachii',
    muscle: 'Biceps brachii',
    section: 'The Biceps brachii',
    bilateral: true,
    origins: [
      ['scapula_$', 'Supraglenoid_tubercle'],
      ['scapula_$', 'Coracoid_process'],
    ],
    insertions: [['radius_$', 'Radial_tuberosity']],
  },
  {
    id: 'brachialis',
    muscle: 'Brachialis',
    section: 'The Brachialis',
    bilateral: true,
    origins: [['humerus_$', 'Anteromedial_surface_of_humerus']],
    insertions: [['ulna_$', 'Tuberosity_of_ulna']],
  },
  {
    id: 'triceps_brachii',
    muscle: 'Triceps brachii',
    section: 'The Triceps brachii',
    bilateral: true,
    origins: [
      ['scapula_$', 'Infraglenoid_tubercle'],
      ['humerus_$', 'Posterior_surface_of_humerus'],
    ],
    insertions: [['ulna_$', 'Olecranon']],
  },
  {
    id: 'brachioradialis',
    muscle: 'Brachioradialis',
    section: 'The Brachioradialis',
    bilateral: true,
    origins: [['humerus_$', 'Lateral_supracondylar_ridge']],
    insertions: [['radius_$', 'Radial_styloid_process']],
  },
  {
    id: 'pronator_teres',
    muscle: 'Pronator teres',
    section: 'The Pronator teres',
    bilateral: true,
    origins: [
      ['humerus_$', 'Medial_epicondyle_of_humerus'],
      ['ulna_$', 'Coronoid_process_of_ulna'],
    ],
    insertions: [['radius_$', 'Pronator_tuberosity']],
  },
  {
    id: 'supinator',
    muscle: 'Supinator',
    section: 'The Supinator',
    bilateral: true,
    origins: [
      ['humerus_$', 'Lateral_epicondyle_of_humerus'],
      ['ulna_$', 'Supinator_crest'],
    ],
    insertions: [['radius_$', 'Lateral_surface_of_radius']],
  },
  {
    id: 'sternocleidomastoid',
    muscle: 'Sternocleidomastoideus',
    section: 'The Sternocleidomastoideus',
    bilateral: true,
    origins: [
      ['sternum', 'Manubrium_of_sternum'],
      ['clavicle_$', 'Sternal_end'],
    ],
    insertions: [
      ['temporal_$', 'Mastoid_process'],
      ['occipital', 'Superior_nuchal_line'],
    ],
  },
  {
    id: 'erector_spinae',
    muscle: 'Sacrospinalis (erector spinae)',
    section: 'The Sacrospinalis',
    bilateral: true,
    origins: [
      ['sacrum', 'Dorsal_surface_of_sacrum'],
      ['hip_$', 'Iliac_crest'],
    ],
    insertions: [
      ['rib_6_$', 'Angle_of_rib'],
      ['vertebra_l3', 'Transverse_process'],
    ],
  },
  {
    id: 'rectus_abdominis',
    muscle: 'Rectus abdominis',
    section: 'The Rectus abdominis',
    bilateral: true,
    origins: [['hip_$', 'Pubic_crest']],
    insertions: [['sternum', 'Xiphoid_tip']],
  },
  {
    id: 'psoas_major',
    muscle: 'Psoas major',
    section: 'The Psoas major',
    bilateral: true,
    origins: [
      ['vertebra_l3', 'Vertebral_body'],
      ['vertebra_l3', 'Transverse_process'],
    ],
    insertions: [['femur_$', 'Lesser_trochanter']],
  },
  {
    id: 'iliacus',
    muscle: 'Iliacus',
    section: 'The Iliacus',
    bilateral: true,
    origins: [['hip_$', 'Iliac_fossa']],
    insertions: [['femur_$', 'Lesser_trochanter']],
  },
  {
    id: 'gluteus_maximus',
    muscle: 'Gluteus maximus',
    section: 'The Gluteus maximus',
    bilateral: true,
    origins: [
      ['hip_$', 'Gluteal_surface_of_ilium'],
      ['sacrum', 'Dorsal_surface_of_sacrum'],
    ],
    insertions: [['femur_$', 'Gluteal_tuberosity']],
  },
  {
    id: 'gluteus_medius',
    muscle: 'Gluteus medius',
    section: 'The Gluteus medius',
    bilateral: true,
    origins: [['hip_$', 'Gluteal_surface_of_ilium']],
    insertions: [['femur_$', 'Greater_trochanter']],
  },
  {
    id: 'rectus_femoris',
    muscle: 'Rectus femoris',
    section: 'The Quadriceps femoris',
    bilateral: true,
    origins: [['hip_$', 'Anterior_inferior_iliac_spine']],
    insertions: [],
    ligaments: [['tibia_$', 'Tibial_tuberosity']],
  },
  {
    id: 'vastus_lateralis',
    muscle: 'Vastus lateralis',
    section: 'The Quadriceps femoris',
    bilateral: true,
    origins: [
      ['femur_$', 'Linea_aspera'],
      ['femur_$', 'Intertrochanteric_line'],
    ],
    insertions: [],
    ligaments: [['tibia_$', 'Tibial_tuberosity']],
  },
  {
    id: 'adductor_magnus',
    muscle: 'Adductor magnus',
    section: 'The Adductor magnus',
    bilateral: true,
    origins: [['hip_$', 'Ischial_tuberosity']],
    insertions: [
      ['femur_$', 'Linea_aspera'],
      ['femur_$', 'Adductor_tubercle'],
    ],
  },
  {
    id: 'biceps_femoris',
    muscle: 'Biceps femoris',
    section: 'The Biceps femoris',
    bilateral: true,
    origins: [
      ['hip_$', 'Ischial_tuberosity'],
      ['femur_$', 'Linea_aspera'],
    ],
    insertions: [['fibula_$', 'Head_of_fibula']],
  },
  {
    id: 'semitendinosus',
    muscle: 'Semitendinosus',
    section: 'The Semitendinosus',
    bilateral: true,
    origins: [['hip_$', 'Ischial_tuberosity']],
    insertions: [['tibia_$', 'Medial_surface_of_tibia']],
  },
  {
    id: 'semimembranosus',
    muscle: 'Semimembranosus',
    section: 'The Semimembranosus',
    bilateral: true,
    origins: [['hip_$', 'Ischial_tuberosity']],
    insertions: [['tibia_$', 'Medial_condyle_of_tibia']],
  },
  {
    id: 'gastrocnemius',
    muscle: 'Gastrocnemius',
    section: 'The Gastrocnemius',
    bilateral: true,
    origins: [
      ['femur_$', 'Medial_condyle_of_femur'],
      ['femur_$', 'Lateral_condyle_of_femur'],
    ],
    insertions: [['calcaneus_$', 'Calcaneal_tuberosity']],
  },
  {
    id: 'soleus',
    muscle: 'Soleus',
    section: 'The Soleus',
    bilateral: true,
    origins: [
      ['tibia_$', 'Soleal_line'],
      ['fibula_$', 'Head_of_fibula'],
    ],
    insertions: [['calcaneus_$', 'Calcaneal_tuberosity']],
  },
  {
    id: 'tibialis_anterior',
    muscle: 'Tibialis anterior',
    section: 'The Tibialis anterior',
    bilateral: true,
    origins: [
      ['tibia_$', 'Lateral_condyle_of_tibia'],
      ['tibia_$', 'Lateral_surface_of_tibia'],
    ],
    insertions: [['metatarsal_1_$', 'First_metatarsal_bone']],
  },
  {
    id: 'tibialis_posterior',
    muscle: 'Tibialis posterior',
    section: 'The Tibialis posterior',
    bilateral: true,
    origins: [
      ['tibia_$', 'Posterior_surface_of_tibia'],
      ['fibula_$', 'Medial_surface_of_fibula'],
    ],
    insertions: [['navicular_$', 'Tuberosity_of_navicular_bone']],
  },
  {
    id: 'popliteus',
    muscle: 'Popliteus',
    section: 'The Popliteus',
    bilateral: true,
    origins: [['femur_$', 'Groove_for_popliteus_muscle']],
    insertions: [['tibia_$', 'Posterior_surface_of_tibia']],
  },
];

const centroids = new Map(DATASET_MANIFEST.bones.map((b) => [b.id, b.centroid]));

function side(bone: string, s: 'l' | 'r'): string {
  return bone.replace('$', s);
}

/** Muscles and features the dataset could not locate, so the omission is visible. */
export function attachmentGaps(): string[] {
  const gaps: string[] = [];
  for (const m of MUSCLES) {
    for (const [bone, feature] of [...m.origins, ...m.insertions, ...(m.ligaments ?? [])]) {
      const id = side(bone, 'r');
      if (!RAW[id]?.[feature]) gaps.push(`${m.id}: ${id}/${feature}`);
    }
  }
  return gaps;
}

export function buildAttachmentSites(): AttachmentSiteDef[] {
  const out: AttachmentSiteDef[] = [];
  const seen = new Set<string>();
  for (const m of MUSCLES) {
    for (const s of m.bilateral ? (['r', 'l'] as const) : (['r'] as const)) {
      const place = (
        pairs: ReadonlyArray<readonly [string, string]>,
        kind: AttachmentSiteDef['kind'],
        role: string,
      ) => {
        for (const [boneTemplate, feature] of pairs) {
          const bone = side(boneTemplate, s);
          const world = RAW[bone]?.[feature];
          const centroid = centroids.get(bone);
          if (!world || !centroid) continue;
          const id = `${m.id}_${role}_${s}_${landmarkId(bone, feature).split('__')[1]}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const local = (i: 0 | 1 | 2) =>
            (world[i] - centroid[i]) / DATASET_MANIFEST.subjectStature;
          out.push({
            id,
            bone,
            kind,
            displayName: `${m.muscle} ${role}, ${s === 'r' ? 'right' : 'left'}: ${feature.replace(/_/g, ' ')}`,
            position: {
              x: mul(local(0), param('stature')),
              y: mul(local(1), param('stature')),
              z: mul(local(2), param('stature')),
            },
            structure: m.muscle,
            source: gray(m.section),
            ext: writeExtension(undefined, PROVENANCE_NS, {
              dataset: DATASET_MANIFEST.dataset.name,
              datasetVersion: DATASET_MANIFEST.dataset.version,
              sourceSha256: DATASET_MANIFEST.dataset.sourceSha256,
              locatedBy: `marker: ${feature}`,
            }),
          });
        }
      };
      place(m.origins, 'muscle_origin', 'origin');
      place(m.insertions, 'muscle_insertion', 'insertion');
      if (m.ligaments) place(m.ligaments, 'ligament', 'ligament');
    }
  }
  return out;
}

/**
 * Via points, as attachment sites the muscle data can name.
 *
 * A muscle lies along the bones it passes rather than running straight between its attachments.
 * These are where it touches, carried over from the reference model by the frame construction in
 * `muscleViaPoints.ts` -- which is generated, so the numbers here are never typed by hand.
 *
 * Cited to the reference model rather than to Gray, because that is where they come from: Gray
 * says which bony features a muscle attaches to, and says nothing about where along a shaft a
 * tendon happens to lie. The sites this sits beside are the other way round -- Gray's anatomical
 * statement, located on this subject's markers.
 */
export function buildMuscleViaPointSites(): AttachmentSiteDef[] {
  const centroids = new Map(DATASET_MANIFEST.bones.map((b) => [b.id, b.centroid]));
  for (const point of MUSCLE_VIA_POINTS) {
    if (!centroids.has(point.bone)) {
      throw new Error(`Via point '${point.id}' is on '${point.bone}', which is not packed.`);
    }
  }
  return MUSCLE_VIA_POINTS.map((point) => ({
    id: point.id,
    bone: point.bone,
    kind: 'tendon_via_point' as const,
    displayName: `${point.unit}, via point ${point.order}`,
    position: {
      x: mul(point.local[0], param('stature')),
      y: mul(point.local[1], param('stature')),
      z: mul(point.local[2], param('stature')),
    },
    structure: point.unit,
    source: cite(
      'caggiano2022',
      `myoarm_r_chain.xml, site ${point.referenceSite}, carried into this skeleton's humerus ` +
        'frame by the construction in muscleViaPoints.ts',
    ),
    ext: writeExtension(undefined, PROVENANCE_NS, {
      dataset: DATASET_MANIFEST.dataset.name,
      datasetVersion: DATASET_MANIFEST.dataset.version,
      sourceSha256: DATASET_MANIFEST.dataset.sourceSha256,
      locatedBy: `reference site ${point.referenceSite}, through the humerus ISB frame`,
    }),
  }));
}
