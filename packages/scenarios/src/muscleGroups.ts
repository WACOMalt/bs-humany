/**
 * The muscle groups a person drives: one table, for every control that offers them.
 *
 * The studio's sliders are generated from this, the headless publisher's panel reads it, and so
 * the headset's panel shows exactly the same groups in the same order at the same ids. Every
 * one of the two hundred and seventy-two units belongs to exactly one group -- a test holds
 * that against the muscle data -- so nothing in the body is out of reach of a slider.
 *
 * Grouped the way a person thinks about a joint: what flexes it, what extends it, and so on.
 * Ids are the studio's original slider ids where a group already existed, so nothing that
 * remembered them by name has to change.
 */

export type DriveSection = 'Arm' | 'Hand' | 'Leg' | 'Trunk' | 'Neck';

export interface DriveGroup {
  readonly id: string;
  readonly title: string;
  readonly section: DriveSection;
  readonly units: readonly string[];
}

const both = (...names: string[]): string[] => names.flatMap((n) => [`${n}_r`, `${n}_l`]);

export const MUSCLE_GROUPS: readonly DriveGroup[] = [
  // --- arm -------------------------------------------------------------------------------------
  {
    id: 'shoulderFlexorDrive',
    title: 'Shoulder flexors',
    section: 'Arm',
    units: both('deltoid_anterior', 'pectoralis_major_clavicular', 'coracobrachialis'),
  },
  {
    id: 'shoulderExtensorDrive',
    title: 'Shoulder extensors',
    section: 'Arm',
    units: both('deltoid_posterior', 'latissimus_dorsi_lumbar', 'teres_major'),
  },
  {
    id: 'shoulderAbductorDrive',
    title: 'Shoulder abductors',
    section: 'Arm',
    units: both('deltoid_middle', 'supraspinatus'),
  },
  {
    id: 'armAdductorDrive',
    title: 'Latissimus and pectoralis',
    section: 'Arm',
    units: both(
      'latissimus_dorsi_thoracic',
      'latissimus_dorsi_iliac',
      'pectoralis_major_sternal',
      'pectoralis_major_abdominal',
    ),
  },
  {
    id: 'shoulderExternalRotatorDrive',
    title: 'Shoulder external rotators',
    section: 'Arm',
    units: both('infraspinatus', 'teres_minor'),
  },
  {
    id: 'shoulderInternalRotatorDrive',
    title: 'Shoulder internal rotators',
    section: 'Arm',
    units: both('subscapularis'),
  },
  {
    id: 'flexorDrive',
    title: 'Elbow flexors',
    section: 'Arm',
    units: both('biceps_brachii_long', 'biceps_brachii_short', 'brachialis', 'brachioradialis'),
  },
  {
    id: 'extensorDrive',
    title: 'Elbow extensors',
    section: 'Arm',
    units: both(
      'triceps_brachii_long',
      'triceps_brachii_lateral',
      'triceps_brachii_medial',
      'anconeus',
    ),
  },
  {
    id: 'wristFlexorDrive',
    title: 'Wrist flexors',
    section: 'Arm',
    units: both('flexor_carpi_radialis', 'flexor_carpi_ulnaris'),
  },
  {
    id: 'wristExtensorDrive',
    title: 'Wrist extensors',
    section: 'Arm',
    units: both(
      'extensor_carpi_radialis_longus',
      'extensor_carpi_radialis_brevis',
      // The ulnar one, which the wrist had no counterpart to until the fifth metacarpal's base
      // was measured and it could be given somewhere to end.
      'extensor_carpi_ulnaris',
    ),
  },
  {
    id: 'pronatorDrive',
    title: 'Pronators',
    section: 'Arm',
    units: both('pronator_teres', 'pronator_quadratus'),
  },
  { id: 'supinatorDrive', title: 'Supinator', section: 'Arm', units: both('supinator') },
  // --- hand ------------------------------------------------------------------------------------
  {
    id: 'fingerFlexorDrive',
    title: 'Finger flexors',
    section: 'Hand',
    units: both(
      ...[2, 3, 4, 5].flatMap((d) => [
        `flexor_digitorum_superficialis_${d}`,
        `flexor_digitorum_profundus_${d}`,
      ]),
    ),
  },
  {
    id: 'fingerExtensorDrive',
    title: 'Finger extensors',
    section: 'Hand',
    units: both(
      ...[2, 3, 4, 5].map((d) => `extensor_digitorum_${d}`),
      'extensor_indicis',
      'extensor_digiti_minimi',
    ),
  },
  {
    id: 'thumbFlexorDrive',
    title: 'Thumb flexors',
    section: 'Hand',
    units: both('flexor_pollicis_longus'),
  },
  {
    id: 'thumbExtensorDrive',
    title: 'Thumb extensors',
    section: 'Hand',
    units: both('extensor_pollicis_longus', 'extensor_pollicis_brevis', 'abductor_pollicis_longus'),
  },
  // --- toes ---------------------------------------------------------------------------------
  {
    id: 'toeFlexorDrive',
    title: 'Toe flexors',
    section: 'Leg',
    units: both('flexor_digitorum_longus', 'flexor_hallucis_longus'),
  },
  {
    id: 'toeExtensorDrive',
    title: 'Toe extensors',
    section: 'Leg',
    units: both('extensor_digitorum_longus', 'extensor_hallucis_longus'),
  },
  // --- leg -------------------------------------------------------------------------------------
  {
    id: 'hipFlexorDrive',
    title: 'Hip flexors',
    section: 'Leg',
    units: both('iliacus', 'psoas_major', 'sartorius', 'tensor_fasciae_latae'),
  },
  {
    id: 'hipExtensorDrive',
    title: 'Hip extensors',
    section: 'Leg',
    units: both(
      'gluteus_maximus_superior',
      'gluteus_maximus_middle',
      'gluteus_maximus_inferior',
      'adductor_magnus_ischiocondylar',
    ),
  },
  {
    id: 'hipAbductorDrive',
    title: 'Hip abductors',
    section: 'Leg',
    units: both(
      'gluteus_medius_anterior',
      'gluteus_medius_middle',
      'gluteus_medius_posterior',
      'gluteus_minimus_anterior',
      'gluteus_minimus_middle',
      'gluteus_minimus_posterior',
    ),
  },
  {
    id: 'hipAdductorDrive',
    title: 'Hip adductors',
    section: 'Leg',
    units: both(
      'adductor_longus',
      'adductor_brevis',
      'adductor_magnus_proximal',
      'adductor_magnus_middle',
      'adductor_magnus_distal',
      'gracilis',
    ),
  },
  {
    id: 'hipExternalRotatorDrive',
    title: 'Hip external rotators',
    section: 'Leg',
    units: both('piriformis'),
  },
  {
    id: 'kneeFlexorDrive',
    title: 'Knee flexors',
    section: 'Leg',
    units: both(
      'biceps_femoris_long',
      'biceps_femoris_short',
      'semitendinosus',
      'semimembranosus',
      'gastrocnemius_lateral',
      'gastrocnemius_medial',
    ),
  },
  {
    id: 'kneeExtensorDrive',
    title: 'Knee extensors',
    section: 'Leg',
    units: both('rectus_femoris', 'vastus_lateralis', 'vastus_medialis', 'vastus_intermedius'),
  },
  {
    id: 'anklePlantarflexorDrive',
    title: 'Ankle plantarflexors',
    section: 'Leg',
    units: both('soleus', 'tibialis_posterior', 'fibularis_longus', 'fibularis_brevis'),
  },
  {
    id: 'ankleDorsiflexorDrive',
    title: 'Ankle dorsiflexors',
    section: 'Leg',
    units: both('tibialis_anterior'),
  },
  // --- trunk -----------------------------------------------------------------------------------
  {
    id: 'trunkFlexorDrive',
    title: 'Trunk flexors',
    section: 'Trunk',
    units: both('rectus_abdominis', 'external_oblique', 'internal_oblique'),
  },
  {
    id: 'trunkExtensorDrive',
    title: 'Trunk extensors',
    section: 'Trunk',
    units: both('erector_spinae'),
  },
  {
    id: 'intercostalDrive',
    title: 'Intercostals',
    section: 'Trunk',
    units: both(
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].flatMap((n) => [
        `external_intercostal_${n}`,
        `internal_intercostal_${n}`,
      ]),
    ),
  },
  // --- neck and shoulder girdle -----------------------------------------------------------------
  {
    id: 'neckFlexorDrive',
    title: 'Neck flexors',
    section: 'Neck',
    units: both(
      'sternocleidomastoid',
      'longus_colli',
      'longus_capitis',
      'scalenus_anterior',
      'scalenus_medius',
      'scalenus_posterior',
    ),
  },
  {
    id: 'neckExtensorDrive',
    title: 'Neck extensors',
    section: 'Neck',
    units: both(
      'splenius_capitis',
      'splenius_cervicis',
      'semispinalis_capitis',
      'longissimus_capitis',
      'longissimus_cervicis',
    ),
  },
  {
    id: 'girdleElevatorDrive',
    title: 'Shoulder girdle elevators',
    section: 'Neck',
    units: both('trapezius_upper', 'levator_scapulae'),
  },
  {
    id: 'girdleRetractorDrive',
    title: 'Shoulder girdle retractors',
    section: 'Neck',
    units: both('trapezius_middle', 'trapezius_lower', 'rhomboid_minor', 'rhomboid_major'),
  },
  {
    id: 'girdleProtractorDrive',
    title: 'Shoulder girdle protractors',
    section: 'Neck',
    units: both(
      'serratus_anterior_superior',
      'serratus_anterior_middle',
      'serratus_anterior_inferior',
      'pectoralis_minor',
    ),
  },
];

/** The studio's mapping from a slider's 0..100 to excitation: squared, so the first few per
 * cent of drive get a usable stretch of travel. */
export function driveForSlider(position: number): number {
  const fraction = position / 100;
  return fraction * fraction;
}

/**
 * What opposes what, for the cord's reciprocal inhibition.
 *
 * A stretched muscle's Ia afferent excites it and, through an interneuron, inhibits its
 * opposite; without the second half a pair co-contract and the joint stiffens instead of
 * moving. The table is symmetric and it is written once here, beside the groups themselves, so
 * the studio, the headset and the trainer all inhibit the same pairs.
 *
 * Three groups have no entry and want none. The hip's external rotators have no single
 * antagonist in this table -- the internal rotators are spread through the adductors -- the
 * intercostals oppose the breath rather than a muscle, and the girdle's elevators are opposed by
 * gravity and the weight of the arm.
 */
const OPPOSED: readonly (readonly [string, string])[] = [
  ['shoulderFlexorDrive', 'shoulderExtensorDrive'],
  ['shoulderAbductorDrive', 'armAdductorDrive'],
  ['shoulderExternalRotatorDrive', 'shoulderInternalRotatorDrive'],
  ['flexorDrive', 'extensorDrive'],
  ['wristFlexorDrive', 'wristExtensorDrive'],
  ['fingerFlexorDrive', 'fingerExtensorDrive'],
  ['thumbFlexorDrive', 'thumbExtensorDrive'],
  ['toeFlexorDrive', 'toeExtensorDrive'],
  ['pronatorDrive', 'supinatorDrive'],
  ['hipFlexorDrive', 'hipExtensorDrive'],
  ['hipAbductorDrive', 'hipAdductorDrive'],
  ['kneeFlexorDrive', 'kneeExtensorDrive'],
  ['anklePlantarflexorDrive', 'ankleDorsiflexorDrive'],
  ['trunkFlexorDrive', 'trunkExtensorDrive'],
  ['neckFlexorDrive', 'neckExtensorDrive'],
  ['girdleRetractorDrive', 'girdleProtractorDrive'],
];

/** Every group's antagonist, both ways round, by group id. */
export const ANTAGONISTS: ReadonlyMap<string, string> = new Map(
  OPPOSED.flatMap(([a, b]) => [
    [a, b],
    [b, a],
  ]),
);

/**
 * The groups as the cord wants them: units by name, and the group each one opposes. The shape
 * `SpinalModule` takes, built here because the group table and the pairing both live here.
 */
export function reflexGroups(): readonly {
  readonly id: string;
  readonly units: readonly string[];
  readonly antagonist: string | undefined;
}[] {
  return MUSCLE_GROUPS.map((g) => ({
    id: g.id,
    units: g.units,
    antagonist: ANTAGONISTS.get(g.id),
  }));
}
