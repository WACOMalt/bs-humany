/**
 * The attachment and path sites every built body carries -- milestone M5.3, spec section 14.5
 * item 2.
 *
 * Each site is a bony feature Gray (1918) names as a muscle's origin, insertion or ligament, or
 * one its tendon is held against on the way. Gray gives the anatomical statement; the measured
 * tables give where this subject has the feature (`locateFeature` in `landmarks.ts`).
 * `buildDocument` puts every site here into every body placed on the dataset, whatever its
 * profile (a procedurally placed body has none), and the muscle-data units bind to them by id --
 * an id this file builds with `attachmentSiteId`, and the generators that write the units build
 * with the same function, so the two cannot drift. `buildMuscleViaPointSites` adds the via points
 * carried from the reference model, cited to it rather than to Gray.
 *
 * Coverage is the muscles of the limbs, the trunk, the neck and the shoulder girdle, the
 * intercostals, and the long tendons of the fingers and thumb with their paths over every bone
 * they cross. `attachmentGaps` reports a feature of an included muscle that no table locates;
 * `UNMODELLED_MUSCLES` names the muscles left out -- the hand's and the foot's intrinsics and the
 * jaw's -- and why.
 */

import { type AttachmentSiteDef, cite, mul, param, writeExtension } from '@bs-humany/hsdl';
import {
  type AttachmentRole,
  CARPAL_TUNNEL,
  FIRST_COMPARTMENT,
  LISTERS_TUBERCLE,
  ULNAR_COMPARTMENT,
  attachmentSiteId,
} from './attachmentSiteId.js';
import { DATASET_MANIFEST } from './dataset.js';
import { PROVENANCE_NS, locateFeature } from './landmarks.js';
import { MUSCLE_VIA_POINTS } from './muscleViaPoints.js';

/**
 * Where an attachment goes, and the provenance line that says how it was found.
 *
 * The export's markers are label anchors: placed out in the clear beside the feature they name so
 * a text label can point at it. Not one marker in the arm lies on its bone -- the olecranon is
 * 10 mm off it, the anteromedial surface of the humerus 30 mm -- and an attachment floating that
 * far off the bone puts a muscle's whole line of action in the wrong place. Brachialis is the
 * case that showed it: its insertion marker stands 50 mm from the elbow's flexion axis where the
 * reference model's stands 24, which gave it twice the moment arm it should have and a path that
 * misses the surface it is supposed to wrap. So the location comes from the measurement and the
 * anatomy still comes from Gray: the marker names which feature, and the mesh says where that
 * feature is. `locateFeature` is that one answer, shared with every landmark.
 *
 * A fitted articular or contact centre is not a place a muscle attaches -- it is the middle of a
 * ball or of the gap between two bones -- so one is never an attachment. No feature any muscle
 * here names is one today (their names are the centres' own, `..._articular_centre` and the
 * like), and before `locateFeature` was shared this lookup did not consult those tables at all;
 * refusing them keeps it that way should a muscle ever name one. A derived point is worded as
 * the marker it is published as, which is how this file has always worded it.
 */
function located(
  bone: string,
  feature: string,
): { readonly world: readonly [number, number, number]; readonly locatedBy: string } | undefined {
  const found = locateFeature(bone, feature);
  if (!found) return undefined;
  switch (found.table) {
    case 'ridge': {
      const ridge = found.ridge;
      return {
        world: found.world,
        locatedBy:
          `measured along the ridge: ${ridge.rule}; ${ridge.anatomy}; ` +
          `${(ridge.height * 1000).toFixed(0)} mm up the bone over ${ridge.traced} bins`,
      };
    }
    case 'surface': {
      const measured = found.landmark;
      return {
        world: found.world,
        locatedBy:
          `marker '${feature}' put on the bone: ${measured.rule}; moved ` +
          `${(measured.offset * 1000).toFixed(1)} mm over ${measured.vertices} vertices`,
      };
    }
    case 'derived':
    case 'marker':
      return { world: found.world, locatedBy: `marker: ${feature}` };
    case 'articular':
    case 'contact':
      return undefined;
  }
}

const gray = (section: string) => cite('gray1918', `Part IV, Myology: ${section}`);

interface MuscleSpec {
  readonly id: string;
  readonly muscle: string;
  readonly section: string;
  /** `[bone, marker]` pairs; a `$` in the bone name, or in the marker's, takes the side. */
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
  /**
   * Bony features the muscle passes over on its way, rather than attaches to.
   *
   * A via point in the usual sense, but stated the way everything else in this file is stated --
   * as a feature Gray names in the muscle's own description -- because these are the ones the
   * reference model holds in a frame this package has no correspondence for. The iliopsoas is
   * the case: Gray has it crossing the pelvic brim at the iliopubic eminence before it turns back
   * to the lesser trochanter, and without that bend the drawn path is a chord that passes behind
   * the hip's centre once the thigh is extended, so the flexor reads as an extensor and the leg
   * cannot be brought back.
   */
  readonly path?: ReadonlyArray<readonly [string, string]>;
  readonly bilateral: boolean;
}

/**
 * Where a tendon running to `stop` is held down, and the two sides do not want the same answer.
 *
 * Both sides get a point at the head of every bone they pass, which is where the pulley is. The
 * extensor gets one at each bone's base as well and the flexor does not, and that asymmetry is
 * the geometry of which side of the bend the tendon is on.
 *
 * The extensor runs over the convex side: as the joint flexes, both bones' ends fall away from
 * the chord between them, so with only the heads the chord swings past the joint centre and the
 * muscle reverses -- extensor digitorum's arm at the little finger's proximal interphalangeal ran
 * -2.9 mm to +1.1 across ninety degrees. A point at each base holds the crossing span at the
 * joint and cures it.
 *
 * The flexor runs over the concave side, where the chord already stands off the joint and a base
 * point pulls it back in: given one, flexor digitorum superficialis went 4.3 mm to -3.3 by thirty
 * degrees, which is worse than the fault it was meant to cure. Both were measured on every digit
 * joint of the hand and both feet; this pairing leaves three reversals out of thirty-two, all of
 * them flexors in the last third of a range a finger rarely reaches.
 */
const heldAt =
  (side: 'Flexor' | 'Extensor') =>
  (
    digit: number,
    stop: 'proximal' | 'middle' | 'distal',
  ): ReadonlyArray<readonly [string, string]> => {
    const chain = [`metacarpal_${digit}_$`, ...phalanxChain(digit, stop)];
    return chain.flatMap((bone, i) => [
      // The first bone's base is behind the wrist and holds nothing; the last bone's head is past
      // the insertion.
      ...(i === 0 || side === 'Flexor' ? [] : [[bone, `${side}_side_of_base`] as const]),
      ...(i === chain.length - 1 ? [] : [[bone, `${side}_side_of_head`] as const]),
    ]);
  };

const flexorPath = heldAt('Flexor');
const extensorPath = heldAt('Extensor');

/** The phalanges of a digit from the proximal one up to and including `stop`. */
function phalanxChain(digit: number, stop: 'proximal' | 'middle' | 'distal'): string[] {
  // The thumb has no middle phalanx, so a tendon ending on its distal one crosses one phalanx.
  const parts = digit === 1 ? ['proximal', 'distal'] : ['proximal', 'middle', 'distal'];
  return parts.slice(0, parts.indexOf(stop) + 1).map((part) => `phalanx_${part}_${digit}_$`);
}

const digitName = (d: number) =>
  ({ 1: 'thumb', 2: 'index', 3: 'middle', 4: 'ring', 5: 'little' })[d] ?? String(d);

/**
 * The long digital tendons, one spec each. See the block comment where they are spread in.
 */
const HAND_EXTRINSICS: readonly MuscleSpec[] = [
  ...([2, 3, 4, 5] as const).flatMap((d): MuscleSpec[] => [
    {
      id: `flexor_digitorum_superficialis_${d}`,
      muscle: `Flexor digitorum superficialis, ${digitName(d)}`,
      section: 'The Flexor digitorum sublimis',
      bilateral: true,
      // Gray: from the medial epicondyle, the coronoid process and the anterior border of the
      // radius, by four tendons to the sides of the middle phalanges of the four fingers.
      origins: [
        ['humerus_$', 'Medial_epicondyle_of_humerus'],
        ['ulna_$', 'Coronoid_process_of_ulna'],
      ],
      footprint: [['humerus_$', 'Medial_epicondyle_of_humerus']],
      path: [CARPAL_TUNNEL, ...flexorPath(d, 'middle')],
      insertions: [[`phalanx_middle_${d}_$`, 'Flexor_side_of_shaft']],
    },
    {
      id: `flexor_digitorum_profundus_${d}`,
      muscle: `Flexor digitorum profundus, ${digitName(d)}`,
      section: 'The Flexor digitorum profundus',
      bilateral: true,
      // Gray: from the upper three-fourths of the volar and medial surfaces of the ulna, by four
      // tendons to the bases of the distal phalanges of the four fingers. It passes *through* the
      // split superficialis tendon, which is why it reaches a joint further.
      origins: [['ulna_$', 'Anterior_border_of_ulna']],
      footprint: [
        ['ulna_$', 'Anterior_border_of_ulna'],
        ['ulna_$', 'Medial_surface_of_ulna'],
      ],
      path: [CARPAL_TUNNEL, ...flexorPath(d, 'distal')],
      insertions: [[`phalanx_distal_${d}_$`, 'Flexor_side_of_shaft']],
    },
    {
      id: `extensor_digitorum_${d}`,
      muscle: `Extensor digitorum, ${digitName(d)}`,
      section: 'The Extensor digitorum communis',
      bilateral: true,
      // Gray: from the lateral epicondyle by the common extensor tendon, by four tendons into the
      // dorsal expansions of the fingers and thence the middle and distal phalanges. One line to
      // the distal phalanx stands for that expansion and extends all three joints together.
      origins: [['humerus_$', 'Lateral_epicondyle_of_humerus']],
      path: [LISTERS_TUBERCLE, ...extensorPath(d, 'distal')],
      insertions: [[`phalanx_distal_${d}_$`, 'Extensor_side_of_shaft']],
    },
  ]),
  {
    id: 'extensor_indicis',
    muscle: 'Extensor indicis',
    section: 'The Extensor indicis',
    bilateral: true,
    // Gray: from the dorsal surface of the ulna below the middle, joining the extensor digitorum
    // tendon of the index finger on the back of the hand.
    origins: [['ulna_$', 'Posterior_surface_of_ulna']],
    path: [LISTERS_TUBERCLE, ...extensorPath(2, 'distal')],
    insertions: [['phalanx_distal_2_$', 'Extensor_side_of_shaft']],
  },
  {
    id: 'extensor_digiti_minimi',
    muscle: 'Extensor digiti minimi',
    section: 'The Extensor digiti quinti proprius',
    bilateral: true,
    // Gray: from the lateral epicondyle by the common extensor tendon, through its own
    // compartment over the distal radioulnar joint, to the dorsal expansion of the little finger.
    origins: [['humerus_$', 'Lateral_epicondyle_of_humerus']],
    path: [ULNAR_COMPARTMENT, ...extensorPath(5, 'distal')],
    insertions: [['phalanx_distal_5_$', 'Extensor_side_of_shaft']],
  },
  {
    id: 'extensor_carpi_ulnaris',
    muscle: 'Extensor carpi ulnaris',
    section: 'The Extensor carpi ulnaris',
    bilateral: true,
    // Gray: from the lateral epicondyle and the posterior border of the ulna, to the base of the
    // fifth metacarpal -- which is measured now, so this muscle can be here at all. It was left
    // out of the forearm set for want of it, and its absence left the wrist with two flexors and
    // no ulnar extensor, so ulnar deviation had only one direction.
    origins: [
      ['humerus_$', 'Lateral_epicondyle_of_humerus'],
      ['ulna_$', 'Posterior_border_of_ulna'],
    ],
    footprint: [['humerus_$', 'Lateral_epicondyle_of_humerus']],
    path: [ULNAR_COMPARTMENT],
    insertions: [['metacarpal_5_$', 'Base_of_digit_bone']],
  },
  {
    id: 'flexor_pollicis_longus',
    muscle: 'Flexor pollicis longus',
    section: 'The Flexor pollicis longus',
    bilateral: true,
    // Gray: from the grooved volar surface of the radius, to the base of the distal phalanx of
    // the thumb.
    origins: [['radius_$', 'Anterior_surface_of_radius']],
    path: [CARPAL_TUNNEL, ...flexorPath(1, 'distal')],
    insertions: [['phalanx_distal_1_$', 'Flexor_side_of_shaft']],
  },
  {
    id: 'extensor_pollicis_longus',
    muscle: 'Extensor pollicis longus',
    section: 'The Extensor pollicis longus',
    bilateral: true,
    // Gray: from the lateral part of the dorsal surface of the ulna, to the base of the distal
    // phalanx of the thumb. Its tendon turns round the dorsal radial tubercle, which is the one
    // place in the hand where a via point is not a simplification but the anatomy itself.
    origins: [['ulna_$', 'Posterior_surface_of_ulna']],
    path: [LISTERS_TUBERCLE, ...extensorPath(1, 'distal')],
    insertions: [['phalanx_distal_1_$', 'Extensor_side_of_shaft']],
  },
  {
    id: 'extensor_pollicis_brevis',
    muscle: 'Extensor pollicis brevis',
    section: 'The Extensor pollicis brevis',
    bilateral: true,
    // Gray: from the dorsal surface of the radius below abductor pollicis longus, to the base of
    // the first phalanx of the thumb.
    origins: [['radius_$', 'Posterior_surface_of_radius']],
    path: [FIRST_COMPARTMENT, ...extensorPath(1, 'proximal')],
    insertions: [['phalanx_proximal_1_$', 'Extensor_side_of_shaft']],
  },
  {
    id: 'abductor_pollicis_longus',
    muscle: 'Abductor pollicis longus',
    section: 'The Abductor pollicis longus',
    bilateral: true,
    // Gray: from the lateral part of the dorsal surface of the ulna and the middle third of the
    // dorsal surface of the radius, to the radial side of the base of the first metacarpal.
    origins: [
      ['ulna_$', 'Posterior_surface_of_ulna'],
      ['radius_$', 'Posterior_surface_of_radius'],
    ],
    footprint: [['radius_$', 'Posterior_surface_of_radius']],
    path: [FIRST_COMPARTMENT],
    insertions: [['metacarpal_1_$', 'Base_of_digit_bone']],
  },
];

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
    // metacarpal -- which used to be unmarked, so this tendon stopped at the scaphoid's tubercle,
    // the radial anchor of the retinaculum it passes under. That base is measured now, so the
    // muscle ends where Gray puts it, and keeps the scaphoid as the point it passes over.
    origins: [['humerus_$', 'Medial_epicondyle_of_humerus']],
    path: [['scaphoid_$', 'Tubercle_of_scaphoid_bone']],
    insertions: [['metacarpal_2_$', 'Base_of_digit_bone']],
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
    // both portions of that ridge; the second metacarpal's base used to be unmarked and the
    // third's stood in for it, and is measured now.
    origins: [['humerus_$', 'Lateral_supracondylar_ridge__lower_third']],
    path: [['radius_$', 'Radial_styloid_process']],
    insertions: [['metacarpal_2_$', 'Base_of_digit_bone']],
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
  /**
   * The long tendons of the hand: what actually bends a finger.
   *
   * The hand has thirty joints and forty degrees of freedom and had no muscle crossing any of
   * them, because there was nothing to attach one to. That is fixed at the other end: every bone
   * in every digit now carries its own base, its own head, and the flexor and extensor sides of
   * that head, all measured off the bone (`tools/ingest/src/derived.ts`).
   *
   * ## The path is the muscle
   *
   * A finger flexor that runs straight from the forearm to a fingertip does not flex the finger.
   * It pulls it off its joints. What makes these muscles work is that the flexors are held
   * against the palmar side of every bone they cross by the fibrous sheath's pulleys, and the
   * extensors ride the dorsal ridges -- so each tendon is given the flexor or extensor side of
   * the head of every bone proximal to its ending, which is where the sheath holds it.
   *
   * These are `path` rather than carried via points because `muscleViaPoints.ts` carries points
   * for the clavicle, scapula, humerus, ulna and radius and nothing beyond: the frame
   * correspondence it is built on stops at the wrist. The ankle set has the same argument written
   * out at length and reached the same answer -- our own geometry beats a correspondence fitted
   * two joints away.
   *
   * ## At the wrist, the compartment each tendon is really in
   *
   * The extensor retinaculum has six compartments and a tendon in the wrong one is deviated the
   * wrong way, so each takes the marked feature its own compartment lies over: abductor pollicis
   * longus and extensor pollicis brevis the radial styloid (first), extensor pollicis longus the
   * dorsal radial tubercle it hooks around (third), the digital extensors that same tubercle,
   * which the fourth compartment lies immediately ulnar to, and extensor digiti minimi and
   * extensor carpi ulnaris the head of the ulna (fifth and sixth). The flexors pass the carpal
   * tunnel, whose marked ulnar wall is the hook of the hamate.
   *
   * ## What is here and what is not
   *
   * The extrinsics: the muscles in the forearm that move the digits. Superficialis stops at the
   * middle phalanx and profundus goes on to the distal one, which is the real difference between
   * them and gives the finger two genuinely different flexions. The extensor is one line to the
   * distal phalanx rather than the dorsal expansion it truly is, and so extends all three joints
   * together -- which is how a finger extends, though not by this mechanism.
   *
   * The intrinsics are not here: the lumbricals and the interossei insert into that same dorsal
   * expansion, which is not bone and which the dataset does not carry, and the thenar and
   * hypothenar muscles arise from the flexor retinaculum, likewise. The reference model has
   * parameters for most of them; they are named in `UNMODELLED_MUSCLES`.
   */
  ...HAND_EXTRINSICS,
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
  // --- The neck: what holds the head up and turns it. Gray's cervical muscles, on the points
  // measured for them (derived.ts): a transverse process tip is its vertebra's most lateral
  // point, a spinous tip its most posterior, and the front of a body its most anterior.
  {
    id: 'splenius_capitis',
    muscle: 'Splenius capitis',
    section: 'The Splenius capitis',
    bilateral: true,
    origins: [['vertebra_t3', 'Spinous_process_tip']],
    insertions: [['temporal_$', 'Mastoid_process']],
  },
  {
    id: 'splenius_cervicis',
    muscle: 'Splenius cervicis',
    section: 'The Splenius cervicis',
    bilateral: true,
    origins: [['vertebra_t5', 'Spinous_process_tip']],
    insertions: [['vertebra_c2', 'Transverse_process_tip_$']],
  },
  {
    id: 'semispinalis_capitis',
    muscle: 'Semispinalis capitis',
    section: 'The Semispinalis capitis',
    bilateral: true,
    origins: [['vertebra_t4', 'Transverse_process_tip_$']],
    insertions: [['occipital', 'Inferior_nuchal_line_$']],
  },
  {
    id: 'longissimus_capitis',
    muscle: 'Longissimus capitis',
    section: 'The Longissimus capitis',
    bilateral: true,
    origins: [['vertebra_t3', 'Transverse_process_tip_$']],
    insertions: [['temporal_$', 'Mastoid_process']],
  },
  {
    id: 'longissimus_cervicis',
    muscle: 'Longissimus cervicis',
    section: 'The Longissimus cervicis',
    bilateral: true,
    origins: [['vertebra_t4', 'Transverse_process_tip_$']],
    insertions: [['vertebra_c4', 'Transverse_process_tip_$']],
  },
  {
    id: 'scalenus_anterior',
    muscle: 'Scalenus anterior',
    section: 'The Scalenus anterior',
    bilateral: true,
    origins: [['vertebra_c4', 'Transverse_process_tip_$']],
    insertions: [['rib_1_$', 'Upper_border_at_50']],
  },
  {
    id: 'scalenus_medius',
    muscle: 'Scalenus medius',
    section: 'The Scalenus medius',
    bilateral: true,
    origins: [['vertebra_c5', 'Transverse_process_tip_$']],
    insertions: [['rib_1_$', 'Upper_border_at_60']],
  },
  {
    id: 'scalenus_posterior',
    muscle: 'Scalenus posterior',
    section: 'The Scalenus posterior',
    bilateral: true,
    origins: [['vertebra_c6', 'Transverse_process_tip_$']],
    insertions: [['rib_2_$', 'Upper_border_at_50']],
  },
  {
    id: 'longus_colli',
    muscle: 'Longus colli',
    section: 'The Longus colli',
    bilateral: true,
    origins: [['vertebra_t2', 'Anterior_surface_of_body']],
    insertions: [['vertebra_c1', 'Anterior_tubercle_of_atlas']],
  },
  {
    id: 'longus_capitis',
    muscle: 'Longus capitis',
    section: 'The Longus capitis',
    bilateral: true,
    origins: [['vertebra_c4', 'Transverse_process_tip_$']],
    insertions: [['occipital', 'Basilar_part_of_occipital_bone']],
  },
  // --- The shoulder girdle: what hangs the scapula from the skull and spine and pins it to the
  // ribs. Trapezius in three parts, as Seth 2019 carries it.
  {
    id: 'trapezius_upper',
    muscle: 'Trapezius, descending part',
    section: 'The Trapezius',
    bilateral: true,
    origins: [['occipital', 'External_occipital_protuberance']],
    insertions: [['clavicle_$', 'Acromial_end']],
  },
  {
    id: 'trapezius_middle',
    muscle: 'Trapezius, transverse part',
    section: 'The Trapezius',
    bilateral: true,
    origins: [['vertebra_c7', 'Spinous_process_tip']],
    insertions: [['scapula_$', 'Acromion']],
  },
  {
    id: 'trapezius_lower',
    muscle: 'Trapezius, ascending part',
    section: 'The Trapezius',
    bilateral: true,
    origins: [['vertebra_t8', 'Spinous_process_tip']],
    insertions: [['scapula_$', 'Spine_of_scapula']],
  },
  {
    id: 'levator_scapulae',
    muscle: 'Levator scapulae',
    section: 'The Levator scapulae',
    bilateral: true,
    origins: [['vertebra_c2', 'Transverse_process_tip_$']],
    insertions: [['scapula_$', 'Superior_angle_of_scapula']],
  },
  {
    id: 'rhomboid_minor',
    muscle: 'Rhomboideus minor',
    section: 'The Rhomboideus minor',
    bilateral: true,
    origins: [['vertebra_c7', 'Spinous_process_tip']],
    insertions: [['scapula_$', 'Medial_border_of_scapula']],
  },
  {
    id: 'rhomboid_major',
    muscle: 'Rhomboideus major',
    section: 'The Rhomboideus major',
    bilateral: true,
    origins: [['vertebra_t3', 'Spinous_process_tip']],
    insertions: [['scapula_$', 'Medial_border_of_scapula']],
  },
  {
    id: 'serratus_anterior_superior',
    muscle: 'Serratus anterior, superior part',
    section: 'The Serratus anterior',
    bilateral: true,
    origins: [['rib_2_$', 'Outer_surface_at_70']],
    insertions: [['scapula_$', 'Superior_angle_of_scapula']],
  },
  {
    id: 'serratus_anterior_middle',
    muscle: 'Serratus anterior, middle part',
    section: 'The Serratus anterior',
    bilateral: true,
    origins: [['rib_5_$', 'Outer_surface_at_70']],
    insertions: [['scapula_$', 'Medial_border_of_scapula']],
  },
  {
    id: 'serratus_anterior_inferior',
    muscle: 'Serratus anterior, inferior part',
    section: 'The Serratus anterior',
    bilateral: true,
    origins: [['rib_8_$', 'Outer_surface_at_70']],
    insertions: [['scapula_$', 'Inferior_angle_of_scapula']],
  },
  {
    id: 'pectoralis_minor',
    muscle: 'Pectoralis minor',
    section: 'The Pectoralis minor',
    bilateral: true,
    origins: [['rib_4_$', 'Outer_surface_at_90']],
    insertions: [['scapula_$', 'Coracoid_process']],
  },
  // --- The intercostals: one external and one internal sheet in each of the eleven spaces,
  // from a rib's lower border to the upper border of the rib below, the external running
  // forward and down and the internal back and down, so that between them they hold the cage.
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const).flatMap((n): MuscleSpec[] => [
    {
      id: `external_intercostal_${n}`,
      muscle: `External intercostal, space ${n}`,
      section: 'The Intercostales externi',
      bilateral: true,
      origins: [[`rib_${n}_$`, 'Lower_border_at_50']],
      insertions: [[`rib_${n + 1}_$`, 'Upper_border_at_60']],
    },
    {
      id: `internal_intercostal_${n}`,
      muscle: `Internal intercostal, space ${n}`,
      section: 'The Intercostales interni',
      bilateral: true,
      origins: [[`rib_${n}_$`, 'Lower_border_at_70']],
      insertions: [[`rib_${n + 1}_$`, 'Upper_border_at_60']],
    },
  ]),
  {
    id: 'erector_spinae',
    muscle: 'Sacrospinalis (erector spinae)',
    section: 'The Sacrospinalis',
    bilateral: true,
    origins: [
      ['sacrum', 'Dorsal_surface_of_sacrum'],
      ['hip_$', 'Iliac_crest'],
    ],
    // Gray: it splits as it ascends and attaches all the way up -- the transverse and spinous
    // processes of the lumbar and thoracic vertebrae, and the angles of the ribs. Those are
    // attachments and they are also the line the muscle follows, which is why two of them are
    // path points in the torso set: a straight run from the sacrum to the sixth rib chords
    // through the abdomen instead of lying in the groove beside the spine.
    insertions: [
      ['rib_6_$', 'Angle_of_rib'],
      ['vertebra_l3', 'Transverse_process'],
      ['vertebra_l3', 'Spinous_process'],
      ['vertebra_t8', 'Spinous_process_tip'],
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
    // Gray: it passes beneath the inguinal ligament over the brim of the pelvis, and the brim it
    // crosses is the iliopubic eminence. That is a bend and not an attachment, which is what
    // `path` is for.
    path: [['hip_$', 'Iliopubic_eminence']],
  },
  {
    id: 'iliacus',
    muscle: 'Iliacus',
    section: 'The Iliacus',
    bilateral: true,
    origins: [['hip_$', 'Iliac_fossa']],
    insertions: [['femur_$', 'Lesser_trochanter']],
    // The same brim, joined to the same tendon. See psoas major above.
    path: [['hip_$', 'Iliopubic_eminence']],
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
    // The third toe's middle phalanx, standing for the four toes the tendon fans to. Gray puts
    // it on the middle and distal phalanges of the lesser toes through the extensor expansion;
    // one unit cannot be on four toes at once, so it takes the middle of the four and says so.
    // It used to stop at a metatarsal head, because the export marks no phalangeal feature --
    // `Base_of_digit_bone` is derived now (see tools/ingest/src/derived.ts), and with the toes
    // articulated a tendon that stopped short of them was crossing no toe joint at all.
    path: [
      ['metatarsal_3_$', 'Extensor_side_of_head'],
      ['phalanx_pedis_proximal_3_$', 'Extensor_side_of_head'],
    ],
    insertions: [['phalanx_pedis_middle_3_$', 'Extensor_side_of_shaft']],
  },
  {
    id: 'extensor_hallucis_longus',
    muscle: 'Extensor hallucis longus',
    section: 'The Extensor hallucis longus',
    bilateral: true,
    // Gray: from the middle of the anterior surface of the fibula, to the base of the distal
    // phalanx of the great toe.
    origins: [['fibula_$', 'Anteromedial_surface_of_fibula']],
    path: [
      ['metatarsal_1_$', 'Extensor_side_of_head'],
      ['phalanx_pedis_proximal_1_$', 'Extensor_side_of_head'],
    ],
    insertions: [['phalanx_pedis_distal_1_$', 'Extensor_side_of_shaft']],
  },
  {
    id: 'flexor_digitorum_longus',
    muscle: 'Flexor digitorum longus',
    section: 'The Flexor digitorum longus',
    bilateral: true,
    // Gray: from the posterior surface of the tibia below the soleal line, to the bases of the
    // distal phalanges of the four lesser toes.
    origins: [['tibia_$', 'Posterior_surface_of_tibia']],
    // The third toe's distal phalanx, standing for the four the tendon divides between.
    path: [
      ['metatarsal_3_$', 'Flexor_side_of_head'],
      ['phalanx_pedis_proximal_3_$', 'Flexor_side_of_head'],
      ['phalanx_pedis_middle_3_$', 'Flexor_side_of_head'],
    ],
    insertions: [['phalanx_pedis_distal_3_$', 'Flexor_side_of_shaft']],
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
    path: [
      ['metatarsal_1_$', 'Flexor_side_of_head'],
      ['phalanx_pedis_proximal_1_$', 'Flexor_side_of_head'],
    ],
    insertions: [['phalanx_pedis_distal_1_$', 'Flexor_side_of_shaft']],
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

/**
 * Whole muscles the body does not have, and why, so the omission is visible.
 *
 * This is a statement about what is *not* in `MUSCLES`, and nothing can compute that from what is,
 * so it is written by hand. `attachmentGaps` answers a different question -- a feature of a muscle
 * that *is* included and the dataset could not locate -- and a muscle with no entry at all never
 * reaches it. The muscle-data tests hold this list against the whole-body set, so a muscle added
 * without taking it off here fails rather than the studio going on saying the body lacks it.
 *
 * `muscles` are id stems, spelled the way a unit id would begin, so that check is a prefix match.
 * No physical numbers here: it says what is missing, not what it would be.
 */
export const UNMODELLED_MUSCLES: readonly {
  readonly group: string;
  readonly muscles: readonly string[];
  readonly reason: string;
  readonly unblockedBy: string;
}[] = [
  {
    group: "the hand's intrinsics",
    muscles: [
      'lumbrical',
      'dorsal_interosseous',
      'palmar_interosseous',
      'abductor_pollicis_brevis',
      'flexor_pollicis_brevis',
      'opponens_pollicis',
      'adductor_pollicis',
      'abductor_digiti_minimi',
      'flexor_digiti_minimi_brevis',
      'opponens_digiti_minimi',
    ],
    reason:
      'The lumbricals and interossei insert into the dorsal expansion, and the thenar and ' +
      'hypothenar muscles arise largely from the flexor retinaculum. Both are soft tissue and the ' +
      'dataset carries neither, so there is nothing on this skeleton to bind them to -- although ' +
      'the reference arm model has parameters for opponens pollicis, the lumbricals and the ' +
      'interossei.',
    unblockedBy:
      'docs/plans/dataset-correspondence.md 5.2: points for the dorsal expansion and the ' +
      'retinaculum, measured or constructed from the bones they span.',
  },
  {
    group: "the foot's intrinsics",
    muscles: [
      'extensor_digitorum_brevis',
      'extensor_hallucis_brevis',
      'abductor_hallucis',
      'flexor_digitorum_brevis',
      'abductor_digiti_minimi',
      'quadratus_plantae',
      'lumbrical',
      'flexor_hallucis_brevis',
      'adductor_hallucis',
      'flexor_digiti_minimi_brevis',
      'dorsal_interosseous',
      'plantar_interosseous',
    ],
    reason:
      'Most attach to the plantar aponeurosis, the long flexor tendons or the extensor ' +
      'expansions, which are soft tissue the dataset does not carry, and the reference leg model ' +
      'has no foot intrinsics at all, so there are no parameters to take either.',
    unblockedBy:
      'A redistributable source for their parameters, and attachment points for the soft ' +
      'structures they run to.',
  },
  {
    group: 'the jaw muscles',
    muscles: ['masseter', 'temporalis', 'medial_pterygoid', 'lateral_pterygoid'],
    reason:
      'They insert on the ramus, angle and coronoid process of the mandible, none of which the ' +
      'dataset marks, and the skeleton has no temporomandibular joint for them to move. No ' +
      'vendored reference model carries them.',
    unblockedBy:
      'A temporomandibular joint, the mandible features measured off the bone, and a source for ' +
      'their parameters.',
  },
];

/** Features of included muscles the dataset could not locate. */
export function attachmentGaps(): string[] {
  const gaps: string[] = [];
  for (const m of MUSCLES) {
    for (const [bone, feature] of [
      ...m.origins,
      ...m.insertions,
      ...(m.ligaments ?? []),
      ...(m.path ?? []),
    ]) {
      const id = side(bone, 'r');
      // `located` is the question, not the raw table: a point measured along a ridge is located,
      // and the dataset's own marker for that ridge is not where the muscle starts.
      if (!located(id, side(feature, 'r'))) gaps.push(`${m.id}: ${id}/${feature}`);
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
  // Named like an origin at a feature called 'footprint', which is what the knee set binds to.
  const id = attachmentSiteId(m.id, 'origin', s, bone, 'footprint');
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
        role: AttachmentRole,
      ) => {
        for (const [boneTemplate, featureTemplate] of pairs) {
          const bone = side(boneTemplate, s);
          // A midline bone's paired features carry the side in the feature instead.
          const feature = side(featureTemplate, s);
          const site = located(bone, feature);
          const centroid = centroids.get(bone);
          if (!site || !centroid) continue;
          const world = site.world;
          // A path site carries the bone it is on and an attachment does not, so that a tendon
          // held against the same named feature on three bones keeps three points through the
          // dedupe below. `attachmentSiteId` has the whole argument, and the generators name the
          // sites with the same function.
          const id = attachmentSiteId(m.id, role, s, bone, feature);
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
      if (m.path) place(m.path, 'tendon_via_point', 'path');
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
