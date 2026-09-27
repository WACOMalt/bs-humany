/**
 * Our own points, as things you can pick and move.
 *
 * Three kinds. A **joint centre** is where the articulation turns. Several of ours were taken from
 * a single marker, and the dataset's markers are label anchors -- placed out in the clear beside a
 * feature so a text label can point at it -- which made them unusable as positions. The hip and
 * the shoulder were fitted from geometry for exactly this, and the lumbosacral and
 * atlanto-occipital joints, which sat 17 and 23 millimetres off the midline where every other
 * spinal level sat at zero, were moved to the discs they are named for in d4bbb4c. An **origin or
 * insertion** is where a muscle starts or ends, measured off the mesh already. A **via point** is
 * where a path is held on its way between them; those are shown to be inspected and cannot be
 * kept as moves yet.
 *
 * The handles are for the points found wrong after all that: judging a point against the bone it
 * sits on, by eye, and moving it when it is plainly wrong. The reference model on screen beside it
 * is context and never the target.
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
import type { MorphologyInput } from './provenance.js';

export type HandleKind = 'joints' | 'sites' | 'vias';

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
  /**
   * The body the move was made on, stamped by the panel when it is kept. Absent on a move read
   * from a version-1 file, which recorded none.
   */
  readonly profile?: string;
  readonly morphology?: MorphologyInput;
}

/**
 * How close, in metres, a kept move's `from` must be to a handle's own position for the move to
 * apply to it: a tenth of a millimetre.
 *
 * A move says where a point went from, and a rebuild at another profile or stature puts the same
 * id somewhere else. Drawing the old `to` there would show a displacement nobody made, so a move
 * whose `from` no longer matches is reported as stale and the handle stays where the body put it.
 * The tolerance only has to absorb the round trip through a saved file's decimal numbers.
 */
export const KEPT_MATCH = 0.0001;

/**
 * The handle colours: picked, untouched, kept, and moved but not kept yet.
 *
 * Pending is amber and not the picked orange, because the two have to be told apart at a glance
 * when the picked point is itself one that was moved: the pick is the one lit, and every other
 * amber dot is a move that will be lost unless it is kept.
 */
export const HANDLE_COLOURS = {
  lit: new Color(0xe0864a),
  rest: new Color(0x8c93a8),
  kept: new Color(0x4fb4c8),
  pending: new Color(0xe8c547),
} as const;

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
  /** The panel's kept moves as last handed over, for the colours; the panel's list is the record. */
  private kept: ReadonlyMap<string, Move> = new Map();
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

  /**
   * Via points as handles: where each muscle path is held between its ends, on the bone that
   * carries it. Read-only in the panel for now; see `viaPoints` in `ourBody.ts`.
   */
  static viasOf(
    vias: readonly { id: string; bone: string; world: { x: number; y: number; z: number } }[],
  ): Handle[] {
    return vias.map((v) => {
      const world = new Vector3(v.world.x, v.world.y, v.world.z);
      return { id: v.id, kind: 'vias' as const, on: v.bone, world, original: world.clone() };
    });
  }

  /**
   * Draw a set of handles, each where the moves made so far put it.
   *
   * A handle with a kept move of its own kind, whose `from` is still where the body puts it, is
   * drawn at the move's `to`; one with a move not kept yet is drawn where it was dragged. A kept
   * move whose `from` no longer matches -- the body was rebuilt at another profile or stature --
   * is returned as stale and not applied. So a rebuild or a switch of kind loses nothing, where
   * it used to put every point back and leave the list of kept moves describing a picture that
   * was no longer on screen.
   */
  show(
    handles: Handle[],
    kept: ReadonlyMap<string, Move> = new Map(),
    pending: ReadonlyMap<string, Vector3> = new Map(),
  ): { stale: string[] } {
    this.clear();
    this.handles = handles;
    this.kept = kept;
    const stale: string[] = [];
    for (const h of handles) {
      const m = kept.get(h.id);
      const at = pending.get(h.id);
      if (m && m.kind === h.kind && h.original.distanceTo(vector(m.from)) <= KEPT_MATCH) {
        h.world.copy(at ?? vector(m.to));
      } else {
        if (m && m.kind === h.kind) stale.push(h.id);
        if (at) h.world.copy(at);
      }
    }
    if (handles.length === 0) return { stale };
    const position: number[] = [];
    const colour: number[] = [];
    for (const [i, h] of handles.entries()) {
      position.push(h.world.x, h.world.y, h.world.z);
      const c = this.colourFor(i);
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
    return { stale };
  }

  /** Take the panel's kept moves again after one was kept or put back, and recolour. */
  recolour(kept: ReadonlyMap<string, Move>): void {
    this.kept = kept;
    this.repaint();
  }

  /** Where a handle is in the list, by id, or -1 when it is not drawn. */
  indexOf(id: string): number {
    return this.handles.findIndex((h) => h.id === id);
  }

  /** The colour a handle is drawn in now, for a test to read. */
  colourAt(index: number): Color | undefined {
    const colour = this.cloud?.geometry.getAttribute('color');
    if (!colour || index < 0 || index >= colour.count) return undefined;
    return new Color(colour.getX(index), colour.getY(index), colour.getZ(index));
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
    this.repaint();
    return h;
  }

  /**
   * A handle's colour: lit when picked; kept when it sits at its kept move's `to`; pending when it
   * sits anywhere else than where the body or a kept move put it; at rest otherwise.
   */
  private colourFor(index: number): Color {
    const h = this.handles[index];
    if (!h) return HANDLE_COLOURS.rest;
    if (index === this.picked) return HANDLE_COLOURS.lit;
    const m = this.kept.get(h.id);
    const keptHere =
      m !== undefined &&
      m.kind === h.kind &&
      h.original.distanceTo(vector(m.from)) <= KEPT_MATCH &&
      h.world.distanceTo(vector(m.to)) <= KEPT_MATCH;
    if (keptHere) return HANDLE_COLOURS.kept;
    if (h.world.distanceTo(h.original) > KEPT_MATCH) return HANDLE_COLOURS.pending;
    return HANDLE_COLOURS.rest;
  }

  private repaint(): void {
    const colour = this.cloud?.geometry.getAttribute('color');
    if (!colour) return;
    for (let i = 0; i < this.handles.length; i++) {
      const c = this.colourFor(i);
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

/** A saved three-number position as a vector. */
function vector(p: readonly [number, number, number]): Vector3 {
  return new Vector3(p[0], p[1], p[2]);
}
