/**
 * GPU skinning of the merged skeleton mesh.
 *
 * Every vertex already names its bone through the `boneIndex` attribute; that becomes a
 * one-weight skin. Each three.js `Bone` carries the bone's current world transform, and its
 * inverse-bind matrix is the inverse of the rest world transform, so the skinned vertex is
 * `current * rest^-1 * restVertex`. At rest every bone matrix is the identity and the mesh draws
 * exactly as the static one did.
 */

import type { SkeletonMesh } from '@bs-humany/render-three';
import {
  Bone,
  type BufferGeometry,
  Float32BufferAttribute,
  type Material,
  Matrix4,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Sphere,
  Uint16BufferAttribute,
  Vector3,
} from 'three';

export interface SkinnedSkeleton {
  readonly mesh: SkinnedMesh;
  /** Bone index by document bone id. */
  readonly indexOf: ReadonlyMap<string, number>;
  /** Pose bones from world transforms given in `order`. */
  update(order: readonly string[], position: Float64Array, orientation: Float64Array): void;
  /** Put every bone back at rest. */
  rest(): void;
  dispose(): void;
}

const ONE = new Vector3(1, 1, 1);

export function createSkinnedSkeleton(
  skeleton: SkeletonMesh,
  geometry: BufferGeometry,
  material: Material,
): SkinnedSkeleton {
  const vertexCount = geometry.getAttribute('position').count;
  const skinIndex = new Uint16Array(vertexCount * 4);
  const skinWeight = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) {
    skinIndex[4 * i] = skeleton.boneIndex[i] ?? 0;
    skinWeight[4 * i] = 1;
  }
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4));

  const bones: Bone[] = [];
  const inverses: Matrix4[] = [];
  const indexOf = new Map<string, number>();
  const position = new Vector3();
  const rotation = new Quaternion();
  for (const bone of skeleton.bones) {
    const b = new Bone();
    b.matrixAutoUpdate = false;
    const t = bone.worldTransform;
    position.set(t.translation.x, t.translation.y, t.translation.z);
    rotation.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
    b.matrixWorld.compose(position, rotation, ONE);
    inverses.push(b.matrixWorld.clone().invert());
    indexOf.set(bone.id, bones.length);
    bones.push(b);
  }
  const mesh = new SkinnedMesh(geometry, material);
  const three = new Skeleton(bones, inverses);
  mesh.bind(three, new Matrix4());
  mesh.frustumCulled = false;
  // Raycasting rejects against the geometry's rest-pose bounding sphere before it ever looks at
  // a skinned vertex, so a body that has fallen over would be unpickable. A sphere that covers
  // anywhere the body can plausibly be keeps picking honest at the cost of the early-out.
  geometry.boundingSphere = new Sphere(new Vector3(0, 1, 0), 25);

  const rests = bones.map((b) => b.matrixWorld.clone());
  return {
    mesh,
    indexOf,
    update(order, pos, quat) {
      for (let i = 0; i < order.length; i++) {
        const k = indexOf.get(order[i] as string);
        if (k === undefined) continue;
        const bone = bones[k];
        if (!bone) continue;
        position.set(pos[3 * i] ?? 0, pos[3 * i + 1] ?? 0, pos[3 * i + 2] ?? 0);
        rotation.set(
          quat[4 * i] ?? 0,
          quat[4 * i + 1] ?? 0,
          quat[4 * i + 2] ?? 0,
          quat[4 * i + 3] ?? 1,
        );
        bone.matrixWorld.compose(position, rotation, ONE);
      }
      three.update();
    },
    rest() {
      bones.forEach((b, i) => b.matrixWorld.copy(rests[i] as Matrix4));
      three.update();
    },
    dispose() {
      three.dispose();
      geometry.dispose();
    },
  };
}
