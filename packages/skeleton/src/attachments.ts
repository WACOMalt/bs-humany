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

import surfaceJson from '@bs-humany/assets-anatomical/data/landmarks-surface.json' with {
  type: 'json',
};
import landmarksJson from '@bs-humany/assets-anatomical/data/landmarks.json' with { type: 'json' };
import ridgeJson from '@bs-humany/assets-anatomical/data/ridge-attachments.json' with {
  type: 'json',
};
import { type AttachmentSiteDef, cite, mul, param, writeExtension } from '@bs-humany/hsdl';
import { DATASET_MANIFEST } from './dataset.js';
import { PROVENANCE_NS, landmarkId } from './landmarks.js';
import { MUSCLE_VIA_POINTS } from './muscleViaPoints.js';

type Table = Record<string, Record<string, [number, number, number]>>;
const RAW: Table = landmarksJson as unknown as Table;

interface SurfaceLandmark {
  readonly bone: string;
  readonly feature: string;
  readonly surface: readonly [number, number, number];
  readonly offset: number;
  readonly vertices: number;
  readonly patchRadius: number;
  readonly rule: string;
}

/**
 * Markers put back on the bone they name, by `pnpm --filter @bs-humany/ingest surface-landmarks`.
 *
 * The dataset's markers are label anchors: placed out in the clear beside the feature they name so
 * a text label can point at it. Not one marker in the arm lies on its bone -- the olecranon is
 * 10 mm off it, the anteromedial surface of the humerus 30 mm -- and an attachment floating that
 * far off the bone puts a muscle's whole line of action in the wrong place. Brachialis is the
 * case that showed it: its insertion marker stands 50 mm from the elbow's flexion axis where the
 * reference model's stands 24, which gave it twice the moment arm it should have and a path that
 * misses the surface it is supposed to wrap.
 *
 * So the location comes from the measurement and the anatomy still comes from Gray: the marker
 * names which feature, and the mesh says where that feature is.
 */
const SURFACE = new Map<string, SurfaceLandmark>(
  (surfaceJson as unknown as { readonly landmarks: readonly SurfaceLandmark[] }).landmarks.map(
    (l) => [`${l.bone}/${l.feature}`, l],
  ),
);

interface RidgeAttachment {
  readonly bone: string;
  readonly feature: string;
  readonly surface: readonly [number, number, number];
  readonly height: number;
  readonly traced: number;
  readonly rule: string;
  readonly anatomy: string;
}

/**
 * Points measured along a ridge, for muscles that do not start where the ridge's marker sits.
 *
 * @see `ridgeAttachments.ts`, which measures them and argues for the rule.
 */
const RIDGE = new Map<string, RidgeAttachment>(
  (ridgeJson as unknown as { readonly attachments: readonly RidgeAttachment[] }).attachments.map(
    (a) => [`${a.bone}/${a.feature}`, a],
  ),
);

/** Where an attachment goes: the measured point on the bone, or the raw marker if none exists. */
function located(
  bone: string,
  feature: string,
): { readonly world: readonly [number, number, number]; readonly locatedBy: string } | undefined {
  const ridge = RIDGE.get(`${bone}/${feature}`);
  if (ridge) {
    return {
      world: ridge.surface,
      locatedBy:
        `measured along the ridge: ${ridge.rule}; ${ridge.anatomy}; ` +
        `${(ridge.height * 1000).toFixed(0)} mm up the bone over ${ridge.traced} bins`,
    };
  }
  const measured = SURFACE.get(`${bone}/${feature}`);
  if (measured) {
    return {
      world: measured.surface,
      locatedBy:
        `marker '${feature}' put on the bone: ${measured.rule}; moved ` +
        `${(measured.offset * 1000).toFixed(1)} mm over ${measured.vertices} vertices`,
    };
  }
  const raw = RAW[bone]?.[feature];
  return raw ? { world: raw, locatedBy: `marker: ${feature}` } : undefined;
}

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
  /**
   * Which origin features the muscle's line of action starts between, when no one of them is it.
   *
   * A muscle does not attach at a point. It attaches over a footprint, and where that footprint
   * is long -- the vasti run down most of the femur -- the line of action starts at the middle of
   * it, not at either end. Each feature Gray names gets its own marker, so naming one of them as
   * *the* origin puts the muscle wherever that feature happens to lie. Vastus medialis is what
   * showed it: its origin was the medial supracondylar line, which is 93 per cent of the way down
   * the femur, and the muscle came out 119 mm long where the same muscle on the model its
   * parameters came from is 283.
   *
   * Listed rather than taken over every origin, because the markers are one per *named feature*
   * and not one per equal share of the footprint. Vastus lateralis arises from four features of
   * which three name the same small area around the greater trochanter, so an even average over
   * all four sits at a quarter of the way down the femur -- higher than the muscle goes.
   */
  readonly footprint?: ReadonlyArray<readonly [string, string]>;
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
    // Gray gives it three heads and they pull in three directions: the clavicular head flexes the
    // arm, the sternocostal head adducts it, and the abdominal part off the lower cartilages pulls
    // it down and in. Each takes the stretch of bone it arises from, per M-ADR-005.
    origins: [
      ['clavicle_$', 'Sternal_end'],
      ['sternum', 'Manubrium_of_sternum'],
      ['rib_6_$', 'Body_of_rib'],
    ],
    insertions: [['humerus_$', 'Crest_of_greater_tubercle']],
  },
  {
    id: 'latissimus_dorsi',
    muscle: 'Latissimus dorsi',
    section: 'The Latissimus dorsi',
    bilateral: true,
    // Gray: the spinous processes of the lower six thoracic vertebrae, the thoracolumbar fascia --
    // which is to say the lumbar and sacral spines -- and the iliac crest. Three stretches of the
    // back from the shoulder blade down to the pelvis, and the muscle's parts follow them.
    origins: [
      ['vertebra_t8', 'Spinous_process_tip'],
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
    // The upper two-thirds of the ridge, which is Gray's, and is not where the ridge's own marker
    // sits: that is near its bottom, 32 mm above the elbow, and a muscle started there had an 18
    // mm flexion moment arm where the model these parameters come from gives 90. The measured
    // point is 65 mm up. See `ridgeAttachments.ts`.
    origins: [['humerus_$', 'Lateral_supracondylar_ridge__upper_two_thirds']],
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
    id: 'pronator_quadratus',
    muscle: 'Pronator quadratus',
    section: 'The Pronator quadratus',
    bilateral: true,
    // Gray: from the lower quarter of the anterior surface of the ulna to the lower quarter of
    // the anterior surface of the radius. The deepest muscle of the forearm and the one that
    // pronates without flexing anything.
    origins: [['ulna_$', 'Medial_surface_of_ulna']],
    insertions: [['radius_$', 'Anterior_surface_of_radius']],
  },
  {
    id: 'anconeus',
    muscle: 'Anconeus',
    section: 'The Anconaeus',
    bilateral: true,
    // Gray: from the back of the lateral epicondyle to the side of the olecranon and the upper
    // quarter of the posterior surface of the ulna.
    origins: [['humerus_$', 'Lateral_epicondyle_of_humerus']],
    insertions: [['ulna_$', 'Olecranon']],
  },
  {
    id: 'flexor_carpi_radialis',
    muscle: 'Flexor carpi radialis',
    section: 'The Flexor carpi radialis',
    bilateral: true,
    // Gray: from the medial epicondyle by the common flexor tendon, to the base of the second
    // metacarpal. The dataset marks nothing on that bone and nothing on the left trapezium either,
    // whose tubercle its tendon grooves; the scaphoid's tubercle is marked on both sides, is the
    // radial anchor of the retinaculum this tendon passes under, and is where this one ends.
    origins: [['humerus_$', 'Medial_epicondyle_of_humerus']],
    insertions: [['scaphoid_$', 'Tubercle_of_scaphoid_bone']],
  },
  {
    id: 'flexor_carpi_ulnaris',
    muscle: 'Flexor carpi ulnaris',
    section: 'The Flexor carpi ulnaris',
    bilateral: true,
    // Gray: two heads, one from the medial epicondyle and one from the olecranon and the upper
    // two-thirds of the posterior border of the ulna, inserting into the pisiform and thence by
    // ligaments to the hook of the hamate and the base of the fifth metacarpal. The pisiform is
    // unmarked; the hook of the hamate is marked and is the next thing along that chain.
    origins: [
      ['humerus_$', 'Medial_epicondyle_of_humerus'],
      ['ulna_$', 'Olecranon'],
    ],
    footprint: [['humerus_$', 'Medial_epicondyle_of_humerus']],
    insertions: [['hamate_$', 'Hook_of_hamate_bone']],
  },
  {
    id: 'palmaris_longus',
    muscle: 'Palmaris longus',
    section: 'The Palmaris longus',
    bilateral: true,
    // Gray: from the medial epicondyle to the flexor retinaculum and the palmar aponeurosis. The
    // retinaculum spans the scaphoid and trapezium on one side to the pisiform and hamate on the
    // other, and the scaphoid's tubercle is its marked radial anchor.
    origins: [['humerus_$', 'Medial_epicondyle_of_humerus']],
    insertions: [['scaphoid_$', 'Tubercle_of_scaphoid_bone']],
  },
  {
    id: 'extensor_carpi_radialis_longus',
    muscle: 'Extensor carpi radialis longus',
    section: 'The Extensor carpi radialis longus',
    bilateral: true,
    // Gray: from the *lower third* of the lateral supracondylar ridge -- brachioradialis takes the
    // upper two-thirds -- to the base of the second metacarpal. `ridgeAttachments.ts` measures
    // both portions of that ridge; the second metacarpal is unmarked and the third's base stands
    // in for it.
    origins: [['humerus_$', 'Lateral_supracondylar_ridge__lower_third']],
    insertions: [['metacarpal_3_$', 'Metacarpal_base']],
  },
  {
    id: 'extensor_carpi_radialis_brevis',
    muscle: 'Extensor carpi radialis brevis',
    section: 'The Extensor carpi radialis brevis',
    bilateral: true,
    // Gray: from the lateral epicondyle by the common extensor tendon, to the base of the third
    // metacarpal -- which the dataset marks as that bone's styloid process, and which is exactly
    // where this tendon ends.
    origins: [['humerus_$', 'Lateral_epicondyle_of_humerus']],
    insertions: [['metacarpal_3_$', 'Styloid_process_of_third_metacarpal_bone']],
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
    id: 'external_oblique',
    muscle: 'Obliquus externus abdominis',
    section: 'The Obliquus externus abdominis',
    bilateral: true,
    // Gray: from the outer surfaces of the lower eight ribs, to the iliac crest, the pubic crest
    // and the linea alba. It runs downward and forward; the internal oblique crosses it going
    // upward and forward, and the pair are given the two ends of that crossing.
    origins: [['rib_6_$', 'Body_of_rib']],
    insertions: [['hip_$', 'Pubic_tubercle']],
  },
  {
    id: 'internal_oblique',
    muscle: 'Obliquus internus abdominis',
    section: 'The Obliquus internus abdominis',
    bilateral: true,
    // Gray: from the iliac crest, the thoracolumbar fascia and the inguinal ligament, to the lower
    // three or four ribs and the linea alba -- upward and forward, across the external oblique.
    origins: [['hip_$', 'Anterior_superior_iliac_spine']],
    insertions: [['rib_6_$', 'Body_of_rib']],
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
    // Gray: the gluteal surface of the ilium behind the posterior gluteal line, the dorsum of the
    // sacrum and coccyx, and the sacrotuberous ligament -- which runs to the ischial tuberosity,
    // and that is where the lowest fibres come from.
    origins: [
      ['hip_$', 'Gluteal_surface_of_ilium'],
      ['sacrum', 'Dorsal_surface_of_sacrum'],
      ['hip_$', 'Ischial_tuberosity'],
    ],
    insertions: [['femur_$', 'Gluteal_tuberosity']],
  },
  {
    id: 'gluteus_medius',
    muscle: 'Gluteus medius',
    section: 'The Gluteus medius',
    bilateral: true,
    // Gray: the outer surface of the ilium between the crest and the posterior gluteal line above
    // and the anterior gluteal line below. Its three parts pull in three directions -- the front
    // flexes and rotates in, the back extends and rotates out -- so each gets the border it
    // arises nearest, per M-ADR-005.
    origins: [
      ['hip_$', 'Outer_lip_of_iliac_crest'],
      ['hip_$', 'Anterior_gluteal_line'],
      ['hip_$', 'Posterior_gluteal_line'],
    ],
    insertions: [['femur_$', 'Greater_trochanter']],
  },
  {
    id: 'rectus_femoris',
    muscle: 'Rectus femoris',
    section: 'The Quadriceps femoris',
    bilateral: true,
    origins: [['hip_$', 'Anterior_inferior_iliac_spine']],
    insertions: [['tibia_$', 'Tibial_tuberosity']],
    ligaments: [['tibia_$', 'Tibial_tuberosity']],
  },
  {
    id: 'vastus_lateralis',
    muscle: 'Vastus lateralis',
    section: 'The Quadriceps femoris',
    bilateral: true,
    // Gray gives it four: the upper part of the intertrochanteric line, the borders of the
    // greater trochanter, the lateral lip of the gluteal tuberosity and the upper half of the
    // lateral lip of the linea aspera.
    origins: [
      ['femur_$', 'Linea_aspera'],
      ['femur_$', 'Intertrochanteric_line'],
      ['femur_$', 'Greater_trochanter'],
      ['femur_$', 'Gluteal_tuberosity'],
    ],
    // Of those four, three name the same small area at the top of the femur and the fourth names
    // half its shaft, so the footprint runs between the gluteal tuberosity and the linea aspera.
    // That puts the line of action 38 per cent of the way down the bone.
    footprint: [
      ['femur_$', 'Gluteal_tuberosity'],
      ['femur_$', 'Linea_aspera'],
    ],
    insertions: [['tibia_$', 'Tibial_tuberosity']],
    ligaments: [['tibia_$', 'Tibial_tuberosity']],
  },
  {
    id: 'vastus_medialis',
    muscle: 'Vastus medialis',
    section: 'The Vastus medialis',
    bilateral: true,
    // The medial lip of the linea aspera is Gray's, and was missing here. Without it the muscle
    // had nothing between the top of the femur and its very bottom.
    origins: [
      ['femur_$', 'Medial_supracondylar_line'],
      ['femur_$', 'Intertrochanteric_line'],
      ['femur_$', 'Linea_aspera'],
    ],
    // All three, which between them run the length of the bone: the footprint comes out halfway
    // down, where a vastus medialis pulls from.
    footprint: [
      ['femur_$', 'Intertrochanteric_line'],
      ['femur_$', 'Linea_aspera'],
      ['femur_$', 'Medial_supracondylar_line'],
    ],
    // Into the patella and through its ligament to the tibia. That is where the force arrives, so
    // it is the insertion; the ligament entry beside it records the same place as the ligament
    // attachment it also is.
    insertions: [['tibia_$', 'Tibial_tuberosity']],
    ligaments: [['tibia_$', 'Tibial_tuberosity']],
  },
  {
    id: 'vastus_intermedius',
    muscle: 'Vastus intermedius',
    section: 'The Vastus intermedius',
    bilateral: true,
    origins: [['femur_$', 'Body_of_femur']],
    insertions: [['tibia_$', 'Tibial_tuberosity']],
    ligaments: [['tibia_$', 'Tibial_tuberosity']],
  },
  {
    id: 'gluteus_minimus',
    muscle: 'Gluteus minimus',
    section: 'The Gluteus minimus',
    bilateral: true,
    // Gray: from the gluteal surface of the ilium between the anterior and inferior gluteal
    // lines. The surface marker is the same one the medius uses; the lines are what separate
    // them, and the footprint runs between the two.
    origins: [
      ['hip_$', 'Gluteal_surface_of_ilium'],
      ['hip_$', 'Anterior_gluteal_line'],
      ['hip_$', 'Inferior_gluteal_line'],
    ],
    footprint: [
      ['hip_$', 'Anterior_gluteal_line'],
      ['hip_$', 'Inferior_gluteal_line'],
    ],
    insertions: [['femur_$', 'Greater_trochanter']],
  },
  {
    id: 'adductor_longus',
    muscle: 'Adductor longus',
    section: 'The Adductor longus',
    bilateral: true,
    // Gray: by a flat narrow tendon from the front of the pubis, in the angle between the crest
    // and the symphysis.
    origins: [['hip_$', 'Pubic_crest']],
    insertions: [['femur_$', 'Linea_aspera']],
  },
  {
    id: 'adductor_brevis',
    muscle: 'Adductor brevis',
    section: 'The Adductor brevis',
    bilateral: true,
    // Gray: from the outer surface of the inferior ramus of the pubis, between the gracilis and
    // obturator externus.
    origins: [['hip_$', 'Inferior_pubic_ramus']],
    // Gray: into the line leading from the lesser trochanter to the linea aspera -- the pectineal
    // line -- and the upper part of the linea aspera itself.
    insertions: [['femur_$', 'Pectineal_line_of_femur']],
  },
  {
    id: 'gracilis',
    muscle: 'Gracilis',
    section: 'The Gracilis',
    bilateral: true,
    // Gray: from the body and inferior ramus of the pubis, to the medial surface of the tibia
    // below the condyle -- the pes anserinus, which it shares with sartorius and semitendinosus.
    origins: [
      ['hip_$', 'Body_of_pubis'],
      ['hip_$', 'Inferior_pubic_ramus'],
    ],
    footprint: [
      ['hip_$', 'Body_of_pubis'],
      ['hip_$', 'Inferior_pubic_ramus'],
    ],
    insertions: [['tibia_$', 'Medial_surface_of_tibia']],
  },
  {
    id: 'sartorius',
    muscle: 'Sartorius',
    section: 'The Sartorius',
    bilateral: true,
    // Gray: from the anterior superior iliac spine, to the medial surface of the tibia. The
    // longest muscle in the body, and it crosses both the hip and the knee.
    origins: [['hip_$', 'Anterior_superior_iliac_spine']],
    insertions: [['tibia_$', 'Medial_surface_of_tibia']],
  },
  {
    id: 'piriformis',
    muscle: 'Piriformis',
    section: 'The Piriformis',
    bilateral: true,
    // Gray: from the front of the sacrum, leaving the pelvis through the greater sciatic foramen
    // to reach the upper border of the greater trochanter.
    origins: [['sacrum', 'Pelvic_surface_of_sacrum']],
    insertions: [['femur_$', 'Greater_trochanter']],
  },
  {
    id: 'tensor_fasciae_latae',
    muscle: 'Tensor fasciae latae',
    section: 'The Tensor fasciae latae',
    bilateral: true,
    // Gray: from the anterior part of the outer lip of the iliac crest and the anterior superior
    // iliac spine. It does not reach the femur -- it ends in the iliotibial tract, which does,
    // and the tibia marks where that arrives.
    origins: [
      ['hip_$', 'Anterior_superior_iliac_spine'],
      ['hip_$', 'Outer_lip_of_iliac_crest'],
    ],
    footprint: [
      ['hip_$', 'Anterior_superior_iliac_spine'],
      ['hip_$', 'Outer_lip_of_iliac_crest'],
    ],
    insertions: [['tibia_$', 'Tubercle_of_iliotibial_tract']],
  },
  {
    id: 'adductor_magnus',
    muscle: 'Adductor magnus',
    section: 'The Adductor magnus',
    bilateral: true,
    // Gray: the inferior ramus of the pubis, the ramus of the ischium, and the ischial
    // tuberosity, in that order from front to back -- which is also the order its parts run in.
    origins: [
      ['hip_$', 'Inferior_pubic_ramus'],
      ['hip_$', 'Ramus_of_ischium'],
      ['hip_$', 'Ischial_tuberosity'],
    ],
    // Gray: into the rough line running from the greater trochanter to the linea aspera, then the
    // linea aspera itself, then its medial prolongation -- and the ischiocondylar part alone into
    // the adductor tubercle. Four stretches of femur for the four parts, front to back.
    insertions: [
      ['femur_$', 'Gluteal_tuberosity'],
      ['femur_$', 'Linea_aspera'],
      ['femur_$', 'Medial_supracondylar_line'],
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
    // The supracondylar lines rather than the condyles themselves, and the difference is the
    // muscle's whole action. Gray puts the medial head at "the upper and back part of the medial
    // condyle" and the lateral head "above the lateral condyle" -- above the joint line, which is
    // what makes gastrocnemius a knee flexor. The dataset's condyle markers sit 23 and 31 mm
    // *below* the flexion axis, where a point on the femur swings forward as the knee closes: an
    // origin there lengthens the muscle with flexion and makes it an extensor. The supracondylar
    // markers are 33 and 39 mm above the axis and 11 mm behind it, which is the right side of
    // both.
    origins: [
      ['femur_$', 'Medial_supracondylar_line'],
      ['femur_$', 'Lateral_supracondylar_line'],
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
    id: 'fibularis_longus',
    muscle: 'Fibularis longus',
    section: 'The Peronaeus longus',
    bilateral: true,
    // Gray: from the head and the upper two-thirds of the lateral surface of the fibula. Its
    // tendon crosses the sole in the cuboid's own groove -- the dataset marks that groove, and it
    // is what turns this muscle from a plantarflexor into one that everts the foot as well.
    origins: [
      ['fibula_$', 'Head_of_fibula'],
      ['fibula_$', 'Lateral_surface_of_fibula'],
    ],
    footprint: [
      ['fibula_$', 'Head_of_fibula'],
      ['fibula_$', 'Lateral_surface_of_fibula'],
    ],
    insertions: [['metatarsal_1_$', 'First_metatarsal_bone']],
  },
  {
    id: 'fibularis_brevis',
    muscle: 'Fibularis brevis',
    section: 'The Peronaeus brevis',
    bilateral: true,
    // Gray: from the lower two-thirds of the lateral surface of the fibula, to the tuberosity at
    // the base of the fifth metatarsal.
    origins: [['fibula_$', 'Lateral_surface_of_fibula']],
    insertions: [['metatarsal_5_$', 'Fifth_metatarsal_bone']],
  },
  {
    id: 'extensor_digitorum_longus',
    muscle: 'Extensor digitorum longus',
    section: 'The Extensor digitorum longus',
    bilateral: true,
    // Gray: from the lateral condyle of the tibia and the upper three-quarters of the anterior
    // surface of the fibula, to the middle and distal phalanges of the four lesser toes.
    origins: [
      ['tibia_$', 'Lateral_condyle_of_tibia'],
      ['fibula_$', 'Anterior_border_of_fibula'],
    ],
    footprint: [
      ['fibula_$', 'Anterior_border_of_fibula'],
      ['fibula_$', 'Body_of_fibula'],
    ],
    // The third metatarsal, standing for the four toes it fans to: the dataset marks no
    // phalangeal feature, so the tendon is carried to the head of the middle bone it runs over
    // and stops there. See the note in the generator: this is an ankle muscle here, not a toe one.
    insertions: [['metatarsal_3_$', 'Head_of_metatarsal_bone']],
  },
  {
    id: 'extensor_hallucis_longus',
    muscle: 'Extensor hallucis longus',
    section: 'The Extensor hallucis longus',
    bilateral: true,
    // Gray: from the middle of the anterior surface of the fibula, to the base of the distal
    // phalanx of the great toe.
    origins: [['fibula_$', 'Anteromedial_surface_of_fibula']],
    insertions: [['metatarsal_1_$', 'Head_of_metatarsal_bone']],
  },
  {
    id: 'flexor_digitorum_longus',
    muscle: 'Flexor digitorum longus',
    section: 'The Flexor digitorum longus',
    bilateral: true,
    // Gray: from the posterior surface of the tibia below the soleal line, to the bases of the
    // distal phalanges of the four lesser toes.
    origins: [['tibia_$', 'Posterior_surface_of_tibia']],
    insertions: [['metatarsal_3_$', 'Head_of_metatarsal_bone']],
  },
  {
    id: 'flexor_hallucis_longus',
    muscle: 'Flexor hallucis longus',
    section: 'The Flexor hallucis longus',
    bilateral: true,
    // Gray: from the lower two-thirds of the posterior surface of the fibula, to the base of the
    // distal phalanx of the great toe. Its tendon runs in a groove on the talus and another on
    // the calcaneus, and the dataset marks the calcaneal one.
    origins: [['fibula_$', 'Posterior_surface_of_fibula']],
    insertions: [['metatarsal_1_$', 'Head_of_metatarsal_bone']],
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
      // `located` is the question, not the raw table: a point measured along a ridge is located,
      // and the dataset's own marker for that ridge is not where the muscle starts.
      if (!located(id, feature)) gaps.push(`${m.id}: ${id}/${feature}`);
    }
  }
  return gaps;
}

/**
 * The middle of a muscle's origin footprint, as a site of its own.
 *
 * The centroid of the named features, in the bone's own frame. They must all be on one bone: a
 * point halfway between two bones is not on either, and a line of action has to start somewhere a
 * body can carry it.
 */
function placeFootprint(
  m: MuscleSpec,
  s: 'r' | 'l',
  out: AttachmentSiteDef[],
  seen: Set<string>,
): void {
  const features = m.footprint ?? [];
  const bone = side(features[0]?.[0] ?? '', s);
  const centroid = centroids.get(bone);
  if (!centroid || features.length === 0) return;
  const located_ = features.map(([boneTemplate, feature]) => {
    if (side(boneTemplate, s) !== bone) {
      throw new Error(`${m.id}: a footprint must lie on one bone, and '${feature}' does not.`);
    }
    return located(bone, feature);
  });
  if (located_.some((l) => !l)) return;
  const mean = (i: 0 | 1 | 2) =>
    located_.reduce((total, l) => total + (l?.world[i] ?? 0), 0) / located_.length;
  const id = `${m.id}_origin_${s}_footprint`;
  if (seen.has(id)) return;
  seen.add(id);
  const local = (i: 0 | 1 | 2) => (mean(i) - centroid[i]) / DATASET_MANIFEST.subjectStature;
  const named = features.map(([, feature]) => feature.replace(/_/g, ' ')).join(', ');
  out.push({
    id,
    bone,
    kind: 'muscle_origin',
    displayName: `${m.muscle} origin, ${s === 'r' ? 'right' : 'left'}: middle of the footprint over ${named}`,
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
      locatedBy: `centroid of the measured positions of ${named}`,
    }),
  });
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
          const site = located(bone, feature);
          const centroid = centroids.get(bone);
          if (!site || !centroid) continue;
          const world = site.world;
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
              locatedBy: site.locatedBy,
            }),
          });
        }
      };
      place(m.origins, 'muscle_origin', 'origin');
      place(m.insertions, 'muscle_insertion', 'insertion');
      if (m.ligaments) place(m.ligaments, 'ligament', 'ligament');
      if (m.footprint) placeFootprint(m, s, out, seen);
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
