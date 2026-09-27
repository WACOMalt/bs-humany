#!/usr/bin/env node
/**
 * Emit the JSON Schema for an HSDL document.
 *
 *   pnpm generate:hsdl-schema          # rewrite docs/spec/schema/hsdl-<version>.schema.json
 *   pnpm generate:hsdl-schema --check  # fail if the file is not what this would write
 *
 * The Zod schema is the single source of truth: TypeScript types are inferred from it and this
 * file is generated from it. Never edit the output by hand -- a hand-maintained schema beside a
 * TypeScript type is two sources of truth that agree until the day they quietly do not.
 *
 * Generating it was never enough on its own. Nothing ran the generator when the Zod schemas
 * changed, so the committed file fell behind them -- it went on describing a collision hull
 * without its scale, and a document the reference body builds failed against it -- while every
 * test passed, because the tests generate a fresh schema rather than reading the published one.
 * `--check` is what `pnpm check:generated`, and CI through it, runs to catch that.
 *
 * The output goes through Biome before it is written or compared, because the committed file is
 * held to `pnpm lint` like any other and Biome lays JSON out differently from JSON.stringify
 * (short arrays on one line). Formatting in the generator means a write is lint-clean as it
 * stands, and the check can compare bytes: the same bytes a fresh write would produce.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '../../..');
const check = process.argv.includes('--check');
const jiti = createJiti(import.meta.url);
const { generateJsonSchema, HSDL_VERSION } = await jiti.import(join(here, '../src/index.ts'));

const output = join(ROOT, 'docs/spec/schema', `hsdl-${HSDL_VERSION}.schema.json`);
const name = relative(ROOT, output);

const formatted = spawnSync(
  join(ROOT, 'node_modules/.bin/biome'),
  ['format', `--stdin-file-path=${name}`],
  { cwd: ROOT, input: `${JSON.stringify(generateJsonSchema(), null, 2)}\n`, encoding: 'utf8' },
);
if (formatted.status !== 0) {
  console.error(`generate-schema: biome could not format the schema:\n${formatted.stderr}`);
  process.exit(1);
}
const rendered = formatted.stdout;

if (check) {
  const committed = existsSync(output) ? readFileSync(output, 'utf8') : null;
  if (committed !== rendered) {
    console.error(
      `generate-schema: ${name} is ${committed === null ? 'missing' : 'stale'}. ` +
        'Run `pnpm generate:hsdl-schema`.',
    );
    process.exit(1);
  }
  console.log(`generate-schema: ok. ${name} matches the Zod schemas.`);
} else {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, rendered);
  console.log(`generate-schema: wrote ${name}`);
}
