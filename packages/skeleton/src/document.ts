/**
 * Assembling the full HSDL document.
 *
 * Joins the taxonomy (identity and hierarchy) with the shape library (geometry and rest
 * transforms) and the segmentation profiles into a single validated `HsdlDocument`.
 *
 * The three are kept separate up to this point on purpose. Naming is the public ABI and changes
 * almost never; geometry is iterated on constantly; segmentation is a performance decision. Fusing
 * them into one 206-entry literal would make all three move together.
 */

import type { PackedBone } from '@bs-humany/assets-anatomical';
import {
  type BoneDef,
  HSDL_VERSION,
  type HsdlDocument,
  assertValidDocument,
  cite,
  provisional,
} from '@bs-humany/hsdl';
import { mul, param } from '@bs-humany/hsdl';
import { buildAttachmentSites } from './attachments.js';
import { buildConstraints } from './constraints.js';
import { DATASET_MANIFEST } from './dataset.js';
import { buildFrameDefs, buildVirtualLandmarks } from './frames.js';
import { BONE_SHAPES, FALLBACK_BONES, fallbackShape } from './geometry/shapes.js';
import { buildJoints } from './joints.js';
import { buildLandmarks } from './landmarks.js';
import { buildCollisionSetup, buildContactRules } from './proxies.js';
import { SEGMENTATION_PROFILES } from './segmentation.js';
import { BONES } from './taxonomy.js';

/** Build the bone definitions by joining taxonomy entries with their shapes. */
/**
 * Rest transform of a bone relative to its anatomical parent, from the dataset.
 *
 * The dataset gives every bone's centroid in one world frame. The parent-relative translation is
 * the difference of centroids, expressed as a fraction of the dataset subject's stature so it
 * scales with the `stature` parameter -- centroid deltas telescope down the tree, so composing them
 * reproduces each bone's measured position exactly. Rotation is identity: the meshes are stored in
 * their world orientation.
 *
 * A bone the dataset lacks (the ossicles, OQ-004) keeps its hand-authored transform, which is
 * relative to a parent that is now dataset-placed; the two agree to within the fallback's own
 * size. This is the interim placement model until landmark-derived frames land (M1.2/M1.3).
 */
const packedById = new Map<string, PackedBone>(DATASET_MANIFEST.bones.map((b) => [b.id, b]));

function datasetRestTransform(entry: { id: string; parent: string | null }) {
  const own = packedById.get(entry.id);
  if (!own) return undefined;
  const parent = entry.parent === null ? undefined : packedById.get(entry.parent);
  const base = parent?.centroid ?? [0, 0, 0];
  const fraction = (i: 0 | 1 | 2) => (own.centroid[i] - base[i]) / DATASET_MANIFEST.subjectStature;
  return {
    translation: {
      x: mul(fraction(0), param('stature')),
      y: mul(fraction(1), param('stature')),
      z: mul(fraction(2), param('stature')),
    },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
}

/**
 * Where bones are placed.
 *
 * `dataset` (default): measured centroids from the Z-Anatomy pack, scaled to stature. Pair it
 * with the mesh pack. `procedural`: the hand-authored layout the procedural recipes were written
 * against, whose origins sit at joint centres with the bone extending along +Y -- the recipes only
 * make sense in that layout, so the two must travel together. The studio's geometry toggle
 * switches documents, not just meshes.
 */
export type Placement = 'dataset' | 'procedural';

export interface BuildOptions {
  readonly placement?: Placement;
}

export function buildBones(options: BuildOptions = {}): BoneDef[] {
  const placement = options.placement ?? 'dataset';
  const frames = placement === 'dataset' ? buildFrameDefs() : new Map();
  return BONES.map((entry): BoneDef => {
    const frame = frames.get(entry.id);
    const shape = BONE_SHAPES.get(entry.id) ?? fallbackShape(entry.region);
    const restTransform =
      (placement === 'dataset' ? datasetRestTransform(entry) : undefined) ?? shape.restTransform;
    return {
      id: entry.id,
      ta: entry.ta,
      displayName: entry.displayName,
      parent: entry.parent,
      region: entry.region,
      ...(entry.side ? { side: entry.side } : {}),
      restTransform,
      ...(frame ? { frame } : {}),
      dimensions: shape.dimensions,
      geometry: shape.geometry,
    };
  });
}

/** Bones rendered with the generic fallback rather than a modelled shape. */

export function unmodelledBones(): string[] {
  return BONES.filter((b) => !BONE_SHAPES.has(b.id)).map((b) => b.id);
}

/**
 * The reference body.
 *
 * Morphology defaults to the midpoint of the sex blend at a 1.70 m, 70 kg body -- a deliberately
 * ordinary starting point rather than either endpoint, so nothing about the default implies a norm.
 */
export function buildDocument(options: BuildOptions = {}): HsdlDocument {
  const bones = buildBones(options);
  const landmarks = [
    ...buildLandmarks(),
    ...(options.placement === 'procedural' ? [] : buildVirtualLandmarks()),
  ];
  // Joints are located from landmarks and oriented by ISB frames, neither of which the procedural
  // layout carries, so that layout stays a bare, unjointed skeleton.
  const joints = options.placement === 'procedural' ? [] : buildJoints({ bones, landmarks });
  // The procedural layout has no joints to activate, so its profiles carry no joint lists.
  const profiles = SEGMENTATION_PROFILES.map((profile) => {
    if (options.placement !== 'procedural') return profile;
    const { joints: _joints, ...rest } = profile;
    return rest;
  });
  // Proxies are fitted to the measured bounds, which only the dataset placement honours.
  const collision =
    options.placement === 'procedural' ? undefined : buildCollisionSetup(profiles, joints);
  const document: HsdlDocument = {
    hsdlVersion: HSDL_VERSION,
    id: 'bs-humany.reference-skeleton',
    meta: {
      name: 'bs-humany reference skeleton',
      description:
        'The complete 206-bone anatomical skeleton with procedural geometry, parameterized by ' +
        'morphology. Phase 1 mechanical layer.',
      convention: 'world',
      sources: [
        cite('deleva1996', 'Table 4, segment inertial parameters'),
        cite('gordon2014', 'Summary statistics, stature and weight by sex'),
        cite('drillis1966', 'Segment lengths as fractions of standing height'),
        cite('winter2009', 'Reproduction of the Drillis and Contini proportion table'),
        cite('wu2002', 'ISB joint coordinate systems: ankle, hip, spine'),
        cite('wu2005', 'ISB joint coordinate systems: shoulder, elbow, wrist, hand'),
        cite(
          'caggiano2022',
          'Joint ranges of motion from the MyoSuite leg, arm, torso and head models',
        ),
        cite(
          'kervyn2021',
          'Bone geometry, placement and landmarks from the Z-Anatomy skeletal system',
        ),
        cite('gray1918', 'Muscle origins and insertions as bony features, Part IV'),
      ],
    },
    units: { length: 'm', mass: 'kg', angle: 'rad', time: 's', force: 'N' },

    bones,
    landmarks,
    joints,
    segmentation: collision ? collision.profiles : profiles,
    collisionProxies: collision ? collision.proxies : [],
    contactRules: collision
      ? buildContactRules(collision)
      : {
          classes: {
            bone_on_ground: { friction: 0.85, restitution: 0.02 },
            bone_on_bone: { friction: 0.3, restitution: 0.0 },
          },
          defaultClass: 'bone_on_ground',
        },
    constraints: options.placement === 'procedural' ? [] : buildConstraints(),

    morphology: {
      default: { sex: 0.5, stature: 1.7, mass: 70 },
      statureRange: [1.4, 2.05],
      massRange: [35, 150],
      populations: [
        {
          describes: 'Segment inertial parameters',
          limitation:
            'de Leva (1996) sampled college-aged Caucasian adults: 100 male, 15 female. Not a ' +
            'universal human norm, and the female table rests on a small sample.',
          source: cite('deleva1996', 'Methods, subject description'),
        },
        {
          describes: 'Stature, body mass and breadths',
          limitation:
            'ANSUR II sampled US Army personnel in 2012. Not representative of the general ' +
            'population in body composition or age distribution; mean BMI runs well above ' +
            'civilian means.',
          source: cite('gordon2014', 'Sample description'),
        },
        {
          describes: 'Segment length proportions',
          limitation:
            'Drillis and Contini (1966) is not sex-separated, so the same limb proportions are ' +
            'applied to both endpoint tables. This understates real dimorphism in the crural and ' +
            'brachial indices and in relative leg length. Tracked as OQ-003.',
          source: provisional(
            'drillis1966',
            'OQ-003',
            'The only proportion table available without redistribution restrictions that covers ' +
              'every segment. Sex-separated replacements are an open question.',
          ),
        },
      ],
    },

    attachmentSites: options.placement === 'procedural' ? [] : buildAttachmentSites(),
  };

  return assertValidDocument(document);
}

/**
 * Known limitations of the reference model, for display in the UI.
 *
 * Spec section 7.3 and section 12: every simplification is recorded rather than presented as the
 * real thing.
 */
export function modelLimitations(): string[] {
  const unmodelled = unmodelledBones();
  const limitations = [
    'Joint ranges are fixed values from the MyoSuite reference models. Several are ' +
      'posture-dependent in reality (hip flexion with knee angle, glenohumeral range with scapular ' +
      'position); each joint records its own simplifications.',
    "Collision proxies are convex decompositions of each segment's bones (up to three " +
      'pieces per bone, twelve per segment), so a rib cage or a pelvis is a dozen convex ' +
      'pieces rather than its true shape. Pairs of unjoined segments whose bounds overlap at ' +
      'rest are excluded from self-collision, so those regions pass through each other.',
    'Joint couplings (lumbar level shares, the patella tracking the knee, the shoulder girdle ' +
      'following elevation) are transcribed from MyoSuite and solved exactly by MuJoCo, the ' +
      'only enabled backend.',
    'The first seven ribs are welded rigidly to the sternum to close the rib cage, which a tree ' +
      'of joints cannot do. Costal cartilage is compliant, so the thorax is stiffer here than ' +
      'in life; before this the cage had no anterior connection at all and opened as the spine ' +
      'bent. See OQ-011.',
    'The scapula travels with the clavicle but does not turn with it: the acromioclavicular ' +
      'joint carries two counter-rotating degrees of freedom that undo the clavicle’s own ' +
      'rotation, as the source model does with a phantom body. Nothing else holds the scapula ' +
      'against the rib cage, so it still drifts a few centimetres clear at full elevation.',
    'The L1 spine moves at two lumbar and two neck region joints, each carrying half of a lumped ' +
      'source range. Per-level lumbar joints exist for L2; two of the six levels are provisional ' +
      '(OQ-007). No cervical lateral bending is defined yet.',
    'Bone placement comes from the Z-Anatomy dataset (one male subject, 1.70 m) scaled uniformly ' +
      'by stature. Pelvic and shoulder breadth, and the sex blend, do not yet move the measured ' +
      'bones; that needs the landmark-derived joint frames of M1.2/M1.3.',
    'Joint centres are the dataset markers for the feature each joint turns about. A marker ' +
      'marks a surface feature, so for the two ball joints -- the hip and the shoulder -- the ' +
      'centre is instead fitted as a sphere through the articular surface. Every other centre ' +
      'is still a marker, a midpoint of markers, or a bounds rule, each recorded on the joint.',
    'ISB segment frames cover the pelvis, femur, tibia/fibula, calcaneus, thorax, clavicle, ' +
      'scapula, humerus, ulna and radius. Vertebrae, skull, hands and the remaining foot bones ' +
      'are world-aligned at their centroid until their systems are defined.',
    "Left-side frames follow the right-handed policy of OQ-006 (Z to the subject's right on both " +
      'sides) rather than the literal ISB wording for left segments.',
    'Limb proportions are sex-neutral: the underlying table is not sex-separated. See OQ-003.',
    'Parameter tables are consistency-checked but not yet verified line by line against their ' +
      'source publications. See OQ-001 and OQ-002.',
  ];
  limitations.push(
    'The procedural skeleton is disabled as a user option and is a future goal; the measured ' +
      'skeleton is the only one rendered. Procedural recipes serve only as the fallback for bones ' +
      'the dataset lacks.',
  );
  if (unmodelled.length > 0) {
    limitations.push(
      `${unmodelled.length} bone(s) use a generic fallback shape rather than a modelled one: ` +
        `${unmodelled.join(', ')}. At their real size a simple form meets the Phase 1 quality bar.`,
    );
  }
  return limitations;
}

export { FALLBACK_BONES, DATASET_MANIFEST };
