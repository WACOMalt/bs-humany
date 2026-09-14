import { type Transform, compose, fromAxisAngle, vec3 } from '@bs-humany/frames';
import { describe, expect, it } from 'vitest';
import { blenderImportScript } from './blender.js';
import {
  type ExportNode,
  boxMesh,
  buildAnimatedGlb,
  composeWorld,
  planeMesh,
  readGlb,
} from './glb.js';

const identity = { x: 0, y: 0, z: 0, w: 1 };
const nodes: ExportNode[] = [
  {
    id: 'root',
    parent: -1,
    restWorld: { translation: vec3(0, 1, 0), rotation: identity },
    mesh: {
      positions: new Float32Array([0, 1, 0, 0.1, 1, 0, 0, 1.1, 0, 0, 1, 0.1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]),
    },
    extras: { displayName: 'Root' },
  },
  {
    id: 'child',
    parent: 0,
    restWorld: { translation: vec3(0, 0.5, 0), rotation: fromAxisAngle(vec3(0, 0, 1), 0.3) },
  },
];

const rate = 500;
const frames = 4;
const times = Float64Array.from({ length: frames }, (_, f) => f / rate);
const position = new Float32Array(frames * nodes.length * 3);
const orientation = new Float32Array(frames * nodes.length * 4);
for (let f = 0; f < frames; f++) {
  nodes.forEach((node, i) => {
    const spin = fromAxisAngle(vec3(1, 0, 0), 0.5 * f);
    const world = compose({ translation: vec3(0, 0.01 * f, 0), rotation: spin }, node.restWorld);
    position.set(
      [world.translation.x, world.translation.y, world.translation.z],
      (f * nodes.length + i) * 3,
    );
    orientation.set(
      [world.rotation.x, world.rotation.y, world.rotation.z, world.rotation.w],
      (f * nodes.length + i) * 4,
    );
  });
}
const glb = buildAnimatedGlb({
  nodes,
  animation: { times, position, orientation },
  extras: { rate },
});
const { json, binary } = readGlb(glb);
const accessors = json.accessors as { bufferView: number; count: number; type: string }[];
const views = json.bufferViews as { byteOffset: number; byteLength: number }[];
const floats = (accessor: number) => {
  const a = accessors[accessor];
  const v = views[a?.bufferView ?? 0];
  if (!a || !v) throw new Error('accessor');
  return new Float32Array(binary.buffer, binary.byteOffset + v.byteOffset, v.byteLength / 4);
};

describe('the animated glb', () => {
  it('is a well-formed container with the hierarchy as nested nodes', () => {
    expect(glb.byteLength % 4).toBe(0);
    const gltfNodes = json.nodes as { name: string; children?: number[]; mesh?: number }[];
    expect(gltfNodes.map((n) => n.name)).toEqual(['root', 'child']);
    expect(gltfNodes[0]?.children).toEqual([1]);
    expect(gltfNodes[0]?.mesh).toBe(0);
    expect(gltfNodes[1]?.mesh).toBeUndefined();
    expect((json.scenes as { nodes: number[] }[])[0]?.nodes).toEqual([0]);
    expect((json.scenes as { extras: { rate: number } }[])[0]?.extras.rate).toBe(rate);
  });

  it('keys every frame at its exact time', () => {
    const animation = (
      json.animations as { samplers: { input: number }[]; channels: unknown[] }[]
    )[0];
    if (!animation) throw new Error('no animation');
    expect(animation.channels).toHaveLength(2 * nodes.length);
    const input = floats(animation.samplers[0]?.input ?? -1);
    expect(Array.from(input)).toEqual(Array.from(Float32Array.from(times)));
    expect(accessors[animation.samplers[0]?.input ?? 0]?.count).toBe(frames);
  });

  it('stores parent-relative keyframes that compose back to the given world transforms', () => {
    const animation = (
      json.animations as {
        samplers: { output: number }[];
        channels: { sampler: number; target: { node: number; path: string } }[];
      }[]
    )[0];
    if (!animation) throw new Error('no animation');
    const stream = (node: number, path: string) => {
      const channel = animation.channels.find(
        (c) => c.target.node === node && c.target.path === path,
      );
      if (!channel) throw new Error(path);
      return floats(animation.samplers[channel.sampler]?.output ?? -1);
    };
    for (let f = 0; f < frames; f++) {
      let parentWorld: Transform | null = null;
      nodes.forEach((_, i) => {
        const t = stream(i, 'translation');
        const r = stream(i, 'rotation');
        const local = {
          translation: vec3(t[3 * f] ?? 0, t[3 * f + 1] ?? 0, t[3 * f + 2] ?? 0),
          rotation: {
            x: r[4 * f] ?? 0,
            y: r[4 * f + 1] ?? 0,
            z: r[4 * f + 2] ?? 0,
            w: r[4 * f + 3] ?? 1,
          },
        };
        const world = composeWorld(parentWorld, local);
        const p = (f * nodes.length + i) * 3;
        expect(world.translation.x).toBeCloseTo(position[p] ?? 0, 5);
        expect(world.translation.y).toBeCloseTo(position[p + 1] ?? 0, 5);
        expect(world.translation.z).toBeCloseTo(position[p + 2] ?? 0, 5);
        const q = (f * nodes.length + i) * 4;
        const dot =
          world.rotation.x * (orientation[q] ?? 0) +
          world.rotation.y * (orientation[q + 1] ?? 0) +
          world.rotation.z * (orientation[q + 2] ?? 0) +
          world.rotation.w * (orientation[q + 3] ?? 1);
        expect(Math.abs(dot)).toBeCloseTo(1, 5);
        parentWorld = world;
      });
    }
  });

  it('moves the mesh into the node frame and records its bounds', () => {
    const mesh = (
      json.meshes as { primitives: { attributes: { POSITION: number }; indices: number }[] }[]
    )[0];
    if (!mesh) throw new Error('no mesh');
    const positions = floats(mesh.primitives[0]?.attributes.POSITION ?? -1);
    // The root sits at y = 1, so the world vertex (0, 1, 0) is the local origin.
    expect(Array.from(positions.subarray(0, 3))).toEqual([0, 0, 0]);
    const accessor = accessors[mesh.primitives[0]?.attributes.POSITION ?? 0] as unknown as {
      min: number[];
      max: number[];
    };
    expect(accessor.min).toEqual([0, 0, 0]);
    expect(accessor.max[1]).toBeCloseTo(0.1, 6);
    expect(accessors[mesh.primitives[0]?.indices ?? 0]?.count).toBe(12);
  });

  it('rejects a child listed before its parent and non-increasing times', () => {
    expect(() =>
      buildAnimatedGlb({
        nodes: [{ ...nodes[1]!, parent: 1 }, nodes[0]!],
        animation: { times, position, orientation },
      }),
    ).toThrow(/parent must come before child/);
    expect(() =>
      buildAnimatedGlb({
        nodes,
        animation: {
          times: Float64Array.from([0, 0]),
          position: position.subarray(0, 12),
          orientation: orientation.subarray(0, 16),
        },
      }),
    ).toThrow(/increase/);
  });
});

describe('the Blender script', () => {
  it('sets the scene rate to the simulation rate before importing', () => {
    const script = blenderImportScript({ glbFileName: 'run.glb', rate: 500, frames: 2500 });
    expect(script).toContain('scene.render.fps = 500');
    expect(script).toContain('scene.frame_end = 2499');
    expect(script).toContain('bpy.ops.import_scene.gltf(filepath=path)');
    expect(script).toContain('"run.glb"');
    // A hundred metre-wide empties would bury the skeleton in axes.
    expect(script).toContain('empty_display_size = 0.01');
    expect(script).toContain('Joint centres');
    expect(script).toContain('hide_viewport = True');
  });
});

describe('scene furniture', () => {
  it('exports unanimated nodes without channels, and box and plane helpers close', () => {
    const box = boxMesh({ x: 1, y: 2, z: 3 });
    expect(box.positions.length / 3).toBe(8);
    expect(box.indices.length / 3).toBe(12);
    const plane = planeMesh(5);
    expect(plane.positions.length / 3).toBe(4);
    const still: ExportNode = {
      id: 'stair',
      parent: -1,
      restWorld: { translation: vec3(1, 0.5, 0), rotation: identity },
      mesh: box,
      animated: false,
    };
    // The two animated nodes keep their keyframes; the static node's slots are left zero.
    const position3 = new Float32Array(frames * 3 * 3);
    const orientation3 = new Float32Array(frames * 3 * 4);
    for (let f = 0; f < frames; f++) {
      position3.set(position.subarray(f * 6, f * 6 + 6), f * 9);
      orientation3.set(orientation.subarray(f * 8, f * 8 + 8), f * 12);
    }
    const out = buildAnimatedGlb({
      nodes: [...nodes, still],
      animation: { times, position: position3, orientation: orientation3 },
    });
    const parsed = readGlb(out);
    const animation = (parsed.json.animations as { channels: { target: { node: number } }[] }[])[0];
    expect(animation?.channels.some((c) => c.target.node === 2)).toBe(false);
    expect(animation?.channels).toHaveLength(4);
    const still2 = (parsed.json.nodes as { name: string; translation: number[] }[])[2];
    expect(still2?.name).toBe('stair');
    expect(still2?.translation).toEqual([1, 0.5, 0]);
  });
});
