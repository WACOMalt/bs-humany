/**
 * Our own points, as things you can pick and move.
 *
 * Two kinds, and they are wrong in different ways. A **joint centre** is where the articulation
 * turns; several of ours are taken from a single marker, and the dataset's markers are label
 * anchors -- placed out in the clear beside a feature so a text label can point at it -- which
 * makes them unusable as positions. The hip and the shoulder were fixed for exactly this; the
 * lumbosacral joint and the atlanto-occipital joint still sit 17 and 23 millimetres off the
 * midline, where every other spinal level sits at zero. An **attachment site** is where a muscle
 * starts or ends, and those are measured off the mesh already.
 *
 * What a handle is for is judging a point against the bone it sits on, by eye, and moving it when
 * it is plainly wrong. The reference model on screen beside it is context and never the target.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import { transformPoint } from '@bs-humany/frames';
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';

export type HandleKind = 'joints' | 'sites';

export interface Handle {
  readonly id: string;
  readonly kind: HandleKind;
  /** What it belongs to: the parent segment for a joint, the bone for a site. */
  readonly on: string;
  /** Where it sits now, in world space at the rest pose. */
  readonly world: Vector3;
  /** Where it sat before anything moved it. */
  readonly original: Vector3;
}

/** A point moved, and why, which is the whole record an override needs. */
export interface Move {
  readonly id: string;
  readonly kind: HandleKind;
  readonly on: string;
  readonly from: [number, number, number];
  readonly to: [number, number, number];
  /** Millimetres, for the eye. */
  readonly moved: number;
  readonly reason: string;
}

const LIT = new Color(0xe0864a);
const REST = new Color(0x8c93a8);
const MOVED = new Color(0x4fb4c8);

export class PointHandles {
  readonly group = new Group();
  private handles: Handle[] = [];
  private cloud: Points | undefined;
  private picked = -1;
  private readonly moved = new Set<string>();

  constructor() {
    this.group.visible = false;
    this.group.renderOrder = 3;
  }

  /**
   * The joint centres at rest: each joint's frame in its parent, put into the world.
   *
   * This is the same quantity the tissue overlay draws a disc at, which is why a disc that looks
   * misplaced is a joint centre that is misplaced -- the drawing is faithful.
   */
  static jointsOf(model: CompiledArticulation): Handle[] {
    const out: Handle[] = [];
    for (const joint of model.joints) {
      const parent = model.segments[joint.parentSegment];
      if (!parent) continue;
      const p = transformPoint(parent.restWorld, joint.frameInParent.translation);
      const world = new Vector3(p.x, p.y, p.z);
      out.push({
        id: joint.id,
        kind: 'joints',
        on: parent.id,
        world,
        original: world.clone(),
      });
    }
    return out;
  }

  /** Every muscle attachment, in the world at rest, from the compiled muscle set. */
  static sitesOf(
    model: CompiledArticulation,
    sites: readonly { id: string; bone: string; world: { x: number; y: number; z: number } }[],
  ): Handle[] {
    const known = new Set(model.segments.map((s) => s.id));
    return sites
      .filter((s) => known.has(s.bone))
      .map((s) => {
        const world = new Vector3(s.world.x, s.world.y, s.world.z);
        return { id: s.id, kind: 'sites' as const, on: s.bone, world, original: world.clone() };
      });
  }

  show(handles: Handle[]): void {
    this.clear();
    this.handles = handles;
    if (handles.length === 0) return;
    const position: number[] = [];
    const colour: number[] = [];
    for (const h of handles) {
      position.push(h.world.x, h.world.y, h.world.z);
      const c = this.moved.has(h.id) ? MOVED : REST;
      colour.push(c.r, c.g, c.b);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colour, 3));
    const material = new PointsMaterial({
      size: 9,
      sizeAttenuation: false,
      vertexColors: true,
      depthTest: false,
      transparent: true,
    });
    this.cloud = new Points(geometry, material);
    this.group.add(this.cloud);
  }

  get all(): readonly Handle[] {
    return this.handles;
  }

  /** The handle nearest a world ray, within a tolerance, for picking with the mouse. */
  nearest(origin: Vector3, direction: Vector3, tolerance = 0.02): number {
    let best = -1;
    let bestDistance = tolerance;
    const v = new Vector3();
    for (let i = 0; i < this.handles.length; i++) {
      const h = this.handles[i] as Handle;
      v.copy(h.world).sub(origin);
      const along = v.dot(direction);
      if (along <= 0) continue;
      const d = v.addScaledVector(direction, -along).length();
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    return best;
  }

  pick(index: number): Handle | undefined {
    this.picked = index;
    this.repaint();
    return this.handles[index];
  }

  get pickedHandle(): Handle | undefined {
    return this.handles[this.picked];
  }

  /** Put the picked handle somewhere else; the cloud follows. */
  moveTo(world: Vector3): void {
    const h = this.handles[this.picked];
    if (!h) return;
    h.world.copy(world);
    const pos = this.cloud?.geometry.getAttribute('position');
    if (pos) {
      pos.setXYZ(this.picked, world.x, world.y, world.z);
      pos.needsUpdate = true;
    }
  }

  /** Record the picked handle's move, or drop it when it has been put back. */
  keep(reason: string): Move | undefined {
    const h = this.handles[this.picked];
    if (!h) return undefined;
    const moved = h.world.distanceTo(h.original);
    if (moved < 1e-6) return undefined;
    this.moved.add(h.id);
    this.repaint();
    return {
      id: h.id,
      kind: h.kind,
      on: h.on,
      from: [h.original.x, h.original.y, h.original.z],
      to: [h.world.x, h.world.y, h.world.z],
      moved: Number((1000 * moved).toFixed(2)),
      reason,
    };
  }

  revert(): Handle | undefined {
    const h = this.handles[this.picked];
    if (!h) return undefined;
    this.moveTo(h.original.clone());
    this.moved.delete(h.id);
    this.repaint();
    return h;
  }

  private repaint(): void {
    const colour = this.cloud?.geometry.getAttribute('color');
    if (!colour) return;
    for (let i = 0; i < this.handles.length; i++) {
      const h = this.handles[i] as Handle;
      const c = i === this.picked ? LIT : this.moved.has(h.id) ? MOVED : REST;
      colour.setXYZ(i, c.r, c.g, c.b);
    }
    colour.needsUpdate = true;
  }

  set visible(on: boolean) {
    this.group.visible = on;
  }

  clear(): void {
    if (!this.cloud) return;
    this.cloud.removeFromParent();
    this.cloud.geometry.dispose();
    (this.cloud.material as PointsMaterial).dispose();
    this.cloud = undefined;
    this.picked = -1;
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }
}
