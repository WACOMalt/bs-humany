/**
 * The checkpoint store says when it could not keep something, and its list survives the files a
 * person or a terminal leaves in the folder.
 *
 * A write that failed used to be swallowed, so the panel announced records as saved over a folder
 * that still held the old ones; and one stray file in the folder threw out of the whole list, so
 * the panel showed no checkpoints at all. The Tauri side is a mock here -- there is no binary
 * under vitest -- and the studio is made to think it is in one by the global the binary sets.
 */

import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCheckpointStore, listLocalCheckpoints, newestFirst } from './store.js';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const invoked = vi.mocked(invoke);

const policy = (at?: string) => ({
  format: 'bs-humany.policy/1',
  sizes: [2, 1],
  weights: '',
  ...(at ? { trained: { generations: 1, fitness: 1, episodes: 1, at } } : {}),
});

beforeEach(() => {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  invoked.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listLocalCheckpoints in the binary', () => {
  it('keeps the policies and names every file that is not one', async () => {
    const files: Record<string, string> = {
      good: JSON.stringify(policy('2026-09-01T00:00:00Z')),
      junk: '{ this is not json',
      foreign: JSON.stringify({ format: 'somebody-else/2', weights: [] }),
    };
    invoked.mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'checkpoint_list') return ['good', 'junk', 'foreign', 'refused'];
      const { name } = args as { name: string };
      if (name === 'refused') throw 'permission denied';
      return files[name] ?? null;
    });
    const { rows, skipped } = await listLocalCheckpoints();
    expect(rows.map((r) => r.name)).toEqual(['good']);
    expect(skipped).toEqual(['junk', 'foreign', 'refused']);
  });

  it('gives an empty list when the folder cannot be listed', async () => {
    invoked.mockRejectedValue('no data directory');
    expect(await listLocalCheckpoints()).toEqual({ rows: [], skipped: [] });
  });
});

describe('a write that fails', () => {
  it('resolves false and says which and why', async () => {
    invoked.mockRejectedValue("'stand v2' is not a checkpoint name");
    const failed = vi.fn();
    const store = createCheckpointStore('stand v2', failed);
    await expect(store.write('policy', policy())).resolves.toBe(false);
    expect(failed).toHaveBeenCalledWith('policy', "'stand v2' is not a checkpoint name");
  });

  it('resolves as kept when the write went through', async () => {
    invoked.mockResolvedValue(undefined);
    const failed = vi.fn();
    const store = createCheckpointStore('stand', failed);
    expect(await store.write('centre', {})).not.toBe(false);
    expect(failed).not.toHaveBeenCalled();
  });
});

describe('newestFirst', () => {
  it('puts the newest first and the undated last, by name, without touching the list given', () => {
    const rows = [
      { name: 'b-undated', file: policy() },
      { name: 'old', file: policy('2026-01-01T00:00:00Z') },
      { name: 'a-undated', file: policy() },
      { name: 'new', file: policy('2026-09-20T12:00:00Z') },
      { name: 'garbled', file: policy('not a date') },
    ];
    const before = rows.map((r) => r.name);
    expect(newestFirst(rows).map((r) => r.name)).toEqual([
      'new',
      'old',
      'a-undated',
      'b-undated',
      'garbled',
    ]);
    expect(rows.map((r) => r.name)).toEqual(before);
  });
});
