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

/**
 * Whether what this studio trains is kept as files in the data folder, which a terminal can read
 * too, rather than in this browser's own store. The Brain panel says which, so a person looking
 * at the list knows where the checkpoints in it live.
 */
export const holdsFilesOnDisk = inTauri;

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
 * Told when a write could not be kept: which of the three it was, and why, in the host's words.
 * The run goes on either way; this is so it can be said rather than found out later.
 */
export type WriteFailed = (kind: Keep, message: string) => void;

/**
 * Why a write failed, as a sentence. The Tauri side rejects with its own error string -- "'stand
 * v2' is not a checkpoint name", a disk's refusal -- and IndexedDB with a DOMException whose name
 * is the useful half (`QuotaExceededError`), so both are kept.
 */
function failureText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (
    error instanceof Error ||
    (typeof DOMException !== 'undefined' && error instanceof DOMException)
  ) {
    return error.message ? `${error.name}: ${error.message}` : error.name;
  }
  return String(error);
}

/**
 * The store for one named checkpoint: real files in the binary, IndexedDB in a browser tab.
 *
 * The binary writes the same JSON the terminal trainer writes, under the app's data directory,
 * so a run started in the studio can be resumed from a terminal and back again. A tab has no
 * such option and keeps its own copy, which is better than refusing to train.
 *
 * A write that fails resolves `false` rather than throwing, which the search reads as "go on, but
 * do not call the record saved", and `onWriteFailed` is told why.
 */
export function createCheckpointStore(name: string, onWriteFailed?: WriteFailed): CheckpointStore {
  return inTauri() ? createFileStore(name, onWriteFailed) : createBrowserStore(name, onWriteFailed);
}

/** Files, through the Tauri side, because a web view cannot write a directory itself. */
function createFileStore(name: string, onWriteFailed?: WriteFailed): CheckpointStore {
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
        return true;
      } catch (error) {
        // A run that cannot save is still a run worth watching, so this does not throw and end
        // it. It used to say nothing at all, and the panel went on announcing records as saved
        // while the folder held the old ones; now the caller is told, and the search is answered
        // `false`, so neither says "saved" over a write that did not happen.
        onWriteFailed?.(kind, failureText(error));
        return false;
      }
    },
    async appendLog() {
      // The history is in `latest`, which is kept; there is no log file to append to here.
    },
  };
}

/** The store for one named checkpoint. Keys are `<name>:<kind>`, so names never collide. */
export function createBrowserStore(name: string, onWriteFailed?: WriteFailed): CheckpointStore {
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
        return true;
      } catch (error) {
        // A full or forbidden store -- a private window, a quota reached -- ends no run, for the
        // same reason as a file that cannot be written; the caller is told and the search is
        // answered `false`, so the panel says it is not saving instead of that it saved.
        onWriteFailed?.(kind, failureText(error));
        return false;
      }
    },
    async appendLog() {
      // Kept in `latest`, which the chart reads; there is no file here to append to.
    },
  };
}

/**
 * One checkpoint's policy file, whichever store this studio uses. The panel needs this to hand
 * a checkpoint over when there is no server to fetch it from.
 */
export async function readLocalCheckpoint(name: string): Promise<unknown | undefined> {
  if (inTauri()) {
    try {
      const text = await invoke<string | null>('checkpoint_read', { name, kind: 'policy' });
      return text ? JSON.parse(text) : undefined;
    } catch {
      return undefined;
    }
  }
  return createBrowserStore(name).read('policy');
}

/** A checkpoint as the panel's list takes it: its name and its policy file, parsed. */
export interface HeldCheckpoint {
  readonly name: string;
  readonly file: unknown;
}

/** What this studio holds, and the names in its folder that turned out not to be checkpoints. */
export interface HeldCheckpoints {
  readonly rows: readonly HeldCheckpoint[];
  /**
   * Files in the checkpoint folder that could not be read, did not parse, or parsed to something
   * other than a policy. Named so the panel can say they were left out rather than leave a person
   * wondering where the file they copied in went. Always empty in a browser tab, whose store holds
   * only what this studio put there.
   */
  readonly skipped: readonly string[];
}

/** Whether a parsed file is a policy, which is all the list and a handover can use. */
const isPolicy = (file: unknown): boolean =>
  typeof file === 'object' &&
  file !== null &&
  (file as { readonly format?: unknown }).format === 'bs-humany.policy/1';

/** When a checkpoint was trained, as a number that sorts, or undefined when its file does not say. */
function trainedAt(row: HeldCheckpoint): number | undefined {
  const at = (row.file as { readonly trained?: { readonly at?: unknown } } | null)?.trained?.at;
  if (typeof at !== 'string') return undefined;
  const time = Date.parse(at);
  return Number.isNaN(time) ? undefined : time;
}

/**
 * The newest checkpoint first, by when its file says it was trained; the ones that do not say go
 * last, by name, so the order is the same from one poll to the next. A new list: the one given is
 * not touched.
 */
export function newestFirst<T extends HeldCheckpoint>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const at = trainedAt(a);
    const bt = trainedAt(b);
    if (at !== undefined && bt !== undefined && at !== bt) return bt - at;
    if (at !== undefined && bt === undefined) return -1;
    if (at === undefined && bt !== undefined) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/** Every checkpoint this studio holds of its own, newest first, for the panel's list. */
export async function listLocalCheckpoints(): Promise<HeldCheckpoints> {
  if (!inTauri()) return { rows: newestFirst(await listBrowserCheckpoints()), skipped: [] };
  let names: string[];
  try {
    names = await invoke<string[]>('checkpoint_list');
  } catch {
    return { rows: [], skipped: [] };
  }
  // Each file on its own. The folder is one a person can copy files into, and a terminal writes
  // it too; one that would not read or parse used to throw out of the whole list, and the panel
  // showed no checkpoints at all because of a single stray file.
  const read = await Promise.all(
    names.map(async (name): Promise<HeldCheckpoint | 'skipped' | undefined> => {
      try {
        const text = await invoke<string | null>('checkpoint_read', { name, kind: 'policy' });
        // Gone between the list and the read: nothing to show and nothing to explain.
        if (!text) return undefined;
        const file = parsedOnce(name, text);
        return isPolicy(file) ? { name, file } : 'skipped';
      } catch {
        return 'skipped';
      }
    }),
  );
  // Forget what has gone from the folder, so the cache is never bigger than the list.
  for (const name of parsed.keys()) if (!names.includes(name)) parsed.delete(name);
  const rows: HeldCheckpoint[] = [];
  const skipped: string[] = [];
  read.forEach((entry, i) => {
    if (entry === 'skipped') skipped.push(names[i] as string);
    else if (entry) rows.push(entry);
  });
  return { rows: newestFirst(rows), skipped };
}

/**
 * The files as last parsed, by name, with the text they were parsed from.
 *
 * The panel asks for the list every few seconds while the Brain tab is open and no server is up,
 * and a policy is up to a megabyte of JSON. Parsing every one of them again each time, to find
 * them exactly as they were, was most of what that poll cost. The text is still read -- a
 * terminal trainer writes the same folder, and a file it rewrote must be seen -- but it is only
 * parsed when it differs from what was parsed last time.
 */
const parsed = new Map<string, { readonly text: string; readonly file: unknown }>();
function parsedOnce(name: string, text: string): unknown {
  const seen = parsed.get(name);
  if (seen?.text === text) return seen.file;
  const file = JSON.parse(text) as unknown;
  parsed.set(name, { text, file });
  return file;
}

/**
 * Every checkpoint the window holds, in the order of their keys, which is by name; the caller
 * puts the newest first. Anything under a `:policy` key that is not a policy is left out, as it is
 * from the binary's folder.
 */
export async function listBrowserCheckpoints(): Promise<readonly HeldCheckpoint[]> {
  try {
    // One database and one transaction for the whole list. It used to open the database once
    // for the keys and once again for every checkpoint, every few seconds, for as long as the
    // Brain tab was open without a server.
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const store = db.transaction(STORE, 'readonly').objectStore(STORE);
        const keys = store.getAllKeys();
        keys.onerror = () => reject(keys.error ?? new Error('The checkpoint store failed.'));
        keys.onsuccess = () => {
          const names = keys.result
            .map(String)
            .filter((k) => k.endsWith(':policy'))
            .map((k) => k.slice(0, -':policy'.length));
          const rows: HeldCheckpoint[] = [];
          if (names.length === 0) resolve(rows);
          for (const name of names) {
            const request = store.get(`${name}:policy`);
            request.onerror = () =>
              reject(request.error ?? new Error('The checkpoint store failed.'));
            request.onsuccess = () => {
              rows.push({ name, file: request.result });
              // Requests in one transaction complete in the order they were made, so the last
              // to answer is the last asked, and the list keeps the order of the keys.
              if (rows.length === names.length) resolve(rows.filter((r) => isPolicy(r.file)));
            };
          }
        };
      });
    } finally {
      db.close();
    }
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
