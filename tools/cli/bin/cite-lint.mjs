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

/**
 * A file carrying a table-level provenance declaration cites its whole table at once.
 *
 * Parameter tables transcribed from a single publication -- de Leva's 99 values, ANSUR II's
 * reference statistics -- have one citation covering every entry. Repeating `source:
 * cite('deleva1996')` on all 22 segment records would be noise that nobody reads, and noise in a
 * citation is worse than none: it trains the reader to skip them.
 *
 * So a `TableProvenance` object satisfies the proximity check for its file. Its own key is still
 * validated against the bibliography, and it must additionally declare a verification status, so
 * the exemption cannot be claimed by writing the word "source" somewhere.
 */
function tableProvenanceKey(text) {
  const match = text.match(/source:\s*'([^']+)',[\s\S]{0,600}?locator:[\s\S]{0,600}?status:/);
  return match?.[1];
}

const files = SCAN_ROOTS.flatMap((r) => collectSourceFiles(join(ROOT, r)));
const problems = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const display = relative(ROOT, file);
  const lines = text.split('\n');
  const tableKey = tableProvenanceKey(text);

  if (tableKey !== undefined && !bibliographyKeys.has(tableKey)) {
    const line = text.slice(0, text.indexOf(tableKey)).split('\n').length;
    problems.push({
      file: display,
      line,
      message:
        `table provenance names unknown citation key '${tableKey}'. Add an entry to ` +
        'docs/sources/bibliography.md, or fix the spelling.',
    });
  }

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

  // Check 1b -- a citation written as a bare string literal must also resolve.
  //
  // Without this, `source: 'whatever I like'` satisfies the proximity check below while naming
  // nothing, which is worse than an uncited value: it looks sourced.
  for (const match of text.matchAll(/\b(?:romSource|source|citation):\s*'([^']+)'/g)) {
    const key = match[1];
    if (!key || bibliographyKeys.has(key)) continue;
    const line = text.slice(0, match.index ?? 0).split('\n').length;
    problems.push({
      file: display,
      line,
      message:
        `citation '${key}' does not resolve to a bibliography entry. Add one to ` +
        'docs/sources/bibliography.md, or fix the spelling.',
    });
  }

  // Check 2 -- a parameter field needs a citation in the same object literal, unless the file
  // carries a table-level provenance declaration covering all of them.
  //
  // The signal we want is a *hardcoded number*, so the test is that the field's value contains a
  // numeric literal. That distinguishes the two things which look alike on a line:
  //
  //   range: [-2.0, 0],                                   <- data. needs a citation.
  //   range: z.tuple([z.number(), z.number()]),           <- a schema declaration. does not.
  //   range: readonly [number, number];                   <- a type annotation. does not.
  //
  // Checking for a numeric literal cannot be satisfied by renaming a variable, which is what
  // keeps the rule from being trivially worked around.
  if (tableKey !== undefined) continue;

  lines.forEach((lineText, index) => {
    const fieldMatch = lineText.match(/^\s*(?:readonly\s+)?([A-Za-z][A-Za-z0-9]*)\??\s*:(.*)$/);
    const field = fieldMatch?.[1];
    const value = fieldMatch?.[2] ?? '';
    if (!field || !PARAMETER_FIELDS.has(field)) return;

    // Zod builder chains declare shape, not values.
    if (/^\s*z\./.test(value)) return;
    // No number on the line means nothing to cite here.
    if (!/-?\d/.test(value)) return;
    // A trailing `;` with no `,` reads as a type member rather than an object property.
    if (/;\s*$/.test(value) && !/,\s*$/.test(value)) return;

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
