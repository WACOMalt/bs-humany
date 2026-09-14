/**
 * Convex-hull collision proxies from the bone meshes -- milestone M5.8.
 *
 *   COACD_PYTHON=.venv/bin/python pnpm --filter @bs-humany/ingest hulls [dataDir]
 *
 * Every segment of every segmentation profile owns a set of bones; each distinct set is one
 * group. The merged mesh of a group is decomposed into a few convex pieces by CoACD
 * (scripts/decompose.py, Python), each piece reduced to a small vertex budget, and the result
 * written to `hulls.json` in the assets package, in the anchor bone's frame at the dataset
 * stature. The skeleton package turns those into `convexHull` proxies; nothing decomposes
 * anything at runtime (spec section 8.1).
 *
 * The budget per group is three pieces per large bone and one per small one (a phalanx, a
 * carpal), capped at twelve: a long bone is one or two pieces plus its head, a finger is three
 * pieces, a rib cage or a skull is a dozen. CoACD merges pieces back while the concavity stays
 * under its threshold, so many groups come in under budget.
 *
 * Re-derivable from the pack and this tool; when the dataset or a profile changes, re-run. The
 * Python side saves after every group and resumes, so an interrupted run loses nothing.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEGMENTATION_PROFILES } from '../../../packages/skeleton/src/segmentation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.argv[2] ?? join(HERE, '../../../packages/assets-anatomical/data'));
const python = process.env.COACD_PYTHON ?? 'python3';

/** Pieces allowed per large and per small bone in a group, and the cap for a group. */
export const HULLS_PER_BONE = 3;
export const HULLS_PER_SMALL_BONE = 1;
export const MAX_HULLS_PER_GROUP = 12;
/**
 * A bone whose longest extent is under this is small: the phalanges, carpals and the smaller
 * tarsals. Extent, not vertex count: the radius is a long bone with a few hundred vertices.
 */
export const SMALL_BONE_EXTENT = 0.06;

interface PackedBone {
  readonly id: string;
  readonly centroid: readonly [number, number, number];
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

const manifest = JSON.parse(readFileSync(join(dataDir, 'manifest.json'), 'utf8')) as {
  dataset: Record<string, unknown>;
  subjectStature: number;
  bones: PackedBone[];
};
const packed = new Map(manifest.bones.map((b) => [b.id, b]));

/** The key the skeleton package uses to find a group: anchor, then the sorted bone set. */
export function groupKey(anchor: string, bones: readonly string[]): string {
  return `${anchor}|${[...bones].sort().join(',')}`;
}

interface Group {
  readonly anchor: string;
  readonly bones: readonly string[];
  readonly segments: string[];
  readonly maxHulls: number;
}

const groups = new Map<string, Group>();
for (const profile of SEGMENTATION_PROFILES) {
  for (const segment of profile.segments) {
    const bones = segment.bones.filter((id) => packed.has(id));
    if (bones.length === 0 || !packed.has(segment.anchor)) continue;
    const key = groupKey(segment.anchor, bones);
    const existing = groups.get(key);
    const label = `${profile.id}/${segment.id}`;
    if (existing) existing.segments.push(label);
    else {
      const extent = (b: PackedBone) =>
        Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      const budget = bones.reduce((sum, id) => {
        const b = packed.get(id);
        return sum + (b && extent(b) < SMALL_BONE_EXTENT ? HULLS_PER_SMALL_BONE : HULLS_PER_BONE);
      }, 0);
      groups.set(key, {
        anchor: segment.anchor,
        bones,
        segments: [label],
        maxHulls: Math.min(MAX_HULLS_PER_GROUP, budget),
      });
    }
  }
}

// A fixed working directory, so a second run resumes what the first one finished.
const work = join(tmpdir(), 'bs-humany-hulls');
mkdirSync(work, { recursive: true });
const groupsPath = join(work, 'groups.json');
const outPath = join(work, 'hulls.json');
writeFileSync(
  groupsPath,
  JSON.stringify(
    Object.fromEntries([...groups].map(([k, g]) => [k, { bones: g.bones, maxHulls: g.maxHulls }])),
  ),
);
console.error(`${groups.size} bone groups; decomposing with ${python} ...`);
const started = Date.now();
const run = spawnSync(
  python,
  [join(HERE, '../scripts/decompose.py'), dataDir, groupsPath, outPath],
  {
    stdio: 'inherit',
  },
);
if (run.status !== 0) throw new Error(`decompose.py failed with status ${run.status}`);

const result = JSON.parse(readFileSync(outPath, 'utf8')) as {
  coacd: string;
  parameters: Record<string, unknown>;
  groups: Record<string, { hulls: number[][][]; settings: string; maxHulls: number }>;
};

/** Tenth of a millimetre at the dataset stature: below the mesh's own precision. */
const round = (x: number) => Math.round(x * 1e4) / 1e4;

const entries = [...groups]
  .map(([key, g]) => {
    const anchor = packed.get(g.anchor);
    const produced = result.groups[key];
    if (!anchor || !produced) throw new Error(`no decomposition for group ${key}`);
    return {
      key,
      anchor: g.anchor,
      bones: g.bones,
      segments: g.segments.sort(),
      maxHulls: g.maxHulls,
      /** Which settings tier produced the pieces: `standard`, `coarse` or `hull-per-bone`. */
      settings: produced.settings,
      // Flat x y z triples per hull, relative to the anchor bone's centroid.
      hulls: produced.hulls.map((hull) =>
        hull.flatMap((v) => [
          round((v[0] ?? 0) - anchor.centroid[0]),
          round((v[1] ?? 0) - anchor.centroid[1]),
          round((v[2] ?? 0) - anchor.centroid[2]),
        ]),
      ),
    };
  })
  .sort((a, b) => a.key.localeCompare(b.key));

const out = {
  format: 'bs-humany.skeleton-hulls/1',
  // A derivative of the dataset carries its licence and attribution (ADR-009).
  dataset: manifest.dataset,
  generator: 'tools/ingest/src/hulls.ts + scripts/decompose.py (CoACD)',
  coacd: result.coacd,
  parameters: {
    ...result.parameters,
    hullsPerBone: HULLS_PER_BONE,
    hullsPerSmallBone: HULLS_PER_SMALL_BONE,
    smallBoneExtent: SMALL_BONE_EXTENT,
    maxHullsPerGroup: MAX_HULLS_PER_GROUP,
  },
  subjectStature: manifest.subjectStature,
  units: 'm',
  frame: 'anchor bone centroid, world-aligned, dataset stature',
  groups: entries,
};
writeFileSync(join(dataDir, 'hulls.json'), `${JSON.stringify(out)}\n`);
const tiers = new Map<string, number>();
for (const e of entries) tiers.set(e.settings, (tiers.get(e.settings) ?? 0) + 1);
console.error(`settings tiers: ${[...tiers].map(([k, v]) => `${k} ${v}`).join(', ')}`);
const totalHulls = entries.reduce((a, e) => a + e.hulls.length, 0);
const totalVerts = entries.reduce((a, e) => a + e.hulls.reduce((b, h) => b + h.length / 3, 0), 0);
console.error(
  `wrote ${join(dataDir, 'hulls.json')}: ${entries.length} groups, ${totalHulls} hulls, ${totalVerts} vertices, ${((Date.now() - started) / 1000).toFixed(0)} s`,
);
