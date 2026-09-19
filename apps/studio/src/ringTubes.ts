/**
 * Muscle bellies from rings: the tube each ring set sweeps, as one three.js mesh.
 *
 * What the muscle bridge carries is rings -- centre, orientation, radius -- and this is the
 * studio's sweep of them, the same sweep the headset viewer does in Rust: vertex `k` of a ring
 * at angle `2 pi k / segments` in the ring's own plane, its normal the same direction, the
 * strips between consecutive rings of a unit, units not stitched to each other.
 */

import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial } from 'three';

export class RingTubes {
  readonly mesh: Mesh;
  private readonly geometry: BufferGeometry;
  private readonly units: number;
  private readonly rings: number;
  private readonly segments: number;

  constructor(units: number, rings: number, segments: number) {
    this.units = units;
    this.rings = rings;
    this.segments = segments;
    const vertices = units * rings * segments;
    const indices = new Uint32Array(units * (rings - 1) * segments * 6);
    let at = 0;
    for (let unit = 0; unit < units; unit++) {
      for (let ring = 0; ring < rings - 1; ring++) {
        const a = (unit * rings + ring) * segments;
        const b = a + segments;
        for (let k = 0; k < segments; k++) {
          const next = (k + 1) % segments;
          indices.set([a + k, b + k, b + next, a + k, b + next, a + next], at);
          at += 6;
        }
      }
    }
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(3 * vertices), 3));
    this.geometry.setAttribute('normal', new BufferAttribute(new Float32Array(3 * vertices), 3));
    this.geometry.setIndex(new BufferAttribute(indices, 1));
    this.mesh = new Mesh(
      this.geometry,
      new MeshStandardMaterial({ color: 0xb84448, roughness: 0.55, metalness: 0 }),
    );
    this.mesh.frustumCulled = false;
  }

  /** `position` 3 a ring, `orientation` 4, `radius` 1, `units * rings` rings. */
  update(
    position: ArrayLike<number>,
    orientation: ArrayLike<number>,
    radius: ArrayLike<number>,
  ): void {
    const pos = this.geometry.getAttribute('position').array as Float32Array;
    const nor = this.geometry.getAttribute('normal').array as Float32Array;
    const total = this.units * this.rings;
    let v = 0;
    for (let r = 0; r < total; r++) {
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
      for (let k = 0; k < this.segments; k++) {
        const angle = (2 * Math.PI * k) / this.segments;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const nx = x0 * c + y0 * s;
        const ny = x1 * c + y1 * s;
        const nz = x2 * c + y2 * s;
        pos[v] = cx + radiusR * nx;
        pos[v + 1] = cy + radiusR * ny;
        pos[v + 2] = cz + radiusR * nz;
        nor[v] = nx;
        nor[v + 1] = ny;
        nor[v + 2] = nz;
        v += 3;
      }
    }
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('normal').needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as MeshStandardMaterial).dispose();
  }
}
