/**
 * The muscle groups a person drives: one table, for every control that offers them.
 *
 * The studio's sliders are generated from this, the headless publisher's panel reads it, and so
 * the headset's panel shows exactly the same groups in the same order at the same ids. Every
 * one of the hundred and forty-eight units belongs to exactly one group -- a test holds that
 * against the muscle data -- so nothing in the body is out of reach of a slider.
 *
 * Grouped the way a person thinks about a joint: what flexes it, what extends it, and so on.
 * Ids are the studio's original slider ids where a group already existed, so nothing that
 * remembered them by name has to change.
 */

export type DriveSection = 'Arm' | 'Leg' | 'Trunk';

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
    units: both('extensor_carpi_radialis_longus', 'extensor_carpi_radialis_brevis'),
  },
  {
    id: 'pronatorDrive',
    title: 'Pronators',
    section: 'Arm',
    units: both('pronator_teres', 'pronator_quadratus'),
  },
  { id: 'supinatorDrive', title: 'Supinator', section: 'Arm', units: both('supinator') },
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
    units: both(
      'soleus',
      'tibialis_posterior',
      'fibularis_longus',
      'fibularis_brevis',
      'flexor_digitorum_longus',
      'flexor_hallucis_longus',
    ),
  },
  {
    id: 'ankleDorsiflexorDrive',
    title: 'Ankle dorsiflexors',
    section: 'Leg',
    units: both('tibialis_anterior', 'extensor_digitorum_longus', 'extensor_hallucis_longus'),
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
];

/** The studio's mapping from a slider's 0..100 to excitation: squared, so the first few per
 * cent of drive get a usable stretch of travel. */
export function driveForSlider(position: number): number {
  const fraction = position / 100;
  return fraction * fraction;
}
