/**
 * How every generator ends: write its file, or under `--check` compare it and write nothing.
 *
 * Every generator used to carry this tail of its own, and they had drifted. Most read the committed file
 * inside a guard; the neck, girdle and thorax generators read it bare, so `--check` against a
 * deleted file died with an ENOENT stack trace rather than saying the file was not what it should
 * be. They said "stale" four different ways, and only some named the command that fixes it. The
 * contract they share is in tools/cli/lib/targets.mjs -- compare, exit non-zero on a difference,
 * write nothing -- and it is kept here, once.
 *
 * The report scripts (`validate:*`, `audit:*`) do not come through here: a report carries the day
 * it was generated, and whether it is current is `reportIsCurrent`'s question, not byte equality.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Byte equality, for text or for a Buffer; a file that is not there equals nothing. */
function identical(committed, text) {
  if (committed === undefined) return false;
  return typeof text === 'string' ? committed === text : committed.equals(text);
}

/**
 * Write `text` to `out`, or with `check` compare it with what is there and exit 1 if it differs.
 *
 * @param {object} options
 * @param {string} options.name what the script calls itself in its messages
 * @param {string} options.script the root package.json script that runs it, for the fix
 * @param {string} options.out absolute path of the file it writes
 * @param {string | Buffer} options.text what it would write
 * @param {boolean} options.check compare only, from `cliFlags`
 * @param {string} [options.summary] what the file holds, for the closing line
 * @param {(committed: string | Buffer | undefined, text: string | Buffer) => boolean} [options.same]
 *   whether the committed file already says what `text` says; byte equality unless a generator has
 *   reason to compare otherwise (generate-source-sites compares data, not layout)
 */
export function emitOrCheck({ name, script, out, text, check, summary, same = identical }) {
  const rel = relative(ROOT, out);
  const tail = summary ? ` -- ${summary}.` : '.';
  if (!check) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    console.log(`${name}: wrote ${rel}${tail}`);
    return;
  }
  let committed;
  try {
    committed = readFileSync(out, typeof text === 'string' ? 'utf8' : undefined);
  } catch {
    committed = undefined;
  }
  if (!same(committed, text)) {
    console.error(`${name}: ${rel} is not what the generator would write. Run \`pnpm ${script}\`.`);
    process.exit(1);
  }
  console.log(`${name}: ${rel} is current${tail}`);
}
