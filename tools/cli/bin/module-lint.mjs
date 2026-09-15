#!/usr/bin/env node
/**
 * Module lint -- M2.8.
 *
 * Static checks for the rules the runtime cannot enforce cheaply:
 *
 *   1. **Banned globals in simulation code.** `Math.random`, `Date.now` and `performance.now`
 *      break the determinism contract (spec 10.7, CONTRIBUTING rule 7). They are banned in every
 *      simulation package outright, test files excepted.
 *   2. **Allocation in `step`.** GC pauses in the simulation loop are unacceptable and very hard
 *      to diagnose (CONTRIBUTING rule 9). Inside any function named `step`, this flags the
 *      expressions that allocate: `new`, array and object literals, spread, template literals,
 *      and the allocating array methods. It is a heuristic on source text and will occasionally
 *      flag something harmless; the escape hatch is a `// allocation-ok: <reason>` comment on the
 *      line, which makes the exception visible in review.
 *
 * Undeclared channel access is enforced at runtime by the kernel and its audit mode, not here.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Packages whose code runs on the simulation thread. */
const SIMULATION_PACKAGES = [
  'packages/kernel',
  'packages/modules-mechanics',
  'packages/modules-sensing',
  'packages/backend-rapier',
  'packages/backend-mujoco',
  'packages/compiler',
];

const BANNED = [
  { pattern: /\bMath\.random\s*\(/, why: 'use the seeded stream from ModuleInitContext.random' },
  { pattern: /\bDate\.now\s*\(/, why: 'simulation time is tick * dt, never wall-clock' },
  { pattern: /\bperformance\.now\s*\(/, why: 'simulation time is tick * dt, never wall-clock' },
];

const ALLOCATING = [
  { pattern: /\bnew\s+[A-Z]/, what: '`new`' },
  { pattern: /(^|[=(,:?]|return)\s*\[/, what: 'array literal' },
  { pattern: /(^|[=(,:?]|return)\s*\{/, what: 'object literal' },
  { pattern: /\.\.\./, what: 'spread' },
  {
    pattern: /\.(map|filter|slice|concat|flatMap|from|split|join)\s*\(/,
    what: 'allocating method',
  },
  { pattern: /`[^`]*\$\{/, what: 'template literal' },
];

function collect(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (e.endsWith('.ts') && !e.endsWith('.test.ts') && !e.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Yield [lineIndex, lineText] for lines inside functions named `step`, by brace matching. */
function* stepBodies(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!/(^|\s)step\s*\([^)]*\)\s*(:\s*[^{]+)?\{\s*$/.test(lines[i])) continue;
    let depth = 0;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (j > i) yield [j, lines[j]];
      if (depth === 0) break;
    }
  }
}

const problems = [];
for (const pkg of SIMULATION_PACKAGES) {
  for (const file of collect(join(ROOT, pkg))) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const display = relative(ROOT, file);

    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const b of BANNED) {
        if (b.pattern.test(line)) {
          problems.push(`${display}:${i + 1}  banned global (${b.why}):\n      ${line.trim()}`);
        }
      }
    });

    for (const [i, line] of stepBodies(lines)) {
      if (/^\s*(\/\/|\*)/.test(line) || /allocation-ok:/.test(line)) continue;
      const code = line.replace(/\/\/.*$/, '');
      for (const a of ALLOCATING) {
        if (a.pattern.test(code)) {
          problems.push(
            `${display}:${i + 1}  ${a.what} inside step() (CONTRIBUTING rule 9; annotate '// allocation-ok: <reason>' if intended):\n      ${line.trim()}`,
          );
          break;
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`module-lint: ${problems.length} problem(s)\n\n  ${problems.join('\n\n  ')}\n`);
  process.exit(1);
}
console.log('module-lint: ok.');
