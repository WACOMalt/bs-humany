/**
 * Fidelity profiles -- the dynamic layer of ADR-001.
 *
 * A profile says which bones become solver rigid bodies and which ride along as kinematic
 * followers. **Every bone belongs to exactly one segment in every profile**, which is what keeps
 * the anatomical layer complete at every fidelity level. The HSDL validator enforces it.
 *
 * Switching profile changes cost, not anatomy.
 */

import type { SegmentationDef } from '@bs-humany/hsdl';
import { BONES } from './taxonomy.js';

const idsIn = (predicate: (id: string) => boolean): string[] =>
  BONES.map((b) => b.id).filter((id) => predicate(id));

const byRegion = (...regions: string[]): string[] =>
  BONES.filter((b) => regions.includes(b.region)).map((b) => b.id);

const sided = (ids: readonly string[], suffix: 'l' | 'r'): string[] =>
  ids.filter((id) => id.endsWith(`_${suffix}`));

const CERVICAL = idsIn((id) => /^vertebra_c\d$/.test(id));
const THORACIC = idsIn((id) => /^vertebra_t\d+$/.test(id));
const LUMBAR = idsIn((id) => /^vertebra_l\d$/.test(id));
const RIBS = idsIn((id) => /^rib_\d+_[lr]$/.test(id));
const SKULL = byRegion('skull');

const HAND = byRegion('hand');
const FOOT = byRegion('foot');

const HINDFOOT_PREFIXES = ['talus', 'calcaneus', 'navicular', 'cuboid', 'cuneiform'];
const isHindfoot = (id: string) => HINDFOOT_PREFIXES.some((p) => id.startsWith(p));

/**
 * `L0-ragdoll`: 15 segments.
 *
 * The mobile-capable profile. The entire trunk is one rigid body, so spinal kinematics at this
 * level are purely cosmetic -- produced by kinematic redistribution after the solve, never by the
 * solver. The profile says so in its limitations, because a fidelity control that only shows a
 * quality label lets a user believe they are measuring something they are not.
 */
export const L0_RAGDOLL: SegmentationDef = {
  id: 'l0_ragdoll',
  displayName: 'L0 — Ragdoll',
  description:
    'Fifteen rigid bodies. The trunk is a single segment and the spine articulates cosmetically ' +
    'only. Targets 60 fps on mobile.',
  defaultBackend: 'rapier',
  solver: { rate: 240, iterations: 8, equalityConstraints: false, selfCollision: 'coarse' },
  limitations: [
    'Spinal kinematics are cosmetic. The trunk is one rigid body, and the visible curve across ' +
      'the vertebrae comes from kinematic redistribution after the solve, not from the solver.',
    'The shoulder girdle does not articulate: clavicle and scapula are welded to the trunk.',
    'Hands and feet are single rigid bodies. Individual digits do not move.',
    'Not suitable for any measurement run.',
  ],
  segments: [
    {
      id: 'pelvis',
      displayName: 'Pelvis',
      anchor: 'sacrum',
      bones: ['sacrum', 'coccyx', 'hip_l', 'hip_r'],
    },
    {
      id: 'trunk',
      displayName: 'Trunk',
      anchor: 'vertebra_t12',
      bones: [
        ...LUMBAR,
        ...THORACIC,
        ...RIBS,
        'sternum',
        'clavicle_l',
        'clavicle_r',
        'scapula_l',
        'scapula_r',
      ],
    },
    {
      id: 'head',
      displayName: 'Head and neck',
      anchor: 'vertebra_c1',
      bones: [...CERVICAL, ...SKULL],
    },
    ...(['l', 'r'] as const).flatMap((s) => [
      {
        id: `upperarm_${s}`,
        displayName: `${label(s)} upper arm`,
        anchor: `humerus_${s}`,
        bones: [`humerus_${s}`],
      },
      {
        id: `forearm_${s}`,
        displayName: `${label(s)} forearm`,
        anchor: `ulna_${s}`,
        bones: [`ulna_${s}`, `radius_${s}`],
      },
      {
        id: `hand_${s}`,
        displayName: `${label(s)} hand`,
        anchor: `capitate_${s}`,
        bones: sided(HAND, s),
      },
      {
        id: `thigh_${s}`,
        displayName: `${label(s)} thigh`,
        anchor: `femur_${s}`,
        bones: [`femur_${s}`, `patella_${s}`],
      },
      {
        id: `shank_${s}`,
        displayName: `${label(s)} shank`,
        anchor: `tibia_${s}`,
        bones: [`tibia_${s}`, `fibula_${s}`],
      },
      {
        id: `foot_${s}`,
        displayName: `${label(s)} foot`,
        anchor: `talus_${s}`,
        bones: sided(FOOT, s),
      },
    ]),
  ],
};

/**
 * `L1-standard`: 23 segments.
 *
 * The desktop default. Lumbar and thoracic spine separate, the neck articulates, the shoulder
 * girdle gets its own body, and the foot splits at the midtarsal joint.
 */
export const L1_STANDARD: SegmentationDef = {
  id: 'l1_standard',
  displayName: 'L1 — Standard',
  description:
    'Twenty-three rigid bodies. The spine articulates in three regions, the shoulder girdle moves, ' +
    'and the foot splits at the midtarsal joint. Targets 60 fps on desktop.',
  defaultBackend: 'rapier',
  solver: { rate: 500, iterations: 12, equalityConstraints: false, selfCollision: 'coarse' },
  limitations: [
    'The spine bends in three regions rather than at each of its twenty-four levels. Motion is ' +
      'redistributed across levels for display.',
    'The scapula is a rigid body rather than gliding on the thorax, so scapulothoracic motion is ' +
      'approximated by the acromioclavicular joint.',
    'Hands do not articulate. Individual digits are rigid with the hand.',
    'Knee translation is not modelled; the knee is flexion only.',
  ],
  segments: [
    {
      id: 'pelvis',
      displayName: 'Pelvis',
      anchor: 'sacrum',
      bones: ['sacrum', 'coccyx', 'hip_l', 'hip_r'],
    },
    { id: 'lumbar', displayName: 'Lumbar spine', anchor: 'vertebra_l3', bones: LUMBAR },
    {
      id: 'thorax',
      displayName: 'Thorax',
      anchor: 'vertebra_t8',
      bones: [...THORACIC, ...RIBS, 'sternum'],
    },
    { id: 'neck', displayName: 'Neck', anchor: 'vertebra_c4', bones: CERVICAL },
    { id: 'head', displayName: 'Head', anchor: 'occipital', bones: SKULL },
    ...(['l', 'r'] as const).flatMap((s) => [
      {
        id: `shoulder_${s}`,
        displayName: `${label(s)} shoulder girdle`,
        anchor: `scapula_${s}`,
        bones: [`clavicle_${s}`, `scapula_${s}`],
      },
      {
        id: `upperarm_${s}`,
        displayName: `${label(s)} upper arm`,
        anchor: `humerus_${s}`,
        bones: [`humerus_${s}`],
      },
      {
        id: `ulna_${s}`,
        displayName: `${label(s)} ulna`,
        anchor: `ulna_${s}`,
        bones: [`ulna_${s}`],
      },
      {
        id: `radius_${s}`,
        displayName: `${label(s)} radius`,
        anchor: `radius_${s}`,
        bones: [`radius_${s}`],
      },
      {
        id: `hand_${s}`,
        displayName: `${label(s)} hand`,
        anchor: `capitate_${s}`,
        bones: sided(HAND, s),
      },
      {
        id: `thigh_${s}`,
        displayName: `${label(s)} thigh`,
        anchor: `femur_${s}`,
        bones: [`femur_${s}`, `patella_${s}`],
      },
      {
        id: `shank_${s}`,
        displayName: `${label(s)} shank`,
        anchor: `tibia_${s}`,
        bones: [`tibia_${s}`, `fibula_${s}`],
      },
      {
        id: `hindfoot_${s}`,
        displayName: `${label(s)} hindfoot`,
        anchor: `talus_${s}`,
        bones: sided(FOOT, s).filter(isHindfoot),
      },
      {
        id: `forefoot_${s}`,
        displayName: `${label(s)} forefoot`,
        anchor: `metatarsal_2_${s}`,
        bones: sided(FOOT, s).filter((id) => !isHindfoot(id)),
      },
    ]),
  ],
};

function label(s: 'l' | 'r'): string {
  return s === 'l' ? 'Left' : 'Right';
}

export const SEGMENTATION_PROFILES: readonly SegmentationDef[] = Object.freeze([
  L0_RAGDOLL,
  L1_STANDARD,
]);
