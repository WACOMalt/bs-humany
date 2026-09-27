#!/usr/bin/env node
/**
 * How far apart the two skeletons are, muscle by muscle.
 *
 *   node tools/train/probes/datasetgap.mjs
 *
 * Bones, attachments and wrapping are measured on Z-Anatomy meshes. The musculotendon parameters
 * come from MyoSuite, measured on MyoSkeleton -- a different body at a fixed anthropometry. The
 * honest measure of the gap is how far each muscle has to travel on each: the same muscle, swept
 * the same way, on two skeletons. This prints that ratio for the units furthest out either way,
 * its spread over every unit compared, and the units the source itself works outside a sensible
 * stretch of its own force-length curve.
 *
 * `docs/plans/dataset-correspondence.md` cites this measurement. The probe it came from lived in
 * the git-ignored `tools/train/runs` with a path into one checkout written into it; this is that
 * probe, tracked. The measuring is `measureDatasetGap` in `tools/cli/bin/measure-dataset-gap.mjs`
 * -- `pnpm measure:dataset-gap` prints the plan's region table from it -- so the two cannot come
 * to measure different things. It writes nothing, and runs from any checkout: every path is found
 * from where this file is.
 */

import { measureDatasetGap } from '../../cli/bin/measure-dataset-gap.mjs';

const { units } = await measureDatasetGap();
const rows = units.filter((u) => u.ratio !== undefined).sort((a, b) => b.ratio - a.ratio);

const line = (r) =>
  `  ${r.ratio.toFixed(2).padStart(5)}  ${(1000 * r.ours).toFixed(0).padStart(5)}mm ${(1000 * r.theirs).toFixed(0).padStart(6)}mm   ${r.unit}`;

console.log(`${rows.length} units measured on both skeletons (of ${units.length} total)\n`);
console.log('  ratio    ours   theirs   unit');
for (const r of rows.slice(0, 14)) console.log(line(r));
console.log('  ...');
for (const r of rows.slice(-8)) console.log(line(r));

// Quartiles as the first probe took them: the value at that fraction of the way up the sorted
// list, rounded down to a whole index.
const ratios = rows.map((r) => r.ratio).sort((a, b) => a - b);
const q = (p) => ratios[Math.floor(p * (ratios.length - 1))];
console.log(
  `\n  median ${q(0.5).toFixed(2)}   quartiles ${q(0.25).toFixed(2)} to ${q(0.75).toFixed(2)}   full range ${ratios[0].toFixed(2)} to ${ratios.at(-1).toFixed(2)}`,
);
console.log(
  `  within 20% of the source: ${rows.filter((r) => Math.abs(r.ratio - 1) <= 0.2).length} of ${rows.length}`,
);
console.log(
  `  more than 2x out:         ${rows.filter((r) => r.ratio > 2 || r.ratio < 0.5).length}`,
);

// The source's own internal consistency: where it works its fibres on its own curve. A band past
// half to one and a half of optimal fibre length is not a working range for any fibre, so a unit
// here is evidence that the source's parameters and its geometry disagree with each other.
const outside = rows.filter((r) => r.low < 0.5 || r.high > 1.5);
console.log(
  `\n  units the SOURCE itself runs outside 0.5-1.5 of optimal fibre length: ${outside.length}`,
);
for (const r of outside.slice(0, 6)) {
  console.log(`    ${r.unit.padEnd(34)} ${r.low.toFixed(2)} to ${r.high.toFixed(2)}`);
}
