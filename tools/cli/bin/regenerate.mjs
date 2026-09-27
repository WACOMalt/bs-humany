#!/usr/bin/env node
/**
 * Rewrites every generated file and report from its source, in dependency order, then checks
 * the result the way CI will.
 *
 *   pnpm regenerate
 *
 * The order matters and is not obvious from the names: the via points feed the region generators,
 * the region data feeds the range sweep, the ranges feed the source-travel report, and every one
 * of them feeds the validation reports and the audit. Running them by hand in the wrong order
 * leaves a report written against data that then changed under it. The order lives in
 * tools/cli/lib/targets.mjs, the same list `pnpm check:generated` runs.
 *
 * It stops at the first script that fails, because everything after it would read that script's
 * stale or half-written output. Then it runs the check pass, because writing is not the same as
 * agreeing: the validation writers record what they find and exit 0 even when what they found is
 * an unrecorded discrepancy, and only the `--check` pass fails on that.
 *
 * Golden trajectories are deliberately not part of this. They are not generated from a source;
 * they record what the simulation did, and a change to them is a claim that the new behaviour is
 * right, made on purpose with the reason in the commit. So UPDATE_GOLDENS is removed from the
 * environment every script here sees, in case the shell that ran this had it set.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { orderedTargets } from '../lib/targets.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const scripts = JSON.parse(readFileSync(new URL('package.json', `file://${root}`), 'utf8')).scripts;
const targets = orderedTargets(scripts);

// Left out rather than blanked: a child reads an empty string as set, and so would any script
// that tests `'UPDATE_GOLDENS' in process.env`.
const { UPDATE_GOLDENS: _never, ...env } = process.env;

for (const [index, target] of targets.entries()) {
  process.stdout.write(`\n[${index + 1}/${targets.length}] pnpm ${target}\n`);
  const run = spawnSync('pnpm', [target], { cwd: root, env, stdio: 'inherit' });
  if (run.status !== 0) {
    process.stdout.write(
      `\nregenerate: pnpm ${target} failed (exit ${run.status ?? run.signal}). Stopped there, ` +
        'because the targets after it read what it writes.\n',
    );
    process.exit(1);
  }
}

process.stdout.write('\nregenerate: every target written. Checking them as CI will.\n\n');
const check = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('check-generated.mjs', import.meta.url))],
  { cwd: root, env, stdio: 'inherit' },
);
process.exit(check.status ?? 1);
