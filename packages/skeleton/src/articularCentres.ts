/**
 * Fitted centres of the ball-and-socket articular surfaces, bundled as JSON.
 *
 * Measured offline by `tools/ingest/src/centres.ts` from the packed bone meshes. They exist
 * because a marker mesh in the export marks a *feature*, not the centre of a ball: the femoral
 * head marker is anchored a centimetre clear of the bone, and using it as the hip centre pivots
 * the femur about the top of its head rather than the middle of it. Both ISB recommendations
 * define these joint centres as the centre of the articular sphere, which is a thing the mesh
 * can be measured for; this table is that measurement, with its residual and inlier count.
 */

import centresJson from '@bs-humany/assets-anatomical/data/articular-centres.json' with {
  type: 'json',
};

export interface ArticularCentre {
  readonly bone: string;
  /** Feature name this centre is published under, alongside the pack's own markers. */
  readonly feature: string;
  readonly description: string;
  /** World metres at the dataset stature. */
  readonly centre: readonly [number, number, number];
  /** Radius of the fitted sphere, metres. */
  readonly radius: number;
  readonly inliers: number;
  /** Mean absolute distance of an inlier from the sphere, metres. */
  readonly residual: number;
  readonly rule: string;
}

/**
 * A joint centre measured where two bones meet.
 *
 * Used for a joint that is a contact between surfaces rather than a ball in a socket. The
 * acromioclavicular marker sits 16 mm clear of the scapula it pivots; the measured contact sits
 * where the clavicle and the acromion actually touch, which is what the scapula hangs from.
 */
export interface ContactCentre {
  /** The two bones, in the order the measurement names them; the feature is published on the first. */
  readonly bones: readonly [string, string];
  readonly feature: string;
  readonly description: string;
  readonly centre: readonly [number, number, number];
  /** Distance between the two surfaces at their closest, metres. */
  readonly gap: number;
  readonly pairs: number;
  readonly rule: string;
}

export interface ArticularCentreTable {
  readonly format: 'bs-humany.articular-centres/1';
  readonly dataset: Record<string, unknown>;
  readonly generator: string;
  readonly subjectStature: number;
  readonly units: 'm';
  readonly frame: string;
  readonly centres: readonly ArticularCentre[];
  readonly contacts: readonly ContactCentre[];
}

export const ARTICULAR_CENTRE_TABLE: ArticularCentreTable =
  centresJson as unknown as ArticularCentreTable;

export const ARTICULAR_CENTRES: readonly ArticularCentre[] = ARTICULAR_CENTRE_TABLE.centres;
export const CONTACT_CENTRES: readonly ContactCentre[] = ARTICULAR_CENTRE_TABLE.contacts;

/** The fitted centre for a bone's articular surface, or undefined. */
export function articularCentre(bone: string, feature: string): ArticularCentre | undefined {
  return ARTICULAR_CENTRES.find((c) => c.bone === bone && c.feature === feature);
}
