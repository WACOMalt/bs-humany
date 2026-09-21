/**
 * Where a run in the window keeps what it makes.
 *
 * Three things a checkpoint needs: the record itself, the search's own centre so a restart
 * continues rather than starting again, and the run's history for the chart. In a terminal they
 * are three files beside each other. Here they go wherever the window can put them.
 *
 * `IndexedDB` rather than `localStorage`, because a policy with twenty thousand weights is
 * roughly a megabyte of base64 and a browser gives `localStorage` about five in total; a run
 * that quietly stopped saving after the fourth checkpoint would be worse than one that never
 * saved at all. A single store with one record a key, which is all this needs.
 *
 * The log is dropped on the floor. It exists in the terminal so a run can be picked over
 * afterwards; the chart the studio draws comes from the history in `latest`, which is kept.
 */

import type { CheckpointStore, Keep } from '@bs-humany/train/trainer';
import { invoke } from '@tauri-apps/api/core';

/** Whether this is the binary rather than a browser tab: the binary writes real files. */
const inTauri = (): boolean =>
  typeof window !== 'undefined' &&
  '__TAURI_INTERNALS__' in (window as unknown as Record<string, unknown>);

const DATABASE = 'bs-humany.training';
const STORE = 'checkpoints';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the checkpoints.'));
  });
}

function act<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('The checkpoint store failed.'));
        transaction.oncomplete = () => db.close();
      }),
  );
}

/**
 * The store for one named checkpoint: real files in the binary, IndexedDB in a browser tab.
 *
 * The binary writes the same JSON the terminal trainer writes, under the app's data directory,
 * so a run started in the studio can be resumed from a terminal and back again. A tab has no
 * such option and keeps its own copy, which is better than refusing to train.
 */
export function createCheckpointStore(name: string): CheckpointStore {
  return inTauri() ? createFileStore(name) : createBrowserStore(name);
}

/** Files, through the Tauri side, because a web view cannot write a directory itself. */
function createFileStore(name: string): CheckpointStore {
  return {
    async read(kind) {
      try {
        const text = await invoke<string | null>('checkpoint_read', { name, kind });
        return text ? JSON.parse(text) : undefined;
      } catch {
        return undefined;
      }
    },
    async write(kind, value) {
      try {
        await invoke('checkpoint_write', { name, kind, text: `${JSON.stringify(value)}\n` });
      } catch {
        // A run that cannot save is still a run worth watching; the panel says so.
      }
    },
    async appendLog() {
      // The history is in `latest`, which is kept; there is no log file to append to here.
    },
  };
}

/** The store for one named checkpoint. Keys are `<name>:<kind>`, so names never collide. */
export function createBrowserStore(name: string): CheckpointStore {
  const key = (kind: Keep): string => `${name}:${kind}`;
  return {
    async read(kind) {
      try {
        return await act('readonly', (store) => store.get(key(kind)));
      } catch {
        // No store, or a private window that refuses one: the run starts that part afresh.
        return undefined;
      }
    },
    async write(kind, value) {
      try {
        await act('readwrite', (store) => store.put(value, key(kind)));
      } catch {
        // A run that cannot save is still a run worth watching; it says so in the panel.
      }
    },
    async appendLog() {
      // Kept in `latest`, which the chart reads; there is no file here to append to.
    },
  };
}

/** Every checkpoint this studio holds of its own, for the panel's list. */
export async function listLocalCheckpoints(): Promise<
  readonly { readonly name: string; readonly file: unknown }[]
> {
  if (!inTauri()) return listBrowserCheckpoints();
  try {
    const names = await invoke<string[]>('checkpoint_list');
    const rows = await Promise.all(
      names.map(async (name) => {
        const text = await invoke<string | null>('checkpoint_read', { name, kind: 'policy' });
        return { name, file: text ? JSON.parse(text) : undefined };
      }),
    );
    return rows.filter((r) => r.file !== undefined);
  } catch {
    return [];
  }
}

/** Every checkpoint the window holds, newest first, for the panel's list. */
export async function listBrowserCheckpoints(): Promise<
  readonly { readonly name: string; readonly file: unknown }[]
> {
  try {
    const keys = (await act('readonly', (store) => store.getAllKeys())) as IDBValidKey[];
    const names = keys
      .map(String)
      .filter((k) => k.endsWith(':policy'))
      .map((k) => k.slice(0, -':policy'.length));
    const rows = await Promise.all(
      names.map(async (name) => ({
        name,
        file: await act('readonly', (store) => store.get(`${name}:policy`)),
      })),
    );
    return rows.filter((r) => r.file !== undefined);
  } catch {
    return [];
  }
}

/** Forget one checkpoint entirely: the record, the centre and the history. */
export async function forgetBrowserCheckpoint(name: string): Promise<void> {
  for (const kind of ['policy', 'centre', 'latest'] as Keep[]) {
    try {
      await act('readwrite', (store) => store.delete(`${name}:${kind}`));
    } catch {
      // Nothing there to forget.
    }
  }
}
