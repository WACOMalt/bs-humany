import { BufferGeometry, Group, Mesh, Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { allNodes, indexMeshesByName } from './fbx.js';

/**
 * A stand-in for an export: two meshes named `Femurr` -- the bone, and a second mesh under a
 * feature group that happens to share its name -- beside a uniquely named one and a non-mesh node
 * that shares the name too, which must not count.
 */
function exportWithADuplicate(): Group {
  const root = new Group();
  const bone = new Mesh(new BufferGeometry());
  bone.name = 'Femurr';
  const feature = new Group();
  feature.name = 'Head_of_femurt';
  const patch = new Mesh(new BufferGeometry());
  patch.name = 'Femurr';
  feature.add(patch);
  bone.add(feature);
  const tibia = new Mesh(new BufferGeometry());
  tibia.name = 'Tibiar';
  const empty = new Object3D();
  empty.name = 'Tibiar';
  root.add(bone, tibia, empty);
  return root;
}

describe('indexMeshesByName', () => {
  it('reports a name two meshes share, and counts only meshes', () => {
    const { byName, duplicates } = indexMeshesByName(
      allNodes(exportWithADuplicate()),
      new Set(['Tibiar']),
    );
    expect(duplicates).toEqual([{ name: 'Femurr', count: 2 }]);
    expect(byName.get('Tibiar')?.name).toBe('Tibiar');
  });

  it('refuses a duplicated name the ingest looks up, and names it', () => {
    expect(() =>
      indexMeshesByName(allNodes(exportWithADuplicate()), new Set(['Femurr', 'Tibiar'])),
    ).toThrow(/Femurr \(2 meshes\)/);
  });

  it('lets a duplicate through when nothing looks it up', () => {
    expect(() =>
      indexMeshesByName(allNodes(exportWithADuplicate()), new Set(['Tibiar'])),
    ).not.toThrow();
  });
});
