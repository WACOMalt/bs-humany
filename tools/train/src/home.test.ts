/**
 * The data directory is computed twice -- once in `tools/train/bin/home.mjs` for the Node side
 * and once in `apps/studio/src-tauri/src/main.rs` for the binary -- because neither can call the
 * other. Two implementations of one path is exactly the thing that drifts, and when it drifts
 * the symptom is a checkpoint trained one way being invisible the other way, which looks like a
 * bug in training rather than a bug in a path. So they are held in step here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const RUST = readFileSync(join(ROOT, 'apps/studio/src-tauri/src/main.rs'), 'utf8');
const NODE = readFileSync(join(ROOT, 'tools/train/bin/home.mjs'), 'utf8');

/**
 * Put the override back as it was. Assigning `undefined` to a `process.env` key does not unset
 * it: the environment holds only strings, so it stores the string 'undefined', and every later
 * `dataHome()` in the process then answers a relative directory named `undefined`. An override
 * that was not set has to be deleted -- through `Reflect`, because the linter's suggested fix for
 * a `delete` is the very assignment that caused this.
 */
function unset(): void {
  Reflect.deleteProperty(process.env, 'BS_HUMANY_HOME');
}
function restore(was: string | undefined): void {
  if (was === undefined) unset();
  else process.env.BS_HUMANY_HOME = was;
}

describe('the data directory', () => {
  it('resolves to a directory named for the project', async () => {
    const { dataHome } = await import('../bin/home.mjs');
    // Without the override, which a developer who trains into a scratch directory may well have
    // exported in the shell this runs from -- and then the path is theirs, not the project's.
    const was = process.env.BS_HUMANY_HOME;
    unset();
    try {
      expect(dataHome().endsWith('bs-humany')).toBe(true);
    } finally {
      restore(was);
    }
    expect('BS_HUMANY_HOME' in process.env).toBe(was !== undefined);
  });

  it('names the same three platform locations in both implementations', () => {
    for (const fragment of ['bs-humany', 'XDG_DATA_HOME', 'Application Support', 'APPDATA']) {
      expect(RUST, `main.rs should mention ${fragment}`).toContain(fragment);
      expect(NODE, `home.mjs should mention ${fragment}`).toContain(fragment);
    }
  });

  it('honours the same override on both sides', () => {
    expect(RUST).toContain('BS_HUMANY_HOME');
    expect(NODE).toContain('BS_HUMANY_HOME');
  });

  it('puts checkpoints under the same subdirectory on both sides', () => {
    expect(RUST).toContain('"policies"');
    expect(NODE).toContain("'policies'");
  });

  it("keeps a run's centre and progress in runs/ on both sides", async () => {
    // The binary kept them in policies/ while the trainer kept them in runs/, so a run begun in
    // one was resumed by the other from its last record instead of from where the search was.
    // The table in main.rs, arm by arm: whitespace may move, the directory and suffix may not.
    const arm = (kind: string, dir: string, suffix: string) =>
      new RegExp(`"${kind}"\\s*=>\\s*Ok\\(\\(\\s*"${dir}",\\s*"${suffix}"\\s*\\)\\)`);
    expect(RUST).toMatch(arm('policy', 'policies', '\\.json'));
    expect(RUST).toMatch(arm('centre', 'runs', '-centre\\.json'));
    expect(RUST).toMatch(arm('latest', 'runs', '-latest\\.json'));

    const { runFile, formerRunFile } = await import('../bin/home.mjs');
    const was = process.env.BS_HUMANY_HOME;
    process.env.BS_HUMANY_HOME = '/tmp/bs-humany-test-home';
    try {
      expect(runFile('stand', 'centre')).toBe(
        join('/tmp/bs-humany-test-home', 'runs', 'stand-centre.json'),
      );
      expect(runFile('stand', 'latest')).toBe(
        join('/tmp/bs-humany-test-home', 'runs', 'stand-latest.json'),
      );
      // Where the binary used to put them, which both sides read and neither writes.
      expect(formerRunFile('stand', 'centre')).toBe(
        join('/tmp/bs-humany-test-home', 'policies', 'stand-centre.json'),
      );
      expect(RUST).toContain('join("policies").join(format!("{name}-{kind}.json"))');
    } finally {
      restore(was);
    }
  });

  it('takes the override when one is set', async () => {
    const { dataHome } = await import('../bin/home.mjs');
    const was = process.env.BS_HUMANY_HOME;
    process.env.BS_HUMANY_HOME = '/tmp/bs-humany-test-home';
    try {
      expect(dataHome()).toBe('/tmp/bs-humany-test-home');
    } finally {
      restore(was);
    }
    expect('BS_HUMANY_HOME' in process.env).toBe(was !== undefined);
  });
});

/**
 * The name rule is the other thing both sides hold. The binary checks a name in Rust before it
 * touches the disk and cannot import `checkpointName.mjs`, so its check is a copy; it used to be a
 * looser copy, and it listed files the page then refused to read. The copy is transcribed here
 * from `valid_checkpoint_name`, the source is held to the transcription, and the transcription is
 * held to the JavaScript over every short name from an alphabet with each kind of character in it.
 */
describe('the checkpoint name', () => {
  const NAME_RULE = readFileSync(join(ROOT, 'tools/train/src/checkpointName.mjs'), 'utf8');

  /** `valid_checkpoint_name` in `main.rs`, transcribed. The source assertions keep it honest. */
  const rustAccepts = (name: string): boolean =>
    name.length > 0 &&
    name.length <= 40 &&
    /^[a-z0-9]/.test(name) &&
    !/[A-Z]/.test(name) &&
    /^[A-Za-z0-9_-]+$/.test(name);

  it('is written the way this test transcribes it, on both sides', () => {
    expect(NAME_RULE).toContain('/^[a-z0-9][a-z0-9_-]{0,39}$/');
    const body = RUST.slice(RUST.indexOf('fn valid_checkpoint_name'));
    const rule = body.slice(0, body.indexOf('\n}\n'));
    expect(rule).toContain('name.is_empty() || name.len() > 40');
    expect(rule).toContain('c.is_ascii_lowercase() || c.is_ascii_digit()');
    expect(rule).toContain('!name.chars().any(|c| c.is_ascii_uppercase())');
    expect(rule).toContain("c.is_ascii_alphanumeric() || c == '-' || c == '_'");
    // And it is the check both the paths and the list go through.
    expect(RUST).toContain('if !valid_checkpoint_name(name) {');
    expect(RUST).toContain('!valid_checkpoint_name(stem)');
  });

  it('gives the same answer in Rust as in JavaScript for every name', async () => {
    const { isCheckpointName } = await import('./checkpointName.mjs');
    const alphabet = ['a', 'z', 'Z', '0', '9', '-', '_', ' ', '.', '/', 'ä'];
    const names: string[] = [''];
    for (const x of alphabet) {
      names.push(x);
      for (const y of alphabet) {
        names.push(x + y);
        for (const z of alphabet) names.push(x + y + z);
      }
    }
    for (let n = 1; n <= 42; n++) names.push('b'.repeat(n), `${'b'.repeat(n - 1)}-`);
    for (const name of names) {
      expect(rustAccepts(name), JSON.stringify(name)).toBe(isCheckpointName(name));
    }
  });
});
