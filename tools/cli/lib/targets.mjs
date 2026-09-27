/**
 * Every script that writes a tracked file from a source, in the order they have to run.
 *
 * `pnpm check:generated` runs this list with `--check`, `pnpm regenerate` runs it without, and CI
 * runs `check:generated`. One list, so the three cannot disagree about what is generated -- the
 * old CI had a step per script, typed out by hand, and the hand generator was simply never among
 * them.
 *
 * The list is read from the root package.json by prefix rather than written out here, so a new
 * `generate:`, `measure:`, `validate:` or `audit:` script is checked the day it is added. The
 * prefix is the contract: a script under one of them MUST accept `--check`, compare what it would
 * write with what is committed, exit non-zero on a difference, and write nothing. check-generated
 * holds every script to the last clause, so one that ignores the flag fails rather than quietly
 * rewriting the file it was meant to check.
 *
 * Only the order is written out, because only the order is knowledge the names do not carry:
 *
 * - `generate:via-points` first. It writes skeleton/src/muscleViaPoints.ts, which the region
 *   generators read (the hand generator imports its path directions).
 * - The other generators next, alphabetically. None reads another's output.
 * - `measure:muscle-ranges`, then `measure:source-travel`. The ranges sweep reads the region data
 *   and writes muscle-data/src/ranges.ts; the source-travel sweep reads those ranges
 *   (`muscleLengthRange`) to set our travel beside the source's in docs/validation/fiber-lengths.md,
 *   so it has to see the new ones. The hand generator reads sourceTravel.ts too, but only to refuse
 *   to run once a hand unit is measured there, so that back edge never changes what is written.
 * - The validation reports (`validate:*`), which read everything above and write docs/validation.
 * - The section 14.5 audit (`audit:*`) last, because it reads those reports.
 */

/** The families of generated output, in the order their stages run. */
const STAGES = ['generate:', 'measure:', 'validate:', 'audit:'];

/**
 * Scripts that must run ahead of the rest of their stage, in this order. Anything else in the
 * stage follows alphabetically.
 */
const FIRST = ['generate:via-points', 'measure:muscle-ranges', 'measure:source-travel'];

/**
 * Generators whose script name predates the prefix convention. `extract:source-sites` writes
 * apps/studio/public/sourceSites.json from the vendored MyoSuite models and takes `--check` like
 * the rest; it is listed by name until it is renamed `generate:source-sites`, at which point the
 * prefix finds it and this entry goes -- orderedTargets refuses a name package.json does not
 * have, so the rename cannot silently drop it from the check.
 */
const EXTRA = { 'extract:source-sites': 'generate:' };

/**
 * The scripts to run, in dependency order.
 *
 * @param {Record<string, string>} scripts the root package.json `scripts` block
 * @returns {string[]} script names, for `pnpm <name>`
 */
export function orderedTargets(scripts) {
  const names = Object.keys(scripts);
  for (const name of [...FIRST, ...Object.keys(EXTRA)]) {
    if (!(name in scripts)) {
      throw new Error(
        `tools/cli/lib/targets.mjs names '${name}', which the root package.json has no script ` +
          'for. If it was renamed, update the list there so it is still checked.',
      );
    }
  }
  const ordered = [];
  for (const stage of STAGES) {
    const inStage = names.filter((name) => name.startsWith(stage) || EXTRA[name] === stage);
    const first = FIRST.filter((name) => inStage.includes(name));
    const rest = inStage.filter((name) => !first.includes(name)).sort();
    ordered.push(...first, ...rest);
  }
  return ordered;
}
