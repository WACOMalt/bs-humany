#!/usr/bin/env node
/**
 * Module lint -- M2.8.
 *
 * Static checks for the rules the runtime cannot enforce cheaply:
 *
 *   1. **Banned globals in simulation code.** `Math.random`, `Date.now` and `performance.now`
 *      break the determinism contract (spec 10.7, CONTRIBUTING rule 7). They are banned in every
 *      simulation package outright, test files excepted.
 *   2. **Allocation on the step path.** GC pauses in the simulation loop are unacceptable and
 *      very hard to diagnose (CONTRIBUTING rule 9). On the step path this flags the expressions
 *      that allocate: `new`, array and object literals, spread, template literals, closures, and
 *      the allocating array methods. It is a heuristic on source text and will occasionally flag
 *      something harmless; the escape hatch is a `// allocation-ok: <reason>` comment, on the line
 *      itself or on a comment line of its own just above the statement it excuses, which makes the
 *      exception visible in review. It belongs on error paths, which end a run rather than
 *      repeating every tick, and on the rare path that cannot help allocating (a backend
 *      rebuilding its views of a heap that has grown) -- never on the ordinary tick.
 *
 *      The step path is, in each file:
 *
 *        - the body of every function or method named `step`;
 *        - the body of every function or method whose JSDoc carries `@stepPath`, which is how a
 *          library function that a module's step calls every tick (`solveEquilibrium`,
 *          `sweepMuscle`, `DelayLine.read`) is put on it from its own file;
 *        - and, transitively, the body of every method of the same file that one of those calls as
 *          `this.<name>(`, and of every function declared in the same file that one of them calls
 *          by its bare name.
 *
 *      What it does not follow is a call into another file. The callee is only on the path if its
 *      own file tags it, so a new library function called from a step needs a `@stepPath` tag in
 *      its JSDoc to be held to the rule by this check rather than by review.
 *
 * `--paths` prints every definition the allocation check reads and how it was reached, for
 * finding out whether a helper is covered before relying on it.
 *
 * Undeclared channel access is enforced at runtime by the kernel and its audit mode, not here.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Packages whose code runs on the simulation thread.
 *
 * Every `modules-*` and `backend-*` package is found by name rather than listed, because a hand-kept
 * list is how the nerves came to run every tick for months without being scanned: nobody adds a
 * package to a list whose purpose they have not read. The rest are named here -- the libraries the
 * modules call into every tick, and the scenarios, whose scripts run once per tick in every host
 * and so share the determinism contract. A backend that still exists is scanned whether or not it
 * is enabled: it is compiled and tested, and it would be enabled again as it stands.
 */
const PACKAGES = join(ROOT, 'packages');
const SIMULATION_PACKAGES = [
  'packages/kernel',
  'packages/compiler',
  'packages/muscle-model',
  'packages/muscle-path',
  'packages/muscle-volume',
  'packages/scenarios',
  ...readdirSync(PACKAGES)
    .filter(
      (name) => /^(modules|backend)-/.test(name) && statSync(join(PACKAGES, name)).isDirectory(),
    )
    .sort()
    .map((name) => `packages/${name}`),
];

const BANNED = [
  { pattern: /\bMath\.random\s*\(/, why: 'use the seeded stream from ModuleInitContext.random' },
  { pattern: /\bDate\.now\s*\(/, why: 'simulation time is tick * dt, never wall-clock' },
  { pattern: /\bperformance\.now\s*\(/, why: 'simulation time is tick * dt, never wall-clock' },
];

const ALLOCATING = [
  { pattern: /\bnew\s+[A-Z]/, what: '`new`' },
  // `of [` too: `for (const step of [-1, 1])` makes that array on every pass through the loop.
  { pattern: /(^|[=(,:?&|]|return|\bof)\s*\[/, what: 'array literal' },
  { pattern: /(^|[=(,:?]|return)\s*\{/, what: 'object literal' },
  { pattern: /\.\.\./, what: 'spread' },
  {
    pattern: /\.(map|filter|slice|concat|flatMap|from|split|join)\s*\(/,
    what: 'allocating method',
  },
  { pattern: /`[^`]*\$\{/, what: 'template literal' },
  // A closure is an object, made each time the expression that defines it runs: a `forEach`
  // callback, or a helper declared inside the loop body that calls it.
  { pattern: /=>|\bfunction\s*\*?\s*\(/, what: 'closure' },
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

const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;
const FUNCTION_DECLARATION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/;
const METHOD_START =
  /^\s*(?:(?:public|private|protected|static|readonly|async|override|get|set)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
/** Words that open a line followed by `(` without being a method's name. */
const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'throw',
  'typeof',
  'await',
  'new',
  'super',
  'function',
  'do',
  'else',
  'yield',
  'void',
  'delete',
]);

/**
 * The line a signature starting on line `i` opens its body on, or -1 when what starts there is a
 * call rather than a definition.
 *
 * The parameter list is followed to its closing parenthesis, however many lines it runs over. A
 * definition then has its body's brace at the end of that line or, with a return type that wraps,
 * of one a few lines on; a call statement ends in `;` or carries on into an expression instead.
 */
function bodyOpening(lines, i, from) {
  let depth = 0;
  for (let j = i; j < lines.length && j < i + 40; j++) {
    const line = lines[j];
    for (let c = j === i ? from : 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          const rest = line
            .slice(c + 1)
            .replace(/\/\/.*$/, '')
            .trim();
          if (rest === '{') return j;
          if (!rest.startsWith(':') || rest.includes('=>') || rest.includes('=')) return -1;
          // A return type: the body opens where the type ends, on this line or a later one.
          for (let k = j; k < lines.length && k < j + 6; k++) {
            const code = (k === j ? rest : lines[k]).replace(/\/\/.*$/, '').trimEnd();
            if (code.endsWith('{')) return k;
            if (code.endsWith(';')) return -1;
          }
          return -1;
        }
      }
    }
  }
  return -1;
}

/** Whether the JSDoc block directly above line `i` carries `@stepPath`. */
function taggedStepPath(lines, i) {
  let j = i - 1;
  if (j < 0 || !/\*\/\s*$/.test(lines[j])) return false;
  for (; j >= 0; j--) {
    // As a tag, at the start of a line of the block: prose that mentions the tag is not one.
    if (/^\s*\*\s*@stepPath\b/.test(lines[j])) return true;
    if (/^\s*\/\*\*/.test(lines[j])) return false;
  }
  return false;
}

/**
 * Every function and method defined in a file, with the lines its body spans.
 *
 * By brace matching from the line the body opens on, which counts the braces of an object return
 * type written on that line too: they balance, so the count comes out the same.
 */
function definitions(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE.test(line)) continue;
    let kind;
    let name;
    let match = FUNCTION_DECLARATION.exec(line);
    if (match) {
      kind = 'function';
      name = match[1];
    } else {
      match = METHOD_START.exec(line);
      if (!match || KEYWORDS.has(match[1])) continue;
      kind = 'method';
      name = match[1];
    }
    const open = bodyOpening(lines, i, line.indexOf('(', match.index + match[0].length - 1));
    if (open < 0) continue;
    let depth = 0;
    let close = open;
    for (let j = open; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      close = j;
      if (depth <= 0) break;
    }
    found.push({ kind, name, line: i, open, close, tagged: taggedStepPath(lines, i) });
  }
  return found;
}

/**
 * The definitions on the step path of one file, each with why it is there.
 *
 * The roots are the `step`s and the `@stepPath`s; from each, a `this.<name>(` reaches the same
 * file's methods of that name and a bare `<name>(` the same file's functions of that name, and so
 * on until nothing new is reached.
 */
function stepPath(lines) {
  const all = definitions(lines);
  const reached = new Map();
  const queue = [];
  for (const d of all) {
    if (d.name === 'step' || d.tagged) {
      reached.set(d, d.name === 'step' ? 'step()' : `${d.name} (@stepPath)`);
      queue.push(d);
    }
  }
  while (queue.length > 0) {
    const d = queue.shift();
    const why = reached.get(d);
    for (let j = d.open + 1; j <= d.close; j++) {
      const code = lines[j].replace(/\/\/.*$/, '');
      if (COMMENT_LINE.test(lines[j])) continue;
      const methods = new Set();
      const functions = new Set();
      for (const m of code.matchAll(/\bthis\.(#?[A-Za-z_$][\w$]*)\s*\(/g)) methods.add(m[1]);
      for (const m of code.matchAll(/(?<![.\w$#])([A-Za-z_$][\w$]*)\s*\(/g)) functions.add(m[1]);
      for (const callee of all) {
        if (reached.has(callee)) continue;
        const called =
          callee.kind === 'method' ? methods.has(callee.name) : functions.has(callee.name);
        if (!called) continue;
        reached.set(callee, `${callee.name} (called from ${why})`);
        queue.push(callee);
      }
    }
  }
  return reached;
}

/**
 * Whether an `allocation-ok` excuses line `i`: on the line itself, or on a comment line of its own
 * above the statement the line belongs to.
 */
function excused(lines, i) {
  if (/allocation-ok:/.test(lines[i])) return true;
  for (let j = i - 1; j >= 0; j--) {
    if (COMMENT_LINE.test(lines[j])) {
      if (/allocation-ok:/.test(lines[j])) return true;
      continue;
    }
    // A code line that ends a statement, or opens or closes a block, is not part of the
    // statement line `i` is in, so a comment above it excuses something else.
    if (/[;{}]\s*(\/\/.*)?$/.test(lines[j])) return false;
  }
  return false;
}

const problems = [];
const listPaths = process.argv.includes('--paths');
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

    // A line inside two reached definitions (a closure inside a method, say) is reported once.
    const flagged = new Set();
    for (const [d, why] of stepPath(lines)) {
      if (listPaths) console.log(`${display}:${d.line + 1}  ${why}`);
      for (let i = d.open + 1; i <= d.close; i++) {
        const line = lines[i];
        if (flagged.has(i) || COMMENT_LINE.test(line) || excused(lines, i)) continue;
        const code = line.replace(/\/\/.*$/, '');
        for (const a of ALLOCATING) {
          if (a.pattern.test(code)) {
            flagged.add(i);
            problems.push(
              `${display}:${i + 1}  ${a.what} in ${why} (CONTRIBUTING rule 9; annotate '// allocation-ok: <reason>' if intended):\n      ${line.trim()}`,
            );
            break;
          }
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
