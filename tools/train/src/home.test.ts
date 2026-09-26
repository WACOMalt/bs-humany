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
