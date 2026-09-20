/**
 * The tissue of a body on the bridge: placed from the publisher's table and somebody else's
 * poses, and it has to land where the bones do.
 */

import { describe, expect, it } from 'vitest';
import { FollowTissue } from './followTissue.js';
import type { TissueTable } from './tissue.js';

const table: TissueTable = {
  discs: [
    { bone: 'l5', kind: 'disc', position: [0, 0.1, 0], rotation: [0, 0, 0, 1] },
    { bone: 'rib_2_r', kind: 'bead', position: [0.02, 0, 0], rotation: [0, 0, 0, 1] },
    { bone: 'nowhere', kind: 'disc', position: [0, 0, 0], rotation: [0, 0, 0, 1] },
  ],
  bars: [
    { boneA: 'l5', localA: [0, 0, 0], boneB: 'rib_2_r', localB: [0, 0, 0] },
    { boneA: 'l5', localA: [0, 0, 0], boneB: 'nowhere', localB: [0, 0, 0] },
  ],
};
const bones = ['l5', 'rib_2_r'];

describe('the tissue of a followed body', () => {
  it('places each shape on its bone and leaves out what names a bone the poses have not got', () => {
    const tissue = new FollowTissue(table, bones);
    // Two of the three discs, and one of the two bars: the rest name a bone nobody published.
    const meshes = tissue.root.children.filter((c) => c.type === 'Mesh');
    expect(meshes.length).toBe(2);

    // l5 a metre up, the rib half a metre up and a quarter forward, both unturned.
    const position = Float64Array.from([0, 1, 0, 0.25, 0.5, 0]);
    const orientation = Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1]);
    tissue.update(position, orientation);
    expect(meshes[0]?.position.toArray()).toEqual([0, 1.1, 0]);
    expect(meshes[1]?.position.toArray()).toEqual([0.27, 0.5, 0]);

    // The one bar runs from l5's origin to the rib's.
    const lines = tissue.root.children.find((c) => c.type === 'LineSegments');
    const drawn = (lines as { geometry: { drawRange: { count: number } } }).geometry.drawRange;
    expect(drawn.count).toBe(2);
    const points = (
      lines as { geometry: { getAttribute(name: string): { array: Float32Array } } }
    ).geometry.getAttribute('position').array;
    expect([...points.slice(0, 6)]).toEqual([0, 1, 0, 0.25, 0.5, 0]);

    // Turned a half turn about Y, the rib's bead goes to the other side of it.
    orientation.set([0, 1, 0, 0], 4);
    tissue.update(position, orientation);
    expect(meshes[1]?.position.x).toBeCloseTo(0.23, 9);
    tissue.dispose();
  });
});
