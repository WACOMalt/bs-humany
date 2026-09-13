/**
 * Landmark definitions -- milestone M1.2.
 *
 * Every named marker in the Z-Anatomy pack becomes an HSDL `LandmarkDef`, positioned in its
 * bone's local frame and scaled with stature. Where the ISB recommendations name the same feature,
 * the landmark carries the ISB definition as its citation and the dataset as the place it was
 * *located* -- the distinction ADR-011 asks for: the standard says what a landmark is, the mesh
 * says where this subject has it.
 *
 * The bone-local frame at this milestone is world-aligned at the bone's centroid, matching how
 * the document places measured bones. ISB-conformant frames replace it in M1.3, built from these
 * very landmarks; the positions here do not change when that happens, only the frame they are
 * expressed in.
 */

import derivedJson from '@bs-humany/assets-anatomical/data/landmarks-derived.json' with {
  type: 'json',
};
import landmarksJson from '@bs-humany/assets-anatomical/data/landmarks.json' with { type: 'json' };
import {
  type Citation,
  type LandmarkDef,
  cite,
  moduleNamespace,
  mul,
  param,
  writeExtension,
} from '@bs-humany/hsdl';
import { DATASET_MANIFEST } from './dataset.js';
import { getBone } from './taxonomy.js';

type LandmarkTable = Record<string, Record<string, [number, number, number]>>;
const RAW: LandmarkTable = landmarksJson as unknown as LandmarkTable;
const DERIVED: Record<string, Record<string, string>> = derivedJson as Record<
  string,
  Record<string, string>
>;

/** Namespace for dataset provenance carried on each landmark. */
export const PROVENANCE_NS = moduleNamespace('provenance');

export interface LandmarkProvenance {
  readonly dataset: string;
  readonly datasetVersion: string;
  readonly sourceSha256: string;
  /** Marker node name in the export, or the derivation rule for a computed landmark. */
  readonly locatedBy: string;
}

/**
 * ISB landmark names and the feature in the pack that realises each.
 *
 * Abbreviations follow Wu et al. 2002 (pelvis, hip, knee, ankle) and Wu et al. 2005 (thorax,
 * clavicle, scapula, humerus, forearm, hand). The right side is listed; the left mirrors it.
 * `frame` names which ISB coordinate system the landmark belongs to; `verified` is false until the
 * definition text has been checked against the paper (OQ-005).
 */
export interface IsbLandmark {
  readonly abbreviation: string;
  readonly description: string;
  readonly bone: string;
  readonly feature: string;
  readonly source: Citation;
  readonly palpable: boolean;
}

const wu2002 = (locator: string) => cite('wu2002', locator);
const wu2005 = (locator: string) => cite('wu2005', locator);

function sided(list: ReadonlyArray<Omit<IsbLandmark, 'bone'> & { bone: string }>): IsbLandmark[] {
  return list.flatMap((l) => {
    if (!l.bone.endsWith('_r')) return [l];
    const left = { ...l, bone: `${l.bone.slice(0, -2)}_l` };
    return [l, left];
  });
}

export const ISB_LANDMARKS: readonly IsbLandmark[] = sided([
  // Pelvis (Wu 2002, section 2.1)
  {
    abbreviation: 'ASIS',
    description: 'Anterior superior iliac spine',
    bone: 'hip_r',
    feature: 'Anterior_superior_iliac_spine',
    source: wu2002('2.1, pelvic bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'PSIS',
    description: 'Posterior superior iliac spine',
    bone: 'hip_r',
    feature: 'Posterior_superior_iliac_spine',
    source: wu2002('2.1, pelvic bony landmarks'),
    palpable: true,
  },
  // Femur (Wu 2002, section 2.2)
  {
    abbreviation: 'HJC',
    description: 'Hip joint centre (centre of the femoral head)',
    bone: 'femur_r',
    feature: 'Head_of_femur',
    source: wu2002('2.2, femoral coordinate system'),
    palpable: false,
  },
  {
    abbreviation: 'FE_med',
    description: 'Medial femoral epicondyle',
    bone: 'femur_r',
    feature: 'Medial_epicondyle_of_femur',
    source: wu2002('2.2, femoral bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'FE_lat',
    description: 'Lateral femoral epicondyle',
    bone: 'femur_r',
    feature: 'Lateral_epicondyle_of_femur',
    source: wu2002('2.2, femoral bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'GT',
    description: 'Greater trochanter',
    bone: 'femur_r',
    feature: 'Greater_trochanter',
    source: wu2002('2.2, femoral bony landmarks'),
    palpable: true,
  },
  // Tibia and fibula (Wu 2002, section 2.3)
  {
    abbreviation: 'MM',
    description: 'Medial malleolus',
    bone: 'tibia_r',
    feature: 'Medial_malleolus',
    source: wu2002('2.3, tibia/fibula bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'LM',
    description: 'Lateral malleolus',
    bone: 'fibula_r',
    feature: 'Lateral_malleolus',
    source: wu2002('2.3, tibia/fibula bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'MC',
    description: 'Medial tibial condyle',
    bone: 'tibia_r',
    feature: 'Medial_condyle_of_tibia',
    source: wu2002('2.3, tibia/fibula bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'LC',
    description: 'Lateral tibial condyle',
    bone: 'tibia_r',
    feature: 'Lateral_condyle_of_tibia',
    source: wu2002('2.3, tibia/fibula bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'TT',
    description: 'Tibial tuberosity',
    bone: 'tibia_r',
    feature: 'Tibial_tuberosity',
    source: wu2002('2.3, tibia/fibula bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'HF',
    description: 'Head of fibula',
    bone: 'fibula_r',
    feature: 'Head_of_fibula',
    source: wu2002('2.3, tibia/fibula bony landmarks'),
    palpable: true,
  },
  // Foot (Wu 2002, section 2.4)
  {
    abbreviation: 'CA',
    description: 'Posterior calcaneus',
    bone: 'calcaneus_r',
    feature: 'Posterior_calcaneal_tuberosity_point',
    source: wu2002('2.4, foot bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'MT1',
    description: 'Head of the first metatarsal',
    bone: 'metatarsal_1_r',
    feature: 'Head_of_metatarsal_bone',
    source: wu2002('2.4, foot bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'MT5',
    description: 'Head of the fifth metatarsal',
    bone: 'metatarsal_5_r',
    feature: 'Head_of_metatarsal_bone',
    source: wu2002('2.4, foot bony landmarks'),
    palpable: true,
  },
  // Thorax (Wu 2005, section 2.1)
  {
    abbreviation: 'IJ',
    description: 'Deepest point of incisura jugularis (suprasternal notch)',
    bone: 'sternum',
    feature: 'Jugular_notch',
    source: wu2005('2.1, thorax bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'PX',
    description: 'Processus xiphoideus, most caudal point on the sternum',
    bone: 'sternum',
    feature: 'Xiphoid_tip',
    source: wu2005('2.1, thorax bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'C7',
    description: 'Processus spinosus of the 7th cervical vertebra',
    bone: 'vertebra_c7',
    feature: 'Spinous_process_tip',
    source: wu2005('2.1, thorax bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'T8',
    description: 'Processus spinosus of the 8th thoracic vertebra',
    bone: 'vertebra_t8',
    feature: 'Spinous_process_tip',
    source: wu2005('2.1, thorax bony landmarks'),
    palpable: true,
  },
  // Clavicle (Wu 2005, section 2.2)
  {
    abbreviation: 'SC',
    description: 'Most ventral point on the sternoclavicular joint',
    bone: 'clavicle_r',
    feature: 'Sternal_end',
    source: wu2005('2.2, clavicle bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'AC',
    description: 'Most dorsal point on the acromioclavicular joint',
    bone: 'clavicle_r',
    feature: 'Acromial_end',
    source: wu2005('2.2, clavicle bony landmarks'),
    palpable: true,
  },
  // Scapula (Wu 2005, section 2.3)
  {
    abbreviation: 'AA',
    description: 'Angulus acromialis, most laterodorsal point of the scapula',
    bone: 'scapula_r',
    feature: 'Acromial_angle',
    source: wu2005('2.3, scapula bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'AI',
    description: 'Angulus inferior, most caudal point of the scapula',
    bone: 'scapula_r',
    feature: 'Inferior_angle_of_scapula',
    source: wu2005('2.3, scapula bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'PC',
    description: 'Most ventral point of processus coracoideus',
    bone: 'scapula_r',
    feature: 'Coracoid_process',
    source: wu2005('2.3, scapula bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'TS',
    description: 'Trigonum spinae scapulae, root of the spine of the scapula',
    bone: 'scapula_r',
    feature: 'Spine_of_scapula',
    source: wu2005('2.3, scapula bony landmarks'),
    palpable: true,
  },
  // Humerus (Wu 2005, section 2.4)
  {
    abbreviation: 'GH',
    description: 'Glenohumeral rotation centre (centre of the humeral head)',
    bone: 'humerus_r',
    feature: 'Head_of_humerus',
    source: wu2005('2.4, humerus coordinate system'),
    palpable: false,
  },
  {
    abbreviation: 'EL',
    description: 'Most caudal point on the lateral epicondyle',
    bone: 'humerus_r',
    feature: 'Lateral_epicondyle_of_humerus',
    source: wu2005('2.4, humerus bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'EM',
    description: 'Most caudal point on the medial epicondyle',
    bone: 'humerus_r',
    feature: 'Medial_epicondyle_of_humerus',
    source: wu2005('2.4, humerus bony landmarks'),
    palpable: true,
  },
  // Forearm (Wu 2005, section 2.5)
  {
    abbreviation: 'RS',
    description: 'Most caudal-lateral point on the radial styloid',
    bone: 'radius_r',
    feature: 'Radial_styloid_process',
    source: wu2005('2.5, forearm bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'US',
    description: 'Most caudal-medial point on the ulnar styloid',
    bone: 'ulna_r',
    feature: 'Ulnar_styloid_process',
    source: wu2005('2.5, forearm bony landmarks'),
    palpable: true,
  },
  {
    abbreviation: 'OL',
    description: 'Olecranon',
    bone: 'ulna_r',
    feature: 'Olecranon',
    source: wu2005('2.5, forearm bony landmarks'),
    palpable: true,
  },
  // Hand (Wu 2005, section 2.6)
  {
    abbreviation: 'MC3',
    description: 'Head of the third metacarpal',
    bone: 'metacarpal_3_r',
    feature: 'Head_of_metacarpal_bone',
    source: wu2005('2.6, hand bony landmarks'),
    palpable: true,
  },
]);

const isbByKey = new Map(ISB_LANDMARKS.map((l) => [`${l.bone}/${l.feature}`, l]));

/** The landmark id convention: `<bone>__<feature>` in snake_case. */
export function landmarkId(bone: string, feature: string): string {
  const feature_ = feature
    .replace(/[()]/g, '')
    .replace(/-/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '')
    .toLowerCase();
  return `${bone}__${feature_}`;
}

/**
 * Build every landmark in the pack as an HSDL definition.
 *
 * Position is the marker's world position minus the bone's centroid, as a fraction of the dataset
 * subject's stature, times the `stature` parameter -- the same rule that places the bone itself,
 * so landmark and bone scale together.
 */
export function buildLandmarks(): LandmarkDef[] {
  const centroids = new Map(DATASET_MANIFEST.bones.map((b) => [b.id, b.centroid]));
  const out: LandmarkDef[] = [];
  const seen = new Set<string>();

  for (const [bone, features] of Object.entries(RAW)) {
    const centroid = centroids.get(bone);
    const taxonomy = getBone(bone);
    if (!centroid || !taxonomy) continue;

    for (const [feature, world] of Object.entries(features)) {
      const id = landmarkId(bone, feature);
      if (seen.has(id)) continue;
      seen.add(id);

      const isb = isbByKey.get(`${bone}/${feature}`);
      const derivedRule = DERIVED[bone]?.[feature];
      const local = (i: 0 | 1 | 2) => (world[i] - centroid[i]) / DATASET_MANIFEST.subjectStature;

      const provenance: LandmarkProvenance = {
        dataset: DATASET_MANIFEST.dataset.name,
        datasetVersion: DATASET_MANIFEST.dataset.version,
        sourceSha256: DATASET_MANIFEST.dataset.sourceSha256,
        locatedBy: derivedRule ? `rule: ${derivedRule}` : `marker: ${feature}`,
      };

      out.push({
        id,
        bone,
        displayName: isb
          ? `${isb.description} (${isb.abbreviation})`
          : feature.replace(/[()]/g, '').replace(/_/g, ' '),
        position: {
          x: mul(local(0), param('stature')),
          y: mul(local(1), param('stature')),
          z: mul(local(2), param('stature')),
        },
        source: isb ? isb.source : cite('kervyn2021', `marker ${feature} on ${bone}`),
        ...(isb ? { palpable: isb.palpable } : {}),
        ext: writeExtension(undefined, PROVENANCE_NS, provenance),
      });
    }
  }
  return out;
}

/** World position of a raw dataset marker at the dataset stature, or throw naming the gap. */
export function markerWorld(bone: string, feature: string): readonly [number, number, number] {
  const p = RAW[bone]?.[feature];
  if (!p) throw new Error(`The dataset has no marker '${feature}' on '${bone}'.`);
  return p;
}

/** Look up an ISB landmark's world position at the dataset stature, or throw naming the gap. */
export function isbLandmarkWorld(
  bone: string,
  abbreviation: string,
): readonly [number, number, number] {
  const entry = ISB_LANDMARKS.find((l) => l.bone === bone && l.abbreviation === abbreviation);
  if (!entry) throw new Error(`No ISB landmark '${abbreviation}' is defined on '${bone}'.`);
  const p = RAW[bone]?.[entry.feature];
  if (!p) {
    throw new Error(
      `ISB landmark '${abbreviation}' on '${bone}' expects feature '${entry.feature}', which the ` +
        'pack does not carry. Re-run ingestion or check the mapping in tools/ingest.',
    );
  }
  return p;
}
