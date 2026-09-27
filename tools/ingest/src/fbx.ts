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

/** Mesh nodes by name, and the names more than one mesh node carries. */
export interface MeshIndex {
  /** Each mesh name's first node, in traversal order. */
  readonly byName: ReadonlyMap<string, Mesh>;
  /** Every name carried by more than one mesh node, with how many carry it, sorted by name. */
  readonly duplicates: readonly { readonly name: string; readonly count: number }[];
}

/**
 * Index the export's mesh nodes by name, refusing a duplicated name the ingest looks up.
 *
 * The ingest finds each bone's mesh by its node name (`BONE_SOURCES` in mapping.ts). If two mesh
 * nodes share a name the lookup can only return one of them, and which one is an accident of
 * traversal order: a bone could be packed from a muscle's attachment patch or a sub-part, and
 * nothing downstream would notice until a muscle attached to the wrong place. So a duplicate among
 * `wanted` -- the names the ingest will look up -- is an error naming every such clash, and the
 * export has to be looked at before the pack is rewritten.
 *
 * A duplicate the ingest never asks for does the lookup no harm, so it is only returned, for the
 * ingest report, where a later mapping that starts to want one of those names will find it
 * already listed.
 */
export function indexMeshesByName(
  nodes: readonly Object3D[],
  wanted: ReadonlySet<string>,
): MeshIndex {
  const byName = new Map<string, Mesh>();
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (!isMesh(node)) continue;
    counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
    if (!byName.has(node.name)) byName.set(node.name, node);
  }
  const duplicates = [...counts]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const clashes = duplicates.filter((d) => wanted.has(d.name));
  if (clashes.length > 0) {
    throw new Error(
      'The export has more than one mesh node under a name the ingest looks up, so which one a ' +
        'bone would be packed from is an accident of traversal order:\n  ' +
        clashes.map((d) => `${d.name} (${d.count} meshes)`).join('\n  '),
    );
  }
  return { byName, duplicates };
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
