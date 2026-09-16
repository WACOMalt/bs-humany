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
  it('sets the scene to the output rate, and the range to the run in seconds', () => {
    // Five seconds of a 500 Hz run into a 60 fps scene: 300 frames, not 2500, and the 2500
    // keyframes stay where they are between them. The scene rate is the output rate -- that is
    // the whole of the split, and it is what makes a simulated second a second of timeline.
    const script = blenderImportScript({
      glbFileName: 'run.glb',
      rate: 500,
      outputFramerate: 60,
      frames: 2500,
    });
    expect(script).toContain('scene.render.fps = 60');
    expect(script).toContain('scene.frame_end = 300');
    expect(script).toContain('bpy.ops.import_scene.gltf(filepath=path)');
    // And a second of simulated time is a second of timeline at any pair of rates, which is the
    // property worth pinning: frame_end over fps has to equal frames over the step rate.
    for (const [rate, fps, frames] of [
      [500, 60, 2500],
      [1000, 24, 4000],
      [500, 500, 1500],
      [240, 30, 481],
    ] as const) {
      const other = blenderImportScript({
        glbFileName: 'x.glb',
        rate,
        outputFramerate: fps,
        frames,
      });
      const end = Number(/scene\.frame_end = (\d+)/.exec(other)?.[1]);
      expect(end / fps).toBeCloseTo(frames / rate, 2);
    }
    expect(script).toContain('"run.glb"');
    // A hundred metre-wide empties would bury the skeleton in axes.
    expect(script).toContain('empty_display_size = 0.01');
    // Run from the Text Editor there is no __file__, so the script has to look elsewhere.
    expect(script).toContain('bpy.data.texts');
    expect(script).toContain('bpy.data.filepath');
    expect(script).toContain('cannot find');
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

describe('a skinned, scaling mesh', () => {
  // A muscle belly in miniature: two rings on a straight path, the second of which moves along
  // and swells. The point of the test is that the deformation survives the round trip -- not that
  // the bytes are as expected, but that a reader applying glTF's own skinning rule to what was
  // written gets the vertices back.
  const identityQuat = { x: 0, y: 0, z: 0, w: 1 };
  const SEGMENTS = 4;
  const ringVertices = (centre: number, radius: number): number[] => {
    const out: number[] = [];
    for (let s = 0; s < SEGMENTS; s++) {
      const a = (2 * Math.PI * s) / SEGMENTS;
      out.push(radius * Math.cos(a), radius * Math.sin(a), centre);
    }
    return out;
  };

  const bindRadius = [0.02, 0.03];
  const skinNodes: ExportNode[] = [
    { id: 'belly', parent: -1, restWorld: { translation: vec3(0, 0, 0), rotation: identityQuat } },
    {
      id: 'ring0',
      parent: 0,
      restWorld: { translation: vec3(0, 0, 0), rotation: identityQuat },
      bindScale: bindRadius[0],
    },
    {
      id: 'ring1',
      parent: 0,
      restWorld: { translation: vec3(0, 0, 0.1), rotation: identityQuat },
      bindScale: bindRadius[1],
    },
    {
      id: 'belly.mesh',
      parent: 0,
      restWorld: { translation: vec3(0, 0, 0), rotation: identityQuat },
      animated: false,
      mesh: {
        positions: Float32Array.from([
          ...ringVertices(0, bindRadius[0] as number),
          ...ringVertices(0.1, bindRadius[1] as number),
        ]),
        indices: Uint32Array.from([0, 1, 4, 1, 5, 4, 1, 2, 5, 2, 6, 5]),
      },
      skin: {
        joints: [1, 2],
        vertexJoint: Uint16Array.from([0, 0, 0, 0, 1, 1, 1, 1]),
      },
    },
  ];

  const skinFrames = 3;
  const skinTimes = Float64Array.from({ length: skinFrames }, (_, f) => f / 500);
  const skinPosition = new Float32Array(skinFrames * skinNodes.length * 3);
  const skinOrientation = new Float32Array(skinFrames * skinNodes.length * 4);
  const skinScale = new Float32Array(skinFrames * skinNodes.length * 3).fill(1);
  // Ring 1 slides toward ring 0 and thickens, which is what a shortening belly does.
  for (let f = 0; f < skinFrames; f++) {
    skinNodes.forEach((_, i) => {
      const at = (f * skinNodes.length + i) * 3;
      const q = (f * skinNodes.length + i) * 4;
      skinPosition[at + 2] = i === 2 ? 0.1 - 0.01 * f : 0;
      skinOrientation[q + 3] = 1;
      if (i === 1 || i === 2) {
        const radius = (bindRadius[i - 1] as number) * (1 + 0.1 * f);
        skinScale[at] = radius;
        skinScale[at + 1] = radius;
        skinScale[at + 2] = radius;
      }
    });
  }

  const glb = buildAnimatedGlb({
    nodes: skinNodes,
    animation: {
      times: skinTimes,
      position: skinPosition,
      orientation: skinOrientation,
      scale: skinScale,
    },
  });
  const { json, binary } = readGlb(glb);
  const accessorFloats = (index: number): Float32Array => {
    const accessor = (json.accessors as Record<string, number>[])[index] as unknown as {
      bufferView: number;
      count: number;
      type: string;
    };
    const view = (json.bufferViews as Record<string, number>[])[accessor.bufferView] as unknown as {
      byteOffset: number;
      byteLength: number;
    };
    return new Float32Array(
      binary.buffer.slice(
        binary.byteOffset + view.byteOffset,
        binary.byteOffset + view.byteOffset + view.byteLength,
      ),
    );
  };

  it('writes one skin, with a joint per ring and a matrix for each', () => {
    const skins = json.skins as { joints: number[]; inverseBindMatrices: number }[];
    expect(skins).toHaveLength(1);
    expect(skins[0]?.joints).toEqual([1, 2]);
    expect(accessorFloats(skins[0]?.inverseBindMatrices as number)).toHaveLength(32);
  });

  it('binds every vertex to one joint at full weight', () => {
    const mesh = (json.meshes as { primitives: { attributes: Record<string, number> }[] }[])[0];
    const attributes = mesh?.primitives[0]?.attributes as Record<string, number>;
    expect(attributes.JOINTS_0).toBeDefined();
    const weights = accessorFloats(attributes.WEIGHTS_0 as number);
    for (let v = 0; v < 8; v++) {
      expect(weights[4 * v], `vertex ${v}`).toBe(1);
      expect(weights[4 * v + 1] as number, `vertex ${v}`).toBe(0);
    }
  });

  it('keyframes scale only where something changes size', () => {
    const channels = (
      json.animations as { channels: { target: { node: number; path: string } }[] }[]
    )[0]?.channels as { target: { node: number; path: string } }[];
    const scaled = channels.filter((c) => c.target.path === 'scale').map((c) => c.target.node);
    // The two rings, and neither the belly root nor the mesh node.
    expect(scaled.sort()).toEqual([1, 2]);
  });

  it('puts the vertices back where the sweep had them, through glTF’s own skinning rule', () => {
    // The check that matters, and the one that would catch a transposed matrix: take the inverse
    // bind matrices *out of the file*, apply glTF's skinning rule with the joint transforms that
    // were written, and see whether the vertices land where the sweep put them. With one joint at
    // full weight that is `skinned = jointWorld * inverseBind * bindVertex`.
    const skins = json.skins as { joints: number[]; inverseBindMatrices: number }[];
    const matrices = accessorFloats(skins[0]?.inverseBindMatrices as number);
    const apply = (m: Float32Array, o: number, v: readonly number[]): number[] => [
      (m[o] ?? 0) * v[0]! + (m[o + 4] ?? 0) * v[1]! + (m[o + 8] ?? 0) * v[2]! + (m[o + 12] ?? 0),
      (m[o + 1] ?? 0) * v[0]! +
        (m[o + 5] ?? 0) * v[1]! +
        (m[o + 9] ?? 0) * v[2]! +
        (m[o + 13] ?? 0),
      (m[o + 2] ?? 0) * v[0]! +
        (m[o + 6] ?? 0) * v[1]! +
        (m[o + 10] ?? 0) * v[2]! +
        (m[o + 14] ?? 0),
    ];

    const frame = 2;
    const nodesCount = skinNodes.length;
    for (const [joint, node] of [
      [0, 1],
      [1, 2],
    ] as const) {
      const at = (frame * nodesCount + node) * 3;
      const radius = skinScale[at] as number;
      const along = skinPosition[at + 2] as number;
      for (let s = 0; s < SEGMENTS; s++) {
        const v = joint * SEGMENTS + s;
        const bind = [
          skinNodes[3]?.mesh?.positions[3 * v] as number,
          skinNodes[3]?.mesh?.positions[3 * v + 1] as number,
          skinNodes[3]?.mesh?.positions[3 * v + 2] as number,
        ];
        // Into the joint's frame by the matrix the writer produced...
        const inJoint = apply(matrices, 16 * joint, bind);
        // ...and out again by the joint's animated transform: a uniform scale and a translation,
        // the rotation being identity throughout this scene.
        const skinned = [inJoint[0]! * radius, inJoint[1]! * radius, inJoint[2]! * radius + along];

        const angle = (2 * Math.PI * s) / SEGMENTS;
        expect(skinned[0] as number, `ring ${joint} vertex ${s}`).toBeCloseTo(
          radius * Math.cos(angle),
          6,
        );
        expect(skinned[1] as number, `ring ${joint} vertex ${s}`).toBeCloseTo(
          radius * Math.sin(angle),
          6,
        );
        expect(skinned[2] as number, `ring ${joint} vertex ${s}`).toBeCloseTo(along, 6);
      }
    }
  });
});
