/**
 * Whether the one ring sweep puts a belly back where the simulation had it.
 *
 * The replayed bellies, the tubes of a followed body and the Blender export's vertex cache all
 * come from `sweepRings` now, so this is the check all three rest on: take a real ring frame out
 * of the capture, sweep it, and compare every vertex and normal with the swept mesh the
 * simulation is showing at that tick. And the renderer's single-precision attributes must get the
 * same belly as the double-precision meshes the playhead and the export build.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { sweepRings } from './ringSweep.js';
import { Simulation } from './simulation.js';

function worst(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out = Math.max(out, Math.abs((a[i] as number) - (b[i] as number)));
  }
  return out;
}

describe('sweeping rings back into bellies', () => {
  it('reproduces the simulation’s swept mesh from a captured ring frame', async () => {
    const simulation = new Simulation(
      buildDocument(),
      resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 }),
      {
        profileId: 'l3_anatomical',
        backend: 'mujoco',
        passiveJoints: true,
        redistribute: true,
        dropHeight: 0.2,
        groundHeight: 0,
        muscles: true,
        outputFramerate: 60,
      },
    );
    await simulation.start();
    for (let t = 0; t < 30; t++) simulation.tick();
    const volume = simulation.muscleVolume;
    const live = simulation.muscleMesh();
    if (!volume || !live) throw new Error('the simulation has no muscle mesh');

    // The newest ring frame is the belly the live mesh is still showing, sweep or no sweep on
    // the tick the simulation is sitting on.
    const rings = simulation.muscleCapture;
    const count = rings.ringCount;
    const index = rings.indexForTick(simulation.ticks - 1);
    const position = new Float32Array(count * 3);
    const orientation = new Float32Array(count * 4);
    const radius = new Float32Array(count);
    expect(rings.frameInto(index, position, orientation, radius)).toBe(true);

    const segments = live.verticesPerUnit / volume.rings;
    const vertices = count * segments;
    const wide = {
      position: new Float64Array(vertices * 3),
      normal: new Float64Array(vertices * 3),
    };
    sweepRings(position, orientation, radius, count, segments, wide.position, wide.normal);
    expect(wide.position.length).toBe(live.position.length);
    // Positions to a micron: what is left is the single precision the capture stores.
    expect(worst(wide.position, live.position)).toBeLessThan(1e-6);
    // A normal is to the same micron at the ring's rim. The ring's frame was measured off the
    // mesh's single-precision vertices, so its direction is as good as a vertex over the ring's
    // radius -- a few parts in a hundred thousand on the thinnest tendon, which is the
    // extraction's rounding and not the sweep's. Scaled by the radius, it is the vertex error.
    let normalAtRim = 0;
    for (let ring = 0; ring < count; ring++) {
      const r = radius[ring] as number;
      for (let i = 3 * ring * segments; i < 3 * (ring + 1) * segments; i++) {
        const off = Math.abs((wide.normal[i] as number) - (live.normal[i] as number));
        normalAtRim = Math.max(normalAtRim, r * off);
      }
    }
    expect(normalAtRim).toBeLessThan(1e-6);
    expect(worst(wide.normal, live.normal)).toBeLessThan(1e-4);

    // The renderer's attributes are single precision; they get the same belly, rounded.
    const narrow = {
      position: new Float32Array(vertices * 3),
      normal: new Float32Array(vertices * 3),
    };
    sweepRings(position, orientation, radius, count, segments, narrow.position, narrow.normal);
    expect(worst(narrow.position, wide.position)).toBeLessThan(1e-6);
    expect(worst(narrow.normal, wide.normal)).toBeLessThan(1e-6);
    simulation.dispose();
  }, 60_000);
});
