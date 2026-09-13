/**
 * Loading the Z-Anatomy FBX headless.
 *
 * three.js's FBXLoader is written for the browser but only touches the DOM in two places, neither
 * of which a mesh-only export reaches: `window.innerWidth` in the camera-node path, and
 * `TextureLoader` when a material references an image. Both are stubbed rather than polyfilled,
 * so if a future export *does* hit them the failure is loud.
 */

import { readFileSync } from 'node:fs';
import type { Group, Mesh, Object3D } from 'three';

export async function loadFbx(path: string): Promise<Group> {
  const g = globalThis as Record<string, unknown>;
  g.window ??= { innerWidth: 1, innerHeight: 1 };
  g.self ??= globalThis;

  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  const buffer = readFileSync(path);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const root = new FBXLoader().parse(arrayBuffer, '');
  root.updateMatrixWorld(true);
  return root;
}

export function isMesh(o: Object3D): o is Mesh {
  return (o as Mesh).isMesh === true;
}

/** Every node in the tree, in traversal order. */
export function allNodes(root: Object3D): Object3D[] {
  const out: Object3D[] = [];
  root.traverse((o) => out.push(o));
  return out;
}

/** Nearest ancestor (or self) satisfying the predicate. */
export function findAncestor(o: Object3D, predicate: (n: Object3D) => boolean): Object3D | null {
  let p: Object3D | null = o;
  while (p) {
    if (predicate(p)) return p;
    p = p.parent;
  }
  return null;
}
