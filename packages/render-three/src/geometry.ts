/**
 * The three.js adapter.
 *
 * The only file in this package that imports three.js. Everything upstream of it -- recipe
 * evaluation, mesh generation, the skeleton build -- is pure, which is what lets the geometry
 * mathematics be tested headlessly.
 */

import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';
import type { MeshData } from './mesh/types.js';
import type { SkeletonMesh } from './skeletonMesh.js';

/** Wrap plain vertex buffers in a `BufferGeometry`. */
export function toBufferGeometry(mesh: MeshData): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Wrap a built skeleton, carrying the per-vertex bone index through as an attribute.
 *
 * The attribute is what lets picking and highlighting resolve to a bone `id` after the merge.
 */
export function toSkeletonGeometry(mesh: SkeletonMesh): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  geometry.setAttribute('boneIndex', new BufferAttribute(mesh.boneIndex, 1));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));

  // Computed rather than left to three.js, so an empty build does not produce a NaN sphere that
  // silently disables frustum culling.
  if (mesh.positions.length > 0) {
    geometry.computeBoundingSphere();
  } else {
    geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), 0);
  }
  return geometry;
}
