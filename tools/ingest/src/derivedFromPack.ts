/**
 * Derived landmarks, measured from the packed meshes.
 *
 *   pnpm --filter @bs-humany/ingest derived-from-pack [dataDir] [--check]
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
 *
 * With `--check` it measures everything in memory and compares the three files with what is
 * committed, writing nothing, as `pnpm --filter @bs-humany/ingest check` and so
 * `pnpm check:generated` run it. It is the first of the re-measuring stages; the order is in
 * packages/assets-anatomical/README.md.
 */

import { DERIVED_RULES, RIB_RULES, ribArc } from './derived.js';
import { DataDir, emit, loadPack, stageArgs } from './packData.js';

const { dataDir, check } = stageArgs();
const data = new DataDir(dataDir);
const { meshOf, landmarks } = loadPack(data);
const derived = data.json<Record<string, Record<string, string>>>('landmarks-derived.json');

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
const written = new Set<string>();
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
  // A derived point is a pure function of its rule and the pack, so this writes it -- including
  // over the value the ingest measured from the FBX, which the drift above has already compared
  // it against and which agrees to a hundredth of a millimetre. Keeping the old value instead
  // was the earlier behaviour and it meant an edited rule silently did nothing: the run reported
  // the improvement as drift and then threw it away. A marker the export carries is never
  // touched, because it was never ours to write.
  table[rule.feature] = point;
  landmarks[rule.bone] = table;
  const rules = derived[rule.bone] ?? {};
  rules[rule.feature] = rule.rule;
  derived[rule.bone] = rules;
  written.add(`${rule.bone}/${rule.feature}`);
}

// A rule that has been removed or renamed leaves its points behind, and a stale point is worse
// than a missing one: it still resolves, so nothing fails, and a muscle goes on attaching to a
// measurement no rule makes any more. Only points this file wrote are dropped -- a marker the
// export carries is never touched, because it was never ours to drop.
let pruned = 0;
for (const [bone, rules] of Object.entries(derived)) {
  for (const feature of Object.keys(rules)) {
    if (written.has(`${bone}/${feature}`)) continue;
    delete rules[feature];
    delete landmarks[bone]?.[feature];
    pruned += 1;
  }
  if (Object.keys(rules).length === 0) delete derived[bone];
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
emit('derived-from-pack', dataDir, check, [
  ['landmarks.json', `${JSON.stringify(sortedKeys(landmarks), null, 1)}\n`],
  ['landmarks-derived.json', `${JSON.stringify(sortedKeys(derived), null, 1)}\n`],
  ['rib-arcs.json', `${JSON.stringify({ ribs: arcs }, null, 1)}\n`],
]);

console.log(
  `derived from the pack: ${added} new landmarks, ${checked} re-measured, ${pruned} stale dropped ` +
    `(worst ${(worst * 1000).toFixed(2)} mm at ${worstAt || 'none'}), ` +
    `${Object.keys(arcs).length} rib arcs`,
);
