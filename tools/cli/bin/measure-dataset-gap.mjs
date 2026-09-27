#!/usr/bin/env node
/**
 * How far apart the two skeletons are, region by region.
 *
 *   pnpm measure:dataset-gap        # print the region table; writes nothing
 *
 * Bones, attachments and wrapping are measured on Z-Anatomy meshes. The musculotendon parameters
 * come from MyoSuite, measured on MyoSkeleton -- a different body at a fixed anthropometry. The
 * honest measure of the gap is how far each muscle has to travel on each: the same muscle, swept
 * the same way, on two skeletons. Here that is the travel `MUSCLE_LENGTH_RANGES` records on
 * `l3_anatomical`, against the travel `SOURCE_MUSCLE_TRAVEL` records on the source's own models
 * (`pnpm measure:source-travel`), as a ratio: above one, the muscle travels further here.
 *
 * This is the table in `docs/plans/dataset-correspondence.md`, which plans the work that closes
 * the gap. It was first produced by a local probe outside the repository, so the plan cited a file
 * nobody else had; the measurement is here now, and `tools/train/probes/datasetgap.mjs` prints the
 * same rows unit by unit. Both read the committed tables and compile the body, and neither writes
 * anything, so running them leaves the working tree as it was.
 *
 * A region is compared only where the source has a travel for its units. The torso's regions have
 * none: the vendored torso model's muscles do not share our names and do not map one to one, so
 * until a correspondence mapping exists they are counted and not compared.
 */

import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * The table's rows: each a label and the muscle-data sets it covers. The grouping is the plan's --
 * the three regions that agree share a row, and so do the five nothing is compared against -- with
 * the hand on a row of its own, because its muscles arrived after the plan's table was written.
 */
export const REGIONS = [
  { label: 'ankle & foot', sets: ['ANKLE_MUSCLES'] },
  { label: 'forearm', sets: ['FOREARM_MUSCLES'] },
  { label: 'elbow', sets: ['ELBOW_MUSCLES'] },
  { label: 'hip, knee, shoulder', sets: ['HIP_MUSCLES', 'KNEE_MUSCLES', 'SHOULDER_MUSCLES'] },
  { label: 'hand', sets: ['HAND_MUSCLES'] },
  {
    label: 'thorax, neck, girdle, trunk, torso',
    sets: ['THORAX_MUSCLES', 'NECK_MUSCLES', 'GIRDLE_MUSCLES', 'TRUNK_MUSCLES', 'TORSO_MUSCLES'],
  },
];

/** The middle value of a list, the mean of the two middle ones for an even count. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const mid = (sorted.length - 1) / 2;
  return ((sorted[Math.floor(mid)] ?? 0) + (sorted[Math.ceil(mid)] ?? 0)) / 2;
}

/**
 * Every unit of the whole body, with its travel on both skeletons where both are known, and the
 * regions above summarised from them.
 *
 * `units` has a row for every compiled unit: `set` names the muscle-data set it came from, and
 * `ratio` is undefined where the source has no travel for it or it does not travel here. Each
 * region has its unit count, how many were compared, and the median ratio of each of its sets.
 */
export async function measureDatasetGap() {
  const jiti = createJiti(import.meta.url);
  const { buildDocument } = await jiti.import(join(ROOT, 'packages/skeleton/src/index.ts'));
  const { compileArticulation } = await jiti.import(join(ROOT, 'packages/compiler/src/index.ts'));
  const { resolveMorphology } = await jiti.import(
    join(ROOT, 'packages/anthropometry/src/index.ts'),
  );
  const muscles = await jiti.import(join(ROOT, 'packages/modules-muscle/src/index.ts'));
  const data = await jiti.import(join(ROOT, 'packages/muscle-data/src/index.ts'));

  // The reference body every committed muscle table is measured on.
  const document = buildDocument();
  const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
  const { articulation } = compileArticulation(document, 'l3_anatomical', morphology);
  const compiled = muscles.compileMuscleSet(
    [...data.ALL_MUSCLES],
    document.attachmentSites,
    articulation,
    morphology.context,
    document.wrappingSurfaces ?? [],
  );

  const setOf = new Map();
  for (const region of REGIONS) {
    for (const set of region.sets) {
      if (!Array.isArray(data[set]))
        throw new Error(`measure-dataset-gap: no ${set} in muscle-data`);
      for (const group of data[set]) for (const unit of group.units) setOf.set(unit.id, set);
    }
  }

  const units = compiled.units.map((unit) => {
    const set = setOf.get(unit.id);
    // Every unit belongs to a row, so a set added to the whole body and not to REGIONS is an error
    // here rather than a region that silently drops out of the table.
    if (set === undefined) {
      throw new Error(`measure-dataset-gap: ${unit.id} is in no region; add its set to REGIONS`);
    }
    const range = data.muscleLengthRange(unit.id);
    const source = data.sourceMuscleTravel(unit.id);
    const ours = range ? (range.longest - range.shortest) * unit.restLength : undefined;
    const compared = source !== undefined && source.travel > 0 && ours !== undefined && ours > 0;
    return {
      unit: unit.id,
      set,
      ours,
      theirs: source?.travel,
      ratio: compared ? ours / source.travel : undefined,
      low: source?.low,
      high: source?.high,
    };
  });

  const regions = REGIONS.map((region) => {
    const members = units.filter((u) => region.sets.includes(u.set));
    const medians = region.sets
      .map((set) =>
        median(members.filter((u) => u.set === set && u.ratio !== undefined).map((u) => u.ratio)),
      )
      .filter((m) => m !== undefined);
    return {
      label: region.label,
      units: members.length,
      compared: members.filter((u) => u.ratio !== undefined).length,
      medians,
    };
  });
  return { units, regions };
}

/** A region's median ratio as the plan writes it: one set's, or the range of its sets'. */
function medianCell(medians) {
  if (medians.length === 0) return '—';
  const low = Math.min(...medians).toFixed(2);
  const high = Math.max(...medians).toFixed(2);
  return low === high ? low : `${low}–${high}`;
}

async function main() {
  const { units, regions } = await measureDatasetGap();
  const compared = units.filter((u) => u.ratio !== undefined).length;
  console.log(
    `Travel here over travel on the source, on l3_anatomical: ${compared} of ${units.length} units compared.\n`,
  );
  console.log('| region | units | compared | median ratio |');
  console.log('|---|---|---|---|');
  for (const r of regions) {
    const count = r.compared === 0 ? `**${r.compared}**` : String(r.compared);
    console.log(`| ${r.label} | ${r.units} | ${count} | ${medianCell(r.medians)} |`);
  }
  console.log('\nA row of several regions gives the range of their medians.');
}

// Run when invoked, not when the probe imports the measurement. Resolved through the real path,
// so a worktree reached through a symbolic link still counts as invoking this file.
const invoked = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href;
if (invoked === import.meta.url) await main();
