/**
 * Joint definitions -- milestone M3.1.
 *
 * Every joint is an ordered list of single degrees of freedom (spec section 7.1). Three things are
 * decided here and nowhere else:
 *
 *   - **Where** the joint is. Joint centres come from the landmarks the dataset carries, using the
 *     ISB definitions (hip centre at the femoral head, knee at the mid-epicondylar point, ankle at
 *     the inter-malleolar point, and so on). Spine joints have no ISB landmarks yet and sit at the
 *     dataset's own markers or between vertebral centroids; that is recorded per joint.
 *   - **Which way** its axes point. The joint frame takes the parent bone's ISB segment frame at
 *     the dataset pose (Wu 2002 section 4: the parent-fixed axis of each joint coordinate system
 *     is an axis of the proximal segment's frame). Bones without an ISB frame -- the vertebrae, the
 *     first metatarsal -- use the ISB orientation directly: X anterior, Y superior, Z right.
 *   - **How far** it moves. Ranges are MyoSuite's (Caggiano et al. 2022), file and joint named in
 *     each citation. MyoSuite is the Apache-2.0 conversion of the OpenSim reference models, so the
 *     numbers trace back to Rajagopal 2016 (leg), MoBL-ARMS (arm) and the myoTorso work.
 *
 * ## Sign policy
 *
 * All frames are right-handed with Z to the subject's right on both sides (OQ-006). A DoF vector
 * that produces flexion on the right therefore produces flexion on the left unchanged, but a
 * vector about X or Y produces the *opposite* clinical motion on the left (abduction instead of
 * adduction, external instead of internal rotation). Left-side joints flip the X and Y components
 * of every DoF vector, so a positive angle means the same clinical motion on both sides. Each
 * DoF's `axis` name states what positive means. The flip is applied in one place, `mirrorVector`,
 * never by hand.
 *
 * ## What L1 gets and what it does not
 *
 * The region joints (`lumbar_region_*`, `neck_region_*`) exist so the L1 profile's three-region
 * spine has a plausible range. They carry half of the source's lumped range each, and say so. The
 * per-level lumbar joints are for L2 and carry the source's per-level values, with the two levels
 * the source lacks marked provisional (OQ-007).
 */

import {
  ISB,
  type Quat,
  type Transform,
  type Vec3,
  WORLD,
  conversionMatrix,
  normalize,
  quatFromMat3,
  relativeTo,
  vec3,
} from '@bs-humany/frames';
import {
  type Citation,
  type DofDef,
  type ExprContext,
  type HsdlDocument,
  type JointDef,
  cite,
  moduleNamespace,
  mul,
  param,
  provisional,
  writeExtension,
} from '@bs-humany/hsdl';
import { DATASET_MANIFEST } from './dataset.js';
import { computeBoneFrames } from './frames.js';
import {
  ARM,
  type DofSpec,
  HEAD,
  type JointSpec,
  LEG,
  MTP_AXIS,
  SUBTALAR_AXIS,
  type Side,
  TORSO,
  centreLocator,
  centreWorld,
  dataset,
  flexionPositive,
  half,
  myo,
  sideName,
  wu2002,
  wu2005,
} from './jointHelpers.js';
import { L2_EXTRA_JOINTS, L3_JOINT_SPECS, L3_ONLY_JOINTS } from './jointsL3.js';
import { computeWorldTransforms } from './pose.js';

function limbJoints(s: Side): JointSpec[] {
  const side = sideName(s);
  const specs: JointSpec[] = [
    {
      id: `hip_${s}`,
      displayName: `Hip, ${side}`,
      parentBone: `hip_${s}`,
      childBone: `femur_${s}`,
      type: 'spherical',
      centre: { isb: [`femur_${s}`, 'HJC'] },
      centreSource: wu2002('4.4, femoral coordinate system: origin at the hip centre'),
      reportingOrder: 'zxy',
      dofs: [
        {
          axis: 'flexion',
          vector: [0, 0, 1],
          range: [-0.523599, 2.0944],
          romSource: myo(LEG, `hip_flexion_${s}`),
        },
        {
          axis: 'adduction',
          vector: [1, 0, 0],
          range: [-0.872665, 0.523599],
          romSource: myo(LEG, `hip_adduction_${s}`),
        },
        {
          axis: 'internal_rotation',
          vector: [0, 1, 0],
          range: [-0.698132, 0.698132],
          romSource: myo(LEG, `hip_rotation_${s}`),
        },
      ],
      limitations: [
        'Hip flexion range depends on knee angle through the hamstrings; a fixed range is used.',
      ],
    },
    {
      id: `knee_${s}`,
      displayName: `Knee, ${side}`,
      parentBone: `femur_${s}`,
      childBone: `tibia_${s}`,
      type: 'revolute',
      centre: { virtual: `femur_${s}__mid_fe` },
      centreSource: wu2002('4.4, knee: origin at the midpoint of the femoral epicondyles'),
      reportingOrder: 'zxy',
      dofs: [
        {
          axis: 'flexion',
          vector: [0, 0, -1],
          range: [0, 2.0944],
          romSource: myo(LEG, `knee_angle_${s}`),
        },
      ],
      limitations: [
        'The knee is a pure hinge about the femoral epicondylar axis. The source couples small ' +
          'anteroposterior and vertical translations and a few degrees of rotation to flexion; ' +
          'those are omitted.',
        'The patella rides with the femur and does not track.',
      ],
    },
    {
      id: `ankle_${s}`,
      displayName: `Ankle, ${side}`,
      parentBone: `tibia_${s}`,
      childBone: `talus_${s}`,
      type: 'universal',
      centre: { virtual: `tibia_${s}__im` },
      centreSource: wu2002('4.2, ankle: origin at the inter-malleolar point'),
      reportingOrder: 'zxy',
      dofs: [
        {
          axis: 'dorsiflexion',
          vector: [0, 0, 1],
          range: [-0.698132, 0.523599],
          romSource: myo(LEG, `ankle_angle_${s}`),
        },
        {
          axis: 'inversion',
          vector: SUBTALAR_AXIS,
          range: [-0.349066, 0.349066],
          romSource: myo(LEG, `subtalar_angle_${s}`),
        },
      ],
      limitations: [
        'Talocrural and subtalar motion are lumped into one joint between tibia and talus, ' +
          'because talus and calcaneus share a segment in every current profile. The inversion ' +
          'axis is the source subtalar axis, expressed in the tibia frame.',
        'Dorsiflexion is about the ISB tibia Z (malleolar) axis rather than the source axis, ' +
          'which is tilted a few degrees from it.',
      ],
    },
    {
      id: `mtp_${s}`,
      displayName: `Metatarsophalangeal, ${side}`,
      parentBone: `metatarsal_1_${s}`,
      childBone: `phalanx_pedis_proximal_1_${s}`,
      type: 'revolute',
      centre: { virtual: `metatarsal_1_${s}__mid_mt_heads` },
      centreSource: cite('caggiano2022', `${LEG}, body toes_${s}: origin at the metatarsal heads`),
      dofs: [
        {
          axis: 'extension',
          vector: MTP_AXIS,
          range: [-0.523599, 0.523599],
          romSource: myo(LEG, `mtp_angle_${s}`),
        },
      ],
      limitations: [
        'All five toes move together about one oblique axis through the metatarsal heads. The ' +
          "source vector is negated so that positive is extension (toes up), matching the ankle's " +
          'dorsiflexion-positive convention.',
      ],
    },
    {
      id: `sternoclavicular_${s}`,
      displayName: `Sternoclavicular, ${side}`,
      parentBone: 'sternum',
      childBone: `clavicle_${s}`,
      type: 'universal',
      centre: { isb: [`clavicle_${s}`, 'SC'] },
      centreSource: wu2005('2.3.2, clavicle coordinate system: origin at SC'),
      reportingOrder: 'yxz',
      dofs: [
        {
          axis: 'protraction',
          vector: [0, 1, 0],
          range: [-0.75, 0],
          romSource: myo(ARM, 'sternoclavicular_r2_r'),
        },
        {
          axis: 'elevation',
          vector: [-1, 0, 0],
          range: [0, 0.318],
          romSource: myo(ARM, 'sternoclavicular_r3_r'),
        },
      ],
      limitations: [
        'The whole shoulder girdle moves at the sternoclavicular joint with sternoclavicular ' +
          'ranges. The acromioclavicular joint and scapulothoracic gliding are not modelled in ' +
          'the L1 profile, and clavicular axial rotation is locked, as in the source.',
        'The source arm model is right-sided only; the left mirrors it.',
      ],
    },
    {
      id: `glenohumeral_${s}`,
      displayName: `Glenohumeral, ${side}`,
      parentBone: `scapula_${s}`,
      childBone: `humerus_${s}`,
      type: 'spherical',
      centre: { isb: [`humerus_${s}`, 'GH'] },
      centreSource: wu2005('2.3.4, humerus coordinate system: origin at GH'),
      reportingOrder: 'yxy',
      dofs: [
        {
          axis: 'plane_of_elevation',
          vector: [0, 1, 0],
          range: [-1.658, 2.269],
          romSource: myo(ARM, 'elv_angle_r'),
        },
        {
          axis: 'elevation',
          vector: [-1, 0, 0],
          // biome-ignore lint/suspicious/noApproximativeNumericConstant: the source's value, verbatim
          range: [0, 3.142],
          romSource: myo(ARM, 'shoulder_elv_r'),
        },
        {
          axis: 'internal_rotation',
          vector: [0, 1, 0],
          range: [-1.571, 2.094],
          romSource: myo(ARM, 'shoulder_rot_r'),
        },
      ],
      limitations: [
        'Glenohumeral range depends on scapular position; fixed ranges are used and the ' +
          'scapula does not glide.',
        'The source orders these as plane of elevation, elevation, axial rotation in nested ' +
          'frames. Here they are three hinges in the ISB Y-X-Y sequence; the axial rotation ' +
          'sign is taken as internal-positive, which the source does not state.',
        'Gimbal lock: the Y-X-Y sequence is singular at zero elevation, the rest pose, where ' +
          'plane of elevation and axial rotation share an axis and only their sum is ' +
          'determined. Kept because it is the ISB convention the ranges are stated in; a ' +
          'backend recovering angles from poses must resolve the split, and does so toward ' +
          'neutral, so within a few degrees of zero elevation the recovered angles do not encode ' +
          'a small swing of the arm and the range stops on those two DoFs do not act on it.',
        'The source arm model is right-sided only; the left mirrors it.',
      ],
    },
    {
      id: `elbow_${s}`,
      displayName: `Elbow, ${side}`,
      parentBone: `humerus_${s}`,
      childBone: `ulna_${s}`,
      type: 'revolute',
      centre: { virtual: `humerus_${s}__mid_el_em` },
      centreSource: wu2005('3.3, elbow: origin at the midpoint of EL and EM'),
      reportingOrder: 'zxy',
      dofs: [
        {
          axis: 'flexion',
          vector: [0, 0, 1],
          range: [0, 2.269],
          romSource: myo(ARM, 'elbow_flexion_r'),
        },
      ],
      limitations: [
        'Flexion is about the humeral epicondylar axis. Carrying angle is whatever the dataset ' +
          'pose has; it does not change with flexion.',
        'The source arm model is right-sided only; the left mirrors it.',
      ],
    },
    {
      id: `radioulnar_${s}`,
      displayName: `Radioulnar, ${side}`,
      parentBone: `ulna_${s}`,
      childBone: `radius_${s}`,
      type: 'revolute',
      centre: { marker: [`radius_${s}`, 'Head_of_radius'] },
      centreSource: wu2005(
        '3.3, forearm: pronation/supination axis from the head of the radius to US',
      ),
      dofs: [
        {
          axis: 'pronation',
          vector: [0, 1, 0],
          range: [-1.5708, 1.5708],
          romSource: myo(ARM, 'pro_sup_r'),
        },
      ],
      limitations: [
        'Pronation is about the ulna frame Y axis through the radial head, rather than the line ' +
          'from the radial head to the ulnar styloid, which is a few degrees off it.',
        'The source arm model is right-sided only; the left mirrors it.',
      ],
    },
    {
      id: `wrist_${s}`,
      displayName: `Wrist, ${side}`,
      parentBone: `radius_${s}`,
      childBone: `capitate_${s}`,
      type: 'universal',
      centre: { virtual: `radius_${s}__mid_rs_us` },
      centreSource: provisional(
        'wu2005',
        'OQ-005',
        'The hand sections have not been checked against the paper; the wrist centre is taken ' +
          'as the midpoint of the styloids pending that.',
        '3.3, wrist',
      ),
      reportingOrder: 'zxy',
      dofs: [
        {
          axis: 'flexion',
          vector: [0, 0, 1],
          range: [-0.785398, 0.785398],
          romSource: myo(ARM, 'flexion_r'),
        },
        {
          axis: 'ulnar_deviation',
          vector: [1, 0, 0],
          range: [-0.174533, 0.436332],
          romSource: myo(ARM, 'deviation_r'),
        },
      ],
      limitations: [
        'Radiocarpal and midcarpal motion are lumped into one joint between radius and capitate.',
        'The source arm model is right-sided only; the left mirrors it.',
      ],
    },
  ];
  return specs.map((spec) => ({ ...spec, side: s }));
}

// --- Spine -----------------------------------------------------------------------------------

const LUMBAR_LUMPED = {
  flexion: flexionPositive([-1.35, 0.7538]),
  lateralBending: [-0.4363, 0.4363],
  axialRotation: [-0.7854, 0.7854],
} as const;

/** Per-level lumbar ranges the source carries, flexion-positive. */
const LUMBAR_LEVELS: ReadonlyArray<{
  readonly id: string;
  readonly lower: string;
  readonly upper: string;
  readonly sourceJoint: string;
  readonly flexion: readonly [number, number];
  readonly lateralBending: readonly [number, number];
  readonly axialRotation: readonly [number, number];
}> = [
  {
    id: 'l4_l5',
    lower: 'vertebra_l5',
    upper: 'vertebra_l4',
    sourceJoint: 'L4_L5',
    flexion: flexionPositive([-0.18607, 0.083953]),
    lateralBending: [-0.0889703, 0.089703],
    axialRotation: [-0.3168812, 0.3168812],
  },
  {
    id: 'l3_l4',
    lower: 'vertebra_l4',
    upper: 'vertebra_l3',
    sourceJoint: 'L3_L4',
    flexion: flexionPositive([-0.249288, 0.0925752]),
    lateralBending: [-0.1568935, 0.1568935],
    axialRotation: [-0.02968812, 0.02968812],
  },
  {
    id: 'l2_l3',
    lower: 'vertebra_l3',
    upper: 'vertebra_l2',
    sourceJoint: 'L2_L3',
    flexion: flexionPositive([-0.282282, 0.1048278]),
    lateralBending: [-0.159075, 0.159075],
    axialRotation: [-0.10442594, 0.10442594],
  },
  {
    id: 'l1_l2',
    lower: 'vertebra_l2',
    upper: 'vertebra_l1',
    sourceJoint: 'L1_L2',
    flexion: flexionPositive([-0.31161, 0.115719]),
    lateralBending: [-0.0820244, 0.0820244],
    axialRotation: [-0.08269806, 0.08269806],
  },
];

/** Mean of the sourced per-level ranges, for the two levels the source does not carry. */
function meanLumbarRange(key: 'flexion' | 'lateralBending' | 'axialRotation'): [number, number] {
  const n = LUMBAR_LEVELS.length;
  return [
    LUMBAR_LEVELS.reduce((sum, l) => sum + l[key][0], 0) / n,
    LUMBAR_LEVELS.reduce((sum, l) => sum + l[key][1], 0) / n,
  ];
}

const OQ007 = (rationale: string) =>
  provisional('caggiano2022', 'OQ-007', rationale, `${TORSO}, mean of joints L1_L2 .. L4_L5`);

const SPINE_CENTRE_LIMITATION =
  'The joint centre is midway between the two vertebral centroids, which sit a little posterior ' +
  'to the intervertebral disc because a centroid includes the posterior arch.';

function spineDofs(
  ranges: {
    readonly flexion: readonly [number, number];
    readonly lateralBending: readonly [number, number];
    readonly axialRotation: readonly [number, number];
  },
  source: (dof: 'FE' | 'LB' | 'AR') => Citation,
): DofSpec[] {
  return [
    { axis: 'flexion', vector: [0, 0, -1], range: ranges.flexion, romSource: source('FE') },
    {
      axis: 'lateral_bending_right',
      vector: [1, 0, 0],
      range: ranges.lateralBending,
      romSource: source('LB'),
    },
    {
      axis: 'axial_rotation_left',
      vector: [0, 1, 0],
      range: ranges.axialRotation,
      romSource: source('AR'),
    },
  ];
}

const lumpedSource = (dof: 'FE' | 'LB' | 'AR') =>
  myo(TORSO, { FE: 'flex_extension', LB: 'lat_bending', AR: 'axial_rotation' }[dof]);

const REGION_HALF_LIMITATION =
  'Region joint for the L1 profile. It carries half of the source model’s lumped range so ' +
  'that the two region joints together reproduce the whole; the split is arithmetic, not measured.';

const SPINE_JOINTS: JointSpec[] = [
  {
    id: 'lumbar_region_lower',
    displayName: 'Lumbar region, lower (L5/S1)',
    parentBone: 'sacrum',
    childBone: 'vertebra_l5',
    type: 'spherical',
    centre: { marker: ['sacrum', 'Base_of_sacrum'] },
    centreSource: dataset(
      'marker Base_of_sacrum: the superior surface of S1, where the L5/S1 disc sits',
    ),
    reportingOrder: 'zxy',
    dofs: spineDofs(
      {
        flexion: half(LUMBAR_LUMPED.flexion),
        lateralBending: half(LUMBAR_LUMPED.lateralBending),
        axialRotation: half(LUMBAR_LUMPED.axialRotation),
      },
      lumpedSource,
    ),
    limitations: [REGION_HALF_LIMITATION],
  },
  {
    id: 'lumbar_region_upper',
    displayName: 'Lumbar region, upper (T12/L1)',
    parentBone: 'vertebra_l1',
    childBone: 'vertebra_t12',
    type: 'spherical',
    centre: { centroidMid: ['vertebra_l1', 'vertebra_t12'] },
    centreSource: dataset('centroids of vertebra_l1 and vertebra_t12'),
    reportingOrder: 'zxy',
    dofs: spineDofs(
      {
        flexion: half(LUMBAR_LUMPED.flexion),
        lateralBending: half(LUMBAR_LUMPED.lateralBending),
        axialRotation: half(LUMBAR_LUMPED.axialRotation),
      },
      lumpedSource,
    ),
    limitations: [REGION_HALF_LIMITATION, SPINE_CENTRE_LIMITATION],
  },
  {
    id: 'l5_s1',
    displayName: 'Lumbosacral (L5/S1)',
    parentBone: 'sacrum',
    childBone: 'vertebra_l5',
    type: 'spherical',
    centre: { marker: ['sacrum', 'Base_of_sacrum'] },
    centreSource: dataset(
      'marker Base_of_sacrum: the superior surface of S1, where the L5/S1 disc sits',
    ),
    reportingOrder: 'zxy',
    dofs: spineDofs(
      {
        flexion: meanLumbarRange('flexion'),
        lateralBending: meanLumbarRange('lateralBending'),
        axialRotation: meanLumbarRange('axialRotation'),
      },
      () => OQ007('The source torso model has no L5/S1 joint of its own.'),
    ),
    limitations: ['Per-level joint for the L2 profile. Range is provisional; see OQ-007.'],
  },
  ...LUMBAR_LEVELS.map(
    (level): JointSpec => ({
      id: level.id,
      displayName: `Intervertebral ${level.sourceJoint.replace('_', '/')}`,
      parentBone: level.lower,
      childBone: level.upper,
      type: 'spherical',
      centre: { centroidMid: [level.lower, level.upper] },
      centreSource: dataset(`centroids of ${level.lower} and ${level.upper}`),
      reportingOrder: 'zxy',
      dofs: spineDofs(level, (dof) => myo(TORSO, `${level.sourceJoint}_${dof}`)),
      limitations: ['Per-level joint for the L2 profile.', SPINE_CENTRE_LIMITATION],
    }),
  ),
  {
    id: 't12_l1',
    displayName: 'Thoracolumbar (T12/L1)',
    parentBone: 'vertebra_l1',
    childBone: 'vertebra_t12',
    type: 'spherical',
    centre: { centroidMid: ['vertebra_l1', 'vertebra_t12'] },
    centreSource: dataset('centroids of vertebra_l1 and vertebra_t12'),
    reportingOrder: 'zxy',
    dofs: spineDofs(
      {
        flexion: meanLumbarRange('flexion'),
        lateralBending: meanLumbarRange('lateralBending'),
        axialRotation: meanLumbarRange('axialRotation'),
      },
      () => OQ007('The source torso model has no T12/L1 joint of its own.'),
    ),
    limitations: [
      'Per-level joint for the L2 profile. Range is provisional; see OQ-007.',
      SPINE_CENTRE_LIMITATION,
    ],
  },
];

// --- Neck ------------------------------------------------------------------------------------

const NECK_LUMPED = {
  flexion: flexionPositive([-0.87, 1.05]),
  axialRotation: [-1.4, 1.4],
} as const;

const NECK_LIMITATIONS = [
  'Region joint for the L1 profile. It carries half of the source head model’s lumped ' +
    'range so that the two neck joints together reproduce the whole; the split is arithmetic.',
  'No lateral bending: the source head model has none, and no other cited range is in hand.',
  'Axial rotation is about the vertical; the source axis leans forward by about eleven degrees.',
];

function neckDofs(): DofSpec[] {
  return [
    {
      axis: 'flexion',
      vector: [0, 0, -1],
      range: half(NECK_LUMPED.flexion),
      romSource: myo(HEAD, 'neck_flexion'),
    },
    {
      axis: 'axial_rotation_left',
      vector: [0, 1, 0],
      range: half(NECK_LUMPED.axialRotation),
      romSource: myo(HEAD, 'neck_rotation'),
    },
  ];
}

const NECK_JOINTS: JointSpec[] = [
  {
    id: 'neck_region_lower',
    displayName: 'Neck region, lower (C7/T1)',
    parentBone: 'vertebra_t1',
    childBone: 'vertebra_c7',
    type: 'universal',
    centre: { centroidMid: ['vertebra_t1', 'vertebra_c7'] },
    centreSource: dataset('centroids of vertebra_t1 and vertebra_c7'),
    reportingOrder: 'zxy',
    dofs: neckDofs(),
    limitations: [...NECK_LIMITATIONS, SPINE_CENTRE_LIMITATION],
  },
  {
    id: 'neck_region_upper',
    displayName: 'Neck region, upper (atlanto-occipital)',
    parentBone: 'vertebra_c1',
    childBone: 'occipital',
    type: 'universal',
    centre: { marker: ['occipital', 'Occipital_condyle'] },
    centreSource: dataset('marker Occipital_condyle'),
    reportingOrder: 'zxy',
    dofs: neckDofs(),
    limitations: NECK_LIMITATIONS,
  },
];

export const JOINT_SPECS: readonly JointSpec[] = [
  ...SPINE_JOINTS,
  ...NECK_JOINTS,
  ...limbJoints('r'),
  ...limbJoints('l'),
  ...L3_JOINT_SPECS,
];

/**
 * Joint ids the L0 profile activates. The trunk is one segment, so the upper lumbar region joint,
 * the lower neck joint's partner, the radioulnar and the metatarsophalangeal joints all fall
 * inside a segment and would be dropped; they are simply not listed.
 */
export const L0_JOINTS: readonly string[] = [
  'lumbar_region_lower',
  'neck_region_lower',
  ...(['r', 'l'] as const).flatMap((s) => [
    `glenohumeral_${s}`,
    `elbow_${s}`,
    `wrist_${s}`,
    `hip_${s}`,
    `knee_${s}`,
    `ankle_${s}`,
  ]),
];

/** Joint ids the L1 profile activates: one joint per pair of adjacent L1 segments. */
export const L1_JOINTS: readonly string[] = [
  'lumbar_region_lower',
  'lumbar_region_upper',
  'neck_region_lower',
  'neck_region_upper',
  ...(['r', 'l'] as const).flatMap((s) => [
    `sternoclavicular_${s}`,
    `glenohumeral_${s}`,
    `elbow_${s}`,
    `radioulnar_${s}`,
    `wrist_${s}`,
    `hip_${s}`,
    `knee_${s}`,
    `ankle_${s}`,
    `mtp_${s}`,
  ]),
];

/**
 * Joint ids the L2 profile activates. The per-level lumbar joints replace the two region joints;
 * the neck region joints stand in until per-level cervical ranges are sourced.
 */
export const L2_JOINTS: readonly string[] = [
  'l5_s1',
  ...LUMBAR_LEVELS.map((l) => l.id),
  't12_l1',
  // The three thoracic blocks meet at T8/T9 and T4/T5.
  't8_t9',
  't4_t5',
  'neck_region_lower',
  'c2_c3',
  'c1_c2',
  'neck_region_upper',
  ...L1_JOINTS.filter((id) => !id.startsWith('lumbar_region') && !id.startsWith('neck_region')),
  ...L2_EXTRA_JOINTS,
];

/**
 * Joint ids the L3 profile activates: every anatomical level, articulated hands, the patellae,
 * separate talus and calcaneus, and the ribs.
 */
export const L3_JOINTS: readonly string[] = [
  'l5_s1',
  ...LUMBAR_LEVELS.map((l) => l.id),
  't12_l1',
  ...L3_ONLY_JOINTS,
  ...(['r', 'l'] as const).flatMap((s) => [
    `sternoclavicular_${s}`,
    `acromioclavicular_${s}`,
    `glenohumeral_${s}`,
    `elbow_${s}`,
    `radioulnar_${s}`,
    `wrist_${s}`,
    `hip_${s}`,
    `knee_${s}`,
    `patellofemoral_${s}`,
    `talocrural_${s}`,
    `subtalar_${s}`,
    `midtarsal_${s}`,
    `tarsometatarsal_${s}`,
    `mtp_${s}`,
  ]),
];

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

export const JOINT_NS = moduleNamespace('joint');

export interface JointProvenance {
  readonly centre: string;
  /** `isb-frame:<bone>` when the parent bone has an ISB frame, else `isb-canonical`. */
  readonly orientation: string;
  /** True when the DoF vectors were mirrored under the left-side sign policy. */
  readonly mirrored: boolean;
}

/**
 * Rotor inertia added to every DoF, kg*m^2 (spec section 7.1).
 *
 * A numerical conditioning term, not anatomy: deep chains of low-mass bodies are the worst case
 * for a solver, and a sequence such as the Y-X-Y shoulder has a null-space direction at zero
 * elevation whose effective inertia would otherwise be nearly zero, so a limit could not hold it.
 * One thousandth of a kilogram-metre-squared is below the smallest segment inertia about any DoF
 * axis in the model and is recorded here, on every DoF, rather than hidden in a backend.
 */
export const DEFAULT_ARMATURE = 1e-3;

/** The left-side sign policy, in one place. */
export function mirrorVector(v: Vec3): Vec3 {
  return vec3(-v.x, -v.y, v.z);
}

const ISB_CANONICAL: Quat = quatFromMat3(conversionMatrix(ISB, WORLD));

/** The morphology at which the dataset pose is exact: its own subject. */
function datasetContext(): ExprContext {
  return { sex: 0.5, stature: DATASET_MANIFEST.subjectStature, mass: 70 };
}

/**
 * Build every joint definition against a document's bones and landmarks.
 *
 * Runs at the dataset stature: joint centres are dataset positions, and the parent frame's
 * orientation there is the orientation at every stature, since scaling is uniform. The centre is
 * then expressed in the parent bone's frame as a fraction of stature, like every other position
 * in the document.
 */
export function buildJoints(document: Pick<HsdlDocument, 'bones' | 'landmarks'>): JointDef[] {
  const context = datasetContext();
  const world = computeWorldTransforms(document, context);
  const frames = computeBoneFrames(document, context);
  const stature = DATASET_MANIFEST.subjectStature;

  return JOINT_SPECS.map((spec): JointDef => {
    const parentWorld = world.get(spec.parentBone);
    if (!parentWorld)
      throw new Error(`Joint '${spec.id}' parent '${spec.parentBone}' has no pose.`);
    const parentFrame = frames.get(spec.parentBone);
    const centre = centreWorld(spec.centre);
    const jointWorld: Transform = {
      translation: vec3(centre[0], centre[1], centre[2]),
      rotation: parentFrame ? parentFrame.rotation : ISB_CANONICAL,
    };
    const local = relativeTo(jointWorld, parentWorld);
    const mirrored = spec.side === 'l';

    const provenance: JointProvenance = {
      centre: centreLocator(spec.centre),
      orientation: parentFrame ? `isb-frame:${spec.parentBone}` : 'isb-canonical',
      mirrored,
    };

    return {
      id: spec.id,
      displayName: spec.displayName,
      parentBone: spec.parentBone,
      childBone: spec.childBone,
      type: spec.type,
      frame: {
        translation: {
          x: mul(local.translation.x / stature, param('stature')),
          y: mul(local.translation.y / stature, param('stature')),
          z: mul(local.translation.z / stature, param('stature')),
        },
        rotation: local.rotation,
      },
      dofs: spec.dofs.map((d): DofDef => {
        const unit = normalize(vec3(d.vector[0], d.vector[1], d.vector[2]));
        const vector = mirrored ? mirrorVector(unit) : unit;
        return {
          axis: d.axis,
          kind: 'hinge',
          vector: { x: vector.x, y: vector.y, z: vector.z },
          range: [d.range[0], d.range[1]],
          neutral: 0,
          armature: DEFAULT_ARMATURE,
          romSource: d.romSource,
        };
      }),
      ...(spec.reportingOrder ? { reportingOrder: spec.reportingOrder } : {}),
      limitations: [
        ...(spec.limitations ?? []),
        ...(mirrored
          ? [
              'Left side: DoF vectors about X and Y are mirrored so a positive angle is the same ' +
                'clinical motion as on the right (OQ-006).',
            ]
          : []),
      ],
      ext: writeExtension(undefined, JOINT_NS, { ...provenance, centreSource: spec.centreSource }),
    };
  });
}
