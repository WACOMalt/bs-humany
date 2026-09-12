/**
 * Building a renderable skeleton from an HSDL document.
 *
 * Walks the anatomical tree, composing rest transforms into world transforms, evaluates each
 * bone's geometry recipe, and bakes the lot into **one** merged buffer.
 *
 * One draw call rather than 206 is not premature optimization. ADR-010 sets the platform floor at
 * `L0` running on mobile, and 206 individual draw calls is the difference between a phone holding
 * 60 fps and not. Spec section 11 asks for this explicitly.
 *
 * Per-bone identity survives the merge as a vertex attribute, so picking and highlighting still
 * resolve to a bone `id` (spec section 11, bone picking and inspector).
 */

import {
  IDENTITY_TRANSFORM,
  type Transform,
  compose,
  rotate,
  transformPoint,
  vec3,
} from '@bs-humany/frames';
import type { BoneDef, ExprContext, HsdlDocument } from '@bs-humany/hsdl';
import { evaluate } from '@bs-humany/hsdl';
import { evaluateRecipe } from './mesh/evaluate.js';
import { type MeshData, QUALITY_MEDIUM, type TessellationQuality } from './mesh/types.js';

export interface BoneInstance {
  readonly id: string;
  readonly displayName: string;
  readonly ta: string;
  readonly region: string;
  /** World transform in the rest pose, after composing the anatomical chain. */
  readonly worldTransform: Transform;
  /** Index into the merged buffers' `boneIndex` attribute. */
  readonly index: number;
  /** First vertex and vertex count within the merged buffer, for highlighting. */
  readonly vertexStart: number;
  readonly vertexCount: number;
}

export interface SkeletonMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  /** One entry per vertex, naming which bone it belongs to. */
  readonly boneIndex: Float32Array;
  readonly bones: readonly BoneInstance[];
  readonly triangleCount: number;
}

export interface BuildOptions {
  readonly quality?: TessellationQuality;
  /** Restrict to these bone IDs. Used by the region filters in the viewer. */
  readonly include?: ReadonlySet<string>;
}

/**
 * World transforms for every bone, in the rest pose.
 *
 * Computed by composing each bone's parent-relative rest transform down the tree. Exposed
 * separately because the pose module and the inspector both need it without the geometry.
 */
export function computeWorldTransforms(
  document: HsdlDocument,
  context: ExprContext,
): Map<string, Transform> {
  const byId = new Map(document.bones.map((b) => [b.id, b]));
  const world = new Map<string, Transform>();

  const resolve = (bone: BoneDef): Transform => {
    const cached = world.get(bone.id);
    if (cached) return cached;

    const local: Transform = {
      translation: vec3(
        evaluate(bone.restTransform.translation.x, context),
        evaluate(bone.restTransform.translation.y, context),
        evaluate(bone.restTransform.translation.z, context),
      ),
      rotation: bone.restTransform.rotation,
    };

    const parent = bone.parent === null ? undefined : byId.get(bone.parent);
    const parentWorld = parent ? resolve(parent) : IDENTITY_TRANSFORM;
    const result = compose(parentWorld, local);
    world.set(bone.id, result);
    return result;
  };

  for (const bone of document.bones) resolve(bone);
  return world;
}

/** Evaluate every bone's geometry and bake it into one merged buffer. */
export function buildSkeletonMesh(
  document: HsdlDocument,
  context: ExprContext,
  options: BuildOptions = {},
): SkeletonMesh {
  const quality = options.quality ?? QUALITY_MEDIUM;
  const worldTransforms = computeWorldTransforms(document, context);

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const boneIndex: number[] = [];
  const bones: BoneInstance[] = [];

  let index = 0;
  for (const bone of document.bones) {
    if (options.include && !options.include.has(bone.id)) continue;

    const transform = worldTransforms.get(bone.id) ?? IDENTITY_TRANSFORM;

    let mesh: MeshData;
    try {
      mesh = evaluateRecipe(bone.geometry, context, { quality });
    } catch (error) {
      // Name the bone. A recipe failure deep in a 206-bone build is otherwise a stack trace with
      // no indication of which entry is wrong.
      throw new Error(
        `Failed to evaluate geometry for bone '${bone.id}' (${bone.displayName}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const vertexStart = positions.length / 3;
    const count = mesh.positions.length / 3;
    const base = vertexStart;

    for (let i = 0; i < count; i++) {
      const local = vec3(
        mesh.positions[i * 3] ?? 0,
        mesh.positions[i * 3 + 1] ?? 0,
        mesh.positions[i * 3 + 2] ?? 0,
      );
      const localNormal = vec3(
        mesh.normals[i * 3] ?? 0,
        mesh.normals[i * 3 + 1] ?? 0,
        mesh.normals[i * 3 + 2] ?? 0,
      );

      const worldPosition = transformPoint(transform, local);
      // Normals are directions: rotate, never translate.
      const worldNormal = rotate(transform.rotation, localNormal);

      positions.push(worldPosition.x, worldPosition.y, worldPosition.z);
      normals.push(worldNormal.x, worldNormal.y, worldNormal.z);
      boneIndex.push(index);
    }

    for (const i of mesh.indices) indices.push(base + i);

    bones.push({
      id: bone.id,
      displayName: bone.displayName,
      ta: bone.ta,
      region: bone.region,
      worldTransform: transform,
      index,
      vertexStart,
      vertexCount: count,
    });
    index++;
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    boneIndex: new Float32Array(boneIndex),
    bones,
    triangleCount: indices.length / 3,
  };
}

/** Axis-aligned bounds of a built skeleton, for framing the camera. */
export function skeletonBounds(mesh: SkeletonMesh): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const min: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let a = 0 as 0 | 1 | 2; a < 3; a = (a + 1) as 0 | 1 | 2) {
      const v = mesh.positions[i + a] ?? 0;
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}
