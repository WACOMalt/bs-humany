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
import { DEFAULT_UPDATE_HZ } from '@bs-humany/modules-muscle';
import { Simulation } from '@bs-humany/session';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { Playback } from './playback.js';

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

    // The ring capture holds a frame a sweep, so the bone frame's tick is looked up among them;
    // the belly it finds is the one the live mesh is still showing, sweep or no sweep this tick.
    const rings = simulation.muscleCapture;
    const ringIndex = rings.indexForTick(simulation.capture.firstTick + last);
    expect(rings.frameCount).toBeLessThan(simulation.capture.frameCount);
    expect(simulation.ticks - rings.tickAt(ringIndex)).toBeLessThan(
      simulation.stepsPerSecond / DEFAULT_UPDATE_HZ,
    );
    const segments = live.verticesPerUnit / volume.rings;
    const belly = playback.bellyAt(
      rings,
      ringIndex,
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

  it('finds the frame a run time lands on, from a capture that started late', () => {
    // A capture whose first frame is tick 500, at 16.67 ticks a frame: the headset asks for a
    // time of the run, and the playhead counts from the capture's start.
    const perFrame = 1000 / 60;
    expect(Playback.frameOfTick(500, 500, perFrame)).toBe(0);
    for (const frame of [0, 1, 17, 59]) {
      const tick = 500 + Playback.tickOf(frame, perFrame);
      expect(Playback.frameOfTick(tick, 500, perFrame)).toBe(frame);
    }
    // Before the capture is a negative frame, which the caller clamps; a rate of nothing is 0.
    expect(Playback.frameOfTick(0, 500, perFrame)).toBeLessThan(0);
    expect(Playback.frameOfTick(900, 500, 0)).toBe(0);
  });

  it('is at the newest frame while live, whatever the playhead was left at', () => {
    // The playhead was put on frame 3 by a scrub, then the run went live and carried on to a
    // hundred frames. Live, the frame on screen is the newest; a frame back from there is 98,
    // not 2 -- which is what stepping back from the stale playhead used to give.
    const playback = new Playback();
    playback.frame = 3;
    expect(playback.at(100, true)).toBe(99);
    expect(playback.at(100, false)).toBe(3);
    // Off the live edge it is the playhead, clamped into the capture as `clampedFrame` has it.
    playback.frame = 250;
    expect(playback.at(100, false)).toBe(99);
    expect(playback.at(100, false)).toBe(playback.clampedFrame(100));
    // Nothing captured is frame 0 either way, never -1.
    expect(playback.at(0, true)).toBe(0);
    expect(playback.at(0, false)).toBe(0);
  });

  it('counts an empty capture as live unless it was stopped, and a stopped one behind the run as not', () => {
    // A carry, a session load and a restore clear the capture and leave the run paused where it
    // was: the next tick is the capture's first, so ▶ there computes a frame rather than going
    // "back to live" without one.
    expect(Playback.atLiveEdge({ frameCount: 0, firstTick: 0 }, false, 812)).toBe(true);
    expect(Playback.atLiveEdge({ frameCount: 0, firstTick: 0 }, true, 812)).toBe(false);
    // Holding frames, it is the newest frame's tick against the run's, stopped or not.
    expect(Playback.atLiveEdge({ frameCount: 100, firstTick: 500 }, false, 599)).toBe(true);
    expect(Playback.atLiveEdge({ frameCount: 100, firstTick: 500 }, true, 599)).toBe(true);
    expect(Playback.atLiveEdge({ frameCount: 100, firstTick: 500 }, true, 640)).toBe(false);
  });

  it('turns a frame into the run tick it shows and back, from a capture that started late', () => {
    // The timeline's clock is the run's: a capture that began at tick 500 after a carry shows
    // frame 0 at 0.5 s of the run, not at 0 s.
    for (const [firstTick, perFrame] of [
      [0, 1000 / 60],
      [500, 1000 / 60],
      [37, 500 / 24],
      [1, 2],
    ] as const) {
      expect(Playback.runTickOf(0, firstTick, perFrame)).toBe(firstTick);
      for (const frame of [0, 1, 17, 59, 600]) {
        const tick = Playback.runTickOf(frame, firstTick, perFrame);
        expect(tick - firstTick).toBe(Playback.tickOf(frame, perFrame));
        expect(Playback.frameOfTick(tick, firstTick, perFrame)).toBe(frame);
      }
    }
  });

  it('hands out a frame’s rings in arrays it keeps, and nothing for a frame it lacks', () => {
    const frames = 3;
    const ringCount = 4;
    const rings = {
      frameCount: frames,
      ringCount,
      frameInto(
        index: number,
        position: Float32Array,
        orientation: Float32Array,
        radius: Float32Array,
      ) {
        if (index < 0 || index >= frames) return false;
        position.fill(index);
        orientation.fill(index + 0.5);
        radius.fill(index / 10);
        return true;
      },
    };
    const playback = new Playback();
    const first = playback.ringsAt(rings, 1);
    if (!first) throw new Error('no rings for frame 1');
    expect(first.position).toHaveLength(ringCount * 3);
    expect(first.orientation).toHaveLength(ringCount * 4);
    expect(Array.from(first.radius)).toEqual([0.1, 0.1, 0.1, 0.1].map(Math.fround));
    // The next read is into the same arrays, handed out in the same object: once a run has been
    // read, replaying it to the headset allocates nothing a frame.
    const second = playback.ringsAt(rings, 2);
    expect(second).toBe(first);
    expect(first.position[0]).toBe(2);
    expect(playback.ringsAt(rings, 3)).toBeUndefined();
    expect(playback.ringsAt({ ...rings, ringCount: 0 }, 0)).toBeUndefined();
  });
});
