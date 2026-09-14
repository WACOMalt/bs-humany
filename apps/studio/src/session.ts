/**
 * Session save and load -- milestone M4.9.
 *
 * A session is the control settings plus, when a simulation is running, its kernel snapshot.
 * The snapshot's byte arrays travel as base64 so the whole thing is one JSON document that can
 * be downloaded, attached to a bug report, or dropped back into the studio.
 */

import type { KernelSnapshot } from '@bs-humany/kernel';

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

/** Trigger a browser download of text content. */
/** Offer bytes as a file download. */
export function downloadBytes(filename: string, bytes: Uint8Array, type: string): void {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = window.document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function download(filename: string, content: string, type = 'application/json'): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
