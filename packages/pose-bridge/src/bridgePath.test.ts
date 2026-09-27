/**
 * The bridge path, stated once.
 *
 * `DEFAULT_PATH` in `codec.ts` is where the command-line publishers, the dashboard and the viewer
 * meet. The Node tools take it from the codec; three places cannot, and carry it as a literal:
 * the dashboard, which loads no TypeScript, and the two Rust programs. This reads them as text,
 * so the day somebody changes the path in one place the others fail here rather than in a
 * headset that shows nothing.
 *
 * The studio is the exception on purpose: it publishes on a bridge of its own, so that Connect
 * VR can never delete or overwrite a running showcase's files. Its path must differ from the
 * default, and the Tauri side has a test of its own that says the same thing from there.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PATH } from './codec.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const text = (path: string) => readFileSync(`${ROOT}${path}`, 'utf8');

describe('the bridge path', () => {
  it('is the codec’s wherever it has to be written out', () => {
    expect(text('tools/train/bin/dashboard.mjs')).toContain(`'${DEFAULT_PATH}'`);
    expect(text('apps/xr-viewer/src/main.rs')).toContain(`"${DEFAULT_PATH}"`);
  });

  it('is taken from the codec, not repeated, by the Node publishers', () => {
    for (const path of ['tools/cli/bin/publish-pose.mjs', 'tools/train/bin/showcase.mjs']) {
      const source = text(path);
      expect(source, path).not.toContain(DEFAULT_PATH);
      expect(source, path).toMatch(/flag\('path', DEFAULT_PATH\)/);
    }
  });

  it('is not the studio’s, which publishes on a bridge of its own', () => {
    const base = /const BRIDGE_BASE: &str = "([^"]+)";/.exec(
      text('apps/studio/src-tauri/src/main.rs'),
    )?.[1];
    expect(base).toBeDefined();
    expect(base).not.toBe(DEFAULT_PATH);
    expect(base?.startsWith('/dev/shm/')).toBe(true);
  });
});
