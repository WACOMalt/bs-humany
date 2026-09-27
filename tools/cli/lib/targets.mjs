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
 * Measurements that print their tables and write nothing, so there is nothing to check or
 * regenerate: the evidence behind a page that quotes them, tracked so it can be re-run. They are
 * named `measure:` because that is what they do, and left out here because running them would
 * compare nothing -- and the reflex sweep alone takes half an hour of simulation.
 */
const PRINT_ONLY = ['measure:dataset-gap', 'measure:reflex-gains'];

/**
 * Checks that live in a workspace package rather than the root package.json, as the pnpm
 * arguments that run them. `pnpm check:generated` runs them; `pnpm regenerate` does not rewrite
 * them, though its closing check pass holds them like everything else.
 *
 * - The anatomical data's pack-only stages (`derive` in tools/ingest, checked by its `check`
 *   script). They sit upstream of every generator -- the landmarks, centres and wrap radii are
 *   what the skeleton and the muscle data are built from -- so they are checked first. They are
 *   not regenerated with the rest because re-measuring the anatomy is a step of its own, taken
 *   after a new pack and in the order packages/assets-anatomical/README.md gives, never as a side
 *   effect of refreshing a report.
 */
const CHECK_ONLY = [{ label: 'ingest check', args: ['--filter', '@bs-humany/ingest', 'check'] }];

/**
 * Everything `pnpm check:generated` runs, in order: the check-only targets above, then every
 * target of `orderedTargets` with `--check`.
 *
 * @param {Record<string, string>} scripts the root package.json `scripts` block
 * @returns {{ label: string, args: string[] }[]} what to print, and the arguments for `pnpm`
 */
export function checkTargets(scripts) {
  return [
    ...CHECK_ONLY,
    ...orderedTargets(scripts).map((name) => ({ label: name, args: [name, '--check'] })),
  ];
}

/**
 * The scripts to run, in dependency order.
 *
 * @param {Record<string, string>} scripts the root package.json `scripts` block
 * @returns {string[]} script names, for `pnpm <name>`
 */
export function orderedTargets(scripts) {
  const names = Object.keys(scripts).filter((name) => !PRINT_ONLY.includes(name));
  for (const name of [...FIRST, ...PRINT_ONLY]) {
    if (!(name in scripts)) {
      throw new Error(
        `tools/cli/lib/targets.mjs names '${name}', which the root package.json has no script ` +
          'for. If it was renamed, update the list there so it is still ordered or left out.',
      );
    }
  }
  const ordered = [];
  for (const stage of STAGES) {
    const inStage = names.filter((name) => name.startsWith(stage));
    const first = FIRST.filter((name) => inStage.includes(name));
    const rest = inStage.filter((name) => !first.includes(name)).sort();
    ordered.push(...first, ...rest);
  }
  return ordered;
}
