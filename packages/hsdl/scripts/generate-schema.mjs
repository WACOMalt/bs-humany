#!/usr/bin/env node
/**
 * Emit the JSON Schema for an HSDL document.
 *
 * The Zod schema is the single source of truth: TypeScript types are inferred from it and this
 * file is generated from it. Never edit the output by hand -- a hand-maintained schema beside a
 * TypeScript type is two sources of truth that agree until the day they quietly do not.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const here = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const { generateJsonSchema, HSDL_VERSION } = await jiti.import(join(here, '../src/index.ts'));

const output = join(here, '../../../docs/spec/schema', `hsdl-${HSDL_VERSION}.schema.json`);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(generateJsonSchema(), null, 2)}\n`);
console.log(`Wrote ${output}`);
