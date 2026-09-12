#!/usr/bin/env node
/**
 * Citation coverage lint.
 *
 * CONTRIBUTING rule 3: a number without a source is a bug. This is the mechanism that keeps
 * "research accuracy" from silently eroding into plausible-looking invention as the model grows,
 * which is the failure mode the specification is most worried about.
 *
 * Two checks run:
 *
 *   1. **Unknown key.** Every `cite('key', ...)` in the source must resolve to an entry in
 *      `docs/sources/bibliography.md`. A typo'd key is a citation that looks present and is not.
 *   2. **Uncited parameter.** Fields the schema marks as requiring provenance -- `range`,
 *      `relativeMass`, `comPosition`, and friends -- must appear alongside a citation within the
 *      same object literal.
 *
 * Check 2 is deliberately conservative: it fires only on field names that are known to carry
 * physical parameters, so it cannot be satisfied by renaming a variable. As the data packages land
 * this list grows with them.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIBLIOGRAPHY = join(ROOT, 'docs/sources/bibliography.md');
const SCAN_ROOTS = ['packages', 'apps', 'tools'];

/**
 * Field names that name a physical parameter and therefore require provenance.
 * Keep alphabetical. Add to this list whenever a new parameter kind enters HSDL.
 */
const PARAMETER_FIELDS = new Set([
  'comPosition',
  'maxIsometricForce',
  'optimalFiberLength',
  'passiveDamping',
  'passiveStiffness',
  'pennationAngle',
  'radiusOfGyration',
  'range',
  'relativeMass',
  'tendonSlackLength',
]);

/** Names that count as a citation when found beside a parameter field. */
const CITATION_FIELDS = ['romSource', 'source', 'sources', 'citation', 'cite'];

function collectSourceFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function readBibliographyKeys() {
  let text;
  try {
    text = readFileSync(BIBLIOGRAPHY, 'utf8');
  } catch {
    console.error(`cite-lint: cannot read ${relative(ROOT, BIBLIOGRAPHY)}`);
    process.exit(2);
  }
  const keys = new Set();
  // Entries are headed `### \`key\` — tier`.
  for (const match of text.matchAll(/^###\s+`([a-z][a-z0-9]*\d{4}[a-z]?)`/gm)) {
    if (match[1]) keys.add(match[1]);
  }
  return keys;
}

const bibliographyKeys = readBibliographyKeys();
if (bibliographyKeys.size === 0) {
  console.error('cite-lint: no citation keys found in the bibliography. Is the format intact?');
  process.exit(2);
}

const files = SCAN_ROOTS.flatMap((r) => collectSourceFiles(join(ROOT, r)));
const problems = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const display = relative(ROOT, file);
  const lines = text.split('\n');

  // Check 1 -- every cited key exists.
  for (const match of text.matchAll(/\bcite\(\s*'([^']+)'/g)) {
    const key = match[1];
    if (!key || bibliographyKeys.has(key)) continue;
    const line = text.slice(0, match.index ?? 0).split('\n').length;
    problems.push({
      file: display,
      line,
      message:
        `unknown citation key '${key}'. Add an entry to docs/sources/bibliography.md, or fix the ` +
        'spelling. A key that does not resolve is a citation that looks present and is not.',
    });
  }

  // Check 2 -- a parameter field needs a citation in the same object literal.
  lines.forEach((lineText, index) => {
    const fieldMatch = lineText.match(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:/);
    const field = fieldMatch?.[1];
    if (!field || !PARAMETER_FIELDS.has(field)) return;
    // Ignore type declarations and interface members -- they carry no value to cite.
    if (/^\s*(readonly\s+)?[A-Za-z][A-Za-z0-9]*\??\s*:\s*[A-Z[]/.test(lineText)) return;

    const windowText = lines.slice(Math.max(0, index - 12), index + 13).join('\n');
    const hasCitation =
      CITATION_FIELDS.some((c) => windowText.includes(`${c}:`)) || windowText.includes('cite(');
    if (!hasCitation) {
      problems.push({
        file: display,
        line: index + 1,
        message:
          `parameter field '${field}' has no citation nearby. CONTRIBUTING rule 3: a number ` +
          'without a source is a bug. Add a romSource/source, or record it in ' +
          'docs/sources/open-questions.md and cite that.',
      });
    }
  });
}

if (problems.length > 0) {
  console.error(`cite-lint: ${problems.length} problem(s)\n`);
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}\n    ${p.message}\n`);
  }
  process.exit(1);
}

console.log(
  `cite-lint: ok. ${bibliographyKeys.size} citation keys available, ${files.length} source files scanned.`,
);
