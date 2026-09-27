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

import type { BoneMesh, SkeletonAssets } from '@bs-humany/assets-anatomical';
import {
  IDENTITY_TRANSFORM,
  type Transform,
  rotate,
  transformPoint,
  vec3,
} from '@bs-humany/frames';
import type { ExprContext, HsdlDocument } from '@bs-humany/hsdl';
import { evaluate } from '@bs-humany/hsdl';
import { evaluateRecipe } from './mesh/evaluate.js';
import { computeSmoothNormals } from './mesh/primitives.js';
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
  readonly geometrySource: GeometrySource;
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
  /**
   * Measured bone meshes (ADR-005, ADR-011). A bone present here is drawn from the dataset; any
   * bone absent -- the ossicles, or everything when no assets are loaded -- falls back to its
   * procedural recipe.
   *
   * Dataset meshes are stored in world space at the dataset subject's stature. For now they are
   * scaled uniformly by `stature / subjectStature`, which keeps every bone where the dataset put
   * it and makes the whole skeleton follow the stature slider. Per-bone placement at parametric
   * joint centres, so that pelvic and shoulder breadth act on the measured skeleton too, comes
   * with the landmark-derived frames of M1.2/M1.3.
   */
  readonly assets?: SkeletonAssets;
}

/** Which source a bone's geometry came from, surfaced in the inspector. */
export type GeometrySource = 'dataset' | 'procedural';

import { computeWorldTransforms } from '@bs-humany/skeleton';

export { computeWorldTransforms };

/**
 * Each measured bone's smooth normals, worked out once per loaded pack.
 *
 * A measured bone is only ever scaled, and uniformly -- by `stature / subjectStature`, see
 * `BuildOptions.assets` -- and a uniform scale does not turn a surface, so its normals are the same
 * whatever the sliders say. Recomputing them for all two hundred bones on every rebuild was most of
 * the cost of a stature drag. Keyed on the pack's own bone objects, so a pack that is let go takes
 * its normals with it.
 */
const datasetNormals = new WeakMap<BoneMesh, Float32Array>();

function normalsOf(bone: BoneMesh): Float32Array {
  let normals = datasetNormals.get(bone);
  if (!normals) {
    normals = computeSmoothNormals(bone.positions, bone.indices);
    datasetNormals.set(bone, normals);
  }
  return normals;
}

/** One bone's contribution to the merged buffer, decided before anything is allocated. */
type Planned =
  | {
      readonly bone: HsdlDocument['bones'][number];
      readonly transform: Transform;
      readonly dataset: BoneMesh;
    }
  | {
      readonly bone: HsdlDocument['bones'][number];
      readonly transform: Transform;
      readonly mesh: MeshData;
    };

/**
 * Evaluate every bone's geometry and bake it into one merged buffer.
 *
 * Two passes: the first decides where every bone's geometry comes from and counts it, the second
 * writes it into buffers allocated once at their final size. It used to push each of a quarter of
 * a million vertices onto plain arrays and copy those into typed ones at the end, which on a
 * slider drag was a second copy of the whole skeleton per input event. The numbers written are
 * the same: the same float64 products, rounded to float32 once, where they land.
 */
export function buildSkeletonMesh(
  document: HsdlDocument,
  context: ExprContext,
  options: BuildOptions = {},
): SkeletonMesh {
  const quality = options.quality ?? QUALITY_MEDIUM;
  const worldTransforms = computeWorldTransforms(document, context);
  const assets = options.assets;
  const stature = evaluate({ param: 'stature' }, context);
  const datasetScale = assets ? stature / assets.manifest.subjectStature : 1;

  // --- Pass one: what each bone is drawn from, and how much of it there is ----------------------
  const plan: Planned[] = [];
  let vertexTotal = 0;
  let indexTotal = 0;
  for (const bone of document.bones) {
    if (options.include && !options.include.has(bone.id)) continue;

    const transform = worldTransforms.get(bone.id) ?? IDENTITY_TRANSFORM;
    const datasetBone = assets?.bones.get(bone.id);

    if (datasetBone) {
      plan.push({ bone, transform, dataset: datasetBone });
      vertexTotal += datasetBone.positions.length / 3;
      indexTotal += datasetBone.indices.length;
      continue;
    }

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
    plan.push({ bone, transform, mesh });
    vertexTotal += mesh.positions.length / 3;
    indexTotal += mesh.indices.length;
  }

  // --- Pass two: fill buffers allocated once -----------------------------------------------------
  const positions = new Float32Array(vertexTotal * 3);
  const normals = new Float32Array(vertexTotal * 3);
  const indices = new Uint32Array(indexTotal);
  const boneIndex = new Float32Array(vertexTotal);
  const bones: BoneInstance[] = [];

  let vertexStart = 0;
  let indexStart = 0;
  plan.forEach((entry, index) => {
    const { bone, transform } = entry;
    let count: number;
    let source: GeometrySource;

    if ('dataset' in entry) {
      // Already in world space: scale about the origin and skip the rest-transform chain.
      const from = entry.dataset.positions;
      count = from.length / 3;
      for (let i = 0; i < count * 3; i++) {
        positions[vertexStart * 3 + i] = (from[i] ?? 0) * datasetScale;
      }
      normals.set(normalsOf(entry.dataset), vertexStart * 3);
      const local = entry.dataset.indices;
      for (let i = 0; i < local.length; i++)
        indices[indexStart + i] = vertexStart + (local[i] ?? 0);
      indexStart += local.length;
      source = 'dataset';
    } else {
      const mesh = entry.mesh;
      count = mesh.positions.length / 3;
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

        const at = (vertexStart + i) * 3;
        positions[at] = worldPosition.x;
        positions[at + 1] = worldPosition.y;
        positions[at + 2] = worldPosition.z;
        normals[at] = worldNormal.x;
        normals[at + 1] = worldNormal.y;
        normals[at + 2] = worldNormal.z;
      }
      for (let i = 0; i < mesh.indices.length; i++) {
        indices[indexStart + i] = vertexStart + (mesh.indices[i] ?? 0);
      }
      indexStart += mesh.indices.length;
      source = 'procedural';
    }

    boneIndex.fill(index, vertexStart, vertexStart + count);
    bones.push({
      id: bone.id,
      displayName: bone.displayName,
      ta: bone.ta,
      region: bone.region,
      worldTransform: transform,
      index,
      vertexStart,
      vertexCount: count,
      geometrySource: source,
    });
    vertexStart += count;
  });

  return {
    positions,
    normals,
    indices,
    boneIndex,
    bones,
    triangleCount: indexTotal / 3,
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
