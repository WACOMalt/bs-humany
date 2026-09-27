/**
 * What comes out of the Blender export, checked against what the simulation had.
 *
 * The bones are the easy half: they are rigid, so a node with a mesh and two keyframe channels
 * says everything about them, and the writer's own tests cover that. The muscles are the half
 * worth a test here, because nothing about them is rigid -- a belly is swept anew along its path
 * -- and what makes them exportable at all is the claim that a belly is rigid *ring by ring*: the
 * ring capture holds each ring's frame at every sweep, and every vertex is rebuilt from those.
 *
 * They leave as one mesh and a PC2 vertex cache beside the file, one sample per output frame. So
 * the tests read the cache that was written and compare its vertices against the mesh the
 * simulation actually had on each sample's tick. If the ring frames, the tick each was taken at,
 * the axis conversion or the sampling disagreed anywhere, the vertices would land somewhere else.
 */

import { fileURLToPath } from 'node:url';
import { resolveMorphology } from '@bs-humany/anthropometry';
import { loadSkeletonAssetsFromDisk } from '@bs-humany/assets-anatomical';
import { PC2_HEADER_BYTES, readGlb } from '@bs-humany/export-gltf';
import { DEFAULT_UPDATE_HZ } from '@bs-humany/modules-muscle';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { buildBlenderExport, exportStride, sampleCount } from './blenderExport.js';
import { MAX_TICKS_PER_ADVANCE, Simulation } from './simulation.js';

const document = buildDocument();
const assets = await loadSkeletonAssetsFromDisk(
  fileURLToPath(new URL('../../../packages/assets-anatomical/data', import.meta.url)),
);

async function running(
  ticks: number,
  captureBudgetBytes?: number,
  rates: { outputFramerate?: number; stepsPerSecond?: number } = {},
): Promise<Simulation> {
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
      captureBudgetBytes,
      ...rates,
    },
  );
  await simulation.start();
  for (let t = 0; t < ticks; t++) simulation.tick();
  return simulation;
}

interface Gltf {
  nodes: { name: string; extras?: Record<string, unknown>; mesh?: number; skin?: number }[];
  meshes: { primitives: { attributes: Record<string, number> }[] }[];
  skins?: { joints: number[]; inverseBindMatrices: number }[];
  accessors: { bufferView: number; count: number; type: string }[];
  bufferViews: { byteOffset: number; byteLength: number }[];
  animations: {
    channels: { sampler: number; target: { node: number; path: string } }[];
    samplers: { input: number; output: number }[];
  }[];
}

const floats = (json: Gltf, binary: Uint8Array, accessor: number): Float32Array => {
  const view = json.bufferViews[json.accessors[accessor]?.bufferView ?? 0];
  if (!view) return new Float32Array(0);
  return new Float32Array(
    binary.buffer.slice(
      binary.byteOffset + view.byteOffset,
      binary.byteOffset + view.byteOffset + view.byteLength,
    ),
  );
};

describe('the Blender export, with muscles', () => {
  it('carries one belly mesh, the bones, and nothing skinned', async () => {
    const simulation = await running(40);
    const exported = buildBlenderExport(simulation, document, assets);
    const { json } = readGlb(exported.glb) as unknown as { json: Gltf };

    const volume = simulation.muscleVolume;
    const units = simulation.muscles?.units.length ?? 0;
    if (!volume) throw new Error('the simulation has no muscle volume');
    const belly = json.nodes.find((n) => n.name === 'muscles');
    expect(belly?.mesh).toBeDefined();
    expect(units).toBeGreaterThan(0);
    // One mesh holding every unit, rather than one mesh each: a Mesh Cache modifier is per object
    // and a hundred and forty-eight of them is a hundred and forty-eight file handles.
    expect(json.nodes.filter((n) => n.name.startsWith('muscle__'))).toHaveLength(0);
    const positions = json.meshes[belly?.mesh as number]?.primitives[0]?.attributes.POSITION;
    expect(json.accessors[positions as number]?.count).toBe(units * volume.rings * volume.segments);
    // And the skeleton is still there, which a muscle change must not cost.
    expect(json.nodes.some((n) => n.name === 'humerus_r')).toBe(true);
    simulation.dispose();
  }, 60_000);

  it('runs the same ticks per frame however long the frames took', async () => {
    // "Play every frame", pinned. `advance` takes an elapsed time and must not pace by it: what a
    // frame advances is one output frame's worth of simulated time. So a run fed a jittering
    // clock -- a browser stalling on garbage collection, a tab in the background -- has to land on
    // exactly the tick a run fed a steady one did, or a capture is at the mercy of how busy the
    // machine was when it was taken.
    const steady = await running(0, undefined, { outputFramerate: 30 });
    for (let f = 0; f < 20; f++) steady.advance(1 / 60);
    const jittery = await running(0, undefined, { outputFramerate: 30 });
    const stalls = [0, 0.001, 2.5, 0.016, 0.4, 0.0001, 1, 0.016, 0.016, 0.9];
    for (let f = 0; f < 20; f++) jittery.advance(stalls[f % stalls.length] as number);

    // Twenty frames at 30 fps output is two thirds of a second, whatever the clock did. The
    // fractional tick is carried rather than rounded per frame, so the total is the floor of the
    // whole sum and not the sum of twenty roundings.
    expect(steady.ticks).toBe(jittery.ticks);
    expect(steady.ticks).toBe(Math.floor((20 / 30) * steady.stepsPerSecond));
    expect(steady.capture.frameCount).toBe(steady.ticks);
    expect(jittery.capture.frameCount).toBe(jittery.ticks);
    steady.dispose();
    jittery.dispose();
  }, 60_000);

  it('spreads an output frame worth more than the cap over several advances', async () => {
    // 2000 steps a second into 1 frame a second is two thousand ticks in one output frame: at L3
    // with the muscles, seconds in which the page answers nothing. The cap is a count of ticks,
    // never of milliseconds, so how far each call gets is still independent of the clock -- and
    // the output frame is still all there, only over more rendered frames.
    const simulation = await running(0, undefined, { stepsPerSecond: 2000, outputFramerate: 1 });
    expect(MAX_TICKS_PER_ADVANCE).toBe(60);
    expect(simulation.advance(5).ticks).toBe(MAX_TICKS_PER_ADVANCE);
    expect(simulation.ticks).toBe(MAX_TICKS_PER_ADVANCE);
    for (let call = 1; call < Math.ceil(2000 / MAX_TICKS_PER_ADVANCE); call++) {
      simulation.advance(0.001);
    }
    expect(simulation.ticks).toBe(2000);
    expect(simulation.capture.frameCount).toBe(simulation.ticks);
    // And the next output frame begins only once this one is paid off.
    expect(simulation.advance(1).ticks).toBe(MAX_TICKS_PER_ADVANCE);
    expect(simulation.ticks).toBe(2000 + MAX_TICKS_PER_ADVANCE);
    simulation.dispose();
  }, 120_000);

  it('gives the timeline a second for every simulated second, at either rate', async () => {
    // The timing contract, from the capture through to the scene the script sets up. Sixty steps
    // and 30 fps out: half a second of run, half a second of timeline, and sixty keyframes still
    // in it rather than thirty -- the output rate divides the timeline, it does not resample the
    // motion.
    const simulation = await running(60, undefined, { outputFramerate: 30, stepsPerSecond: 120 });
    expect(simulation.stepsPerSecond).toBe(120);
    const exported = buildBlenderExport(simulation, document, assets);
    expect(exported.rate).toBe(120);
    expect(exported.outputFramerate).toBe(30);
    expect(exported.seconds).toBeCloseTo(0.5, 6);
    expect(exported.frames).toBe(60);
    expect(exported.script).toContain('scene.render.fps = 30');
    expect(exported.script).toContain('scene.frame_end = 15');

    // And in the file itself: keyframe times are tick over step rate, in seconds, evenly spaced.
    const { json, binary } = readGlb(exported.glb) as unknown as { json: Gltf; binary: Uint8Array };
    const sampler = json.animations[0]?.samplers[0];
    const times = floats(json, binary, sampler?.input as number);
    expect(times).toHaveLength(60);
    expect(times[0]).toBeCloseTo(0, 6);
    expect(times[59]).toBeCloseTo(59 / 120, 6);
    simulation.dispose();
  }, 60_000);

  it('sends the bellies as a streamed cache rather than as armature keyframes', async () => {
    // The change this file exists to pin. As skinned meshes over one bone per cross-section the
    // muscles were 96% of every animation channel, and six tenths of a second of them cost 4.3 GB
    // of Blender. Now they are one mesh and a PC2 the Mesh Cache modifier streams from disk.
    const simulation = await running(120);
    const units = simulation.muscles?.units.length ?? 0;
    const volume = simulation.muscleVolume;
    if (!volume) throw new Error('the simulation has no muscle volume');
    const exported = buildBlenderExport(simulation, document, assets);
    const { json } = readGlb(exported.glb) as unknown as { json: Gltf };

    // No belly skins, no ring joints, no per-unit belly objects: one mesh named for what it is.
    // The only skins left are the costal cartilage, one bar a weld, each end bound to a bone.
    const skinned = json.nodes.filter((n) => n.skin !== undefined);
    expect(skinned.every((n) => n.name.startsWith('cartilage__'))).toBe(true);
    expect(json.skins ?? []).toHaveLength(skinned.length);
    expect(json.nodes.filter((n) => /__ring\d+$/.test(n.name))).toHaveLength(0);
    const belly = json.nodes.find((n) => n.name === 'muscles');
    expect(belly?.mesh).toBeDefined();

    // The cache is one sample per output frame and one point per vertex of that mesh.
    const points = units * volume.rings * volume.segments;
    if (!exported.pointCache) throw new Error('no vertex cache');
    const view = new DataView(
      exported.pointCache.bytes.buffer,
      exported.pointCache.bytes.byteOffset,
      exported.pointCache.bytes.byteLength,
    );
    expect(new TextDecoder().decode(exported.pointCache.bytes.subarray(0, 11))).toBe('POINTCACHE2');
    expect(view.getInt32(16, true)).toBe(points);
    const samples = view.getInt32(28, true);
    expect(samples).toBe(Math.floor(((120 - 1) * exported.outputFramerate) / exported.rate) + 1);
    expect(exported.pointCache.bytes.length).toBe(PC2_HEADER_BYTES + points * samples * 12);
    expect(exported.pointCache.name.endsWith('.pc2')).toBe(true);

    // And the animation is now the bones alone, which is what made it affordable.
    const channels = json.animations[0]?.channels.length ?? 0;
    expect(channels).toBeLessThan(600);
    // The provenance says so too, rather than describing the skinned bellies that went.
    const scene = (json as unknown as { scenes: { extras?: { hierarchy?: string } }[] }).scenes[0];
    expect(scene?.extras?.hierarchy).toContain('.pc2');
    expect(scene?.extras?.hierarchy).not.toContain('ring at a time');
    simulation.dispose();
  }, 60_000);

  it('thins the keyframes when one output frame would hold more than the ceiling', async () => {
    // A thousand steps a second into twelve frames a second is 83 samples inside one frame. The
    // ceiling is 50, so every second step is kept and the timing does not move: sample 2k is
    // still at 2k/1000 seconds.
    expect(exportStride(1000, 60)).toBe(1);
    expect(exportStride(1000, 12)).toBe(2);
    expect(exportStride(2000, 10)).toBe(4);
    expect(sampleCount(120, 2)).toBe(60);
    expect(sampleCount(0, 2)).toBe(0);

    const simulation = await running(120, undefined, { outputFramerate: 12 });
    const exported = buildBlenderExport(simulation, document, assets);
    expect(exported.stride).toBe(2);
    expect(exported.frames).toBe(60);
    // Half the keyframes, the same span of seconds.
    expect(exported.seconds).toBeCloseTo(120 / exported.rate, 6);
    const { json, binary } = readGlb(exported.glb) as unknown as { json: Gltf; binary: Uint8Array };
    const times = floats(json, binary, json.animations[0]?.samplers[0]?.input as number);
    expect(times).toHaveLength(60);
    expect(times[1]).toBeCloseTo(2 / exported.rate, 6);
    expect(times[59]).toBeCloseTo(118 / exported.rate, 6);
    simulation.dispose();
  }, 60_000);

  it('keeps the bellies when the ring capture runs out of budget first', async () => {
    // The regression. A frame of rings is about twenty times a frame of bones -- a hundred and
    // forty-eight units at twenty-four cross-sections apiece against a couple of hundred bodies
    // -- and the two captures were given the same budget, so the rings stopped after about five
    // seconds of simulated time while the bones went on to ninety. The export tested the two
    // lengths for equality and, finding them different, wrote every bone and not one muscle,
    // with nothing anywhere saying why: what came out was a file whose Muscles collection was
    // empty.
    //
    // A budget of one frame's worth of rings, so the limit is reached on the second sweep.
    const simulation = await running(1);
    const perFrame = simulation.muscleCapture.bytes;
    simulation.dispose();
    expect(perFrame).toBeGreaterThan(0);

    const short = await running(40, perFrame + 1);
    expect(short.muscleCapture.full).toBe(true);
    expect(short.muscleCapture.frameCount).toBe(1);
    // Both stopped, over the same span of ticks: that is the invariant the exporter reads. The
    // bones run on to the tick before the sweep the rings refused, and not one tick past it.
    const lastBoneTick = short.capture.firstTick + short.capture.frameCount - 1;
    const refused = lastBoneTick + 1;
    expect(short.capture.frameCount).toBeGreaterThan(1);
    expect(short.capture.frameCount).toBeLessThan(40);
    expect(short.muscleCapture.indexForTick(lastBoneTick)).toBe(0);
    expect(refused - short.muscleCapture.lastTick).toBe(
      Math.floor(short.stepsPerSecond / DEFAULT_UPDATE_HZ),
    );
    expect(short.capturesStoppedBy).toBe('muscles');

    const exported = buildBlenderExport(short, document, assets);
    const { json } = readGlb(exported.glb) as unknown as { json: Gltf };
    expect(json.nodes.find((n) => n.name === 'muscles')?.mesh).toBeDefined();
    expect(exported.pointCache).toBeDefined();
    short.dispose();
  }, 60_000);

  it('puts every vertex of the cache where the sweep had it, in Blender axes', async () => {
    // The whole chain in one assertion, as before, but a shorter chain: the swept mesh, the ring
    // frames measured off it, the cache written from those. The skinning that used to sit in the
    // middle -- inverse bind matrices, per-ring weights -- is gone, and with it the only thing in
    // this file that could be subtly wrong without being obviously wrong.
    const simulation = await running(1);
    const live = simulation.muscleMesh();
    const volume = simulation.muscleVolume;
    if (!live || !volume) throw new Error('the simulation has no muscle mesh');
    const exported = buildBlenderExport(simulation, document, assets);
    if (!exported.pointCache) throw new Error('no vertex cache');

    const bytes = exported.pointCache.bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const points = view.getInt32(16, true);
    expect(points).toBe(live.position.length / 3);

    // Through the axis conversion, which is the part that was wrong for a commit: glTF is +Y up
    // and Blender is +Z up, the importer bakes `(x, y, z) -> (x, -z, y)` into mesh data, and a
    // cache read by a modifier never passes through the importer. Written unconverted the bellies
    // land ninety degrees about X from the bones, and every check that compared the cache against
    // itself said it was perfect.
    let worst = 0;
    for (let v = 0; v < points; v++) {
      const at = PC2_HEADER_BYTES + v * 12;
      const wanted = [
        live.position[v * 3] as number,
        -(live.position[v * 3 + 2] as number),
        live.position[v * 3 + 1] as number,
      ];
      for (let k = 0; k < 3; k++) {
        worst = Math.max(
          worst,
          Math.abs(view.getFloat32(at + k * 4, true) - (wanted[k] as number)),
        );
      }
    }
    // The cache is single precision, which over a belly centimetres across is microns.
    expect(worst).toBeLessThan(1e-4);
    simulation.dispose();
  }, 60_000);

  it('samples the bellies each output frame had, from a capture taken once a sweep', async () => {
    // The ring capture holds a frame a sweep -- one tick in eight at 1000 Hz -- and the cache has
    // one sample an output frame, on whatever tick that frame lands. Most land between sweeps, so
    // each sample has to find the newest sweep at or before its tick; the belly on screen at that
    // tick is exactly that sweep, which is what this compares against, vertex by vertex.
    const simulation = await running(0);
    const tickOf = (sample: number) =>
      1 + Math.round((sample * simulation.stepsPerSecond) / simulation.outputFramerate);
    const wanted = new Map<number, Float64Array>();
    for (let t = 1; t <= 120; t++) {
      simulation.tick();
      const live = simulation.muscleMesh();
      if (!live) throw new Error('the simulation has no muscle mesh');
      wanted.set(t, Float64Array.from(live.position));
    }
    expect(simulation.muscleCapture.frameCount).toBeLessThan(simulation.capture.frameCount / 4);
    const exported = buildBlenderExport(simulation, document, assets);
    if (!exported.pointCache) throw new Error('no vertex cache');
    const bytes = exported.pointCache.bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const points = view.getInt32(16, true);
    const samples = view.getInt32(28, true);
    expect(samples).toBeGreaterThan(4);
    let worst = 0;
    for (let sample = 0; sample < samples; sample++) {
      const live = wanted.get(tickOf(sample));
      if (!live) throw new Error(`no live mesh for sample ${sample}`);
      for (let v = 0; v < points; v++) {
        const at = PC2_HEADER_BYTES + (sample * points + v) * 12;
        const blender = [
          live[v * 3] as number,
          -(live[v * 3 + 2] as number),
          live[v * 3 + 1] as number,
        ];
        for (let k = 0; k < 3; k++) {
          worst = Math.max(
            worst,
            Math.abs(view.getFloat32(at + k * 4, true) - (blender[k] as number)),
          );
        }
      }
    }
    expect(worst).toBeLessThan(1e-4);
    simulation.dispose();
  }, 60_000);
});
