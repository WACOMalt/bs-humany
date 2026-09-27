/**
 * Rings back into a belly: the one sweep every consumer of captured or bridged rings shares.
 *
 * What the muscle bridge carries and the ring capture holds is rings -- centre, orientation,
 * radius -- and three places in the studio turn them back into vertices: the playhead replaying a
 * run, the tubes drawn for a body followed over the bridge, and the Blender export's vertex cache.
 * They used to do it three times over, in two different formulations of the same rotation, which
 * is two chances for one of them to drift from the others without anything saying so. This is the
 * one sweep, and the headset viewer does the same arithmetic in Rust.
 *
 * Vertex `k` of a ring is at angle `2 pi k / segments` from the ring frame's own X axis, in the
 * plane X and Y span, at the ring's radius. That is not a convention chosen here: it is how
 * `extractMuscleRings` (packages/modules-muscle/src/rings.ts) measured the frame off the swept
 * mesh -- X toward vertex zero, Z along the ring's normal -- so running it backwards puts every
 * vertex where the sweep had it. The normal is the same direction without the radius, which for a
 * tube is the surface normal the sweep itself wrote rather than an estimate of one.
 *
 * The frame's X and Y columns are read straight off the quaternion rather than by rotating a
 * vector with it: six products a ring instead of a full rotation a vertex, and the same answer
 * for a unit quaternion. No three.js here, because the export runs where there is no scene.
 */

/** Somewhere to write numbers: a `Float32Array` and a `Float64Array` are both one. */
export interface WritableNumbers {
  [index: number]: number;
  readonly length: number;
}

/**
 * Sweep `ringCount` rings into `ringCount * segments` vertices, in ring order.
 *
 * `position` is 3 a ring, `orientation` 4 (xyzw), `radius` 1. The outputs are written from index
 * zero, 3 a vertex, and may be single or double precision: the renderer's attributes are the
 * one and the replayed and exported meshes the other. Allocation-free, since the tubes of a
 * followed body are swept every frame they arrive.
 */
export function sweepRings(
  position: ArrayLike<number>,
  orientation: ArrayLike<number>,
  radius: ArrayLike<number>,
  ringCount: number,
  segments: number,
  outPosition: WritableNumbers,
  outNormal: WritableNumbers,
): void {
  let v = 0;
  for (let r = 0; r < ringCount; r++) {
    const cx = position[3 * r] ?? 0;
    const cy = position[3 * r + 1] ?? 0;
    const cz = position[3 * r + 2] ?? 0;
    const qx = orientation[4 * r] ?? 0;
    const qy = orientation[4 * r + 1] ?? 0;
    const qz = orientation[4 * r + 2] ?? 0;
    const qw = orientation[4 * r + 3] ?? 1;
    const radiusR = radius[r] ?? 0;
    // The ring frame's X and Y columns from the quaternion.
    const x0 = 1 - 2 * (qy * qy + qz * qz);
    const x1 = 2 * (qx * qy + qz * qw);
    const x2 = 2 * (qx * qz - qy * qw);
    const y0 = 2 * (qx * qy - qz * qw);
    const y1 = 1 - 2 * (qx * qx + qz * qz);
    const y2 = 2 * (qy * qz + qx * qw);
    for (let k = 0; k < segments; k++) {
      const angle = (2 * Math.PI * k) / segments;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const nx = x0 * c + y0 * s;
      const ny = x1 * c + y1 * s;
      const nz = x2 * c + y2 * s;
      outPosition[v] = cx + radiusR * nx;
      outPosition[v + 1] = cy + radiusR * ny;
      outPosition[v + 2] = cz + radiusR * nz;
      outNormal[v] = nx;
      outNormal[v + 1] = ny;
      outNormal[v + 2] = nz;
      v += 3;
    }
  }
}
