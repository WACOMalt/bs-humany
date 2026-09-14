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

export interface ExportNode {
  /** Stable id; becomes the node name. */
  readonly id: string;
  /** Index of the parent node in the same array, or -1 for a root. Parents come first. */
  readonly parent: number;
  /** World transform in the rest pose. */
  readonly restWorld: Transform;
  /** Rigid mesh in world coordinates at rest, or none. It is moved into the node's frame. */
  readonly mesh?:
    | { readonly positions: Float32Array | Float64Array; readonly indices: Uint32Array }
    | undefined;
  /** Free-form metadata written to the node's `extras`. */
  readonly extras?: Readonly<Record<string, unknown>> | undefined;
}

export interface ExportAnimation {
  /** Keyframe times in seconds, one per frame, strictly increasing. */
  readonly times: Float64Array | Float32Array;
  /** World positions, `frames * nodes * 3`, node-major within a frame. */
  readonly position: Float32Array | Float64Array;
  /** World orientations, `frames * nodes * 4`, x y z w. */
  readonly orientation: Float32Array | Float64Array;
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
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: 'SCALAR' | 'VEC3' | 'VEC4';
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
    data: Float32Array | Uint32Array,
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
    const components = type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4;
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
  nodes.forEach((node, i) => {
    if (node.parent >= i) throw new Error(`node ${node.id}: parent must come before child`);
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
    for (let f = 0; f < frames; f++) {
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
    const translationAccessor = bin.add(translation, 'VEC3', FLOAT);
    const rotationAccessor = bin.add(rotation, 'VEC4', FLOAT);
    channels.push({
      sampler:
        samplers.push({
          input: timeAccessor,
          output: translationAccessor,
          interpolation: 'LINEAR',
        }) - 1,
      target: { node: i, path: 'translation' },
    });
    channels.push({
      sampler:
        samplers.push({ input: timeAccessor, output: rotationAccessor, interpolation: 'LINEAR' }) -
        1,
      target: { node: i, path: 'rotation' },
    });

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
      // The mesh is given at rest in world coordinates; the node draws it from its own frame.
      const toLocal = invert(node.restWorld);
      const count = node.mesh.positions.length / 3;
      const local = new Float32Array(count * 3);
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
      const positionAccessor = bin.add(local, 'VEC3', FLOAT, ARRAY_BUFFER, boundsOf(local, 3));
      const indexAccessor = bin.add(
        Uint32Array.from(node.mesh.indices),
        'SCALAR',
        UNSIGNED_INT,
        ELEMENT_ARRAY_BUFFER,
      );
      gltfNode.mesh =
        meshes.push({
          name: `${node.id}.mesh`,
          primitives: [
            { attributes: { POSITION: positionAccessor }, indices: indexAccessor, mode: 4 },
          ],
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
