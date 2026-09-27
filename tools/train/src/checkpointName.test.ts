/**
 * The checkpoint-name rule, written once in JavaScript for the dashboard, the trainer and the
 * studio. Two copies of one rule drift, and this one had: the dashboard allowed forty-one
 * characters and the binary forty, so a checkpoint the dashboard trained was one the binary refused
 * to read. The studio binary's Rust copy is held exactly equal to this one in home.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { CHECKPOINT_NAME, checkpointNameProblem, isCheckpointName } from './checkpointName.mjs';

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
});
