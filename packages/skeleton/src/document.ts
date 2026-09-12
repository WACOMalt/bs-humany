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

import {
  type BoneDef,
  HSDL_VERSION,
  type HsdlDocument,
  assertValidDocument,
  cite,
  provisional,
} from '@bs-humany/hsdl';
import { BONE_SHAPES, FALLBACK_BONES, fallbackShape } from './geometry/shapes.js';
import { SEGMENTATION_PROFILES } from './segmentation.js';
import { BONES } from './taxonomy.js';

/** Build the bone definitions by joining taxonomy entries with their shapes. */
export function buildBones(): BoneDef[] {
  return BONES.map((entry): BoneDef => {
    const shape = BONE_SHAPES.get(entry.id) ?? fallbackShape(entry.region);
    return {
      id: entry.id,
      ta: entry.ta,
      displayName: entry.displayName,
      parent: entry.parent,
      region: entry.region,
      ...(entry.side ? { side: entry.side } : {}),
      restTransform: shape.restTransform,
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
export function buildDocument(): HsdlDocument {
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
      ],
    },
    units: { length: 'm', mass: 'kg', angle: 'rad', time: 's', force: 'N' },

    bones: buildBones(),
    landmarks: [],
    joints: [],
    segmentation: [...SEGMENTATION_PROFILES],
    collisionProxies: [],
    contactRules: {
      classes: {
        bone_on_ground: { friction: 0.85, restitution: 0.02 },
        bone_on_bone: { friction: 0.3, restitution: 0.0 },
      },
      defaultClass: 'bone_on_ground',
    },
    constraints: [],

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

    attachmentSites: [],
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
    'Joint definitions are not yet present. This document carries anatomy and geometry only, so ' +
      'the skeleton is posable but not yet simulable.',
    'Landmarks and bone local frames are not yet defined, so joint centres are implied by the ' +
      'rest transforms rather than derived from landmarks.',
    'Limb proportions are sex-neutral: the underlying table is not sex-separated. See OQ-003.',
    'Parameter tables are consistency-checked but not yet verified line by line against their ' +
      'source publications. See OQ-001 and OQ-002.',
  ];
  if (unmodelled.length > 0) {
    limitations.push(
      `${unmodelled.length} bone(s) use a generic fallback shape rather than a modelled one: ` +
        `${unmodelled.join(', ')}. At their real size a simple form meets the Phase 1 quality bar.`,
    );
  }
  return limitations;
}

export { FALLBACK_BONES };
