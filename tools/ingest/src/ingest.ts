/**
 * M1.11 -- ingest the Z-Anatomy skeletal export into the assets-anatomical data package.
 *
 *   pnpm --filter @bs-humany/ingest run ingest <SkeletalSystem100.fbx> [outDir]
 *
 * Outputs `skeleton.bin`, `manifest.json`, `landmarks.json` and a symmetry report. Everything is
 * re-derivable from the source file and this tool, which is the point: when the dataset updates,
 * re-run rather than re-author.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Mesh, Object3D } from 'three';
import { allNodes, isMesh, loadFbx } from './fbx.js';
import { type WorldMesh, extractWorldMesh, markerCentre, mergeWorldMeshes } from './geometry.js';
import { BONE_SOURCES } from './mapping.js';
import { pack } from './pack.js';
import { weld } from './weld.js';

const [, , inputArg, outArg] = process.argv;
if (!inputArg) throw new Error('usage: ingest <SkeletalSystem100.fbx> [outDir]');
const input = resolve(inputArg);
const outDir = resolve(outArg ?? '../../packages/assets-anatomical/data');
mkdirSync(outDir, { recursive: true });

const started = Date.now();
const root = await loadFbx(input);
const nodes = allNodes(root);
const meshByName = new Map<string, Mesh>();
for (const n of nodes) {
  if (!isMesh(n)) continue;
  // Bone names are unique in the export; assert rather than assume.
  if (meshByName.has(n.name))
    meshByName.set(n.name, n); // keep last; duplicates checked below
  else meshByName.set(n.name, n);
}

interface Extracted {
  id: string;
  source: readonly string[];
  mesh: WorldMesh;
  rawVertices: number;
  node: Object3D;
}

const extracted: Extracted[] = [];
const missing: string[] = [];
const excluded: string[] = [];

for (const source of BONE_SOURCES) {
  const meshes = source.nodes.map((n) => meshByName.get(n));
  const absent = source.nodes.filter((_, i) => !meshes[i]);
  if (absent.length > 0) {
    missing.push(`${source.id}: ${absent.join(', ')}`);
    continue;
  }
  if (source.excluded) {
    excluded.push(`${source.id} (${source.excluded})`);
    continue;
  }
  const parts = meshes.map((m) => extractWorldMesh(m as Mesh));
  const fused = parts.length === 1 ? (parts[0] as WorldMesh) : mergeWorldMeshes(parts);
  extracted.push({
    id: source.id,
    source: source.nodes,
    mesh: weld(fused),
    rawVertices: fused.vertexCount,
    node: meshes[0] as Mesh,
  });
}

if (missing.length > 0) {
  throw new Error(`Bones with no matching mesh in the export:\n  ${missing.join('\n  ')}`);
}

// --- Ground the model: soles at y = 0. ------------------------------------------------------
let minY = Number.POSITIVE_INFINITY;
let maxY = Number.NEGATIVE_INFINITY;
for (const e of extracted) {
  if (e.mesh.min[1] < minY) minY = e.mesh.min[1];
  if (e.mesh.max[1] > maxY) maxY = e.mesh.max[1];
}
for (const e of extracted) {
  const p = e.mesh.positions;
  for (let i = 1; i < p.length; i += 3) p[i] = (p[i] ?? 0) - minY;
  e.mesh.centroid[1] -= minY;
  e.mesh.min[1] -= minY;
  e.mesh.max[1] -= minY;
}
const subjectStature = maxY - minY;

// --- Landmarks: 36-vertex marker primitives under each bone, named by feature. ---------------
// Suffix `j` is used on right-side and midline features, `i` on left-side ones.
const landmarks: Record<string, Record<string, [number, number, number]>> = {};
let landmarkCount = 0;
for (const e of extracted) {
  const table: Record<string, [number, number, number]> = {};
  e.node.traverse((o) => {
    if (o === e.node || !isMesh(o)) return;
    const count = o.geometry.getAttribute('position')?.count ?? 0;
    if (count !== 36) return;
    const m = /^(.*)[ji]$/.exec(o.name);
    if (!m || !m[1]) return;
    const c = markerCentre(o);
    table[m[1]] = [c[0], c[1] - minY, c[2]];
    landmarkCount++;
  });
  if (Object.keys(table).length > 0) landmarks[e.id] = table;
}

// --- Symmetry report -------------------------------------------------------------------------
const byId = new Map(extracted.map((e) => [e.id, e]));
const symmetry: string[] = [];
for (const e of extracted) {
  if (!e.id.endsWith('_r')) continue;
  const left = byId.get(`${e.id.slice(0, -2)}_l`);
  if (!left) continue;
  const dx = Math.abs(e.mesh.centroid[0] + left.mesh.centroid[0]);
  const dy = Math.abs(e.mesh.centroid[1] - left.mesh.centroid[1]);
  const dz = Math.abs(e.mesh.centroid[2] - left.mesh.centroid[2]);
  const dv = Math.abs(e.mesh.vertexCount - left.mesh.vertexCount);
  if (dx > 0.005 || dy > 0.005 || dz > 0.005 || dv > 0) {
    symmetry.push(
      `${e.id.slice(0, -2)}: centroid mismatch (${(dx * 1000).toFixed(1)}, ${(dy * 1000).toFixed(1)}, ` +
        `${(dz * 1000).toFixed(1)}) mm, vertex counts ${e.mesh.vertexCount} vs ${left.mesh.vertexCount}`,
    );
  }
}

// --- Pack ------------------------------------------------------------------------------------
const sha256 = createHash('sha256').update(readFileSync(input)).digest('hex');
const manifest = pack(
  extracted.map((e) => ({ id: e.id, source: e.source, mesh: e.mesh })),
  join(outDir, 'skeleton.bin'),
  join(outDir, 'manifest.json'),
  {
    name: 'Z-Anatomy SkeletalSystem',
    version: 'LluisV/Z-Anatomy PC-Version, Resources/Models/FBX/SkeletalSystem100.fbx',
    license: 'CC-BY-SA-4.0',
    attribution: [
      'BodyParts3D - The Database Center for Life Science - CC-BY-SA 2.1 Japan',
      'Z-Anatomy - The libre 3D atlas of anatomy - CC-BY-SA 4.0',
    ],
    sourceFile: basename(input),
    sourceSha256: sha256,
  },
  subjectStature,
);
writeFileSync(join(outDir, 'landmarks.json'), `${JSON.stringify(landmarks, null, 1)}\n`);

const rawTotal = extracted.reduce((a, e) => a + e.rawVertices, 0);
const report = [
  `Z-Anatomy ingestion -- ${new Date().toISOString()}`,
  `source: ${basename(input)} sha256 ${sha256}`,
  `bones packed: ${manifest.bones.length}   excluded: ${excluded.length} (${excluded.join(', ')})`,
  `subject stature: ${subjectStature.toFixed(4)} m (soles placed at y = 0)`,
  `vertices: ${rawTotal.toLocaleString()} raw -> ${manifest.totals.vertices.toLocaleString()} welded; triangles ${manifest.totals.triangles.toLocaleString()}; ${(manifest.totals.bytes / 1048576).toFixed(1)} MB`,
  `landmarks: ${landmarkCount} markers on ${Object.keys(landmarks).length} bones`,
  '',
  `symmetry discrepancies over 5 mm or in vertex count (${symmetry.length}):`,
  ...symmetry.map((s) => `  ${s}`),
  '',
  `elapsed ${((Date.now() - started) / 1000).toFixed(1)} s`,
];
writeFileSync(join(outDir, 'INGEST-REPORT.txt'), `${report.join('\n')}\n`);
console.log(report.join('\n'));
