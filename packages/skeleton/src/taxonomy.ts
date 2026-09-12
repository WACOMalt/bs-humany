/**
 * The complete human bone taxonomy: 206 bones.
 *
 * This is the anatomical layer of ADR-001, and it is always complete. Every bone here is present
 * at every fidelity level, always has a valid world transform, and is always renderable and
 * inspectable. Which of them become solver rigid bodies is a separate question, answered by the
 * segmentation profile.
 *
 * **These IDs are the project's public ABI.** A muscle module written years from now attaches an
 * origin to `humerus_r` regardless of whether the humerus is currently its own rigid body or part
 * of a lumped arm segment. Spec section 4.4: they MUST NOT change without a major HSDL version
 * bump.
 *
 * ## The count
 *
 * 206 is the standard adult count, and it is a convention rather than a measurement. It counts the
 * sacrum as one bone (five fused sacral vertebrae) and the coccyx as one (three to five fused),
 * counts the sternum as one (manubrium, body and xiphoid process, which fuse at different ages),
 * and excludes sesamoid bones other than the patellae -- most people have two more at the first
 * metatarsophalangeal joint of each foot, and many have others. Bone count also varies genuinely
 * between individuals: an extra lumbar vertebra, a cervical rib, and unfused sutural bones in the
 * skull are all common.
 *
 * Recorded here so that a future contributor who counts 208 in an atlas knows this was a choice.
 *
 * ## Regularity
 *
 * The regular series -- vertebrae, ribs, digits -- are generated rather than typed out. Twenty-four
 * hand-written phalanx entries would differ from each other only in two characters, which is a
 * recipe for a transposed digit number that nobody spots. The irregular bones are listed
 * explicitly.
 *
 * ## Parents
 *
 * The parent relation is the anatomical containment tree, rooted at the sacrum. Where an unpaired
 * bone articulates bilaterally -- the mandible against both temporal bones, the sternum against
 * both first ribs -- a tree cannot represent the truth, so the convention is to parent it to the
 * left member and record that in `parentNote`.
 */

import type { BoneRegion } from '@bs-humany/hsdl';
import type { BoneTaxonomyEntry } from './taxonomy-types.js';

const entries: BoneTaxonomyEntry[] = [];

function bone(
  id: string,
  ta: string,
  displayName: string,
  parent: string | null,
  region: BoneRegion,
  extra: { side?: 'left' | 'right'; parentNote?: string } = {},
): void {
  entries.push({
    id,
    ta,
    displayName,
    parent,
    region,
    ...(extra.side ? { side: extra.side } : {}),
    ...(extra.parentNote ? { parentNote: extra.parentNote } : {}),
  });
}

/** Add a left and a right copy. `parent` may be a function of side for paired parents. */
function pair(
  baseId: string,
  ta: string,
  displayName: string,
  parent: string | ((suffix: 'l' | 'r') => string),
  region: BoneRegion,
): void {
  for (const suffix of ['l', 'r'] as const) {
    const side = suffix === 'l' ? 'left' : 'right';
    const resolvedParent = typeof parent === 'function' ? parent(suffix) : parent;
    bone(
      `${baseId}_${suffix}`,
      ta,
      `${side === 'left' ? 'Left' : 'Right'} ${displayName}`,
      resolvedParent,
      region,
      { side },
    );
  }
}

const BILATERAL_CONVENTION =
  'Articulates bilaterally, so a tree cannot represent the true relation. Parented to the left ' +
  'member by convention. See the taxonomy module comment.';

// =============================================================================================
// Axial skeleton -- 80 bones
// =============================================================================================

// --- Vertebral column: 26 -------------------------------------------------------------------
// Rooted at the sacrum. The column runs upward from L5 and the pelvis hangs off the sides, which
// matches both the body plan and the usual floating-base choice for the dynamic root.

bone('sacrum', 'Os sacrum', 'Sacrum', null, 'sacral');
bone('coccyx', 'Os coccygis', 'Coccyx', 'sacrum', 'sacral');

const LUMBAR_COUNT = 5;
const THORACIC_COUNT = 12;
const CERVICAL_COUNT = 7;

// Lumbar L5 -> L1, each parented to the level below it.
for (let level = LUMBAR_COUNT; level >= 1; level--) {
  bone(
    `vertebra_l${level}`,
    'Vertebra lumbalis',
    `Lumbar vertebra L${level}`,
    level === LUMBAR_COUNT ? 'sacrum' : `vertebra_l${level + 1}`,
    'lumbar',
  );
}

// Thoracic T12 -> T1.
for (let level = THORACIC_COUNT; level >= 1; level--) {
  bone(
    `vertebra_t${level}`,
    'Vertebra thoracica',
    `Thoracic vertebra T${level}`,
    level === THORACIC_COUNT ? 'vertebra_l1' : `vertebra_t${level + 1}`,
    'thoracic',
  );
}

// Cervical C7 -> C1. C1 and C2 keep their proper names: they are structurally unlike the rest,
// and spec section 7.2 warns that C1-C2 must not be modelled as a generic 3-DoF ball joint.
for (let level = CERVICAL_COUNT; level >= 1; level--) {
  const ta = level === 1 ? 'Atlas' : level === 2 ? 'Axis' : 'Vertebra cervicalis';
  const name =
    level === 1 ? 'Atlas (C1)' : level === 2 ? 'Axis (C2)' : `Cervical vertebra C${level}`;
  bone(
    `vertebra_c${level}`,
    ta,
    name,
    level === CERVICAL_COUNT ? 'vertebra_t1' : `vertebra_c${level + 1}`,
    'cervical',
  );
}

// --- Thoracic cage: 25 ----------------------------------------------------------------------
// Twelve rib pairs, each parented to its thoracic vertebra. Ribs 1-7 are true ribs reaching the
// sternum through their own costal cartilage; 8-10 are false ribs joining the cartilage above;
// 11 and 12 are floating.

for (let index = 1; index <= 12; index++) {
  for (const suffix of ['l', 'r'] as const) {
    const side = suffix === 'l' ? 'left' : 'right';
    bone(
      `rib_${index}_${suffix}`,
      'Costa',
      `${side === 'left' ? 'Left' : 'Right'} rib ${index}`,
      `vertebra_t${index}`,
      'thorax',
      { side },
    );
  }
}

bone('sternum', 'Sternum', 'Sternum', 'rib_1_l', 'thorax', { parentNote: BILATERAL_CONVENTION });

// --- Skull: 22 ------------------------------------------------------------------------------
// The occipital bone is the cranial base and carries the atlanto-occipital joint, so it is the
// skull's attachment to the column. The rest hang off it in a shallow tree that approximates the
// real sutures without pretending a tree can capture them.

bone('occipital', 'Os occipitale', 'Occipital bone', 'vertebra_c1', 'skull');
pair('parietal', 'Os parietale', 'parietal bone', 'occipital', 'skull');
pair('temporal', 'Os temporale', 'temporal bone', 'occipital', 'skull');
bone('sphenoid', 'Os sphenoidale', 'Sphenoid bone', 'occipital', 'skull');
bone('frontal', 'Os frontale', 'Frontal bone', 'sphenoid', 'skull');
bone('ethmoid', 'Os ethmoidale', 'Ethmoid bone', 'sphenoid', 'skull');
bone('vomer', 'Vomer', 'Vomer', 'ethmoid', 'skull');
pair('nasal', 'Os nasale', 'nasal bone', 'frontal', 'skull');
pair('lacrimal', 'Os lacrimale', 'lacrimal bone', 'frontal', 'skull');
pair('maxilla', 'Maxilla', 'maxilla', 'frontal', 'skull');
pair('zygomatic', 'Os zygomaticum', 'zygomatic bone', (s) => `maxilla_${s}`, 'skull');
pair('palatine', 'Os palatinum', 'palatine bone', (s) => `maxilla_${s}`, 'skull');
pair(
  'concha_nasalis_inferior',
  'Concha nasalis inferior',
  'inferior nasal concha',
  'ethmoid',
  'skull',
);
bone('mandible', 'Mandibula', 'Mandible', 'temporal_l', 'skull', {
  parentNote: `${BILATERAL_CONVENTION} The temporomandibular joints are bilateral.`,
});

// --- Auditory ossicles: 6 -------------------------------------------------------------------
// The smallest bones in the body, in the middle ear. No mechanical role in a ragdoll, included
// because the anatomical layer is complete by definition.

pair('malleus', 'Malleus', 'malleus', (s) => `temporal_${s}`, 'skull');
pair('incus', 'Incus', 'incus', (s) => `malleus_${s}`, 'skull');
pair('stapes', 'Stapes', 'stapes', (s) => `incus_${s}`, 'skull');

// --- Hyoid: 1 ------------------------------------------------------------------------------

bone('hyoid', 'Os hyoideum', 'Hyoid bone', 'mandible', 'skull', {
  parentNote:
    'The hyoid has no bony articulation at all -- it is suspended by muscles and ligaments from ' +
    'the styloid processes and the mandible. Parented to the mandible so the tree is connected.',
});

// =============================================================================================
// Appendicular skeleton -- 126 bones
// =============================================================================================

// --- Pectoral girdle and upper limb: 64 ------------------------------------------------------
// The clavicle is the only bony connection between the upper limb and the axial skeleton, through
// the sternoclavicular joint. Parenting reflects that: sternum -> clavicle -> scapula -> humerus.

pair('clavicle', 'Clavicula', 'clavicle', 'sternum', 'shoulder_girdle');
pair('scapula', 'Scapula', 'scapula', (s) => `clavicle_${s}`, 'shoulder_girdle');
pair('humerus', 'Humerus', 'humerus', (s) => `scapula_${s}`, 'arm');
pair('ulna', 'Ulna', 'ulna', (s) => `humerus_${s}`, 'forearm');
// The radius is parented to the ulna rather than the humerus: pronation and supination are a
// rotation of the radius about the ulna, which the tree should reflect.
pair('radius', 'Radius', 'radius', (s) => `ulna_${s}`, 'forearm');

/** Proximal row lateral to medial, then distal row. Parented to the radius or ulna as they sit. */
const CARPALS: ReadonlyArray<readonly [string, string, string, 'radius' | 'ulna' | string]> = [
  ['scaphoid', 'Os scaphoideum', 'scaphoid', 'radius'],
  ['lunate', 'Os lunatum', 'lunate', 'radius'],
  ['triquetrum', 'Os triquetrum', 'triquetrum', 'ulna'],
  ['pisiform', 'Os pisiforme', 'pisiform', 'triquetrum'],
  ['trapezium', 'Os trapezium', 'trapezium', 'scaphoid'],
  ['trapezoid', 'Os trapezoideum', 'trapezoid', 'scaphoid'],
  ['capitate', 'Os capitatum', 'capitate', 'scaphoid'],
  ['hamate', 'Os hamatum', 'hamate', 'triquetrum'],
];

for (const [id, ta, name, parentBase] of CARPALS) {
  pair(id, ta, name, (s) => `${parentBase}_${s}`, 'hand');
}

/** Which carpal each metacarpal articulates with, index 1..5 thumb to little finger. */
const METACARPAL_PARENTS = ['trapezium', 'trapezoid', 'capitate', 'hamate', 'hamate'] as const;
const ROMAN = ['I', 'II', 'III', 'IV', 'V'] as const;
const DIGIT_NAMES = [
  'thumb',
  'index finger',
  'middle finger',
  'ring finger',
  'little finger',
] as const;

for (let digit = 1; digit <= 5; digit++) {
  const parentCarpal = METACARPAL_PARENTS[digit - 1] ?? 'capitate';
  pair(
    `metacarpal_${digit}`,
    `Os metacarpi ${ROMAN[digit - 1]}`,
    `metacarpal ${ROMAN[digit - 1]} (${DIGIT_NAMES[digit - 1]})`,
    (s) => `${parentCarpal}_${s}`,
    'hand',
  );
}

// The thumb has two phalanges; digits 2-5 have three. 2 + 4*3 = 14 per hand.
for (let digit = 1; digit <= 5; digit++) {
  const segments: ReadonlyArray<readonly [string, string, string]> =
    digit === 1
      ? [
          ['proximal', 'Phalanx proximalis', 'proximal phalanx'],
          ['distal', 'Phalanx distalis', 'distal phalanx'],
        ]
      : [
          ['proximal', 'Phalanx proximalis', 'proximal phalanx'],
          ['middle', 'Phalanx media', 'middle phalanx'],
          ['distal', 'Phalanx distalis', 'distal phalanx'],
        ];

  let parentBase = `metacarpal_${digit}`;
  for (const [segment, ta, name] of segments) {
    const id = `phalanx_${segment}_${digit}`;
    const capturedParent = parentBase;
    pair(
      id,
      ta,
      `${name} ${ROMAN[digit - 1]} (${DIGIT_NAMES[digit - 1]})`,
      (s) => `${capturedParent}_${s}`,
      'hand',
    );
    parentBase = id;
  }
}

// --- Pelvic girdle and lower limb: 62 --------------------------------------------------------

pair('hip', 'Os coxae', 'hip bone', 'sacrum', 'pelvis');
pair('femur', 'Os femoris', 'femur', (s) => `hip_${s}`, 'thigh');
pair('patella', 'Patella', 'patella', (s) => `femur_${s}`, 'thigh');
pair('tibia', 'Tibia', 'tibia', (s) => `femur_${s}`, 'leg');
// The fibula is parented to the tibia, not the femur: it takes almost no load from the knee and
// articulates with the tibia at both ends.
pair('fibula', 'Fibula', 'fibula', (s) => `tibia_${s}`, 'leg');

const TARSALS: ReadonlyArray<readonly [string, string, string, string]> = [
  ['talus', 'Talus', 'talus', 'tibia'],
  ['calcaneus', 'Calcaneus', 'calcaneus', 'talus'],
  ['navicular', 'Os naviculare', 'navicular', 'talus'],
  ['cuboid', 'Os cuboideum', 'cuboid', 'calcaneus'],
  ['cuneiform_medial', 'Os cuneiforme mediale', 'medial cuneiform', 'navicular'],
  ['cuneiform_intermediate', 'Os cuneiforme intermedium', 'intermediate cuneiform', 'navicular'],
  ['cuneiform_lateral', 'Os cuneiforme laterale', 'lateral cuneiform', 'navicular'],
];

for (const [id, ta, name, parentBase] of TARSALS) {
  pair(id, ta, name, (s) => `${parentBase}_${s}`, 'foot');
}

/** Which tarsal each metatarsal articulates with, index 1..5 hallux to little toe. */
const METATARSAL_PARENTS = [
  'cuneiform_medial',
  'cuneiform_intermediate',
  'cuneiform_lateral',
  'cuboid',
  'cuboid',
] as const;
const TOE_NAMES = ['hallux', 'second toe', 'third toe', 'fourth toe', 'fifth toe'] as const;

for (let digit = 1; digit <= 5; digit++) {
  const parentTarsal = METATARSAL_PARENTS[digit - 1] ?? 'cuboid';
  pair(
    `metatarsal_${digit}`,
    `Os metatarsi ${ROMAN[digit - 1]}`,
    `metatarsal ${ROMAN[digit - 1]} (${TOE_NAMES[digit - 1]})`,
    (s) => `${parentTarsal}_${s}`,
    'foot',
  );
}

// The hallux has two phalanges; toes 2-5 have three. 2 + 4*3 = 14 per foot.
for (let digit = 1; digit <= 5; digit++) {
  const segments: ReadonlyArray<readonly [string, string, string]> =
    digit === 1
      ? [
          ['proximal', 'Phalanx proximalis', 'proximal phalanx'],
          ['distal', 'Phalanx distalis', 'distal phalanx'],
        ]
      : [
          ['proximal', 'Phalanx proximalis', 'proximal phalanx'],
          ['middle', 'Phalanx media', 'middle phalanx'],
          ['distal', 'Phalanx distalis', 'distal phalanx'],
        ];

  let parentBase = `metatarsal_${digit}`;
  for (const [segment, ta, name] of segments) {
    const id = `phalanx_pedis_${segment}_${digit}`;
    const capturedParent = parentBase;
    pair(
      id,
      ta,
      `${name} ${ROMAN[digit - 1]} (${TOE_NAMES[digit - 1]})`,
      (s) => `${capturedParent}_${s}`,
      'foot',
    );
    parentBase = id;
  }
}

/**
 * The complete taxonomy, frozen.
 *
 * Order is construction order -- axial first, rooted at the sacrum -- which is stable and
 * therefore safe to depend on. Do not sort it: a change in ordering would change every
 * index-based buffer layout downstream.
 */
export const BONES: readonly BoneTaxonomyEntry[] = Object.freeze(entries);

/** The standard adult bone count. See the module comment for what this convention includes. */
export const EXPECTED_BONE_COUNT = 206;

const byId = new Map(BONES.map((b) => [b.id, b]));

export function getBone(id: string): BoneTaxonomyEntry | undefined {
  return byId.get(id);
}

export function boneIds(): readonly string[] {
  return BONES.map((b) => b.id);
}

/** The single root of the anatomical tree. */
export const ROOT_BONE_ID = 'sacrum';

export function childrenOf(id: string): BoneTaxonomyEntry[] {
  return BONES.filter((b) => b.parent === id);
}

/** Walk from a bone to the root, inclusive of both ends. */
export function ancestorsOf(id: string): BoneTaxonomyEntry[] {
  const chain: BoneTaxonomyEntry[] = [];
  let current = byId.get(id);
  while (current) {
    chain.push(current);
    current = current.parent === null ? undefined : byId.get(current.parent);
  }
  return chain;
}

export function bonesInRegion(region: BoneRegion): BoneTaxonomyEntry[] {
  return BONES.filter((b) => b.region === region);
}
