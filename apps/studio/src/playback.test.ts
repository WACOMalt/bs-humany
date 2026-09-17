/**
 * Whether what comes back off the playhead is what the simulation had.
 *
 * The claim playback rests on is that the capture is enough: bones are stored outright, and a
 * muscle belly is recoverable from its rings because a ring is a circle in a measured frame. If
 * either is out, a run watched back is not the run, and the screenshot somebody took of it is of
 * nothing.
 *
 * So both are checked against the live state at the same tick, in millimetres.
 */

import { fileURLToPath } from 'node:url';
import { resolveMorphology } from '@bs-humany/anthropometry';
import { loadSkeletonAssetsFromDisk } from '@bs-humany/assets-anatomical';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { Playback } from './playback.js';
import { Simulation } from './simulation.js';

const document = buildDocument();
const assets = await loadSkeletonAssetsFromDisk(
  fileURLToPath(new URL('../../../packages/assets-anatomical/data', import.meta.url)),
);

async function running(ticks: number): Promise<Simulation> {
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
      muscles: true,
      outputFramerate: 60,
    },
  );
  await simulation.start();
  for (let t = 0; t < ticks; t++) simulation.tick();
  return simulation;
}

describe('playing a capture back', () => {
  it('puts the bones and the bellies where the simulation had them', async () => {
    const simulation = await running(30);
    expect(assets.manifest.bones.length).toBeGreaterThan(0);
    const volume = simulation.muscleVolume;
    const live = simulation.muscleMesh();
    const units = simulation.muscles?.units.length ?? 0;
    if (!volume || !live) throw new Error('the simulation has no muscle mesh');

    const playback = new Playback();
    expect(playback.units(units)).toHaveLength(units);
    // The last captured frame is the tick the simulation is sitting on, so the two are comparable
    // without stepping either.
    const last = simulation.capture.frameCount - 1;
    expect(last).toBe(simulation.ticks - 1);

    const bones = playback.bonesAt(simulation.capture, last);
    if (!bones) throw new Error('no bone frame');
    const liveBones = simulation.boneTransforms();
    let worstBone = 0;
    for (let i = 0; i < bones.position.length; i++) {
      worstBone = Math.max(
        worstBone,
        Math.abs((bones.position[i] as number) - (liveBones.position[i] as number)),
      );
    }
    // Single precision over a body two metres across: a few microns, not a few millimetres.
    expect(worstBone).toBeLessThan(1e-4);

    const segments = live.verticesPerUnit / volume.rings;
    const belly = playback.bellyAt(
      simulation.muscleCapture,
      last,
      { index: live.index, verticesPerUnit: live.verticesPerUnit },
      volume.rings,
      segments,
    );
    if (!belly) throw new Error('no belly frame');
    expect(belly.position.length).toBe(live.position.length);
    let worstVertex = 0;
    for (let i = 0; i < belly.position.length; i++) {
      worstVertex = Math.max(
        worstVertex,
        Math.abs((belly.position[i] as number) - (live.position[i] as number)),
      );
    }
    // A belly is centimetres across and the rings were measured off this very mesh, so what is
    // left is the single precision the capture stores and nothing else.
    expect(worstVertex).toBeLessThan(1e-4);
    simulation.dispose();
  }, 60_000);

  it('counts output frames rather than ticks, and stops at the end', () => {
    // A thousand ticks at 60 fps output is 16.67 ticks a frame. Frame 59 sits on tick 983 and
    // frame 60 would want tick 1000, which the capture does not have -- so sixty frames, and the
    // partial frame at the end is not one.
    expect(Playback.frames(1000, 1000 / 60)).toBe(60);
    expect(Playback.tickOf(0, 1000 / 60)).toBe(0);
    expect(Playback.tickOf(59, 1000 / 60)).toBe(983);
    expect(Playback.frames(0, 16.67)).toBe(0);
    // One tick is one frame however fine the output rate is: there is something to look at.
    expect(Playback.frames(1, 16.67)).toBe(1);

    const playback = new Playback();
    playback.playing = true;
    // Half a second at 24 fps is twelve frames, and it stops rather than running off the end.
    playback.advance(0.5, 24, 60);
    expect(playback.clampedFrame(60)).toBe(12);
    expect(playback.playing).toBe(true);
    playback.advance(10, 24, 60);
    expect(playback.clampedFrame(60)).toBe(59);
    expect(playback.playing).toBe(false);
  });
});
