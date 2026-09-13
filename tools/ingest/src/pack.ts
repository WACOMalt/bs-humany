/**
 * Packing per-bone meshes into one binary blob plus a JSON manifest.
 *
 * One file rather than 206: a single fetch on mobile, and every offset known up front so the
 * renderer can build its merged draw call without waiting on anything. Normals are not stored --
 * they are recomputed on load by `recomputeSmoothNormals`, which halves the vertex payload.
 */

import { writeFileSync } from 'node:fs';
import type { WorldMesh } from './geometry.js';

export interface PackedBone {
  readonly id: string;
  /** Source mesh node name(s) in the FBX, for re-derivation when the dataset updates. */
  readonly source: readonly string[];
  readonly vertexOffset: number;
  readonly vertexCount: number;
  readonly indexOffset: number;
  readonly indexCount: number;
  readonly centroid: readonly [number, number, number];
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface Manifest {
  readonly format: 'bs-humany.skeleton-mesh/1';
  readonly dataset: {
    readonly name: string;
    readonly version: string;
    readonly license: string;
    readonly attribution: readonly string[];
    readonly sourceFile: string;
    readonly sourceSha256: string;
  };
  /** Standing height of the dataset subject, metres, from the top of the skull to the sole. */
  readonly subjectStature: number;
  readonly units: 'm';
  readonly bones: readonly PackedBone[];
  readonly totals: {
    readonly vertices: number;
    readonly triangles: number;
    readonly bytes: number;
  };
}

export function pack(
  entries: ReadonlyArray<{ id: string; source: readonly string[]; mesh: WorldMesh }>,
  binPath: string,
  manifestPath: string,
  dataset: Manifest['dataset'],
  subjectStature: number,
): Manifest {
  const totalVerts = entries.reduce((a, e) => a + e.mesh.vertexCount, 0);
  const totalIdx = entries.reduce((a, e) => a + e.mesh.indices.length, 0);
  const positions = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIdx);
  const bones: PackedBone[] = [];
  let vo = 0;
  let io = 0;
  for (const e of entries) {
    positions.set(e.mesh.positions, vo * 3);
    indices.set(e.mesh.indices, io);
    bones.push({
      id: e.id,
      source: e.source,
      vertexOffset: vo,
      vertexCount: e.mesh.vertexCount,
      indexOffset: io,
      indexCount: e.mesh.indices.length,
      centroid: e.mesh.centroid,
      min: e.mesh.min,
      max: e.mesh.max,
    });
    vo += e.mesh.vertexCount;
    io += e.mesh.indices.length;
  }
  // Layout: [positions f32 ...][indices u32 ...]. Offsets are element counts within each section.
  const bin = new Uint8Array(positions.byteLength + indices.byteLength);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(indices.buffer), positions.byteLength);
  writeFileSync(binPath, bin);

  const manifest: Manifest = {
    format: 'bs-humany.skeleton-mesh/1',
    dataset,
    subjectStature,
    units: 'm',
    bones,
    totals: { vertices: totalVerts, triangles: totalIdx / 3, bytes: bin.byteLength },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
  return manifest;
}
