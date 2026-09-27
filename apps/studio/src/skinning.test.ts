/**
 * The bone tints: layered, so the Align tab's segment and the inspector's bone can both be lit,
 * and painted on the drawn mesh, so a tint goes wherever the bone does.
 */

import type { SkeletonMesh } from '@bs-humany/render-three';
import { BufferGeometry, Color, Float32BufferAttribute, MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { createSkinnedSkeleton, paintTints } from './skinning.js';

const RED = new Color(1, 0, 0);
const BLUE = new Color(0, 0, 1);

/** Two vertices on bone 0 (`a`), three on bone 1 (`b`). */
const vertexBone = Float32Array.from([0, 0, 1, 1, 1]);
const indexOf = new Map([
  ['a', 0],
  ['b', 1],
]);

/** The colour of vertex `v`, as a triple. */
const at = (colours: Float32Array, v: number) => Array.from(colours.subarray(3 * v, 3 * v + 3));

describe('painting tint layers', () => {
  it('puts each layer on its own bones, and a later layer over an earlier one', () => {
    const colours = new Float32Array(5 * 3);
    paintTints(
      vertexBone,
      indexOf,
      [
        { bones: ['a', 'b'], colour: RED },
        { bones: ['b'], colour: BLUE },
      ],
      colours,
    );
    expect(at(colours, 0)).toEqual([1, 0, 0]);
    expect(at(colours, 1)).toEqual([1, 0, 0]);
    for (const v of [2, 3, 4]) expect(at(colours, v)).toEqual([0, 0, 1]);
  });

  it('turns everything back to white when the layers are cleared or empty', () => {
    const colours = new Float32Array(5 * 3);
    paintTints(vertexBone, indexOf, [{ bones: ['a'], colour: RED }], colours);
    paintTints(
      vertexBone,
      indexOf,
      [
        { bones: [], colour: RED },
        { bones: [], colour: BLUE },
      ],
      colours,
    );
    expect(Array.from(colours).every((c) => c === 1)).toBe(true);
    paintTints(vertexBone, indexOf, [{ bones: ['b'], colour: BLUE }], colours);
    paintTints(vertexBone, indexOf, [], colours);
    expect(Array.from(colours).every((c) => c === 1)).toBe(true);
  });

  it('paints nothing for an id that is not one of the bones', () => {
    const colours = new Float32Array(5 * 3);
    paintTints(vertexBone, indexOf, [{ bones: ['no_such_bone'], colour: RED }], colours);
    expect(Array.from(colours).every((c) => c === 1)).toBe(true);
  });
});

describe('the skinned skeleton', () => {
  it('writes the layers into the drawn mesh and asks for an upload', () => {
    const skeleton = {
      boneIndex: vertexBone,
      bones: [
        { id: 'a', vertexStart: 0, vertexCount: 2, worldTransform: identity() },
        { id: 'b', vertexStart: 2, vertexCount: 3, worldTransform: identity() },
      ],
    } as unknown as SkeletonMesh;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(5 * 3), 3));
    const skinned = createSkinnedSkeleton(skeleton, geometry, new MeshBasicMaterial());
    const colour = geometry.getAttribute('color') as Float32BufferAttribute;
    const before = colour.version;

    skinned.setTints([
      { bones: ['a'], colour: RED },
      { bones: ['b'], colour: BLUE },
    ]);
    expect([colour.getX(0), colour.getY(0), colour.getZ(0)]).toEqual([1, 0, 0]);
    expect([colour.getX(4), colour.getY(4), colour.getZ(4)]).toEqual([0, 0, 1]);
    expect(colour.version).toBeGreaterThan(before);

    skinned.setTints([]);
    expect([colour.getX(4), colour.getY(4), colour.getZ(4)]).toEqual([1, 1, 1]);
    skinned.dispose();
  });
});

function identity() {
  return { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
}
