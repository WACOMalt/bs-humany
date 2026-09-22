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
 * running model by `pnpm extract:source-sites`, alongside their bones: the models' own meshes,
 * vendored beside the XML and verified against the pinned commit.
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
  Mesh,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  Quaternion,
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
/** A bone mesh a body wears, and where it sits in that body's frame. */
export interface SourceMesh {
  readonly file: string;
  readonly pos: readonly number[];
  /** MuJoCo's order: w first. */
  readonly quat: readonly number[];
}

export interface SourceBody {
  readonly name: string;
  /** The body it hangs off, or null at the root. */
  readonly parent: string | null;
  /** The bone meshes it wears; empty for a body their model draws nothing for. */
  readonly meshes: readonly SourceMesh[];
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
 * A first guess at where a model belongs: the change of axes, which is a fact rather than a
 * judgement, and nothing else.
 *
 * Measured off both models rather than taken from either one's documentation, by asking which
 * axis separates a right femur from a left and which one drops from the pelvis to the toes:
 *
 *              lateral          vertical        forward
 *   theirs     X, right is -    Z, up is +      -Y
 *   ours       X, right is +    Y, up is +      -Z
 *
 * So a point of theirs becomes a point of ours as `(x, y, z) -> (-x, z, y)`. That is a half turn
 * about `(0, 1, 1)`, which is a rotation and not a reflection, as it has to be -- no arrangement
 * of bones turns into its own mirror image.
 *
 * As Euler angles in the order three composes them, that is a quarter turn back about X and a
 * half turn about Z: `Rx(-90) * Rz(180)` carries `(x, y, z)` to `(-x, z, y)`. The quarter turn
 * alone leaves the model rolled through half a circle, which is what it looked like.
 *
 * Where along the body it belongs, and whether the stature matches, stay at neutral for a person
 * to set. Guessing those would put the two bodies somewhere plausible and wrong.
 */
export const Z_UP_TO_Y_UP: Placement = { ...NEUTRAL, rx: -90, rz: 180 };

export class SourceOverlay {
  readonly group = new Group();
  /** Their skeleton, drawn separately so muscles and bones can be shown on their own. */
  readonly bones = new Group();
  private readonly lines = new Map<string, LineSegments>();
  private readonly boneLines = new Map<string, LineSegments>();
  private boneJoints: Points | undefined;
  private meshes: Mesh[] = [];
  /** The bone last emphasised, so meshes arriving later can catch up with it. */
  private emphasised: string | undefined;
  /** Each mesh's geom offset inside its body, kept so a retarget can recompute from it. */
  private readonly wearing = new WeakMap<Mesh, SourceMesh>();
  private data: SourceSites | undefined;
  private shown = new Set<string>();

  constructor(private readonly colour = new Color(0x4fb4c8)) {
    this.group.visible = false;
    this.group.renderOrder = 2;
    this.bones.visible = false;
    this.bones.renderOrder = 2;
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

  /**
   * Their skeleton: a bone from each body to each of its children, and a dot at every joint.
   *
   * The tree first -- every body's pose and what it hangs off, which is the skeleton's structure
   * exactly -- and then the meshes over it. The tree is drawn synchronously and stands on its
   * own, so a mesh that will not load leaves the structure visible rather than an empty
   * viewport. A leaf body with no children still gets a dot, so a toe or a patella can be seen.
   */
  showBones(model: string): void {
    this.clearBones();
    const source = this.model(model);
    if (!source) return;
    void this.loadMeshes(source);
    const at = new Map(source.bodies.map((b) => [b.name, b.pos]));
    const material = () =>
      new LineBasicMaterial({
        color: 0xe8e2d6,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
      });
    for (const body of source.bodies) {
      const child = at.get(body.name);
      if (!child) continue;
      const points: number[] = [];
      for (const other of source.bodies) {
        if (other.parent !== body.name) continue;
        const end = at.get(other.name);
        if (!end) continue;
        points.push(
          child[0] as number,
          child[1] as number,
          child[2] as number,
          end[0] as number,
          end[1] as number,
          end[2] as number,
        );
      }
      if (points.length === 0) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
      const line = new LineSegments(geometry, material());
      line.name = body.name;
      this.boneLines.set(body.name, line);
      this.bones.add(line);
    }
    // Every joint anchor, so the places the two skeletons must agree about are visible.
    const anchors: number[] = [];
    for (const joint of source.joints) {
      anchors.push(joint.anchor[0] as number, joint.anchor[1] as number, joint.anchor[2] as number);
    }
    // Leaf bodies have no bone drawn to them; a dot keeps them on screen.
    for (const body of source.bodies) {
      if (source.bodies.some((other) => other.parent === body.name)) continue;
      anchors.push(body.pos[0] as number, body.pos[1] as number, body.pos[2] as number);
    }
    if (anchors.length > 0) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(anchors, 3));
      this.boneJoints = new Points(
        geometry,
        new PointsMaterial({
          size: 7,
          sizeAttenuation: false,
          color: 0xe0864a,
          depthTest: false,
          transparent: true,
        }),
      );
      this.bones.add(this.boneJoints);
    }
  }

  /**
   * Their actual bones, loaded from the meshes vendored beside the models.
   *
   * Asynchronous and best-effort: the stick figure above is drawn first and stands on its own,
   * so a mesh that will not load leaves the tree visible rather than an empty viewport. Each
   * mesh sits at its geom's offset inside its body, and the body's own pose puts it in their
   * world; the group's placement then brings the whole thing into ours.
   */
  private async loadMeshes(source: SourceModel): Promise<void> {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
    const loader = new STLLoader();
    // A material each, not one shared: an emphasis has to be able to pick one bone out of the
    // rest, and a shared material lights the whole skeleton or none of it.
    const material = () =>
      new MeshStandardMaterial({
        color: 0xd8d2c6,
        roughness: 0.85,
        metalness: 0,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      });
    for (const body of source.bodies) {
      for (const wear of body.meshes) {
        try {
          const geometry = await loader.loadAsync(`refMeshes/${wear.file}`);
          const mesh = new Mesh(geometry, material());
          // Their geom's offset inside the body, then the body's pose in their world.
          const local = new Vector3(wear.pos[0] ?? 0, wear.pos[1] ?? 0, wear.pos[2] ?? 0);
          const spin = new Quaternion(
            wear.quat[1] ?? 0,
            wear.quat[2] ?? 0,
            wear.quat[3] ?? 0,
            wear.quat[0] ?? 1,
          );
          const bodySpin = new Quaternion(
            body.quat[1] ?? 0,
            body.quat[2] ?? 0,
            body.quat[3] ?? 0,
            body.quat[0] ?? 1,
          );
          mesh.quaternion.copy(bodySpin).multiply(spin);
          mesh.position
            .copy(local)
            .applyQuaternion(bodySpin)
            .add(new Vector3(body.pos[0] ?? 0, body.pos[1] ?? 0, body.pos[2] ?? 0));
          mesh.name = body.name;
          this.wearing.set(mesh, wear);
          this.meshes.push(mesh);
          this.bones.add(mesh);
          // A selection made while these were still loading still applies to them.
          if (this.emphasised !== undefined) this.emphasiseBone(this.emphasised);
        } catch {
          // A mesh that is not there is not worth stopping for: the tree is still drawn.
        }
      }
    }
  }

  /**
  /**
   * Put their bones on ours, through the same fits the paths go through.
   *
   * A retarget that moves the muscles and leaves the bones where they were is a picture of
   * muscles floating beside a skeleton they no longer belong to. Each mesh is taken into its own
   * body's frame, scaled to our bone, and put back out through our segment's -- the same three
   * steps `retargetPath` does to a point, applied to a whole mesh at once.
   *
   * A mesh whose body is not paired is hidden rather than left behind, for the same reason a
   * half-retargeted path is dropped.
   */
  retargetBones(
    fits: ReadonlyMap<string, { position: Vector3; rotation: Quaternion; scale: number }>,
  ): void {
    for (const mesh of this.meshes) {
      const fit = fits.get(mesh.name);
      const wear = this.wearing.get(mesh);
      if (!fit || !wear) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      const geomSpin = new Quaternion(
        wear.quat[1] ?? 0,
        wear.quat[2] ?? 0,
        wear.quat[3] ?? 0,
        wear.quat[0] ?? 1,
      );
      // The geom's offset is stated in its body's frame, so the geom's own turn survives the
      // change of body and our segment's rotation replaces theirs.
      mesh.quaternion.copy(fit.rotation).multiply(geomSpin);
      mesh.position
        .set(wear.pos[0] ?? 0, wear.pos[1] ?? 0, wear.pos[2] ?? 0)
        .multiplyScalar(fit.scale)
        .applyQuaternion(fit.rotation)
        .add(fit.position);
      mesh.scale.setScalar(fit.scale);
    }
    // The tree is theirs and says nothing once the meshes are on our bones.
    for (const line of this.boneLines.values()) line.visible = false;
    if (this.boneJoints) this.boneJoints.visible = false;
  }

  /**
   * Light one of their bones up and dim the rest, for the pairing list's selection.
   *
   * Both the tree and the meshes, because either alone leaves the eye hunting: the tree says
   * where the bone is in the chain and the mesh says what shape it is, and a pairing is decided
   * on both.
   */
  emphasiseBone(name: string | undefined): void {
    this.emphasised = name;
    for (const [id, line] of this.boneLines) {
      const material = line.material as LineBasicMaterial;
      const lit = name === undefined || id === name;
      material.opacity = lit ? (name === undefined ? 0.85 : 1) : 0.15;
      material.color.set(name !== undefined && id === name ? 0xe0864a : 0xe8e2d6);
      material.needsUpdate = true;
    }
    for (const mesh of this.meshes) {
      const material = mesh.material as MeshStandardMaterial;
      const lit = name === undefined || mesh.name === name;
      material.opacity = name === undefined ? 0.55 : lit ? 0.95 : 0.08;
      material.color.set(name !== undefined && lit ? 0xe0864a : 0xd8d2c6);
      material.emissive.set(name !== undefined && lit ? 0x3a1c08 : 0x000000);
      material.needsUpdate = true;
    }
  }

  set bonesVisible(on: boolean) {
    this.bones.visible = on;
  }

  get bonesVisible(): boolean {
    return this.bones.visible;
  }

  private clearBones(): void {
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      (mesh.material as MeshStandardMaterial).dispose();
    }
    this.meshes = [];
    for (const line of this.boneLines.values()) {
      line.removeFromParent();
      line.geometry.dispose();
      (line.material as LineBasicMaterial).dispose();
    }
    this.boneLines.clear();
    if (this.boneJoints) {
      this.boneJoints.removeFromParent();
      this.boneJoints.geometry.dispose();
      (this.boneJoints.material as PointsMaterial).dispose();
      this.boneJoints = undefined;
    }
  }

  place(p: Placement): void {
    this.bones.position.set(p.x, p.y, p.z);
    this.bones.rotation.set((p.rx * Math.PI) / 180, (p.ry * Math.PI) / 180, (p.rz * Math.PI) / 180);
    this.bones.scale.setScalar(p.scale);
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
    this.clearBones();
    this.group.removeFromParent();
    this.bones.removeFromParent();
  }
}
