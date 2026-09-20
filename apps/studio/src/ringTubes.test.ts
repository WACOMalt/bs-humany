/**
 * The bellies of a body on the bridge: which way their faces point, and that they leave the
 * scene when they are done with.
 */

import { Group } from 'three';
import { describe, expect, it } from 'vitest';
import { RingTubes } from './ringTubes.js';

/** Volume enclosed by the mesh, by the divergence theorem: positive when the faces point out. */
function signedVolume(tubes: RingTubes): number {
  const geometry = tubes.mesh.geometry;
  const position = geometry.getAttribute('position').array as Float32Array;
  const index = geometry.getIndex()?.array as ArrayLike<number>;
  let total = 0;
  for (let i = 0; i + 2 < index.length; i += 3) {
    const at = (k: number) => 3 * (index[i + k] as number);
    const p = (k: number, o: number) => position[at(k) + o] as number;
    total +=
      (p(0, 0) * (p(1, 1) * p(2, 2) - p(1, 2) * p(2, 1)) +
        p(0, 1) * (p(1, 2) * p(2, 0) - p(1, 0) * p(2, 2)) +
        p(0, 2) * (p(1, 0) * p(2, 1) - p(1, 1) * p(2, 0))) /
      6;
  }
  return total;
}

describe('the bridge tubes', () => {
  it('wind outward, so a belly is seen from outside rather than through', () => {
    // A straight tube along +Z: rings at the identity, so the ring frame's X and Y are across it.
    const rings = 6;
    const segments = 12;
    const tubes = new RingTubes(1, rings, segments);
    const position = new Float32Array(3 * rings);
    const orientation = new Float32Array(4 * rings);
    const radius = new Float32Array(rings);
    for (let r = 0; r < rings; r++) {
      position[3 * r + 2] = 0.03 * r;
      orientation[4 * r + 3] = 1;
      radius[r] = 0.02;
    }
    tubes.update(position, orientation, radius);
    // Inside out this is the same number negated, which is the whole of the difference on screen.
    expect(signedVolume(tubes)).toBeGreaterThan(0);
    tubes.dispose();
  });

  it('leave the scene when disposed, whatever they were added to', () => {
    // The bug this is here for: added to one group and removed from another, the bellies of a
    // finished training run stayed on screen over every run that followed.
    const parent = new Group();
    const tubes = new RingTubes(1, 3, 6);
    parent.add(tubes.mesh);
    expect(parent.children).toHaveLength(1);
    tubes.dispose();
    expect(parent.children).toHaveLength(0);
    expect(tubes.mesh.parent).toBeNull();
  });
});
