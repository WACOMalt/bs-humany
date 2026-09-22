#!/usr/bin/env node
/**
 * Runs every generator in `--check` mode, the way CI does.
 *
 *   pnpm check:generated
 *
 * A generated file and its generator can drift apart in one direction without anything local
 * noticing: hand-edit the output and the tests still pass, because the tests read the output. The
 * next person to run the generator silently loses the edit. CI has a step per generator and
 * catches it; this runs the same set in one command so it is caught before the push rather than
 * after it.
 *
 * The list is every `generate:*` script in the root package.json, so a generator added later is
 * checked without touching this file.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const scripts = JSON.parse(readFileSync(new URL('package.json', `file://${root}`), 'utf8')).scripts;
const targets = Object.keys(scripts).filter((name) => name.startsWith('generate:'));

let failed = 0;
for (const target of targets) {
  const run = spawnSync('pnpm', [target, '--check'], { cwd: root, encoding: 'utf8' });
  const ok = run.status === 0;
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${target}\n`);
  if (!ok) process.stdout.write(`${(run.stdout || '') + (run.stderr || '')}\n`);
}

process.stdout.write(
  `\n${targets.length - failed} of ${targets.length} generated files match their generator.\n`,
);
process.exit(failed === 0 ? 0 : 1);
