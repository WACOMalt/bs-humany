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
import { L0_JOINTS, L1_JOINTS, L2_JOINTS, L3_JOINTS } from './joints.js';
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
    'The pelvis-trunk joint carries half of the lumped lumbar range, since the upper lumbar ' +
      'region joint falls inside the trunk segment.',
    'Not suitable for any measurement run.',
  ],
  joints: [...L0_JOINTS],
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
 * girdle gets its own body, and the toes articulate at the metatarsophalangeal joints.
 */
export const L1_STANDARD: SegmentationDef = {
  id: 'l1_standard',
  displayName: 'L1 — Standard',
  description:
    'Twenty-three rigid bodies. The spine articulates in three regions, the shoulder girdle moves, ' +
    'and the toes articulate at the metatarsophalangeal joints. Targets 60 fps on desktop.',
  defaultBackend: 'rapier',
  solver: { rate: 500, iterations: 12, equalityConstraints: false, selfCollision: 'coarse' },
  limitations: [
    'The spine bends in three regions rather than at each of its twenty-four levels. Motion is ' +
      'redistributed across levels for display.',
    'The scapula is a rigid body rather than gliding on the thorax, so scapulothoracic motion is ' +
      'approximated by the acromioclavicular joint.',
    'Hands do not articulate. Individual digits are rigid with the hand.',
    'Knee translation is not modelled; the knee is flexion only.',
    'The foot is rigid from the ankle to the metatarsal heads; the midtarsal joint does not move.',
  ],
  joints: [...L1_JOINTS],
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
      // Foot and toes, split at the metatarsophalangeal joints: the articulation a ragdoll needs
      // for the foot to fold on landing, and the one the MyoSuite leg models carry (mtp_angle).
      {
        id: `foot_${s}`,
        displayName: `${label(s)} foot`,
        anchor: `talus_${s}`,
        bones: sided(FOOT, s).filter((id) => !id.startsWith('phalanx_pedis_')),
      },
      {
        id: `toes_${s}`,
        displayName: `${label(s)} toes`,
        anchor: `phalanx_pedis_proximal_1_${s}`,
        bones: sided(FOOT, s).filter((id) => id.startsWith('phalanx_pedis_')),
      },
    ]),
  ],
};

/**
 * `L2-biomechanical`: 49 segments.
 *
 * Every lumbar vertebra is its own body; the thoracic spine moves in three blocks with its ribs;
 * the atlas and axis are separate from the sub-axial cervical spine (spec 7.2: C1-C2 is
 * rotation-dominant and must not be a generic ball); clavicle and scapula separate; the patella
 * is a body; each finger and the toes articulate.
 */
export const L2_BIOMECHANICAL: SegmentationDef = {
  id: 'l2_biomechanical',
  displayName: 'L2 — Biomechanical',
  description:
    'Forty-nine rigid bodies. Per-level lumbar spine, three thoracic blocks, atlas and axis ' +
    'separate, shoulder girdle split, patellae, and articulated digits. Targets 60 fps on desktop ' +
    'with Rapier, about 30 fps with MuJoCo.',
  defaultBackend: 'rapier',
  solver: { rate: 500, iterations: 16, equalityConstraints: true, selfCollision: 'full' },
  limitations: [
    'The thoracic spine moves in three blocks of four vertebrae, not at each level.',
    'Sub-axial cervical vertebrae C3-C7 are one body.',
    'Carpals and metacarpals are one body per hand; fingers articulate at the metacarpophalangeal ' +
      'joint only, as one segment each.',
    'Toes are one segment per foot.',
    'The cervical spine mixes the L1 region joints at C7/T1 and the atlanto-occipital joint ' +
      'with per-level C2/C3 and atlanto-axial joints, so its total range is over-counted.',
    'Midtarsal and tarsometatarsal joints are rigid (OQ-011).',
  ],
  joints: [...L2_JOINTS],
  segments: [
    {
      id: 'pelvis',
      displayName: 'Pelvis',
      anchor: 'sacrum',
      bones: ['sacrum', 'coccyx', 'hip_l', 'hip_r'],
    },
    ...LUMBAR.map((id) => ({
      id: id.replace('vertebra_', ''),
      displayName: id.replace('vertebra_l', 'Lumbar vertebra L'),
      anchor: id,
      bones: [id],
    })),
    ...(
      [
        ['thoracic_lower', 'Lower thoracic block (T9-T12)', 'vertebra_t10', [9, 10, 11, 12]],
        ['thoracic_middle', 'Middle thoracic block (T5-T8)', 'vertebra_t7', [5, 6, 7, 8]],
        ['thoracic_upper', 'Upper thoracic block (T1-T4)', 'vertebra_t3', [1, 2, 3, 4]],
      ] as const
    ).map(([id, displayName, anchor, levels]) => ({
      id,
      displayName,
      anchor,
      bones: [
        ...levels.map((t) => `vertebra_t${t}`),
        ...levels.flatMap((t) => [`rib_${t}_l`, `rib_${t}_r`]),
        ...(id === 'thoracic_upper' ? ['sternum'] : []),
      ],
    })),
    {
      id: 'cervical',
      displayName: 'Sub-axial cervical spine (C3-C7)',
      anchor: 'vertebra_c5',
      bones: ['vertebra_c3', 'vertebra_c4', 'vertebra_c5', 'vertebra_c6', 'vertebra_c7'],
    },
    { id: 'axis', displayName: 'Axis (C2)', anchor: 'vertebra_c2', bones: ['vertebra_c2'] },
    { id: 'atlas', displayName: 'Atlas (C1)', anchor: 'vertebra_c1', bones: ['vertebra_c1'] },
    { id: 'head', displayName: 'Head', anchor: 'occipital', bones: SKULL },
    ...(['l', 'r'] as const).flatMap((s) => [
      {
        id: `clavicle_${s}`,
        displayName: `${label(s)} clavicle`,
        anchor: `clavicle_${s}`,
        bones: [`clavicle_${s}`],
      },
      {
        id: `scapula_${s}`,
        displayName: `${label(s)} scapula`,
        anchor: `scapula_${s}`,
        bones: [`scapula_${s}`],
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
        displayName: `${label(s)} carpus and metacarpus`,
        anchor: `capitate_${s}`,
        bones: sided(HAND, s).filter((id) => !id.startsWith('phalanx_')),
      },
      ...[1, 2, 3, 4, 5].map((d) => ({
        id: `finger_${d}_${s}`,
        displayName: `${label(s)} ${['thumb', 'index finger', 'middle finger', 'ring finger', 'little finger'][d - 1]}`,
        anchor: `phalanx_proximal_${d}_${s}`,
        bones: sided(HAND, s).filter(
          (id) => id.startsWith('phalanx_') && id.endsWith(`_${d}_${s}`),
        ),
      })),
      {
        id: `thigh_${s}`,
        displayName: `${label(s)} thigh`,
        anchor: `femur_${s}`,
        bones: [`femur_${s}`],
      },
      {
        id: `patella_${s}`,
        displayName: `${label(s)} patella`,
        anchor: `patella_${s}`,
        bones: [`patella_${s}`],
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
        bones: [`talus_${s}`, `calcaneus_${s}`],
      },
      {
        id: `midfoot_${s}`,
        displayName: `${label(s)} midfoot`,
        anchor: `navicular_${s}`,
        bones: [
          `navicular_${s}`,
          `cuboid_${s}`,
          `cuneiform_medial_${s}`,
          `cuneiform_intermediate_${s}`,
          `cuneiform_lateral_${s}`,
        ],
      },
      {
        id: `forefoot_${s}`,
        displayName: `${label(s)} forefoot`,
        anchor: `metatarsal_2_${s}`,
        bones: sided(FOOT, s).filter((id) => id.startsWith('metatarsal_')),
      },
      {
        id: `toes_${s}`,
        displayName: `${label(s)} toes`,
        anchor: `phalanx_pedis_proximal_1_${s}`,
        bones: sided(FOOT, s).filter((id) => id.startsWith('phalanx_pedis_')),
      },
    ]),
  ],
};

/**
 * `L3-anatomical`: every vertebra, every rib, every phalanx, the patellae, separate talus and
 * calcaneus. About 110 rigid bodies. The reference profile for measurement runs, not for
 * interaction; the benchmark table says what it costs.
 */
export const L3_ANATOMICAL: SegmentationDef = {
  id: 'l3_anatomical',
  displayName: 'L3 — Anatomical',
  description:
    'Per-vertebra spine, ribs on pump-handle hinges, articulated fingers and thumbs, patellae, ' +
    'talus and calcaneus apart. About a hundred and ten rigid bodies; MuJoCo recommended.',
  defaultBackend: 'mujoco',
  solver: { rate: 1000, iterations: 24, equalityConstraints: true, selfCollision: 'full' },
  limitations: [
    'Per-level thoracic and cervical ranges are provisional (OQ-010); costovertebral and tarsal ' +
      'joints are provisional or rigid (OQ-011).',
    'The carpals and metacarpals two to five are one body per hand; the thumb metacarpal moves ' +
      'at its saddle joint.',
    'Toes are one segment per foot, at the metatarsophalangeal joints.',
    'The sternum is rigid with the first right rib; the rib cage does not breathe.',
  ],
  joints: [...L3_JOINTS],
  segments: [
    {
      id: 'pelvis',
      displayName: 'Pelvis',
      anchor: 'sacrum',
      bones: ['sacrum', 'coccyx', 'hip_l', 'hip_r'],
    },
    ...[...LUMBAR, ...THORACIC, ...CERVICAL].map((id) => ({
      id: id.replace('vertebra_', ''),
      displayName: id
        .replace('vertebra_', 'Vertebra ')
        .toUpperCase()
        .replace('VERTEBRA', 'Vertebra'),
      anchor: id,
      bones: [id],
    })),
    ...RIBS.map((id) => ({
      id,
      displayName: id.replace(
        /rib_(\d+)_([lr])/,
        (_, n, side) => `${label(side as 'l' | 'r')} rib ${n}`,
      ),
      anchor: id,
      bones: [id],
    })),
    { id: 'sternum', displayName: 'Sternum', anchor: 'sternum', bones: ['sternum'] },
    { id: 'head', displayName: 'Head', anchor: 'occipital', bones: SKULL },
    ...(['l', 'r'] as const).flatMap((s) => [
      {
        id: `clavicle_${s}`,
        displayName: `${label(s)} clavicle`,
        anchor: `clavicle_${s}`,
        bones: [`clavicle_${s}`],
      },
      {
        id: `scapula_${s}`,
        displayName: `${label(s)} scapula`,
        anchor: `scapula_${s}`,
        bones: [`scapula_${s}`],
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
        displayName: `${label(s)} carpus and metacarpals two to five`,
        anchor: `capitate_${s}`,
        bones: sided(HAND, s).filter(
          (id) => !id.startsWith('phalanx_') && id !== `metacarpal_1_${s}`,
        ),
      },
      {
        id: `metacarpal_1_${s}`,
        displayName: `${label(s)} thumb metacarpal`,
        anchor: `metacarpal_1_${s}`,
        bones: [`metacarpal_1_${s}`],
      },
      ...sided(HAND, s)
        .filter((id) => id.startsWith('phalanx_'))
        .map((id) => ({
          id,
          displayName: `${label(s)} ${id.replace(/phalanx_(\w+)_(\d)_[lr]/, '$1 phalanx $2')}`,
          anchor: id,
          bones: [id],
        })),
      {
        id: `thigh_${s}`,
        displayName: `${label(s)} thigh`,
        anchor: `femur_${s}`,
        bones: [`femur_${s}`],
      },
      {
        id: `patella_${s}`,
        displayName: `${label(s)} patella`,
        anchor: `patella_${s}`,
        bones: [`patella_${s}`],
      },
      {
        id: `shank_${s}`,
        displayName: `${label(s)} shank`,
        anchor: `tibia_${s}`,
        bones: [`tibia_${s}`, `fibula_${s}`],
      },
      {
        id: `talus_${s}`,
        displayName: `${label(s)} talus`,
        anchor: `talus_${s}`,
        bones: [`talus_${s}`],
      },
      {
        id: `calcaneus_${s}`,
        displayName: `${label(s)} calcaneus`,
        anchor: `calcaneus_${s}`,
        bones: [`calcaneus_${s}`],
      },
      {
        id: `midfoot_${s}`,
        displayName: `${label(s)} midfoot`,
        anchor: `navicular_${s}`,
        bones: [
          `navicular_${s}`,
          `cuboid_${s}`,
          `cuneiform_medial_${s}`,
          `cuneiform_intermediate_${s}`,
          `cuneiform_lateral_${s}`,
        ],
      },
      {
        id: `forefoot_${s}`,
        displayName: `${label(s)} forefoot`,
        anchor: `metatarsal_2_${s}`,
        bones: sided(FOOT, s).filter((id) => id.startsWith('metatarsal_')),
      },
      {
        id: `toes_${s}`,
        displayName: `${label(s)} toes`,
        anchor: `phalanx_pedis_proximal_1_${s}`,
        bones: sided(FOOT, s).filter((id) => id.startsWith('phalanx_pedis_')),
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
  L2_BIOMECHANICAL,
  L3_ANATOMICAL,
]);
