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

export interface ArticularCentreTable {
  readonly format: 'bs-humany.articular-centres/1';
  readonly dataset: Record<string, unknown>;
  readonly generator: string;
  readonly subjectStature: number;
  readonly units: 'm';
  readonly frame: string;
  readonly centres: readonly ArticularCentre[];
}

export const ARTICULAR_CENTRE_TABLE: ArticularCentreTable =
  centresJson as unknown as ArticularCentreTable;

export const ARTICULAR_CENTRES: readonly ArticularCentre[] = ARTICULAR_CENTRE_TABLE.centres;

/** The fitted centre for a bone's articular surface, or undefined. */
export function articularCentre(bone: string, feature: string): ArticularCentre | undefined {
  return ARTICULAR_CENTRES.find((c) => c.bone === bone && c.feature === feature);
}
