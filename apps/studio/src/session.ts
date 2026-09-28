/**
 * Session save and load -- milestone M4.9.
 *
 * A session is the settings that define a run plus, when a simulation is running, its kernel
 * snapshot. The snapshot's byte arrays travel as base64 so the whole thing is one JSON document
 * that can be downloaded, attached to a bug report, or dropped back into the studio.
 *
 * The second format adds what the first left out and a fresh studio could not guess: whether the
 * muscles were on, the step rate somebody chose, the output rate and capture budget, the drive
 * sliders, the cord, the brain's authority and chosen checkpoint, and a fingerprint of the
 * channels the snapshot was taken from. Without the rate and the muscles, a session saved from a
 * run at 2000 steps a second or with muscles off failed to restore in a fresh studio with the
 * kernel's own complaint about `dt` or channel lists, which named nothing a person could change.
 * A file of the first format still loads: what it lacks is filled from its snapshot where the
 * snapshot says (`inferRunSettings`), and from the studio's defaults otherwise.
 */

import type { KernelSnapshot } from '@bs-humany/kernel';
import { PASSIVE_JOINT_MODULE_ID } from '@bs-humany/modules-mechanics';
import { MUSCLE_STATE } from '@bs-humany/modules-muscle';
import { SPINAL_REGIONS, type SpinalRegion } from '@bs-humany/modules-nerves';
import { DEFAULT_OUTPUT_FRAMERATE } from '@bs-humany/session';
import { invoke, isTauri } from '@tauri-apps/api/core';

/** The format this studio writes. */
export const SESSION_FORMAT = 'bs-humany.session/2';
/** Every format this studio reads: its own, and the one before it, filled in with defaults. */
const READABLE_FORMATS: readonly string[] = ['bs-humany.session/1', SESSION_FORMAT];

/** The cord's gains as the Spine sliders hold them; the two force limits are not on a slider. */
export interface SessionReflex {
  readonly stretch: number;
  readonly velocity: number;
  readonly setPoint: number;
  readonly inhibition: number;
  readonly delaySeconds: number;
  /**
   * The stretch of each region whose slider was moved off Stretch, all regions, by region name.
   * A region not named follows `stretch`, so a file saved before regions -- which has none --
   * loads as its one stretch everywhere, which is what it ran.
   */
  readonly regionStretch?: Readonly<Partial<Record<SpinalRegion, number>>> | undefined;
}

export interface SessionSettings {
  readonly sex: number;
  readonly stature: number;
  readonly mass: number;
  /**
   * The three limb proportions, which files written before 2026-09-27 carry. Nothing measured
   * follows them yet and the studio no longer offers them, so a value here is read and ignored;
   * the fields stay so those files keep their type. Never written.
   */
  readonly crural?: number | undefined;
  readonly brachial?: number | undefined;
  readonly legLength?: number | undefined;
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
  /** The Muscles box. A scenario that drives muscles turns them on whatever this says. */
  readonly muscles?: boolean | undefined;
  /**
   * Simulation steps a second, written only when somebody chose one. Absent, the run steps at
   * its profile's own solver rate, which is what the studio does until the slider is moved.
   */
  readonly stepsPerSecond?: number | undefined;
  readonly outputFramerate?: number | undefined;
  /** The capture budget in mebibytes. Absent keeps this studio's own, which its machine sets. */
  readonly captureBudgetMiB?: number | undefined;
  /** Each drive group's slider position, 0 to 100, by group id. A group not named is at 0. */
  readonly drive?: Readonly<Record<string, number>> | undefined;
  /** The cord on the Spine sliders. Absent keeps the sliders as they are. */
  readonly reflex?: SessionReflex | undefined;
  /** The Brain panel's Authority slider. Absent keeps it as it is. */
  readonly brainAuthority?: number | undefined;
  /**
   * The checkpoint chosen in the Brain panel's list, by id: a name to find it by, never its
   * weights. A file cannot carry a checkpoint, only say which one it was.
   */
  readonly checkpoint?: string | undefined;
}

/** A channel as a session fingerprints it: its id, its declared version and its size in bytes. */
export type ChannelPrint = readonly [id: string, version: string, bytes: number];

export interface SessionFile {
  readonly format: 'bs-humany.session/1' | typeof SESSION_FORMAT;
  readonly savedAt: string;
  readonly settings: SessionSettings;
  readonly simulation?:
    | {
        readonly ticks: number;
        readonly snapshot: SerializedSnapshot;
        /**
         * The channels of the kernel the snapshot was taken from, sorted by id. A build whose
         * channels differ in version or size cannot take the snapshot, and this says so before
         * anything is restored. Absent from files of the first format.
         */
        readonly channels?: readonly ChannelPrint[] | undefined;
      }
    | undefined;
}

/**
 * Settings as the studio applies them: every field a fresh studio has a fixed default for is
 * filled. The ones left optional have none that belongs in a file -- the profile's own step rate,
 * this machine's capture budget, the Brain panel's cord, authority and list as they stand.
 */
export interface NormalisedSettings extends SessionSettings {
  readonly grabStrength: number;
  readonly gravity: boolean;
  readonly floor: boolean;
  readonly muscles: boolean;
  readonly outputFramerate: number;
  readonly drive: Readonly<Record<string, number>>;
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
  if (typeof value !== 'object' || value === null) return false;
  const { format, settings } = value as { format?: unknown; settings?: unknown };
  return (
    typeof format === 'string' &&
    READABLE_FORMATS.includes(format) &&
    typeof settings === 'object' &&
    settings !== null
  );
}

/**
 * The format a parsed file claims, when it claims to be a session of any format: so a session
 * from a newer studio is refused as that, rather than as a file that is not a session at all.
 */
export function sessionFormatOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const format = (value as { format?: unknown }).format;
  return typeof format === 'string' && format.startsWith('bs-humany.session/') ? format : undefined;
}

/**
 * What a snapshot says about the run it was taken from, for a file that does not say it itself.
 *
 * The rate is the one its clock stepped at, because `dt` is fixed for the life of a run and a
 * restore must step at the same one. The muscles are on when the snapshot holds their state
 * channel, which only a run with muscles registers.
 */
export function inferRunSettings(snapshot: {
  readonly dt: number;
  readonly channels: Readonly<Record<string, unknown>>;
}): { stepsPerSecond: number; muscles: boolean } {
  return {
    stepsPerSecond: Math.round(1 / snapshot.dt),
    muscles: MUSCLE_STATE in snapshot.channels,
  };
}

/**
 * A file's settings, checked and filled in, ready to apply.
 *
 * The fields every format has always carried are required, and a file without one is refused
 * with its name rather than applied half-way. The rest take the studio's defaults when they are
 * missing, except where a snapshot says otherwise: with a run to restore, its rate and its
 * muscles are the snapshot's, because the kernel refuses a restore at any other rate or with the
 * other set of channels. A number that is not finite counts as missing, and so does a cord with a
 * gain missing, because it is not the cord that was saved.
 */
export function normaliseSettings(
  raw: unknown,
  snapshot?: { readonly dt: number; readonly channels: Readonly<Record<string, unknown>> },
): NormalisedSettings {
  // Worded to follow "The session failed to load:", which is where the studio shows them.
  if (typeof raw !== 'object' || raw === null) throw new Error('it has no settings.');
  const s = raw as Record<string, unknown>;
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`its settings have no usable ${what}.`);
    return value;
  };
  const inferred = snapshot ? inferRunSettings(snapshot) : undefined;
  const stepsPerSecond = inferred?.stepsPerSecond ?? positive(s.stepsPerSecond);
  const scenarioParameters = numbersOf(s.scenarioParameters);
  const captureBudgetMiB = positive(s.captureBudgetMiB);
  const reflex = reflexOf(s.reflex);
  const brainAuthority = finite(s.brainAuthority);
  const checkpoint = text(s.checkpoint);
  return {
    sex: need(finite(s.sex), 'skeletal proportions (sex)'),
    stature: need(positive(s.stature), 'stature'),
    mass: need(positive(s.mass), 'body mass'),
    profile: need(text(s.profile), 'body profile'),
    backend: need(text(s.backend), 'physics backend'),
    scenario: need(text(s.scenario), 'scenario'),
    passive: need(flag(s.passive), 'passive joint setting'),
    redistribute: need(flag(s.redistribute), 'spinal redistribution setting'),
    dropHeight: need(finite(s.dropHeight), 'drop height'),
    grabStrength: positive(s.grabStrength) ?? 1,
    gravity: flag(s.gravity) ?? true,
    floor: flag(s.floor) ?? true,
    ...(scenarioParameters ? { scenarioParameters } : {}),
    muscles: inferred?.muscles ?? flag(s.muscles) ?? true,
    ...(stepsPerSecond !== undefined ? { stepsPerSecond } : {}),
    outputFramerate: positive(s.outputFramerate) ?? DEFAULT_OUTPUT_FRAMERATE,
    ...(captureBudgetMiB !== undefined ? { captureBudgetMiB } : {}),
    drive: numbersOf(s.drive) ?? {},
    ...(reflex ? { reflex } : {}),
    ...(brainAuthority !== undefined ? { brainAuthority } : {}),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
  };
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positive(value: unknown): number | undefined {
  const n = finite(value);
  return n !== undefined && n > 0 ? n : undefined;
}

function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A record of finite numbers, leaving out any entry that is not one; undefined for no record. */
function numbersOf(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const n = finite(entry);
    if (n !== undefined) out[key] = n;
  }
  return out;
}

function reflexOf(value: unknown): SessionReflex | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const r = value as Record<string, unknown>;
  const stretch = finite(r.stretch);
  const velocity = finite(r.velocity);
  const setPoint = finite(r.setPoint);
  const inhibition = finite(r.inhibition);
  const delaySeconds = finite(r.delaySeconds);
  if (
    stretch === undefined ||
    velocity === undefined ||
    setPoint === undefined ||
    inhibition === undefined ||
    delaySeconds === undefined
  ) {
    return undefined;
  }
  // Only the regions the cord knows, each a finite number; anything else in the file is not a
  // setting of this cord and is left out rather than refusing the session over it.
  const given = numbersOf(r.regionStretch) ?? {};
  const regionStretch: Partial<Record<SpinalRegion, number>> = {};
  for (const region of SPINAL_REGIONS) {
    const v = given[region];
    if (v !== undefined) regionStretch[region] = v;
  }
  return {
    stretch,
    velocity,
    setPoint,
    inhibition,
    delaySeconds,
    ...(Object.keys(regionStretch).length > 0 ? { regionStretch } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Whether a saved run fits the run built to take it
// ---------------------------------------------------------------------------------------------

/** A kernel's channels, as far as a fingerprint reads them: `Kernel.channels` is one. */
export interface ChannelSource {
  ids(): readonly string[];
  storage(id: string): {
    readonly spec: { readonly version: string };
    readonly buffer: { readonly byteLength: number };
  };
}

/** A kernel's channels, fingerprinted and sorted by id, for a session file to carry. */
export function channelPrints(channels: ChannelSource): ChannelPrint[] {
  return [...channels.ids()].sort().map((id): ChannelPrint => {
    const storage = channels.storage(id);
    return [id, storage.spec.version, storage.buffer.byteLength];
  });
}

/**
 * What a restore depends on, for the run that was saved or the run built to take it: the step,
 * the channels -- a version is undefined where a file of the first format did not record one --
 * and the modules registered, which a snapshot records as the random stream each one is given.
 */
export interface RunPrint {
  readonly dt: number;
  readonly channels: readonly (readonly [id: string, version: string | undefined, bytes: number])[];
  readonly modules: readonly string[];
}

/** The run a session saved, from its fingerprint where it has one and from its snapshot else. */
export function savedRunPrint(
  snapshot: KernelSnapshot,
  channels: readonly ChannelPrint[] | undefined,
): RunPrint {
  return {
    dt: snapshot.dt,
    channels:
      channels ??
      Object.keys(snapshot.channels)
        .sort()
        .map((id) => [id, undefined, snapshot.channels[id]?.byteLength ?? 0] as const),
    modules: Object.keys(snapshot.random).sort(),
  };
}

/**
 * What the studio says of a session whose run cannot be put back into this build's body. The run
 * that goes instead is a fresh one with the session's settings, which is what the tail says.
 */
export const RESTORE_REFUSED =
  'This session was saved from a different build of the body; its settings were applied and ' +
  'the simulation restarted from the beginning.';

/** The tail every refusal ends with, since the studio does the same thing whatever the reason. */
const RESTARTED = 'its settings were applied and the simulation restarted from the beginning.';

/**
 * Why a saved run cannot go into the run built for it, as the sentence the studio shows, or
 * undefined when nothing a restore checks differs.
 *
 * The kernel refuses a mismatch in its own words -- a `dt`, or two lists of channel ids -- which
 * name nothing a person can change. Three of the differences are settings, and each is named with
 * which way it was: the step rate, the muscles, and the passive joints, which register a module
 * and so a random stream of their own. Anything else -- a channel of another size or version, a
 * module one body has and the other lacks -- is the body of another build, which no setting fits.
 */
export function restoreMismatch(saved: RunPrint, running: RunPrint): string | undefined {
  if (saved.dt !== running.dt) {
    return (
      `This session was saved at ${Math.round(1 / saved.dt)} steps a second and this run ` +
      `steps at ${Math.round(1 / running.dt)}; ${RESTARTED}`
    );
  }
  const savedIds = new Set(saved.channels.map(([id]) => id));
  const runningIds = new Set(running.channels.map(([id]) => id));
  const savedMuscles = savedIds.has(MUSCLE_STATE);
  if (savedMuscles !== runningIds.has(MUSCLE_STATE)) {
    return (
      `This session was saved with muscles ${savedMuscles ? 'on' : 'off'} and this run has them ` +
      `${savedMuscles ? 'off' : 'on'}; ${RESTARTED}`
    );
  }
  const savedPassive = saved.modules.includes(PASSIVE_JOINT_MODULE_ID);
  if (savedPassive !== running.modules.includes(PASSIVE_JOINT_MODULE_ID)) {
    return (
      `This session was saved with passive joint resistance ${savedPassive ? 'on' : 'off'} and ` +
      `this run has it ${savedPassive ? 'off' : 'on'}; ${RESTARTED}`
    );
  }
  const now = new Map(running.channels.map((c) => [c[0], c]));
  const channelsDiffer =
    savedIds.size !== runningIds.size ||
    saved.channels.some(([id, version, bytes]) => {
      const there = now.get(id);
      return (
        there === undefined || there[2] !== bytes || (version !== undefined && there[1] !== version)
      );
    });
  const modulesDiffer =
    saved.modules.length !== running.modules.length ||
    saved.modules.some((id) => !running.modules.includes(id));
  return channelsDiffer || modulesDiffer ? RESTORE_REFUSED : undefined;
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
