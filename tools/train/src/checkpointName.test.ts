/**
 * The checkpoint-name rule is written in JavaScript for the dashboard, the trainer and the studio,
 * and again in Rust for the studio binary, which checks a name before it touches the disk. Two
 * copies of one rule drift, and this one had: the dashboard allowed forty-one characters and the
 * binary forty, so a checkpoint the dashboard trained was one the binary refused to read. The Rust
 * check is deliberately looser -- it takes capitals -- so what is held here is that it stays a
 * superset: every name the JavaScript accepts, the Rust accepts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKPOINT_NAME, checkpointNameProblem, isCheckpointName } from './checkpointName.mjs';

const ROOT = join(import.meta.dirname, '../../..');
const RUST = readFileSync(join(ROOT, 'apps/studio/src-tauri/src/main.rs'), 'utf8');

/** `checkpoint_path`'s test in `main.rs`, transcribed. The source assertions below keep it honest. */
const rustAccepts = (name: string): boolean =>
  name.length > 0 && name.length <= 40 && /^[A-Za-z0-9_-]+$/.test(name);

const ACCEPTED = ['stand', 'stand_v2-a', 'my-stand_2', '0', 'a'.repeat(40)];
const REJECTED = [
  '',
  'My Stand',
  'stand 2',
  'Stand',
  'My-Stand',
  '-x',
  '_x',
  '../x',
  'a'.repeat(41),
];

describe('a checkpoint name', () => {
  it('is lower-case letters, digits, dashes and underscores, up to forty', () => {
    for (const name of ACCEPTED) expect(isCheckpointName(name), name).toBe(true);
    for (const name of REJECTED) expect(isCheckpointName(name), name).toBe(false);
    expect(isCheckpointName(undefined)).toBe(false);
    expect(isCheckpointName(42)).toBe(false);
    expect(CHECKPOINT_NAME.test('a'.repeat(40))).toBe(true);
  });

  it('says what is wrong in one sentence, and nothing when nothing is', () => {
    expect(checkpointNameProblem('stand')).toBeUndefined();
    expect(checkpointNameProblem('My Stand')).toBe(
      "'My Stand' is not a checkpoint name: lower-case letters, digits, dashes and underscores, starting with a letter or digit, up to 40",
    );
    expect(checkpointNameProblem('')).toMatch(/needs a name/);
    expect(checkpointNameProblem(undefined)).toMatch(/needs a name/);
  });

  it('is never looser than the studio binary', () => {
    // If either of these moves, `rustAccepts` above is no longer a transcription of it.
    expect(RUST).toContain('name.len() > 40');
    expect(RUST).toContain("c.is_ascii_alphanumeric() || c == '-' || c == '_'");
    for (const name of ACCEPTED) expect(rustAccepts(name), name).toBe(true);
    // And exhaustively over every short name from a small alphabet that has each kind of
    // character in it, plus one of each length to past the cap.
    const alphabet = ['a', 'Z', '0', '-', '_', ' ', '.', '/'];
    const names: string[] = [];
    for (const x of alphabet)
      for (const y of alphabet) for (const z of alphabet) names.push(x + y + z);
    for (let n = 1; n <= 42; n++) names.push('b'.repeat(n));
    for (const name of names) {
      if (isCheckpointName(name)) expect(rustAccepts(name), name).toBe(true);
    }
  });
});
