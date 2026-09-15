/**
 * Animated glTF 2.0 binary (.glb) writer.
 *
 * The export exists so a simulation can be inspected in Blender at full time fidelity: every
 * tick becomes a keyframe at its exact time in seconds, and nothing is resampled. The scene is
 * the bone hierarchy as nested nodes, each bone carrying its own rigid mesh in its rest frame,
 * animated by translation and rotation channels; the importer turns that into an object
 * hierarchy with baked keyframes, which is the most direct representation of rigid bones.
 *
 * Written by hand rather than through a library: the format is a JSON header plus one binary
 * buffer, the subset needed here is small, and a dependency would drag a scene-graph model in
 * for nothing. Coordinates are the canonical frame (+X right, +Y up, +Z posterior), which is
 * glTF's own Y-up right-handed convention; Blender converts to Z-up on import.
 */

import {
  type Quat,
  type Transform,
  compose,
  invert,
  relativeTo,
  transformPoint,
} from '@bs-humany/frames';

/**
 * A rigid binding of a mesh's vertices to a chain of joints, one joint per vertex.
 *
 * What it is for: a muscle belly. Its mesh is swept along the path every tick, so it is not rigid
 * in any bone and cannot be exported the way a bone is -- but it is rigid ring by ring, because a
 * ring's vertices are a circle in that ring's own frame and only the ring moves. Give each ring a
 * joint and each vertex its ring, and the whole deformation -- the path bending, the belly
 * thickening -- is carried by joint transforms, which is what glTF animates and what Blender
 * imports as an armature.
 *
 * One joint per vertex at full weight rather than blended weights: a blend would smooth across
 * rings that the sweep already placed exactly, and smoothing an exact answer is not an
 * improvement.
 */
export interface ExportSkin {
  /** Node indices of the joints, in the order `vertexJoint` addresses them. */
  readonly joints: readonly number[];
  /** Which joint each vertex belongs to, as an index into `joints`. */
  readonly vertexJoint: Uint16Array;
}

export interface ExportNode {
  /** Stable id; becomes the node name. */
  readonly id: string;
  /** Index of the parent node in the same array, or -1 for a root. Parents come first. */
  readonly parent: number;
  /** World transform in the rest pose. */
  readonly restWorld: Transform;
  /**
   * Rigid mesh in world coordinates at rest, or none. It is moved into the node's frame.
   *
   * A skinned mesh is the exception: its vertices stay in the bind space they were given, because
   * glTF ignores a skinned node's own transform and places every vertex through its joints.
   */
  readonly mesh?:
    | { readonly positions: Float32Array | Float64Array; readonly indices: Uint32Array }
    | undefined;
  /** Binds this node's mesh to joints, for geometry that deforms rather than moves. */
  readonly skin?: ExportSkin | undefined;
  /**
   * How much bigger this node's geometry is at bind time than the unit it is authored in.
   *
   * Only meaningful for a joint. A muscle ring is authored as a unit circle and drawn at its own
   * radius, so its bind scale is that radius and its scale keyframes are the radius it has at
   * each frame; the inverse bind matrix has to undo the one to make the other mean anything.
   * Defaults to 1, which is every node that is not a ring.
   */
  readonly bindScale?: number | undefined;
  /** Free-form metadata written to the node's `extras`. */
  readonly extras?: Readonly<Record<string, unknown>> | undefined;
  /**
   * False for scene furniture that never moves: the node gets no animation channels and its
   * slots in the animation arrays are ignored. Defaults to true.
   */
  readonly animated?: boolean | undefined;
}

export interface ExportAnimation {
  /** Keyframe times in seconds, one per frame, strictly increasing. */
  readonly times: Float64Array | Float32Array;
  /** World positions, `frames * nodes * 3`, node-major within a frame. */
  readonly position: Float32Array | Float64Array;
  /** World orientations, `frames * nodes * 4`, x y z w. */
  readonly orientation: Float32Array | Float64Array;
  /**
   * Local scales, `frames * nodes * 3`, or none for a scene where nothing changes size.
   *
   * Local rather than world, unlike the other two, and the asymmetry is deliberate: position and
   * orientation are stated in the world because a bone's pose is a world fact, and the writer
   * takes them into each node's parent. A scale is not a pose -- it says how much bigger this
   * node's own geometry is drawn than it was at bind time -- and composing one down a chain of
   * rigid parents would mean nothing. A node with no scale keyframes stays at 1.
   */
  readonly scale?: Float32Array | Float64Array | undefined;
}

export interface ExportInput {
  readonly nodes: readonly ExportNode[];
  readonly animation: ExportAnimation;
  /** Scene-level metadata written to `scene.extras` (rate, profile, provenance, licence). */
  readonly extras?: Readonly<Record<string, unknown>> | undefined;
  readonly generator?: string | undefined;
  readonly animationName?: string | undefined;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const UNSIGNED_SHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: 'SCALAR' | 'VEC3' | 'VEC4' | 'MAT4';
  min?: number[];
  max?: number[];
}

/** Collects binary blocks and their glTF bufferViews/accessors, 4-byte aligned. */
class BinaryBuilder {
  readonly parts: Uint8Array[] = [];
  readonly bufferViews: { buffer: 0; byteOffset: number; byteLength: number; target?: number }[] =
    [];
  readonly accessors: Accessor[] = [];
  private byteLength = 0;

  add(
    data: Float32Array | Uint32Array | Uint16Array,
    type: Accessor['type'],
    componentType: number,
    target?: number,
    bounds?: { min: number[]; max: number[] },
  ): number {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const view = this.bufferViews.length;
    this.bufferViews.push({
      buffer: 0,
      byteOffset: this.byteLength,
      byteLength: bytes.byteLength,
      ...(target === undefined ? {} : { target }),
    });
    this.parts.push(bytes);
    this.byteLength += bytes.byteLength;
    const pad = (4 - (this.byteLength % 4)) % 4;
    if (pad > 0) {
      this.parts.push(new Uint8Array(pad));
      this.byteLength += pad;
    }
    const components = type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : type === 'VEC4' ? 4 : 16;
    this.accessors.push({
      bufferView: view,
      componentType,
      count: data.length / components,
      type,
      ...(bounds ?? {}),
    });
    return this.accessors.length - 1;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }
}

/** True when a node's scale stream is ever anything but one, to within a part in ten thousand. */
function scaleVaries(
  scale: Float32Array | Float64Array,
  frames: number,
  n: number,
  node: number,
): boolean {
  for (let f = 0; f < frames; f++) {
    const at = (f * n + node) * 3;
    for (let c = 0; c < 3; c++) {
      if (Math.abs((scale[at + c] ?? 1) - 1) > 1e-4) return true;
    }
  }
  return false;
}

/**
 * The inverse of a joint's bind pose, column-major, as glTF wants it.
 *
 * Built by hand rather than through a matrix library because it is the only matrix in this file:
 * the inverse of a rotation, a translation and a uniform scale is the transpose of the rotation
 * over the scale, applied to the negated translation.
 */
function inverseBindMatrix(rest: Transform, bindScale: number): Float32Array {
  const { x, y, z, w } = rest.rotation;
  // Rotation matrix, column-major: columns are the rotated basis vectors.
  const r = [
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
  ];
  const s = 1 / (bindScale || 1);
  const t = rest.translation;
  // Transposed rotation, scaled: the inverse of R*S.
  const m = new Float32Array(16);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      m[4 * col + row] = (r[3 * row + col] ?? 0) * s;
    }
  }
  m[12] = -((m[0] ?? 0) * t.x + (m[4] ?? 0) * t.y + (m[8] ?? 0) * t.z);
  m[13] = -((m[1] ?? 0) * t.x + (m[5] ?? 0) * t.y + (m[9] ?? 0) * t.z);
  m[14] = -((m[2] ?? 0) * t.x + (m[6] ?? 0) * t.y + (m[10] ?? 0) * t.z);
  m[15] = 1;
  return m;
}

function boundsOf(data: Float32Array, components: number): { min: number[]; max: number[] } {
  const min = new Array<number>(components).fill(Number.POSITIVE_INFINITY);
  const max = new Array<number>(components).fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < data.length; i += components) {
    for (let c = 0; c < components; c++) {
      const v = data[i + c] ?? 0;
      if (v < (min[c] ?? 0)) min[c] = v;
      if (v > (max[c] ?? 0)) max[c] = v;
    }
  }
  if (data.length === 0) return { min: min.fill(0), max: max.fill(0) };
  return { min, max };
}

/** Build the .glb bytes. Throws on a malformed hierarchy or mismatched animation sizes. */
export function buildAnimatedGlb(input: ExportInput): Uint8Array {
  const { nodes, animation } = input;
  const n = nodes.length;
  const frames = animation.times.length;
  if (
    animation.position.length !== frames * n * 3 ||
    animation.orientation.length !== frames * n * 4
  ) {
    throw new Error(
      `animation holds ${animation.position.length / 3} positions and ${animation.orientation.length / 4} orientations for ${frames} frames of ${n} nodes`,
    );
  }
  if (animation.scale && animation.scale.length !== frames * n * 3) {
    throw new Error(
      `animation holds ${animation.scale.length / 3} scales for ${frames} frames of ${n} nodes`,
    );
  }
  nodes.forEach((node, i) => {
    if (node.parent >= i) throw new Error(`node ${node.id}: parent must come before child`);
    for (const joint of node.skin?.joints ?? []) {
      if (joint < 0 || joint >= nodes.length) {
        throw new Error(`node ${node.id}: joint ${joint} is not a node in this scene`);
      }
    }
  });
  for (let f = 1; f < frames; f++) {
    if ((animation.times[f] ?? 0) <= (animation.times[f - 1] ?? 0)) {
      throw new Error(`keyframe times must increase: frame ${f}`);
    }
  }

  const bin = new BinaryBuilder();
  const times = Float32Array.from(animation.times);
  const timeAccessor = bin.add(times, 'SCALAR', FLOAT, undefined, boundsOf(times, 1));

  const gltfNodes: Record<string, unknown>[] = [];
  const meshes: Record<string, unknown>[] = [];
  const samplers: { input: number; output: number; interpolation: 'LINEAR' }[] = [];
  const skins: { name: string; joints: number[]; inverseBindMatrices: number }[] = [];
  const channels: { sampler: number; target: { node: number; path: string } }[] = [];
  const children: number[][] = nodes.map(() => []);
  nodes.forEach((node, i) => {
    if (node.parent >= 0) children[node.parent]?.push(i);
  });

  // World -> local per frame, then the keyframe streams per node.
  const worldAt = (f: number, i: number): Transform => {
    const p = (f * n + i) * 3;
    const q = (f * n + i) * 4;
    return {
      translation: {
        x: animation.position[p] ?? 0,
        y: animation.position[p + 1] ?? 0,
        z: animation.position[p + 2] ?? 0,
      },
      rotation: {
        x: animation.orientation[q] ?? 0,
        y: animation.orientation[q + 1] ?? 0,
        z: animation.orientation[q + 2] ?? 0,
        w: animation.orientation[q + 3] ?? 1,
      },
    };
  };

  nodes.forEach((node, i) => {
    const parentRest = node.parent >= 0 ? (nodes[node.parent]?.restWorld ?? node.restWorld) : null;
    const restLocal = parentRest ? relativeTo(node.restWorld, parentRest) : node.restWorld;

    const translation = new Float32Array(frames * 3);
    const rotation = new Float32Array(frames * 4);
    let previous: Quat | null = null;
    const animated = node.animated !== false;
    for (let f = 0; animated && f < frames; f++) {
      const world = worldAt(f, i);
      const local = node.parent >= 0 ? relativeTo(world, worldAt(f, node.parent)) : world;
      translation[3 * f] = local.translation.x;
      translation[3 * f + 1] = local.translation.y;
      translation[3 * f + 2] = local.translation.z;
      // Keep consecutive quaternions on the same hemisphere so interpolation takes the short way.
      let q = local.rotation;
      if (
        previous &&
        previous.x * q.x + previous.y * q.y + previous.z * q.z + previous.w * q.w < 0
      ) {
        q = { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
      }
      previous = q;
      rotation[4 * f] = q.x;
      rotation[4 * f + 1] = q.y;
      rotation[4 * f + 2] = q.z;
      rotation[4 * f + 3] = q.w;
    }
    if (animated) {
      const translationAccessor = bin.add(translation, 'VEC3', FLOAT);
      const rotationAccessor = bin.add(rotation, 'VEC4', FLOAT);
      const sampler = (output: number) =>
        samplers.push({ input: timeAccessor, output, interpolation: 'LINEAR' }) - 1;
      channels.push({
        sampler: sampler(translationAccessor),
        target: { node: i, path: 'translation' },
      });
      channels.push({ sampler: sampler(rotationAccessor), target: { node: i, path: 'rotation' } });
      // Only for nodes that actually change size: a stream of ones for every bone in the body
      // would double the animation for nothing.
      if (animation.scale && scaleVaries(animation.scale, frames, n, i)) {
        const scale = new Float32Array(frames * 3);
        for (let f = 0; f < frames; f++) {
          const at = (f * n + i) * 3;
          scale[3 * f] = animation.scale[at] ?? 1;
          scale[3 * f + 1] = animation.scale[at + 1] ?? 1;
          scale[3 * f + 2] = animation.scale[at + 2] ?? 1;
        }
        channels.push({
          sampler: sampler(bin.add(scale, 'VEC3', FLOAT)),
          target: { node: i, path: 'scale' },
        });
      }
    }

    const gltfNode: Record<string, unknown> = {
      name: node.id,
      translation: [restLocal.translation.x, restLocal.translation.y, restLocal.translation.z],
      rotation: [
        restLocal.rotation.x,
        restLocal.rotation.y,
        restLocal.rotation.z,
        restLocal.rotation.w,
      ],
    };
    if ((children[i]?.length ?? 0) > 0) gltfNode.children = children[i];
    if (node.extras) gltfNode.extras = node.extras;
    if (node.mesh && node.mesh.indices.length >= 3) {
      const count = node.mesh.positions.length / 3;
      const local = new Float32Array(count * 3);
      if (node.skin) {
        // A skinned mesh stays in the bind space it was given: glTF ignores the transform of the
        // node that carries it and places every vertex through its joints instead.
        for (let v = 0; v < count * 3; v++) local[v] = node.mesh.positions[v] ?? 0;
      } else {
        // The mesh is given at rest in world coordinates; the node draws it from its own frame.
        const toLocal = invert(node.restWorld);
        for (let v = 0; v < count; v++) {
          const p = transformPoint(toLocal, {
            x: node.mesh.positions[3 * v] ?? 0,
            y: node.mesh.positions[3 * v + 1] ?? 0,
            z: node.mesh.positions[3 * v + 2] ?? 0,
          });
          local[3 * v] = p.x;
          local[3 * v + 1] = p.y;
          local[3 * v + 2] = p.z;
        }
      }
      const positionAccessor = bin.add(local, 'VEC3', FLOAT, ARRAY_BUFFER, boundsOf(local, 3));
      const indexAccessor = bin.add(
        Uint32Array.from(node.mesh.indices),
        'SCALAR',
        UNSIGNED_INT,
        ELEMENT_ARRAY_BUFFER,
      );
      const attributes: Record<string, number> = { POSITION: positionAccessor };
      if (node.skin) {
        const joints = new Uint16Array(count * 4);
        const weights = new Float32Array(count * 4);
        for (let v = 0; v < count; v++) {
          joints[4 * v] = node.skin.vertexJoint[v] ?? 0;
          weights[4 * v] = 1;
        }
        attributes.JOINTS_0 = bin.add(joints, 'VEC4', UNSIGNED_SHORT, ARRAY_BUFFER);
        attributes.WEIGHTS_0 = bin.add(weights, 'VEC4', FLOAT, ARRAY_BUFFER);
        // The inverse bind matrix takes a vertex from bind space into the joint's own frame, so
        // the joint's later transform carries it from there. It inverts the joint's rest pose
        // including its scale, which is what lets a ring's radius be animated at all.
        const matrices = new Float32Array(node.skin.joints.length * 16);
        node.skin.joints.forEach((jointNode, j) => {
          const rest = nodes[jointNode]?.restWorld ?? node.restWorld;
          const bind = nodes[jointNode]?.bindScale ?? 1;
          matrices.set(inverseBindMatrix(rest, bind), 16 * j);
        });
        gltfNode.skin =
          skins.push({
            name: `${node.id}.skin`,
            joints: [...node.skin.joints],
            inverseBindMatrices: bin.add(matrices, 'MAT4', FLOAT),
          }) - 1;
      }
      gltfNode.mesh =
        meshes.push({
          name: `${node.id}.mesh`,
          primitives: [{ attributes, indices: indexAccessor, mode: 4 }],
        }) - 1;
    }
    gltfNodes.push(gltfNode);
  });

  const roots = nodes.map((node, i) => (node.parent < 0 ? i : -1)).filter((i) => i >= 0);
  const binary = bin.bytes();
  const json = {
    asset: { version: '2.0', generator: input.generator ?? 'bs-humany export-gltf' },
    scene: 0,
    scenes: [
      { name: 'bs-humany', nodes: roots, ...(input.extras ? { extras: input.extras } : {}) },
    ],
    nodes: gltfNodes,
    meshes,
    ...(skins.length > 0 ? { skins } : {}),
    animations: [{ name: input.animationName ?? 'simulation', samplers, channels }],
    accessors: bin.accessors,
    bufferViews: bin.bufferViews,
    buffers: [{ byteLength: binary.byteLength }],
  };
  return packGlb(new TextEncoder().encode(JSON.stringify(json)), binary);
}

function packGlb(json: Uint8Array, binary: Uint8Array): Uint8Array {
  const jsonPadded = (4 - (json.byteLength % 4)) % 4;
  const binPadded = (4 - (binary.byteLength % 4)) % 4;
  const total = 12 + 8 + json.byteLength + jsonPadded + 8 + binary.byteLength + binPadded;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  let offset = 12;
  view.setUint32(offset, json.byteLength + jsonPadded, true);
  view.setUint32(offset + 4, CHUNK_JSON, true);
  out.set(json, offset + 8);
  out.fill(0x20, offset + 8 + json.byteLength, offset + 8 + json.byteLength + jsonPadded);
  offset += 8 + json.byteLength + jsonPadded;
  view.setUint32(offset, binary.byteLength + binPadded, true);
  view.setUint32(offset + 4, CHUNK_BIN, true);
  out.set(binary, offset + 8);
  return out;
}

/** Parse a .glb back into its JSON header and binary chunk. For tests and round trips. */
export function readGlb(bytes: Uint8Array): { json: Record<string, unknown>; binary: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a glb');
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON) throw new Error('first chunk is not JSON');
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Record<
    string,
    unknown
  >;
  const binOffset = 20 + jsonLength;
  const binLength = view.getUint32(binOffset, true);
  if (view.getUint32(binOffset + 4, true) !== CHUNK_BIN) throw new Error('second chunk is not BIN');
  return { json, binary: bytes.subarray(binOffset + 8, binOffset + 8 + binLength) };
}

/** Compose world transforms from a parent chain, the inverse of what the writer does. */
export function composeWorld(parentWorld: Transform | null, local: Transform): Transform {
  return parentWorld ? compose(parentWorld, local) : local;
}

/** A box mesh centred on the origin, for scene furniture: 8 vertices, 12 triangles. */
export function boxMesh(halfExtents: { x: number; y: number; z: number }): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const { x, y, z } = halfExtents;
  const positions = new Float32Array([
    -x,
    -y,
    -z,
    x,
    -y,
    -z,
    x,
    y,
    -z,
    -x,
    y,
    -z,
    -x,
    -y,
    z,
    x,
    -y,
    z,
    x,
    y,
    z,
    -x,
    y,
    z,
  ]);
  // Outward-facing, counter-clockwise from outside.
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4,
    7, 0, 7, 3,
  ]);
  return { positions, indices };
}

/** A square in the X-Z plane of the given half size, facing +Y. */
export function planeMesh(halfSize: number): { positions: Float32Array; indices: Uint32Array } {
  const s = halfSize;
  return {
    positions: new Float32Array([-s, 0, -s, s, 0, -s, s, 0, s, -s, 0, s]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
  };
}
