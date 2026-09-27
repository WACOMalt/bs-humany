/**
 * Reading the pack, for the stages that measure from it.
 *
 * Five stages re-measure the data package from the packed meshes rather than from the 500 MB
 * export: `derived-from-pack`, `surface-landmarks`, `ridge-attachments`, `centres` and
 * `wrap-radii` (the order is in the package README). Each used to open `manifest.json` and
 * `skeleton.bin` itself, with its own cast of the manifest, its own view of the buffer -- two
 * reinterpreted the whole file, index section and all, as floats -- and its own idea of which
 * landmark table answers for a feature. They agreed, but only because nobody had changed one of
 * them yet. This module is the one way in, and it goes through the same `parseSkeletonAssets`
 * the studio and the skeleton load the pack with, so a stage cannot read a pack the runtime would
 * refuse.
 *
 * It also keeps the record of what a stage read. A measured table used to be stamped with the day
 * it was written, which says nothing about what it was measured from and changes every time it is
 * re-run, so re-running an unchanged stage dirtied the tree and a check against the committed
 * file had to learn to ignore the stamp. Every file a stage reads here is hashed as it is read,
 * and the stage records `inputsSha256` in place of the date: the same inputs give the same file,
 * byte for byte, and a table whose inputs have moved on says so.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type SkeletonManifest, parseSkeletonAssets } from '@bs-humany/assets-anatomical';
import type { WorldMesh } from './geometry.js';

type Vec3 = [number, number, number];

/** Landmark positions per bone, world metres at the dataset stature, keyed by feature name. */
export type LandmarkTable = Record<string, Record<string, Vec3>>;

/** The committed data package, which every stage reads and writes unless told otherwise. */
export const DEFAULT_DATA_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/assets-anatomical/data',
);

/**
 * What a stage was asked to do: which data directory, and whether to write or only compare.
 *
 * `--check` renders every output in memory, compares it with the file on disk and writes
 * nothing, which is the contract `pnpm check:generated` holds every generator to (see
 * tools/cli/lib/targets.mjs). The directory is the first argument that is not a flag, so a scratch
 * copy of the data can be re-measured without touching the committed one.
 */
export function stageArgs(argv: readonly string[] = process.argv.slice(2)): {
  dataDir: string;
  check: boolean;
} {
  const dir = argv.find((a) => !a.startsWith('--'));
  return { dataDir: dir ? resolve(dir) : DEFAULT_DATA_DIR, check: argv.includes('--check') };
}

/**
 * A data directory, and a record of every file read from it.
 *
 * `inputsSha256` is the provenance a measured table carries. It is a sha256 over each file read,
 * taken in name order so that reordering the reads in a stage cannot change it, and each file
 * contributes its name and length before its bytes so that two different sets of files cannot run
 * together into the same stream.
 */
export class DataDir {
  readonly #read = new Map<string, Buffer>();

  constructor(readonly path: string) {}

  /** A file's bytes, recorded as an input. */
  read(name: string): Buffer {
    const bytes = readFileSync(join(this.path, name));
    this.#read.set(name, bytes);
    return bytes;
  }

  /** A JSON file, parsed, recorded as an input. */
  json<T>(name: string): T {
    return JSON.parse(this.read(name).toString('utf8')) as T;
  }

  /** The files read so far, in the order the hash takes them. */
  inputs(): string[] {
    return [...this.#read.keys()].sort();
  }

  /** The sha256 of every file read so far: what a measured table records instead of a date. */
  inputsSha256(): string {
    const hash = createHash('sha256');
    for (const name of this.inputs()) {
      const bytes = this.#read.get(name) as Buffer;
      hash.update(`${name}\0${bytes.byteLength}\0`);
      hash.update(bytes);
    }
    return hash.digest('hex');
  }
}

export interface PackData {
  readonly manifest: SkeletonManifest;
  /** Every vertex of every bone, world metres, in pack order: the position section of the bin. */
  readonly positions: Float32Array;
  /** One bone's own vertices as a mesh, or undefined for a bone the pack does not carry. */
  readonly meshOf: (bone: string) => WorldMesh | undefined;
  /**
   * The raw marker table, `landmarks.json`: the export's markers and the points `derived.ts`
   * publishes beside them. A mutable copy, because `derived-from-pack` rewrites it.
   */
  readonly landmarks: LandmarkTable;
}

/** The pack: `manifest.json`, `skeleton.bin` and `landmarks.json`, read through `data`. */
export function loadPack(data: DataDir): PackData {
  const manifest = data.json<SkeletonManifest>('manifest.json');
  const bin = data.read('skeleton.bin');
  // parseSkeletonAssets takes an ArrayBuffer of exactly the file; a Node Buffer may be a window
  // onto a larger pooled one.
  const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
  const landmarks = data.json<LandmarkTable>('landmarks.json');
  const assets = parseSkeletonAssets(manifest, buffer, landmarks);
  const positions = new Float32Array(buffer, 0, manifest.totals.vertices * 3);
  const meshOf = (bone: string): WorldMesh | undefined => {
    const mesh = assets.bones.get(bone);
    if (!mesh) return undefined;
    return {
      positions: mesh.positions,
      indices: mesh.indices,
      vertexCount: mesh.positions.length / 3,
      triangleCount: mesh.indices.length / 3,
      centroid: [...mesh.centroid] as Vec3,
      min: [...mesh.min] as Vec3,
      max: [...mesh.max] as Vec3,
    };
  };
  return { manifest, positions, meshOf, landmarks };
}

/**
 * Where each feature is, as far as the ingest knows it: the raw marker table, then the markers put
 * back on the bone (`landmarks-surface.json`) over it, then the ridge attachments
 * (`ridge-attachments.json`) over both.
 *
 * This is the precedence the skeleton's landmark lookup uses (`LOCATED` in
 * packages/skeleton/src/landmarks.ts), stopped before the fitted centres: those are what
 * `centres` writes, no stage reads them back, and they are published under names of their own.
 * A stage that located a feature any other way would measure about a different point than the
 * runtime attaches to -- and at the elbow the difference is not small, because the raw epicondyle
 * markers stand 103.5 mm apart where the bone between them measures 63.8.
 *
 * `through` stops the layering early, for a stage that is itself one of the layers:
 * `ridge-attachments` reads the table up to the surface points and cannot read its own output.
 */
export function loadLocatedLandmarks(
  data: DataDir,
  through: 'surface' | 'ridge' = 'ridge',
): LandmarkTable {
  const located: LandmarkTable = {};
  const put = (bone: string, feature: string, at: Vec3) => {
    located[bone] ??= {};
    (located[bone] as Record<string, Vec3>)[feature] = at;
  };
  for (const [bone, features] of Object.entries(data.json<LandmarkTable>('landmarks.json'))) {
    for (const [feature, at] of Object.entries(features)) put(bone, feature, at);
  }
  const surface = data.json<{
    readonly landmarks: readonly { bone: string; feature: string; surface: Vec3 }[];
  }>('landmarks-surface.json');
  for (const l of surface.landmarks) put(l.bone, l.feature, l.surface);
  if (through === 'ridge') {
    const ridges = data.json<{
      readonly attachments: readonly { bone: string; feature: string; surface: Vec3 }[];
    }>('ridge-attachments.json');
    for (const r of ridges.attachments) put(r.bone, r.feature, r.surface);
  }
  return located;
}

/**
 * Write a stage's outputs, or under `--check` compare them with what is on disk and write nothing.
 *
 * A mismatch is reported with the first line that differs and sets a failing exit code; every
 * output is compared, so one run names every file that has drifted rather than the first.
 * Returns whether everything matched (always true when writing).
 */
export function emit(
  stage: string,
  dataDir: string,
  check: boolean,
  outputs: readonly (readonly [name: string, text: string])[],
): boolean {
  let matched = true;
  for (const [name, text] of outputs) {
    const path = join(dataDir, name);
    if (!check) {
      writeFileSync(path, text);
      continue;
    }
    let committed: string;
    try {
      committed = readFileSync(path, 'utf8');
    } catch {
      committed = '';
    }
    if (committed === text) continue;
    matched = false;
    const want = text.split('\n');
    const have = committed.split('\n');
    let line = 0;
    while (line < want.length && want[line] === have[line]) line += 1;
    console.error(
      `${stage} --check: ${name} is not what ${stage} would write. First difference at line ` +
        `${line + 1}:\n  committed: ${have[line] ?? '(end of file)'}\n  measured:  ` +
        `${want[line] ?? '(end of file)'}\nRun \`pnpm --filter @bs-humany/ingest ${stage}\` and ` +
        'review the diff, or find what changed its inputs.',
    );
  }
  const names = outputs.map(([n]) => n).join(', ');
  if (!matched) process.exitCode = 1;
  else console.error(check ? `${stage} --check: ${names} match.` : `${stage}: wrote ${names}.`);
  return matched;
}
