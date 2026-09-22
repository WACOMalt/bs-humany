/**
 * The reference models' muscles, drawn beside ours.
 *
 * The parameters in this body come from MyoSuite and the geometry from Z-Anatomy, and nothing in
 * either says which of their muscles is which of ours: the names do not match -- their torso
 * calls the external obliques `EO1` to `EO6` where we have one `external_oblique` -- and the
 * correspondence is not one to one. It has to be decided by someone looking at both, which means
 * both have to be on screen at once.
 *
 * What is drawn is each muscle's path as a polyline through the sites it runs over, read off the
 * running model by `pnpm extract:source-sites`. Their meshes are not vendored, only the XML, so
 * there are no bones on that side -- and for deciding which muscle is which, paths are enough.
 *
 * ## Why the whole model gets a transform
 *
 * Their world is not ours. Their torso roots at the sacrum with its own orientation; our pelvis
 * sits wherever the scenario put it. Before any muscle can be compared to any other the two
 * bodies have to be brought roughly into register, and that is a rigid placement a person does by
 * eye in a few seconds and a script gets subtly wrong. So the overlay carries one transform for
 * the whole model, and the alignment tool hands it a gizmo.
 *
 * It is a *reference*. Nothing here is ever a snap target: attachment points in this project are
 * measured from the Z-Anatomy meshes and stay ours (ADR-011), and a tool that made it easy to
 * drag ours onto theirs would quietly undo that decision.
 */

import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Vector3,
} from 'three';

export interface SourceMuscle {
  readonly name: string;
  /** World points on the source model, flat xyz, in that model's own frame. */
  readonly path: readonly number[];
  /** Which body carries each point, one per point, for a per-body retarget. */
  readonly on: readonly string[];
  /** The bodies its sites sit on, in the source's own naming. */
  readonly bodies: readonly string[];
}

/** One of their joints: where it turns, in their world, and which body it is on. */
export interface SourceJoint {
  readonly name: string;
  readonly body: string | null;
  readonly anchor: readonly number[];
  readonly axis: readonly number[];
}

/** One of their bodies, with its pose in their world at the neutral pose. */
export interface SourceBody {
  readonly name: string;
  /** The body it hangs off, or null at the root. */
  readonly parent: string | null;
  readonly pos: readonly number[];
  /** MuJoCo's order: w first. */
  readonly quat: readonly number[];
}

export interface SourceModel {
  readonly muscles: readonly SourceMuscle[];
  readonly joints: readonly SourceJoint[];
  readonly bodies: readonly SourceBody[];
}

export interface SourceSites {
  readonly format: string;
  readonly models: Readonly<Record<string, SourceModel>>;
}

/** Where a model's overlay sits in our world, and how big. */
export interface Placement {
  x: number;
  y: number;
  z: number;
  /** Degrees, applied in XYZ order. */
  rx: number;
  ry: number;
  rz: number;
  scale: number;
}

export const NEUTRAL: Placement = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1 };

/**
 * A first guess at where a model belongs.
 *
 * MyoSuite's models are Z-up and ours is Y-up, which is a quarter turn about X and is the one
 * part of the registration that is a fact rather than a judgement. The rest -- where along the
 * body, and whether the stature matches -- is left at neutral for a person to set, because
 * guessing it would put the two bodies somewhere plausible and wrong.
 */
export const Z_UP_TO_Y_UP: Placement = { ...NEUTRAL, rx: -90 };

export class SourceOverlay {
  readonly group = new Group();
  private readonly lines = new Map<string, LineSegments>();
  private data: SourceSites | undefined;
  private shown = new Set<string>();

  constructor(private readonly colour = new Color(0x4fb4c8)) {
    this.group.visible = false;
    this.group.renderOrder = 2;
  }

  load(data: SourceSites): void {
    this.data = data;
  }

  get models(): readonly string[] {
    return this.data ? Object.keys(this.data.models) : [];
  }

  muscles(model: string): readonly SourceMuscle[] {
    return this.data?.models[model]?.muscles ?? [];
  }

  model(name: string): SourceModel | undefined {
    return this.data?.models[name];
  }

  /**
   * Draw the paths a retarget has already moved onto our bones, rather than their own.
   *
   * A muscle whose path could not be retargeted -- because one of the bodies it runs over is not
   * paired yet -- is left out, because half a path on our bones and half on theirs is a picture
   * of nothing.
   */
  showRetargeted(paths: ReadonlyMap<string, readonly number[]>): void {
    this.clear();
    for (const [name, path] of paths) {
      const points: number[] = [];
      const n = path.length / 3;
      for (let i = 0; i < n - 1; i++) {
        points.push(
          path[3 * i] as number,
          path[3 * i + 1] as number,
          path[3 * i + 2] as number,
          path[3 * i + 3] as number,
          path[3 * i + 4] as number,
          path[3 * i + 5] as number,
        );
      }
      if (points.length === 0) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
      const material = new LineBasicMaterial({
        color: this.colour,
        transparent: true,
        opacity: 0.45,
        depthTest: false,
      });
      const line = new LineSegments(geometry, material);
      line.name = name;
      this.lines.set(name, line);
      this.group.add(line);
    }
  }

  /** Draw one model's muscles; anything drawn before is taken down. */
  show(model: string): void {
    this.clear();
    for (const muscle of this.muscles(model)) {
      const points: number[] = [];
      const n = muscle.path.length / 3;
      for (let i = 0; i < n - 1; i++) {
        points.push(
          muscle.path[3 * i] as number,
          muscle.path[3 * i + 1] as number,
          muscle.path[3 * i + 2] as number,
          muscle.path[3 * i + 3] as number,
          muscle.path[3 * i + 4] as number,
          muscle.path[3 * i + 5] as number,
        );
      }
      if (points.length === 0) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
      const material = new LineBasicMaterial({
        color: this.colour,
        transparent: true,
        opacity: 0.45,
        depthTest: false,
      });
      const line = new LineSegments(geometry, material);
      line.name = muscle.name;
      this.lines.set(muscle.name, line);
      this.group.add(line);
    }
  }

  /** Light one muscle up and dim the rest, or clear the emphasis with undefined. */
  emphasise(name: string | undefined): void {
    for (const [id, line] of this.lines) {
      const material = line.material as LineBasicMaterial;
      const lit = name === undefined || id === name;
      material.opacity = lit ? (name === undefined ? 0.45 : 0.95) : 0.08;
      material.needsUpdate = true;
    }
  }

  /** Which muscles are already paired, so the eye can skip them. */
  markPaired(paired: ReadonlySet<string>): void {
    this.shown = new Set(paired);
    for (const [id, line] of this.lines) {
      (line.material as LineBasicMaterial).color.set(
        this.shown.has(id) ? 0x6d747f : this.colour.getHex(),
      );
    }
  }

  place(p: Placement): void {
    this.group.position.set(p.x, p.y, p.z);
    this.group.rotation.set((p.rx * Math.PI) / 180, (p.ry * Math.PI) / 180, (p.rz * Math.PI) / 180);
    this.group.scale.setScalar(p.scale);
  }

  /** The placement back out of the group, after a gizmo has moved it. */
  readPlacement(): Placement {
    const r = this.group.rotation;
    return {
      x: this.group.position.x,
      y: this.group.position.y,
      z: this.group.position.z,
      rx: (r.x * 180) / Math.PI,
      ry: (r.y * 180) / Math.PI,
      rz: (r.z * 180) / Math.PI,
      scale: this.group.scale.x,
    };
  }

  /** The centre of what is drawn, for pointing a camera or a gizmo at it. */
  centre(): Vector3 {
    const box = new Vector3();
    let n = 0;
    const sum = new Vector3();
    for (const line of this.lines.values()) {
      const pos = line.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        sum.add(box.set(pos.getX(i), pos.getY(i), pos.getZ(i)));
        n += 1;
      }
    }
    return n ? sum.divideScalar(n) : new Vector3();
  }

  set visible(on: boolean) {
    this.group.visible = on;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  clear(): void {
    for (const line of this.lines.values()) {
      line.removeFromParent();
      line.geometry.dispose();
      (line.material as LineBasicMaterial).dispose();
    }
    this.lines.clear();
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }
}
