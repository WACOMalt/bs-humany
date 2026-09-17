/**
 * Session save and load -- milestone M4.9.
 *
 * A session is the control settings plus, when a simulation is running, its kernel snapshot.
 * The snapshot's byte arrays travel as base64 so the whole thing is one JSON document that can
 * be downloaded, attached to a bug report, or dropped back into the studio.
 */

import type { KernelSnapshot } from '@bs-humany/kernel';
import { invoke, isTauri } from '@tauri-apps/api/core';

export interface SessionSettings {
  readonly sex: number;
  readonly stature: number;
  readonly mass: number;
  readonly crural: number;
  readonly brachial: number;
  readonly legLength: number;
  readonly profile: string;
  readonly backend: string;
  readonly scenario: string;
  readonly passive: boolean;
  readonly redistribute: boolean;
  readonly dropHeight: number;
  /** Grab spring multiplier, 1 being the backend's default. */
  readonly grabStrength?: number | undefined;
  /** False leaves a running body coasting. */
  readonly gravity?: boolean | undefined;
  /** False lets the body fall through the ground plane. */
  readonly floor?: boolean | undefined;
  /** The chosen scenario's parameter values, by parameter id. Absent means its defaults. */
  readonly scenarioParameters?: Readonly<Record<string, number>> | undefined;
}

export interface SessionFile {
  readonly format: 'bs-humany.session/1';
  readonly savedAt: string;
  readonly settings: SessionSettings;
  readonly simulation?:
    | {
        readonly ticks: number;
        readonly snapshot: SerializedSnapshot;
      }
    | undefined;
}

interface SerializedSnapshot {
  readonly tick: number;
  readonly dt: number;
  readonly seed: number;
  readonly channels: Record<string, string>;
  readonly random: KernelSnapshot['random'];
  readonly modules: Record<string, { readonly bytes: string } | unknown>;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function serializeSnapshot(snapshot: KernelSnapshot): SerializedSnapshot {
  const channels: Record<string, string> = {};
  for (const [id, bytes] of Object.entries(snapshot.channels)) channels[id] = toBase64(bytes);
  const modules: Record<string, unknown> = {};
  for (const [id, state] of Object.entries(snapshot.modules)) {
    modules[id] = state instanceof Uint8Array ? { bytes: toBase64(state) } : state;
  }
  return {
    tick: snapshot.tick,
    dt: snapshot.dt,
    seed: snapshot.seed,
    channels,
    random: snapshot.random,
    modules,
  };
}

export function deserializeSnapshot(data: SerializedSnapshot): KernelSnapshot {
  const channels: Record<string, Uint8Array> = {};
  for (const [id, text] of Object.entries(data.channels)) channels[id] = fromBase64(text);
  const modules: Record<string, unknown> = {};
  for (const [id, state] of Object.entries(data.modules)) {
    modules[id] =
      state &&
      typeof state === 'object' &&
      'bytes' in state &&
      typeof (state as { bytes: unknown }).bytes === 'string'
        ? fromBase64((state as { bytes: string }).bytes)
        : state;
  }
  return { tick: data.tick, dt: data.dt, seed: data.seed, channels, random: data.random, modules };
}

export function isSessionFile(value: unknown): value is SessionFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { format?: unknown }).format === 'bs-humany.session/1' &&
    typeof (value as { settings?: unknown }).settings === 'object'
  );
}

/**
 * Put bytes in a file, by whichever of the two routes exists here.
 *
 * In a browser that is an anchor with a `download` attribute and an object URL, which is the only
 * way a page may write a file and works everywhere. In the desktop shell it is neither: a web
 * view has no download handler, so the anchor is clicked and nothing happens and nothing says so
 * -- which is exactly what Save, Load and both Exports did in the binary. There it goes to a
 * native save dialog instead, over the raw request body, because a Blender export is a hundred
 * megabytes and JSON would spell every byte of it as a number.
 *
 * Resolves false when the dialog was cancelled, and true when a file was written. A browser
 * cannot tell the difference and says true.
 */
export async function downloadBytes(
  filename: string,
  bytes: Uint8Array,
  type: string,
): Promise<boolean> {
  if (isTauri()) {
    // A fresh copy, because the bytes may be a view onto a larger buffer and the bridge sends the
    // whole buffer rather than the view.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return await invoke<boolean>('save_file', copy, { headers: { 'x-file-name': filename } });
  }
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = window.document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** The same, for text. */
export async function download(
  filename: string,
  content: string,
  type = 'application/json',
): Promise<boolean> {
  if (isTauri()) return downloadBytes(filename, new TextEncoder().encode(content), type);
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/**
 * Write several files that belong together.
 *
 * A Blender export is three of them -- the glTF, the vertex cache the bellies stream from, and the
 * import script -- and none is any use without the others. In the desktop shell that is one folder
 * dialog and three files written into it, because three save dialogs is three chances to put one
 * of them somewhere the other two are not. In a browser it is three downloads, which is the only
 * thing a page can do.
 */
export async function downloadSet(
  files: readonly { readonly name: string; readonly bytes: Uint8Array; readonly type: string }[],
): Promise<boolean> {
  if (files.length === 0) return false;
  if (isTauri()) {
    const total = files.reduce((t, f) => t + f.bytes.byteLength, 0);
    const body = new Uint8Array(total);
    let at = 0;
    for (const f of files) {
      body.set(f.bytes, at);
      at += f.bytes.byteLength;
    }
    return await invoke<boolean>('save_file_set', body, {
      headers: {
        'x-file-names': JSON.stringify(files.map((f) => f.name)),
        'x-file-sizes': JSON.stringify(files.map((f) => f.bytes.byteLength)),
      },
    });
  }
  for (const f of files) await downloadBytes(f.name, f.bytes, f.type);
  return true;
}

/**
 * Ask for a text file, through a native dialog where there is one.
 *
 * Undefined means the shell handled it and nothing was chosen; a browser returns undefined too,
 * and the caller falls back to the hidden `<input type="file">` that works there.
 */
export async function openTextFile(): Promise<string | undefined> {
  if (!isTauri()) return undefined;
  const text = await invoke<string | null>('open_text_file');
  return typeof text === 'string' ? text : undefined;
}

/** Whether the file pickers have to go through the desktop shell rather than the DOM. */
export function usesNativeFilePickers(): boolean {
  return isTauri();
}
