#!/usr/bin/env node
/**
 * Checks that every generated file and report still matches its source. CI runs this script, as
 * one step, so running it locally is running what CI runs.
 *
 *   pnpm check:generated
 *
 * A generated file and its generator can drift apart in one direction without anything local
 * noticing: hand-edit the output and the tests still pass, because the tests read the output. The
 * next person to run the generator silently loses the edit. This runs every generator,
 * measurement, validation report and the section 14.5 audit with `--check`, in dependency order,
 * and fails if any of them would write something different from what is committed.
 *
 * The list comes from tools/cli/lib/targets.mjs, which reads it off the root package.json by
 * prefix (`generate:`, `measure:`, `validate:`, `audit:`), so a script added under one of those is
 * checked without touching this file. `pnpm regenerate` runs the same list in write mode.
 *
 * A check must not write. A script that took `--check` for a request to rewrite its file would
 * pass here and leave the tree changed, and in CI -- where nothing looks at the tree afterwards --
 * the check would be a formality. So the working tree is fingerprinted around every target, and
 * one that changes it fails and is named, even when it exits 0. The fingerprint is `git status`
 * plus `git diff`, which sees a clean file being written and an already-modified one being
 * rewritten; do not edit files while this runs, or the edit is blamed on whichever script ran.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { orderedTargets } from '../lib/targets.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const scripts = JSON.parse(readFileSync(new URL('package.json', `file://${root}`), 'utf8')).scripts;
const targets = orderedTargets(scripts);

/** A hash of everything git can see changed in the working tree, tracked or not. */
function treeFingerprint() {
  const hash = createHash('sha256');
  for (const args of [
    ['status', '--porcelain=v1', '--untracked-files=all'],
    ['diff', '--no-ext-diff', '--binary'],
  ]) {
    const run = spawnSync('git', args, { cwd: root, maxBuffer: 1 << 30 });
    if (run.status !== 0) {
      throw new Error(`check-generated: git ${args[0]} failed: ${run.stderr}`);
    }
    hash.update(run.stdout);
  }
  return hash.digest('hex');
}

let failed = 0;
for (const target of targets) {
  const before = treeFingerprint();
  const run = spawnSync('pnpm', [target, '--check'], { cwd: root, encoding: 'utf8' });
  const wrote = treeFingerprint() !== before;
  const ok = run.status === 0 && !wrote;
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${target}\n`);
  if (!ok) process.stdout.write(`${(run.stdout || '') + (run.stderr || '')}\n`);
  if (wrote) {
    process.stdout.write(
      `  ${target} changed the working tree under --check. A check must compare and write ` +
        'nothing; see tools/cli/lib/targets.mjs. `git status` shows what it wrote.\n\n',
    );
  }
}

process.stdout.write(
  `\n${targets.length - failed} of ${targets.length} generated files and reports match their ` +
    'sources.\n',
);
process.exit(failed === 0 ? 0 : 1);
