/**
 * Derived landmarks, measured from the packed meshes.
 *
 *   pnpm --filter @bs-humany/ingest derived-from-pack [dataDir]
 *
 * `ingest.ts` derives its landmarks while it has the FBX open. The rules in `derived.ts` need only
 * a bone's vertices, and the pack holds every bone's vertices at the dataset's stature in the same
 * frame the landmarks are in, so the rules can be run again here without the 500 MB source --
 * which is what lets a new rule be added and measured in a minute. ADR-011 permits measuring
 * from the dataset; CONTRIBUTING rule 5 asks that the derivation be recorded so it can be re-run,
 * and every point written here carries its rule in `landmarks-derived.json` as the ingest's do.
 *
 * Every rule is applied, including the ones the ingest already ran: a point the ingest measured
 * from the FBX should come out the same from the pack, and the difference is reported, so this
 * is also a check that the pack is the geometry the landmarks were taken from.
 *
 * The rib rules also measure each rib's length along its arc, which `rib-arcs.json` records for
 * the intercostals' cross-sections (Bruno 2015 sizes them by rib length).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DERIVED_RULES, RIB_RULES, ribArc } from './derived.js';
import type { WorldMesh } from './geometry.js';
import type { Manifest } from './pack.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.argv[2] ?? join(HERE, '../../../packages/assets-anatomical/data'));

const manifest = JSON.parse(readFileSync(join(dataDir, 'manifest.json'), 'utf8')) as Manifest;
const bin = readFileSync(join(dataDir, 'skeleton.bin'));
const positions = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
const landmarks = JSON.parse(readFileSync(join(dataDir, 'landmarks.json'), 'utf8')) as Record<
  string,
  Record<string, [number, number, number]>
>;
const derived = JSON.parse(readFileSync(join(dataDir, 'landmarks-derived.json'), 'utf8')) as Record<
  string,
  Record<string, string>
>;

function meshOf(bone: string): WorldMesh | undefined {
  const packed = manifest.bones.find((b) => b.id === bone);
  if (!packed) return undefined;
  const from = packed.vertexOffset * 3;
  return {
    positions: positions.subarray(from, from + packed.vertexCount * 3),
    indices: new Uint32Array(0),
    vertexCount: packed.vertexCount,
    triangleCount: packed.indexCount / 3,
    centroid: [...packed.centroid] as [number, number, number],
    min: [...packed.min] as [number, number, number],
    max: [...packed.max] as [number, number, number],
  };
}

const context = {
  meshOf,
  landmark: (bone: string, feature: string) => landmarks[bone]?.[feature],
};

const round = (p: [number, number, number]): [number, number, number] =>
  [p[0], p[1], p[2]].map((x) => Math.round(x * 1e6) / 1e6) as [number, number, number];

let added = 0;
let checked = 0;
let worst = 0;
let worstAt = '';
for (const rule of [...DERIVED_RULES, ...RIB_RULES]) {
  const mesh = meshOf(rule.bone);
  if (!mesh) continue;
  const point = round(rule.pick(mesh, context));
  const table = landmarks[rule.bone] ?? {};
  const before = table[rule.feature];
  if (before && derived[rule.bone]?.[rule.feature]) {
    checked += 1;
    const d = Math.hypot(before[0] - point[0], before[1] - point[1], before[2] - point[2]);
    if (d > worst) {
      worst = d;
      worstAt = `${rule.bone}/${rule.feature}`;
    }
  } else if (!before) {
    added += 1;
  }
  // A point the ingest measured from the FBX keeps the ingest's digits.
  if (!before) table[rule.feature] = point;
  landmarks[rule.bone] = table;
  const rules = derived[rule.bone] ?? {};
  rules[rule.feature] = rule.rule;
  derived[rule.bone] = rules;
}

// Every rib's length along its arc, for the intercostals.
const arcs: Record<string, { arcLength: number; rule: string }> = {};
for (let n = 1; n <= 12; n++) {
  for (const s of ['r', 'l'] as const) {
    const bone = `rib_${n}_${s}`;
    const mesh = meshOf(bone);
    if (!mesh) continue;
    const arc = ribArc(mesh, meshOf(`vertebra_t${n}`), s);
    arcs[bone] = { arcLength: Math.round(arc.length * 1e5) / 1e5, rule: arc.rule };
  }
}

const sortedKeys = <T>(o: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.keys(o).map((k) => [k, o[k] as T]));
writeFileSync(
  join(dataDir, 'landmarks.json'),
  `${JSON.stringify(sortedKeys(landmarks), null, 1)}\n`,
);
writeFileSync(
  join(dataDir, 'landmarks-derived.json'),
  `${JSON.stringify(sortedKeys(derived), null, 1)}\n`,
);
writeFileSync(join(dataDir, 'rib-arcs.json'), `${JSON.stringify({ ribs: arcs }, null, 1)}\n`);

console.log(
  `derived from the pack: ${added} new landmarks, ${checked} re-measured ` +
    `(worst ${(worst * 1000).toFixed(2)} mm at ${worstAt || 'none'}), ` +
    `${Object.keys(arcs).length} rib arcs`,
);
