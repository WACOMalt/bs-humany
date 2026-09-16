/**
 * What comes out of the Blender export, checked against what the simulation had.
 *
 * The bones are the easy half: they are rigid, so a node with a mesh and two keyframe channels
 * says everything about them, and the writer's own tests cover that. The muscles are the half
 * worth a test here, because nothing about them is rigid -- a belly is swept anew every tick --
 * and what makes them exportable at all is the claim that a belly is rigid *ring by ring*.
 *
 * So the test evaluates glTF's own skinning rule on the file that was written, using the inverse
 * bind matrices it contains, and compares the result against the mesh the simulation actually had
 * at that tick. If the ring frames, the bind pose, the matrices or the keyframes disagreed
 * anywhere, the vertices would land somewhere else.
 */

import { fileURLToPath } from 'node:url';
import { resolveMorphology } from '@bs-humany/anthropometry';
import { loadSkeletonAssetsFromDisk } from '@bs-humany/assets-anatomical';
import { readGlb } from '@bs-humany/export-gltf';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { buildBlenderExport } from './blenderExport.js';
import { Simulation } from './simulation.js';

const document = buildDocument();
const assets = await loadSkeletonAssetsFromDisk(
  fileURLToPath(new URL('../../../packages/assets-anatomical/data', import.meta.url)),
);

async function running(ticks: number, captureBudgetBytes?: number): Promise<Simulation> {
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
  it('carries a skinned belly for every unit, and the bones as well', async () => {
    const simulation = await running(40);
    const exported = buildBlenderExport(simulation, document, assets);
    const { json } = readGlb(exported.glb) as unknown as { json: Gltf };

    const bellies = json.nodes.filter((n) => n.name.startsWith('muscle__') && n.skin !== undefined);
    expect(bellies).toHaveLength(simulation.muscles?.units.length ?? 0);
    expect(bellies.length).toBeGreaterThan(0);
    // One joint per cross-section, and each joint is a real node in the scene.
    const rings = simulation.muscleVolume?.rings ?? 0;
    for (const belly of bellies) {
      const skin = json.skins?.[belly.skin as number];
      expect(skin?.joints, belly.name).toHaveLength(rings);
      for (const joint of skin?.joints ?? []) {
        expect(json.nodes[joint]?.name, belly.name).toMatch(/__ring\d+$/);
      }
    }
    // And the skeleton is still there, which a muscle change must not cost.
    expect(json.nodes.some((n) => n.name === 'humerus_r')).toBe(true);
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
    // A budget of one frame's worth of rings, so the limit is reached on the second tick.
    const simulation = await running(1);
    const perFrame = simulation.muscleCapture.bytes;
    simulation.dispose();
    expect(perFrame).toBeGreaterThan(0);

    const short = await running(40, perFrame + 1);
    expect(short.muscleCapture.full).toBe(true);
    // Both stopped, and at the same frame: that is the invariant the exporter reads.
    expect(short.capture.frameCount).toBe(short.muscleCapture.frameCount);
    expect(short.capture.frameCount).toBeLessThan(40);
    expect(short.capturesStoppedBy).toBe('muscles');

    const { json } = readGlb(buildBlenderExport(short, document, assets).glb) as unknown as {
      json: Gltf;
    };
    const bellies = json.nodes.filter((n) => n.name.startsWith('muscle__') && n.skin !== undefined);
    expect(bellies).toHaveLength(short.muscles?.units.length ?? 0);
    expect(bellies.length).toBeGreaterThan(0);
    short.dispose();
  }, 60_000);

  it('puts every vertex where the sweep had it, through the file’s own matrices', async () => {
    // The whole chain in one assertion: ring frames read off the swept mesh, captured, written as
    // keyframes and inverse bind matrices, then skinned back. A degree of twist in a ring frame
    // or a transposed matrix moves vertices by millimetres, and the belly is centimetres across.
    const ticks = 40;
    const simulation = await running(ticks);
    const live = simulation.muscleMesh();
    const volume = simulation.muscleVolume;
    if (!live || !volume) throw new Error('the simulation has no muscle mesh');

    const exported = buildBlenderExport(simulation, document, assets);
    const { json, binary } = readGlb(exported.glb) as unknown as {
      json: Gltf;
      binary: Uint8Array;
    };
    const frame = exported.frames - 1;
    const nodeIndex = new Map(json.nodes.map((n, i) => [n.name, i]));

    const sampled = (node: number, path: string, components: number): Float32Array | undefined => {
      const channel = json.animations[0]?.channels.find(
        (c) => c.target.node === node && c.target.path === path,
      );
      if (!channel) return undefined;
      const sampler = json.animations[0]?.samplers[channel.sampler];
      if (!sampler) return undefined;
      const all = floats(json, binary, sampler.output);
      return all.subarray(frame * components, (frame + 1) * components);
    };

    const unitId = simulation.muscles?.units[0]?.id as string;
    const belly = json.nodes[nodeIndex.get(`muscle__${unitId}`) as number];
    const skin = json.skins?.[belly?.skin as number];
    const matrices = floats(json, binary, skin?.inverseBindMatrices as number);
    const attributes = json.meshes[belly?.mesh as number]?.primitives[0]?.attributes as Record<
      string,
      number
    >;
    const bind = floats(json, binary, attributes.POSITION as number);

    let worst = 0;
    for (let ring = 0; ring < volume.rings; ring++) {
      const joint = skin?.joints[ring] as number;
      const translation = sampled(joint, 'translation', 3);
      const rotation = sampled(joint, 'rotation', 4);
      const scale = sampled(joint, 'scale', 3);
      if (!translation || !rotation) throw new Error(`ring ${ring} has no keyframes`);
      const s = scale?.[0] ?? 1;
      const [qx, qy, qz, qw] = [
        rotation[0] as number,
        rotation[1] as number,
        rotation[2] as number,
        rotation[3] as number,
      ];
      for (let segment = 0; segment < volume.segments; segment++) {
        const v = ring * volume.segments + segment;
        // Bind vertex into the joint's frame by the matrix in the file...
        const m = 16 * ring;
        const b = [bind[3 * v] as number, bind[3 * v + 1] as number, bind[3 * v + 2] as number];
        const local = [0, 1, 2].map(
          (row) =>
            (matrices[m + row] as number) * (b[0] as number) +
            (matrices[m + 4 + row] as number) * (b[1] as number) +
            (matrices[m + 8 + row] as number) * (b[2] as number) +
            (matrices[m + 12 + row] as number),
        );
        // ...scaled, rotated and translated by the joint's keyframe, which is glTF's own rule.
        const scaled = local.map((c) => c * s);
        const t = [
          2 * (qy * (scaled[2] as number) - qz * (scaled[1] as number)),
          2 * (qz * (scaled[0] as number) - qx * (scaled[2] as number)),
          2 * (qx * (scaled[1] as number) - qy * (scaled[0] as number)),
        ];
        const skinned = [
          (scaled[0] as number) +
            qw * (t[0] as number) +
            (qy * (t[2] as number) - qz * (t[1] as number)) +
            (translation[0] as number),
          (scaled[1] as number) +
            qw * (t[1] as number) +
            (qz * (t[0] as number) - qx * (t[2] as number)) +
            (translation[1] as number),
          (scaled[2] as number) +
            qw * (t[2] as number) +
            (qx * (t[1] as number) - qy * (t[0] as number)) +
            (translation[2] as number),
        ];
        const at = 3 * v;
        for (let c = 0; c < 3; c++) {
          worst = Math.max(
            worst,
            Math.abs((skinned[c] as number) - (live.position[at + c] as number)),
          );
        }
      }
    }
    // A tenth of a millimetre, which is the width of the single-precision the capture holds.
    expect(worst).toBeLessThan(1e-4);
    simulation.dispose();
  }, 60_000);
});
