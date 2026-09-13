/**
 * Weld duplicate vertices.
 *
 * FBXLoader emits non-indexed geometry: three vertices per triangle, so every shared vertex is
 * stored once per adjoining face. Welding on exact position (quantized to 10 micrometres) restores
 * an index buffer and cuts the payload by roughly two thirds. Exact-position welding cannot merge
 * two genuinely different points, so it is safe on any mesh; what it does change is that smooth
 * normals will be averaged across creases, which on bone is what we want.
 */

import type { WorldMesh } from './geometry.js';

const QUANTUM = 1e-5;

export function weld(mesh: WorldMesh): WorldMesh {
  const remap = new Uint32Array(mesh.vertexCount);
  const keyToIndex = new Map<string, number>();
  const outPositions: number[] = [];
  let next = 0;

  for (let i = 0; i < mesh.vertexCount; i++) {
    const x = mesh.positions[i * 3] ?? 0;
    const y = mesh.positions[i * 3 + 1] ?? 0;
    const z = mesh.positions[i * 3 + 2] ?? 0;
    const key = `${Math.round(x / QUANTUM)},${Math.round(y / QUANTUM)},${Math.round(z / QUANTUM)}`;
    let index = keyToIndex.get(key);
    if (index === undefined) {
      index = next++;
      keyToIndex.set(key, index);
      outPositions.push(x, y, z);
    }
    remap[i] = index;
  }

  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i++) indices[i] = remap[mesh.indices[i] ?? 0] ?? 0;

  return {
    ...mesh,
    positions: new Float32Array(outPositions),
    indices,
    vertexCount: next,
    triangleCount: indices.length / 3,
  };
}
