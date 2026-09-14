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

export interface BonePick {
  readonly boneId: string;
  /** World point where the ray met the bone. */
  readonly point: Vector3;
  readonly distance: number;
}

export interface SkinnedSkeleton {
  readonly mesh: SkinnedMesh;
  /** Bone index by document bone id. */
  readonly indexOf: ReadonlyMap<string, number>;
  /** Pose bones from world transforms given in `order`. */
  update(order: readonly string[], position: Float64Array, orientation: Float64Array): void;
  /** Put every bone back at rest. */
  rest(): void;
  /**
   * The nearest bone a ray meets, or null.
   *
   * Not `Raycaster.intersectObject`: that skins every one of the half-million triangles on the
   * CPU and takes the better part of a second at L3, which is long enough that a press has
   * ended before the grab it asked for begins. Each bone here is rigid -- one bone per vertex,
   * weight one -- so the ray is carried into each bone's own frame instead, rejected against a
   * bounding sphere it was fitted to at rest, and only then tested against triangles. A handful
   * of bones survive the spheres, so a pick costs a fraction of a millisecond.
   */
  pick(origin: Vector3, direction: Vector3): BonePick | null;
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

  // --- Picking ---------------------------------------------------------------------------------
  // Per bone: the triangles that belong to it, and a sphere around them in the rest pose. The
  // merged buffers group both by bone, so each is a contiguous run found in one pass.
  const positions = geometry.getAttribute('position');
  const indices = geometry.getIndex();
  const perBone = skeleton.bones.map((bone) => {
    const centre = new Vector3();
    for (let v = bone.vertexStart; v < bone.vertexStart + bone.vertexCount; v++) {
      centre.x += positions.getX(v);
      centre.y += positions.getY(v);
      centre.z += positions.getZ(v);
    }
    if (bone.vertexCount > 0) centre.divideScalar(bone.vertexCount);
    let radius = 0;
    const point = new Vector3();
    for (let v = bone.vertexStart; v < bone.vertexStart + bone.vertexCount; v++) {
      point.set(positions.getX(v), positions.getY(v), positions.getZ(v));
      radius = Math.max(radius, point.distanceTo(centre));
    }
    return { centre, radius, first: 0, count: 0 };
  });
  if (indices) {
    // Triangles are emitted bone by bone, so the first and last index naming each bone bound it.
    for (let t = 0; t < indices.count; t += 3) {
      const b = skeleton.boneIndex[indices.getX(t)] ?? 0;
      const entry = perBone[b];
      if (!entry) continue;
      if (entry.count === 0) entry.first = t;
      entry.count += 3;
    }
  }

  const localOrigin = new Vector3();
  const localDirection = new Vector3();
  const toLocal = new Matrix4();
  const edge1 = new Vector3();
  const edge2 = new Vector3();
  const pvec = new Vector3();
  const tvec = new Vector3();
  const qvec = new Vector3();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const candidates: { bone: number; near: number }[] = [];

  /** Distance along the ray at which it enters the sphere, or null if it misses. */
  function sphereEntry(centre: Vector3, radius: number): number | null {
    tvec.subVectors(centre, localOrigin);
    const along = tvec.dot(localDirection);
    const perpendicular = tvec.lengthSq() - along * along;
    const r2 = radius * radius;
    if (perpendicular > r2) return null;
    const half = Math.sqrt(r2 - perpendicular);
    const entry = along - half;
    const exit = along + half;
    if (exit < 0) return null;
    return Math.max(entry, 0);
  }

  /** Moller-Trumbore, nearest hit within one bone's triangles. Returns the distance or null. */
  function nearestTriangle(first: number, count: number, limit: number): number | null {
    if (!indices) return null;
    let best: number | null = null;
    for (let t = first; t < first + count; t += 3) {
      const ia = indices.getX(t);
      const ib = indices.getX(t + 1);
      const ic = indices.getX(t + 2);
      a.set(positions.getX(ia), positions.getY(ia), positions.getZ(ia));
      b.set(positions.getX(ib), positions.getY(ib), positions.getZ(ib));
      c.set(positions.getX(ic), positions.getY(ic), positions.getZ(ic));
      edge1.subVectors(b, a);
      edge2.subVectors(c, a);
      pvec.crossVectors(localDirection, edge2);
      const determinant = edge1.dot(pvec);
      // Both faces count: a bone seen from inside the rib cage should still be pickable.
      if (Math.abs(determinant) < 1e-12) continue;
      const inverse = 1 / determinant;
      tvec.subVectors(localOrigin, a);
      const u = tvec.dot(pvec) * inverse;
      if (u < 0 || u > 1) continue;
      qvec.crossVectors(tvec, edge1);
      const v = localDirection.dot(qvec) * inverse;
      if (v < 0 || u + v > 1) continue;
      const distance = edge2.dot(qvec) * inverse;
      if (distance < 0 || distance > limit) continue;
      if (best === null || distance < best) best = distance;
    }
    return best;
  }

  return {
    mesh,
    indexOf,

    pick(origin, direction) {
      candidates.length = 0;
      for (let i = 0; i < bones.length; i++) {
        const entry = perBone[i];
        const bone = bones[i];
        const inverse = inverses[i];
        if (!entry || !bone || !inverse || entry.count === 0) continue;
        // Rest space to now: the bone's current place, undone back to where the vertices live.
        toLocal.multiplyMatrices(bone.matrixWorld, inverse).invert();
        localOrigin.copy(origin).applyMatrix4(toLocal);
        localDirection.copy(direction).transformDirection(toLocal);
        const near = sphereEntry(entry.centre, entry.radius);
        if (near !== null) candidates.push({ bone: i, near });
      }
      candidates.sort((x, y) => x.near - y.near);
      let best: { bone: number; distance: number } | null = null;
      for (const candidate of candidates) {
        // Every remaining sphere starts beyond the hit already found.
        if (best && candidate.near > best.distance) break;
        const entry = perBone[candidate.bone];
        const bone = bones[candidate.bone];
        const inverse = inverses[candidate.bone];
        if (!entry || !bone || !inverse) continue;
        toLocal.multiplyMatrices(bone.matrixWorld, inverse).invert();
        localOrigin.copy(origin).applyMatrix4(toLocal);
        localDirection.copy(direction).transformDirection(toLocal);
        const distance = nearestTriangle(
          entry.first,
          entry.count,
          best ? best.distance : Number.POSITIVE_INFINITY,
        );
        if (distance !== null && (!best || distance < best.distance)) {
          best = { bone: candidate.bone, distance };
        }
      }
      if (!best) return null;
      const id = skeleton.bones[best.bone]?.id;
      if (!id) return null;
      return {
        boneId: id,
        // The ray is a unit direction in world space, so the distance carries over unchanged.
        point: new Vector3().copy(direction).multiplyScalar(best.distance).add(origin),
        distance: best.distance,
      };
    },

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
