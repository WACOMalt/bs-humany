/**
 * The flags a generator, measurement, validation or audit script takes, and nothing else.
 *
 * Each of these scripts used to ask `process.argv.includes('--check')`, which answers only whether
 * one exact string is there. A mistyped `--chek` was not a check: the script took it for a request
 * to write, rewrote the committed file, and exited 0, so the command someone ran to confirm the
 * tree was current changed the tree instead. `pnpm check:generated` would catch the write, but a
 * person at a terminal, or a CI step typed by hand, would not. An unknown flag is now an error
 * that names the flags the script does take.
 *
 * `--check` is common to all of them (the contract is in tools/cli/lib/targets.mjs); a script that
 * takes more declares them in `node:util` `parseArgs` form.
 */

import { parseArgs } from 'node:util';

/** The declared options as they would be typed: `--check --out <value>`. */
function optionList(options) {
  return Object.entries(options)
    .map(([name, spec]) => (spec.type === 'string' ? `--${name} <value>` : `--${name}`))
    .join(' ');
}

/**
 * The parsed flags, or exit 2 with the option list.
 *
 * pnpm 9 passes a literal `--` through to the script when it is written before the flags
 * (`pnpm generate:elbow-muscles -- --check`), and `parseArgs` would read everything after it as a
 * positional, so a leading one is dropped: both spellings mean the same run. No script here takes
 * a positional, so one is refused like an unknown flag -- `pnpm generate:x check` is a mistake,
 * not a file name.
 *
 * @param {string} scriptName what the script calls itself in its messages
 * @param {Record<string, import('node:util').ParseArgsOptionConfig>} extraOptions flags beyond `--check`
 * @returns {Record<string, boolean | string | undefined>} `check` is always a boolean
 */
export function cliFlags(scriptName, extraOptions = {}) {
  const options = { check: { type: 'boolean', default: false }, ...extraOptions };
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values;
  } catch (error) {
    const quotedArg = /'([^']+)'/.exec(error.message)?.[1];
    const problem =
      error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
        ? `no such option ${quotedArg}`
        : error.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL'
          ? `takes no arguments, and was given '${quotedArg}'`
          : error.message;
    console.error(`${scriptName}: ${problem}; options: ${optionList(options)}`);
    process.exit(2);
  }
}
