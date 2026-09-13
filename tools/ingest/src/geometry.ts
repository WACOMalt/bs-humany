/**
 * Pulling a mesh's own geometry into our frame.
 *
 * "Own" matters. In the Z-Anatomy export a bone node's children include muscle attachment areas,
 * feature markers and sub-parts; those are separate meshes and are handled separately. This module
 * reads exactly one `Mesh` node's vertex data, bakes its world matrix in, then converts from the
 * FBX frame (X left, Y up, Z anterior, centimetres) to the canonical world frame in metres.
 */

import { WORLD, Z_ANATOMY_FBX, at, conversionMatrix } from '@bs-humany/frames';
import { type BufferGeometry, Matrix4, type Mesh, Vector3 } from 'three';

const CM_TO_M = 0.01;

/** Rotation taking FBX coordinates into world coordinates, as a three.js matrix. */
const FBX_TO_WORLD = (() => {
  const m = conversionMatrix(Z_ANATOMY_FBX, WORLD);
  const out = new Matrix4();
  // frames' Mat3 is column-major; Matrix4.set takes row-major arguments.
  out.set(
    at(m, 0, 0),
    at(m, 0, 1),
    at(m, 0, 2),
    0,
    at(m, 1, 0),
    at(m, 1, 1),
    at(m, 1, 2),
    0,
    at(m, 2, 0),
    at(m, 2, 1),
    at(m, 2, 2),
    0,
    0,
    0,
    0,
    1,
  );
  return out;
})();

export interface WorldMesh {
  /** Positions in world metres, non-indexed or indexed per `indices`. */
  positions: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  centroid: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Bake one mesh's world transform and convert frame + units.
 *
 * Non-indexed geometry is left non-indexed; a welding pass is a later optimisation and would have
 * to prove it does not merge across sharp bone edges.
 */
export function extractWorldMesh(mesh: Mesh): WorldMesh {
  const geometry: BufferGeometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position) throw new Error(`Mesh '${mesh.name}' has no position attribute.`);

  const toWorld = new Matrix4().multiplyMatrices(FBX_TO_WORLD, mesh.matrixWorld);
  const count = position.count;
  const positions = new Float32Array(count * 3);
  const v = new Vector3();
  const min: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  let cx = 0;
  let cy = 0;
  let cz = 0;

  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(position, i).applyMatrix4(toWorld).multiplyScalar(CM_TO_M);
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
    cx += v.x;
    cy += v.y;
    cz += v.z;
    if (v.x < min[0]) min[0] = v.x;
    if (v.y < min[1]) min[1] = v.y;
    if (v.z < min[2]) min[2] = v.z;
    if (v.x > max[0]) max[0] = v.x;
    if (v.y > max[1]) max[1] = v.y;
    if (v.z > max[2]) max[2] = v.z;
  }

  const index = geometry.getIndex();
  const indices = index
    ? Uint32Array.from(index.array as ArrayLike<number>)
    : Uint32Array.from({ length: count }, (_, i) => i);

  // A reflection in the baked matrix (negative determinant) would flip winding. Our conversion
  // is a proper rotation and the export's node scales are positive, but check rather than assume:
  // an inside-out bone lights black and is a miserable thing to debug from a screenshot.
  if (toWorld.determinant() < 0) {
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const b = indices[t + 1] ?? 0;
      indices[t + 1] = indices[t + 2] ?? 0;
      indices[t + 2] = b;
    }
  }

  return {
    positions,
    indices,
    vertexCount: count,
    triangleCount: indices.length / 3,
    centroid: [cx / count, cy / count, cz / count],
    min,
    max,
  };
}

/** Concatenate several world meshes into one (used to fuse the sternum's parts). */
export function mergeWorldMeshes(parts: readonly WorldMesh[]): WorldMesh {
  const vertexCount = parts.reduce((a, p) => a + p.vertexCount, 0);
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(parts.reduce((a, p) => a + p.indices.length, 0));
  let vOffset = 0;
  let iOffset = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const min: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (const p of parts) {
    positions.set(p.positions, vOffset * 3);
    for (let i = 0; i < p.indices.length; i++) indices[iOffset + i] = (p.indices[i] ?? 0) + vOffset;
    cx += p.centroid[0] * p.vertexCount;
    cy += p.centroid[1] * p.vertexCount;
    cz += p.centroid[2] * p.vertexCount;
    for (let a = 0 as 0 | 1 | 2; a < 3; a = (a + 1) as 0 | 1 | 2) {
      if (p.min[a] < min[a]) min[a] = p.min[a];
      if (p.max[a] > max[a]) max[a] = p.max[a];
    }
    vOffset += p.vertexCount;
    iOffset += p.indices.length;
  }
  return {
    positions,
    indices,
    vertexCount,
    triangleCount: indices.length / 3,
    centroid: [cx / vertexCount, cy / vertexCount, cz / vertexCount],
    min,
    max,
  };
}

/** World-space centre of a marker mesh (a 36-vertex primitive at a named feature). */
export function markerCentre(mesh: Mesh): [number, number, number] {
  const { centroid } = extractWorldMesh(mesh);
  return centroid;
}
