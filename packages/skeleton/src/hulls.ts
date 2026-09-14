/**
 * Precomputed convex decompositions of the segments' bones, bundled as JSON.
 *
 * Produced offline by `tools/ingest` (CoACD over the packed meshes) and read here so the
 * document can carry `convexHull` proxies without touching a mesh at runtime (spec section 8.1,
 * ADR-006). Like the manifest, the table is a CC BY-SA derivative of the dataset and lives in
 * the assets package; this module only types it.
 */

import type { SkeletonManifest } from '@bs-humany/assets-anatomical';
import hullsJson from '@bs-humany/assets-anatomical/data/hulls.json' with { type: 'json' };

export interface HullGroup {
  /** `anchor|sorted,bone,ids`; see `hullGroupKey`. */
  readonly key: string;
  readonly anchor: string;
  readonly bones: readonly string[];
  /** `profile/segment` labels of every segment that owns exactly this bone set. */
  readonly segments: readonly string[];
  readonly maxHulls: number;
  /** The settings tier that produced the pieces: `standard`, `coarse` or `hull-per-bone`. */
  readonly settings: string;
  /** One flat `x y z ...` list per hull, metres relative to the anchor centroid at dataset stature. */
  readonly hulls: readonly (readonly number[])[];
}

export interface HullTable {
  readonly format: 'bs-humany.skeleton-hulls/1';
  /** Licence and attribution of the meshes the hulls derive from, copied from the manifest. */
  readonly dataset: SkeletonManifest['dataset'];
  readonly generator: string;
  readonly coacd: string;
  readonly parameters: {
    /** Settings tiers tried in order; a group overrunning the time limit moves to the next. */
    readonly settings: readonly { readonly name: string; readonly threshold?: number }[];
    readonly timeLimitSeconds: number;
    readonly maxVertices: number;
    readonly seed: number;
    readonly preprocessMode: string;
    readonly hullsPerBone: number;
    readonly hullsPerSmallBone: number;
    readonly smallBoneExtent: number;
    readonly maxHullsPerGroup: number;
  };
  readonly subjectStature: number;
  readonly units: 'm';
  readonly frame: string;
  readonly groups: readonly HullGroup[];
}

export const HULL_TABLE: HullTable = hullsJson as unknown as HullTable;

/** The key a segment's bone set is filed under. Must match `tools/ingest/src/hulls.ts`. */
export function hullGroupKey(anchor: string, bones: readonly string[]): string {
  return `${anchor}|${[...bones].sort().join(',')}`;
}

export const HULL_GROUPS: ReadonlyMap<string, HullGroup> = new Map(
  HULL_TABLE.groups.map((g) => [g.key, g]),
);
