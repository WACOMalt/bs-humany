/**
 * What a checkpoint may be called.
 *
 * One rule, written once, in plain JavaScript with no imports, because four places have to agree
 * on it and they cannot all load the same kind of file: the dashboard is a Node script, the
 * studio is bundled by vite, the trainer's recipe module is TypeScript loaded through jiti, and
 * the studio binary checks the name again in Rust before it touches the disk. The first three
 * import this file; the fourth is held to it by a test.
 *
 * A name is a file stem -- `<name>.json` in the policies directory and `<name>-centre.json`,
 * `<name>-latest.json` beside the runs -- so it must be nothing that could leave that directory,
 * nothing a file system could fold into another name, and nothing a shell would have to quote.
 * Lower-case letters, digits, dashes and underscores, starting with a letter or a digit so it can
 * never be read as an option.
 *
 * Forty characters in all: the name input's `maxlength`, and the length `checkpoint_path` in
 * `apps/studio/src-tauri/src/main.rs` refuses beyond. The dashboard's copy of this used to allow
 * one more -- `{0,40}` after the first character is forty-one -- so a name the dashboard trained
 * happily was one the studio binary then refused to read. The Rust check (`valid_checkpoint_name`)
 * is now this same rule, not a looser one: a name either side refuses, the other refuses too, so
 * a file in the data folder is listed and readable by every one of them or by none.
 * `tools/train/src/home.test.ts` holds the two equal.
 */

/** A checkpoint's name: up to forty lower-case letters, digits, dashes and underscores. */
export const CHECKPOINT_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Whether `name` is one a checkpoint may have. */
export function isCheckpointName(name) {
  return typeof name === 'string' && CHECKPOINT_NAME.test(name);
}

/**
 * The one sentence to show when `name` is not a checkpoint name, or undefined when it is.
 *
 * Said rather than fixed: a name that is quietly lower-cased or trimmed or replaced by the task
 * trains a checkpoint nobody asked for, and at worst overwrites one somebody wanted.
 */
export function checkpointNameProblem(name) {
  if (isCheckpointName(name)) return undefined;
  if (name === undefined || name === null || name === '') {
    return 'a checkpoint needs a name: lower-case letters, digits, dashes and underscores, up to 40';
  }
  return `'${String(name)}' is not a checkpoint name: lower-case letters, digits, dashes and underscores, starting with a letter or digit, up to 40`;
}
