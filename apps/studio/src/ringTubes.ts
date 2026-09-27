/**
 * Muscle bellies from rings: the tube each ring set sweeps, as one three.js mesh.
 *
 * What the muscle bridge carries is rings -- centre, orientation, radius -- and these are the
 * tubes they sweep into, with the studio's one sweep (`sweepRings`), the same one the playhead and
 * the export use and the headset viewer does in Rust: vertex `k` of a ring at angle
 * `2 pi k / segments` in the ring's own plane, its normal the same direction, the strips between
 * consecutive rings of a unit, units not stitched to each other.
 */

import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial } from 'three';
import { MUSCLE_SLACK, MUSCLE_TAUT } from './palette.js';
import { sweepRings } from './ringSweep.js';

// The studio's own overlay's colours, so a followed belly tints the way one of ours does.
const SLACK = new Color(MUSCLE_SLACK);
const TAUT = new Color(MUSCLE_TAUT);
const _tint = new Color();

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
          // Wound outward, as the sweep in `@bs-humany/muscle-volume` is: round the ring the way
          // the angle grows, then along it the way the tangent points. The other order draws the
          // tube inside out, which a front-face-culled material shows as its far wall.
          indices.set([a + k, a + next, b + k, a + next, b + next, b + k], at);
          at += 6;
        }
      }
    }
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(3 * vertices), 3));
    this.geometry.setAttribute('normal', new BufferAttribute(new Float32Array(3 * vertices), 3));
    const colours = new Float32Array(3 * vertices);
    for (let i = 0; i < vertices; i++) {
      colours[3 * i] = SLACK.r;
      colours[3 * i + 1] = SLACK.g;
      colours[3 * i + 2] = SLACK.b;
    }
    this.geometry.setAttribute('color', new BufferAttribute(colours, 3));
    this.geometry.setIndex(new BufferAttribute(indices, 1));
    this.mesh = new Mesh(
      this.geometry,
      new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 }),
    );
    this.mesh.frustumCulled = false;
  }

  /** `position` 3 a ring, `orientation` 4, `radius` 1, `units * rings` rings. */
  update(
    position: ArrayLike<number>,
    orientation: ArrayLike<number>,
    radius: ArrayLike<number>,
  ): void {
    sweepRings(
      position,
      orientation,
      radius,
      this.units * this.rings,
      this.segments,
      this.geometry.getAttribute('position').array as Float32Array,
      this.geometry.getAttribute('normal').array as Float32Array,
    );
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('normal').needsUpdate = true;
  }

  /** Tint each unit from slack to taut by its tension fraction, in unit order. */
  tint(tension: ArrayLike<number>): void {
    const colours = this.geometry.getAttribute('color').array as Float32Array;
    const perUnit = this.rings * this.segments;
    for (let unit = 0; unit < this.units; unit++) {
      _tint.copy(SLACK).lerp(TAUT, Math.min(1, Math.max(0, tension[unit] ?? 0)));
      const from = 3 * unit * perUnit;
      for (let v = 0; v < perUnit; v++) {
        colours[from + 3 * v] = _tint.r;
        colours[from + 3 * v + 1] = _tint.g;
        colours[from + 3 * v + 2] = _tint.b;
      }
    }
    this.geometry.getAttribute('color').needsUpdate = true;
  }

  /** Free the buffers and leave the scene: whoever added it need not remember where. */
  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    (this.mesh.material as MeshStandardMaterial).dispose();
  }
}
