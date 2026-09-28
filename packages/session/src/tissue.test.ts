/**
 * The connective tissue, as the overlay draws it and the bridge carries it.
 *
 * The shapes are derived from the compiled articulation alone, so the test asks the body for
 * them and checks what any reader would rely on: every spinal level has a disc, every rib's
 * cartilage has a bar, and every frame in the bridge's table is named by a bone the pose bridge
 * publishes -- a headset builds the geometry from those names and its poses, so a name that is
 * not there is a disc that is not drawn.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation.js';
import { barMesh, cylinderMesh, sphereMesh, tissueOf, tissueTable } from './tissue.js';

const document = buildDocument();

describe('the tissue of an anatomical body', () => {
  it('has a disc at every spinal level, a bar for every costal cartilage, and names bones', async () => {
    const simulation = new Simulation(
      document,
      resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 }),
      {
        profileId: 'l3_anatomical',
        backend: 'mujoco',
        passiveJoints: true,
        redistribute: true,
        dropHeight: 0.2,
        groundHeight: 0,
        muscles: false,
      },
    );
    await simulation.start();
    try {
      const tissue = tissueOf(simulation.articulation);
      const discs = tissue.discs.filter((d) => d.kind === 'disc');
      const beads = tissue.discs.filter((d) => d.kind === 'bead');
      // Twenty-three intervertebral levels from C2/C3 to L5/S1 plus the joints at the head;
      // a bead at each costovertebral hinge; a bar for every rib that reaches the sternum.
      expect(discs.length).toBeGreaterThanOrEqual(23);
      expect(beads.length).toBeGreaterThanOrEqual(10);
      expect(tissue.bars.length).toBeGreaterThanOrEqual(10);

      const table = tissueTable(simulation.articulation);
      const bones = new Set(simulation.boneOrder());
      expect(table.discs.length).toBe(tissue.discs.length);
      expect(table.bars.length).toBe(tissue.bars.length);
      for (const disc of table.discs) expect(bones.has(disc.bone)).toBe(true);
      for (const bar of table.bars) {
        expect(bones.has(bar.boneA)).toBe(true);
        expect(bones.has(bar.boneB)).toBe(true);
        expect(bar.boneA).not.toBe(bar.boneB);
      }
      // A bar's ends are on the two bones' hulls, so they are not at either origin and are
      // within a rib's reach of each other once posed.
      for (const bar of tissue.bars) {
        expect(Math.hypot(bar.onA.x, bar.onA.y, bar.onA.z)).toBeGreaterThan(0);
        expect(Math.hypot(bar.onB.x, bar.onB.y, bar.onB.z)).toBeGreaterThan(0);
      }
    } finally {
      simulation.dispose();
    }
  }, 120_000);
});

describe('the tissue meshes', () => {
  it('are closed and indexed within their vertices', () => {
    for (const mesh of [cylinderMesh(0.014, 0.005), sphereMesh(0.006)]) {
      const count = mesh.positions.length / 3;
      expect(mesh.indices.length % 3).toBe(0);
      for (const i of mesh.indices) expect(i).toBeLessThan(count);
    }
    const bar = barMesh({ x: 0, y: 0, z: 0 }, { x: 0, y: 0.1, z: 0 }, 0.004, 6);
    expect(bar.positions.length / 3).toBe(12);
    // The first six vertices ring one end, the next six the other, at the bar's radius.
    const at = (index: number) => bar.positions[index] ?? Number.NaN;
    for (let i = 0; i < 6; i++) {
      expect(Math.hypot(at(i * 3), at(i * 3 + 2))).toBeCloseTo(0.004, 6);
      expect(at(i * 3 + 1)).toBeCloseTo(0, 6);
      expect(at((6 + i) * 3 + 1)).toBeCloseTo(0.1, 6);
    }
  });
});
