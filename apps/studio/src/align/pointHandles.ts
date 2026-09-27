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
import {
  BufferGeometry,
  type Camera,
  Color,
  Float32BufferAttribute,
  Group,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';
import { restJointCentre } from './ourBody.js';

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

/**
 * CSS pixels from a dot's centre that still count as clicking it.
 *
 * The dots are drawn nine CSS pixels across whatever the distance (`sizeAttenuation: false`), so
 * a press within 4.5 px is on the dot itself; the rest is slack for a hand that lands just beside
 * it. The tolerance is in pixels because the dot is: a tolerance in world metres is a different
 * size on screen at every zoom. The two centimetres this replaced were, on a viewport 800 pixels
 * high under the studio's 38-degree lens, some sixty pixels either way at the closest the camera
 * goes and under two at the farthest -- a dot you could not miss, then one you could not hit.
 */
export const PICK_RADIUS_PX = 8;

/** Screen distances this close are the same pixel, and the dot nearer the camera wins them. */
const SAME_PIXEL_PX = 1;

/** A box on the page, in CSS pixels: what `getBoundingClientRect` gives for the canvas. */
export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export class PointHandles {
  readonly group = new Group();
  private handles: Handle[] = [];
  private cloud: Points | undefined;
  private picked = -1;
  private readonly moved = new Set<string>();
  /** Reused by `nearestOnScreen`, which runs on every click in the viewport. */
  private readonly scratch = new Vector3();

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
      const world = restJointCentre(model, joint, 'parent');
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

  /**
   * Every muscle attachment, in the world at rest, from the compiled muscle set.
   *
   * A site is kept when the segment carrying it is in this body. Sites from `attachmentSites`
   * name that segment; a site that names only its bone is taken to be on the segment of the same
   * name, which is all an anchor bone can be. The handle is on the bone either way, because the
   * bone is what an override of the site has to name.
   */
  static sitesOf(
    model: CompiledArticulation,
    sites: readonly {
      id: string;
      bone: string;
      segment?: string;
      world: { x: number; y: number; z: number };
    }[],
  ): Handle[] {
    const known = new Set(model.segments.map((s) => s.id));
    return sites
      .filter((s) => known.has(s.segment ?? s.bone))
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

  /**
   * The handle drawn nearest a point on the page, within `radiusPx`, or -1 when none is.
   *
   * Each handle is put through the camera and onto the canvas's box, and measured from the
   * pointer in CSS pixels -- the unit the dots are drawn in. A handle whose depth falls outside
   * the view volume is skipped: one behind the eye still divides out onto the screen, often right
   * under the pointer, but nothing is drawn there. Two dots on the same pixel go to the one nearer
   * the camera, because that is the one on top as far as the eye can tell.
   */
  nearestOnScreen(
    camera: Camera,
    rect: ScreenRect,
    clientX: number,
    clientY: number,
    radiusPx = PICK_RADIUS_PX,
  ): number {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestDepth = Number.POSITIVE_INFINITY;
    const v = this.scratch;
    for (let i = 0; i < this.handles.length; i++) {
      const h = this.handles[i] as Handle;
      v.copy(h.world).project(camera);
      if (!(v.z >= -1 && v.z <= 1)) continue;
      const x = rect.left + ((v.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - v.y) / 2) * rect.height;
      const d = Math.hypot(x - clientX, y - clientY);
      if (d > radiusPx) continue;
      const clearlyCloser = d < bestDistance - SAME_PIXEL_PX;
      const samePixelNearer = Math.abs(d - bestDistance) <= SAME_PIXEL_PX && v.z < bestDepth;
      if (best < 0 || clearlyCloser || samePixelNearer) {
        best = i;
        // The smaller of the two, so a chain of near-ties cannot walk the pick away from the
        // pointer a pixel at a time.
        bestDistance = Math.min(bestDistance, d);
        bestDepth = v.z;
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
  /**
   * Whether the handles are showing.
   *
   * A setter with no getter reads back as undefined, never false, so `!handles.visible` was true
   * whatever had been set and every pick was turned away at its first line.
   */
  get visible(): boolean {
    return this.group.visible;
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
