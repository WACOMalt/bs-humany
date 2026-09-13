/**
 * Joints for the L3-anatomical profile (M5.1), and the extra joints L2 needs to be whole.
 *
 * Everything here that has a MyoSuite range cites it; everything that does not is provisional and
 * says so (OQ-010 for the per-level thoracic and cervical spine, OQ-011 for the costovertebral
 * and tarsal joints). Centres come from markers where the dataset has them and from the meeting
 * of two bones' bounds where it does not, which is how the phalanges are placed.
 *
 * Reading the hand: MyoSuite's finger joints are stated in its own hand frame, where flexion is
 * about x. In this project's joint frames flexion is about z, the medio-lateral axis (the same
 * sign convention as the hip and knee), so the ranges are carried over and the axes restated.
 */

import { provisional } from '@bs-humany/hsdl';
import {
  ARM,
  type DofSpec,
  HEAD,
  type JointSpec,
  LEG,
  SUBTALAR_AXIS,
  type Side,
  TORSO,
  dataset,
  flexionPositive,
  half,
  myo,
  sideName,
  wu2005,
} from './jointHelpers.js';

const OQ010 = (rationale: string, file: string) =>
  provisional('caggiano2022', 'OQ-010', rationale, file);
const OQ011 = (rationale: string) => provisional('kervyn2021', 'OQ-011', rationale);

// ---------------------------------------------------------------------------------------------
// Spine, per level
// ---------------------------------------------------------------------------------------------

/**
 * Mean of the four sourced lumbar levels (see `LUMBAR_LEVELS` in joints.ts), flexion-positive.
 * The thoracic levels take a fraction of it: the rib cage stiffens flexion and lateral bending
 * and leaves axial rotation comparatively free, which is the shape of every published segmental
 * table even though none is transcribed here.
 */
const LUMBAR_MEAN = {
  flexion: flexionPositive([-0.2593, 0.0992]),
  lateralBending: [-0.1219, 0.1219] as const,
  axialRotation: [-0.1334, 0.1334] as const,
};
const THORACIC_LEVEL = {
  flexion: half(LUMBAR_MEAN.flexion),
  lateralBending: half(LUMBAR_MEAN.lateralBending),
  axialRotation: [-0.2, 0.2] as const,
};

/** The head model's lumped neck range, flexion-positive, and its shares per level. */
const NECK_TOTAL = {
  flexion: flexionPositive([-0.87, 1.05]),
  axialRotation: [-1.4, 1.4] as const,
};
/** Atlanto-axial: half of all axial rotation, little else (spec 7.2). */
const C1_C2 = {
  flexion: [-0.05, 0.05] as const,
  lateralBending: [-0.03, 0.03] as const,
  axialRotation: half(NECK_TOTAL.axialRotation),
};
/** Atlanto-occipital: nodding, little else. */
const C0_C1 = {
  flexion: [-0.17, 0.2] as const,
  lateralBending: [-0.05, 0.05] as const,
  axialRotation: [-0.03, 0.03] as const,
};
/** The five sub-axial levels plus C7/T1 share what remains of the neck's flexion and rotation. */
const SUBAXIAL_LEVELS = 6;
const SUBAXIAL = {
  flexion: [
    (NECK_TOTAL.flexion[0] - C1_C2.flexion[0] - C0_C1.flexion[0]) / SUBAXIAL_LEVELS,
    (NECK_TOTAL.flexion[1] - C1_C2.flexion[1] - C0_C1.flexion[1]) / SUBAXIAL_LEVELS,
  ] as const,
  lateralBending: [-0.1, 0.1] as const,
  axialRotation: [
    (NECK_TOTAL.axialRotation[0] - C1_C2.axialRotation[0] - C0_C1.axialRotation[0]) /
      SUBAXIAL_LEVELS,
    (NECK_TOTAL.axialRotation[1] - C1_C2.axialRotation[1] - C0_C1.axialRotation[1]) /
      SUBAXIAL_LEVELS,
  ] as const,
};

function spineDofs(
  ranges: {
    readonly flexion: readonly [number, number];
    readonly lateralBending: readonly [number, number];
    readonly axialRotation: readonly [number, number];
  },
  rationale: string,
  file: string,
): DofSpec[] {
  return [
    {
      axis: 'flexion',
      vector: [0, 0, -1],
      range: ranges.flexion,
      romSource: OQ010(rationale, file),
    },
    {
      axis: 'lateral_bending_right',
      vector: [1, 0, 0],
      range: ranges.lateralBending,
      romSource: OQ010(rationale, file),
    },
    {
      axis: 'axial_rotation_left',
      vector: [0, 1, 0],
      range: ranges.axialRotation,
      romSource: OQ010(rationale, file),
    },
  ];
}

const CENTROID_LIMITATION =
  'The joint centre is midway between the two vertebral centroids, a little posterior to the disc.';

function spineLevel(
  id: string,
  displayName: string,
  lower: string,
  upper: string,
  ranges: Parameters<typeof spineDofs>[0],
  rationale: string,
  file: string,
): JointSpec {
  return {
    id,
    displayName,
    parentBone: lower,
    childBone: upper,
    type: 'spherical',
    centre: { centroidMid: [lower, upper] },
    centreSource: dataset(`centroids of ${lower} and ${upper}`),
    reportingOrder: 'zxy',
    dofs: spineDofs(ranges, rationale, file),
    limitations: [
      'Per-level joint for the L3 profile. Range is provisional; see OQ-010.',
      CENTROID_LIMITATION,
    ],
  };
}

const THORACIC_RATIONALE =
  'The source torso model has no thoracic levels; the range is half the lumbar per-level mean ' +
  'for flexion and lateral bending, and a fixed 0.2 rad of axial rotation.';
const CERVICAL_RATIONALE =
  'The source head model lumps the neck; the lumped range is shared across levels with the ' +
  'atlanto-axial joint taking half of axial rotation and the atlanto-occipital joint nodding.';

const THORACIC_LEVELS: JointSpec[] = Array.from({ length: 11 }, (_, i) => {
  const upper = 11 - i; // T11/T12 first, T1/T2 last
  return spineLevel(
    `t${upper}_t${upper + 1}`,
    `Intervertebral T${upper}/T${upper + 1}`,
    `vertebra_t${upper + 1}`,
    `vertebra_t${upper}`,
    THORACIC_LEVEL,
    THORACIC_RATIONALE,
    TORSO,
  );
});

const CERVICAL_LEVELS: JointSpec[] = [
  spineLevel(
    'c7_t1',
    'Cervicothoracic C7/T1',
    'vertebra_t1',
    'vertebra_c7',
    SUBAXIAL,
    CERVICAL_RATIONALE,
    HEAD,
  ),
  ...[6, 5, 4, 3, 2].map((upper) =>
    spineLevel(
      `c${upper}_c${upper + 1}`,
      `Intervertebral C${upper}/C${upper + 1}`,
      `vertebra_c${upper + 1}`,
      `vertebra_c${upper}`,
      SUBAXIAL,
      CERVICAL_RATIONALE,
      HEAD,
    ),
  ),
  spineLevel(
    'c1_c2',
    'Atlanto-axial C1/C2',
    'vertebra_c2',
    'vertebra_c1',
    C1_C2,
    CERVICAL_RATIONALE,
    HEAD,
  ),
  {
    id: 'c0_c1',
    displayName: 'Atlanto-occipital',
    parentBone: 'vertebra_c1',
    childBone: 'occipital',
    type: 'spherical',
    centre: { marker: ['occipital', 'Occipital_condyle'] },
    centreSource: dataset('marker Occipital_condyle'),
    reportingOrder: 'zxy',
    dofs: spineDofs(C0_C1, CERVICAL_RATIONALE, HEAD),
    limitations: ['Per-level joint for the L3 profile. Range is provisional; see OQ-010.'],
  },
];

// ---------------------------------------------------------------------------------------------
// Ribs and sternum
// ---------------------------------------------------------------------------------------------

const RIB_JOINTS: JointSpec[] = (['r', 'l'] as const).flatMap((s) =>
  Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    return {
      id: `costovertebral_${n}_${s}`,
      displayName: `Costovertebral ${n}, ${sideName(s)}`,
      parentBone: `vertebra_t${n}`,
      childBone: `rib_${n}_${s}`,
      type: 'revolute' as const,
      centre: { nearest: [`rib_${n}_${s}`, `vertebra_t${n}`] as const },
      centreSource: dataset(`bounds of rib_${n}_${s} nearest the centroid of vertebra_t${n}`),
      dofs: [
        {
          axis: 'elevation',
          vector: [0, 0, 1] as const,
          range: [-0.1, 0.1] as const,
          romSource: OQ011('Costovertebral motion is a few degrees of pump-handle elevation.'),
        },
      ],
      limitations: [
        'One pump-handle hinge per rib about the medio-lateral axis at the rib head; the ' +
          'bucket-handle component is not modelled. Provisional range, OQ-011.',
      ],
      side: s,
    };
  }),
);

const STERNUM_JOINT: JointSpec = {
  id: 'sternocostal_1',
  displayName: 'Sternum on the first rib',
  parentBone: 'rib_1_r',
  childBone: 'sternum',
  type: 'fixed',
  centre: { centroid: 'sternum' },
  centreSource: dataset('centroid of sternum'),
  dofs: [],
  limitations: [
    'The sternum is rigid with the first right rib; costal cartilage is not modelled, so the ' +
      'rib cage cannot breathe.',
  ],
};

// ---------------------------------------------------------------------------------------------
// Shoulder girdle, hands, feet, patella
// ---------------------------------------------------------------------------------------------

function girdleAndLimbs(s: Side): JointSpec[] {
  const side = sideName(s);
  const fingerNames = ['thumb', 'index', 'middle', 'ring', 'little'];
  const hand: JointSpec[] = [];

  // Thumb: carpometacarpal saddle, metacarpophalangeal, interphalangeal.
  hand.push(
    {
      id: `cmc_1_${s}`,
      displayName: `Thumb carpometacarpal, ${side}`,
      parentBone: `trapezium_${s}`,
      childBone: `metacarpal_1_${s}`,
      type: 'saddle',
      centre: { boundary: [`trapezium_${s}`, `metacarpal_1_${s}`, 1] },
      centreSource: dataset(`bounds boundary of trapezium_${s} and metacarpal_1_${s}`),
      dofs: [
        {
          axis: 'flexion',
          vector: [-0.042399, -0.665286, 0.745384],
          range: [-0.78, 0.7],
          romSource: myo(ARM, 'cmc_flexion'),
        },
        {
          axis: 'abduction',
          vector: [0.495557, 0.731736, 0.467959],
          range: [-0.5, 0.78],
          romSource: myo(ARM, 'cmc_abduction'),
        },
      ],
      limitations: [
        'Axes are the source model’s thumb axes as given, in a frame that is not this project’s; ' +
          'they are oblique by design (a saddle) and carried over rather than restated.',
      ],
    },
    {
      id: `mcp_1_${s}`,
      displayName: `Thumb metacarpophalangeal, ${side}`,
      parentBone: `metacarpal_1_${s}`,
      childBone: `phalanx_proximal_1_${s}`,
      type: 'revolute',
      centre: { boundary: [`metacarpal_1_${s}`, `phalanx_proximal_1_${s}`, 1] },
      centreSource: dataset(`bounds boundary of metacarpal_1_${s} and phalanx_proximal_1_${s}`),
      dofs: [
        {
          axis: 'flexion',
          vector: [0, 0, 1],
          range: [-0.785398, 0.698132],
          romSource: myo(ARM, 'mp_flexion_r'),
        },
      ],
    },
    {
      id: `ip_1_${s}`,
      displayName: `Thumb interphalangeal, ${side}`,
      parentBone: `phalanx_proximal_1_${s}`,
      childBone: `phalanx_distal_1_${s}`,
      type: 'revolute',
      centre: { boundary: [`phalanx_proximal_1_${s}`, `phalanx_distal_1_${s}`, 1] },
      centreSource: dataset(`bounds boundary of phalanx_proximal_1_${s} and phalanx_distal_1_${s}`),
      dofs: [
        {
          axis: 'flexion',
          vector: [0, 0, 1],
          range: [-1.309, 0.436332],
          romSource: myo(ARM, 'ip_flexion_r'),
        },
      ],
    },
  );

  // Fingers 2 to 5: metacarpophalangeal (flexion, abduction), proximal and distal interphalangeal.
  const SOURCE_NAMES: Record<number, { mcpF: string; mcpA: string; pip: string; dip: string }> = {
    2: {
      mcpF: 'mcp2_flexion_r',
      mcpA: 'mcp2_abduction_r',
      pip: 'pm2_flexion_r',
      dip: 'md2_flexion_r',
    },
    3: {
      mcpF: 'mcp3_flexion_r',
      mcpA: 'mcp3_abduction_r',
      pip: 'pm3_flexion_r',
      dip: 'md3_flexion',
    },
    4: {
      mcpF: 'mcp4_flexion_r',
      mcpA: 'mcp4_abduction_r',
      pip: 'pm4_flexion',
      dip: 'md4_flexion_r',
    },
    5: {
      mcpF: 'mcp5_flexion_r',
      mcpA: 'mcp5_abduction_r',
      pip: 'pm5_flexion_r',
      dip: 'md5_flexion_r',
    },
  };
  for (const n of [2, 3, 4, 5]) {
    const names = SOURCE_NAMES[n];
    if (!names) continue;
    // Abduction is away from the middle finger: toward the thumb (lateral) for the index and
    // middle fingers, away from it for the ring and little fingers.
    const abductionVector: [number, number, number] = n <= 3 ? [-1, 0, 0] : [1, 0, 0];
    hand.push(
      {
        id: `mcp_${n}_${s}`,
        displayName: `${fingerNames[n - 1]} metacarpophalangeal, ${side}`,
        parentBone: `metacarpal_${n}_${s}`,
        childBone: `phalanx_proximal_${n}_${s}`,
        type: 'universal',
        centre: { boundary: [`metacarpal_${n}_${s}`, `phalanx_proximal_${n}_${s}`, 1] },
        centreSource: dataset(
          `bounds boundary of metacarpal_${n}_${s} and phalanx_proximal_${n}_${s}`,
        ),
        reportingOrder: 'zxy',
        dofs: [
          {
            axis: 'flexion',
            vector: [0, 0, 1],
            range: [0, 1.5708],
            romSource: myo(ARM, names.mcpF),
          },
          {
            axis: 'abduction',
            vector: abductionVector,
            range: [-0.261799, 0.261799],
            romSource: myo(ARM, names.mcpA),
          },
        ],
        limitations: [
          'Flexion restated about the medio-lateral axis; the source states it about its own x.',
        ],
      },
      {
        id: `pip_${n}_${s}`,
        displayName: `${fingerNames[n - 1]} proximal interphalangeal, ${side}`,
        parentBone: `phalanx_proximal_${n}_${s}`,
        childBone: `phalanx_middle_${n}_${s}`,
        type: 'revolute',
        centre: { boundary: [`phalanx_proximal_${n}_${s}`, `phalanx_middle_${n}_${s}`, 1] },
        centreSource: dataset(
          `bounds boundary of phalanx_proximal_${n}_${s} and phalanx_middle_${n}_${s}`,
        ),
        dofs: [
          {
            axis: 'flexion',
            vector: [0, 0, 1],
            range: [0, 1.5708],
            romSource: myo(ARM, names.pip),
          },
        ],
      },
      {
        id: `dip_${n}_${s}`,
        displayName: `${fingerNames[n - 1]} distal interphalangeal, ${side}`,
        parentBone: `phalanx_middle_${n}_${s}`,
        childBone: `phalanx_distal_${n}_${s}`,
        type: 'revolute',
        centre: { boundary: [`phalanx_middle_${n}_${s}`, `phalanx_distal_${n}_${s}`, 1] },
        centreSource: dataset(
          `bounds boundary of phalanx_middle_${n}_${s} and phalanx_distal_${n}_${s}`,
        ),
        dofs: [
          {
            axis: 'flexion',
            vector: [0, 0, 1],
            range: [0, 1.5708],
            romSource: myo(ARM, names.dip),
          },
        ],
      },
    );
  }

  const specs: JointSpec[] = [
    {
      id: `acromioclavicular_${s}`,
      displayName: `Acromioclavicular, ${side}`,
      parentBone: `clavicle_${s}`,
      childBone: `scapula_${s}`,
      type: 'spherical',
      centre: { isb: [`clavicle_${s}`, 'AC'] },
      centreSource: wu2005('2.3.2, clavicle coordinate system: AC'),
      reportingOrder: 'yxz',
      dofs: [
        {
          axis: 'protraction',
          vector: [0.157095, 0.947269, -0.279291],
          range: [-0.152, 0],
          romSource: myo(ARM, 'acromioclavicular_r2_r'),
        },
        {
          axis: 'tilt',
          vector: [0.6377, 0.1186, 0.7611],
          range: [0, 0.552],
          romSource: myo(ARM, 'acromioclavicular_r1_r'),
        },
        {
          axis: 'upward_rotation',
          vector: [-0.754084, 0.297594, 0.585487],
          range: [0, 1.228],
          romSource: myo(ARM, 'acromioclavicular_r3_r'),
        },
      ],
      limitations: [
        'Axes are the source model’s acromioclavicular axes as given, in its clavicle frame; ' +
          'scapulothoracic gliding is still not a constraint surface (spec 7.2).',
      ],
    },
    ...hand,
    {
      id: `patellofemoral_${s}`,
      displayName: `Patellofemoral, ${side}`,
      parentBone: `femur_${s}`,
      childBone: `patella_${s}`,
      type: 'revolute',
      centre: { centroid: `patella_${s}` },
      centreSource: dataset(`centroid of patella_${s}`),
      dofs: [
        {
          axis: 'flexion',
          vector: [0, 0, -1],
          range: [-1.79241, 0.010506],
          romSource: myo(LEG, `knee_angle_beta_rotation1_${s}`),
        },
      ],
      limitations: [
        'The patella hinges about its own centroid; the source couples it to knee flexion with ' +
          'translations, which M5.2 supplies as a coupling constraint.',
      ],
    },
    {
      id: `talocrural_${s}`,
      displayName: `Talocrural, ${side}`,
      parentBone: `tibia_${s}`,
      childBone: `talus_${s}`,
      type: 'revolute',
      centre: { virtual: `tibia_${s}__im` },
      centreSource: wu2005('ankle origin at the inter-malleolar point; see Wu 2002 4.2'),
      dofs: [
        {
          axis: 'dorsiflexion',
          vector: [0, 0, 1],
          range: [-0.698132, 0.523599],
          romSource: myo(LEG, `ankle_angle_${s}`),
        },
      ],
    },
    {
      id: `subtalar_${s}`,
      displayName: `Subtalar, ${side}`,
      parentBone: `talus_${s}`,
      childBone: `calcaneus_${s}`,
      type: 'revolute',
      centre: { marker: [`calcaneus_${s}`, 'Tarsal_sinus'] },
      centreSource: dataset(`marker Tarsal_sinus on calcaneus_${s}`),
      dofs: [
        {
          axis: 'inversion',
          vector: SUBTALAR_AXIS,
          range: [-0.349066, 0.349066],
          romSource: myo(LEG, `subtalar_angle_${s}`),
        },
      ],
    },
    {
      id: `midtarsal_${s}`,
      displayName: `Midtarsal, ${side}`,
      parentBone: `talus_${s}`,
      childBone: `navicular_${s}`,
      type: 'fixed',
      centre: { marker: [`talus_${s}`, 'Head_of_talus'] },
      centreSource: dataset(`marker Head_of_talus on talus_${s}`),
      dofs: [],
      limitations: ['Rigid: no cited midtarsal range yet (OQ-011).'],
    },
    {
      id: `tarsometatarsal_${s}`,
      displayName: `Tarsometatarsal, ${side}`,
      parentBone: `cuneiform_intermediate_${s}`,
      childBone: `metatarsal_2_${s}`,
      type: 'fixed',
      centre: { boundary: [`cuneiform_intermediate_${s}`, `metatarsal_2_${s}`, 2] },
      centreSource: dataset(`bounds boundary of cuneiform_intermediate_${s} and metatarsal_2_${s}`),
      dofs: [],
      limitations: ['Rigid: no cited tarsometatarsal range yet (OQ-011).'],
    },
  ];
  return specs.map((spec) => ({ ...spec, side: s }));
}

export const L3_JOINT_SPECS: readonly JointSpec[] = [
  ...THORACIC_LEVELS,
  ...CERVICAL_LEVELS,
  ...RIB_JOINTS,
  STERNUM_JOINT,
  ...girdleAndLimbs('r'),
  ...girdleAndLimbs('l'),
];

/** Joints the L2 profile activates beyond the L1 set: what makes its extra segments connect. */
export const L2_EXTRA_JOINTS: readonly string[] = (['r', 'l'] as const).flatMap((s) => [
  `acromioclavicular_${s}`,
  `patellofemoral_${s}`,
  ...[1, 2, 3, 4, 5].map((n) => `mcp_${n}_${s}`),
  `midtarsal_${s}`,
  `tarsometatarsal_${s}`,
]);

/** Spine levels, ribs and the sternum, activated only by L3. */
export const L3_ONLY_JOINTS: readonly string[] = [
  ...THORACIC_LEVELS.map((j) => j.id),
  ...CERVICAL_LEVELS.map((j) => j.id),
  ...RIB_JOINTS.map((j) => j.id),
  STERNUM_JOINT.id,
  ...(['r', 'l'] as const).flatMap((s) => [
    `cmc_1_${s}`,
    `mcp_1_${s}`,
    `ip_1_${s}`,
    ...[2, 3, 4, 5].flatMap((n) => [`mcp_${n}_${s}`, `pip_${n}_${s}`, `dip_${n}_${s}`]),
  ]),
];
