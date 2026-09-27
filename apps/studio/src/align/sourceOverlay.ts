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
 * running model by `pnpm generate:source-sites`, alongside their bones: the models' own meshes,
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

/** A bone mesh a body wears, and where it sits in that body's frame. */
export interface SourceMesh {
  readonly file: string;
  readonly pos: readonly number[];
  /** MuJoCo's order: w first. */
  readonly quat: readonly number[];
}

/** One of their bodies, with its pose in their world at the neutral pose. */
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

/** How many of a model's bone meshes are on screen, out of how many it declares. */
export interface MeshCount {
  readonly total: number;
  readonly loaded: number;
}

/** How one of their bodies was fitted onto one of our segments, as the retarget computed it. */
export interface BodyFit {
  readonly position: Vector3;
  readonly rotation: Quaternion;
  readonly scale: number;
}

// The overlay's look, named once because each is set in more than one place -- a drawing, an
// emphasis, and the emphasis being cleared -- and three copies of a literal drift apart.
/** A muscle path at rest, faint enough that ours still read through it. */
const PATH_OPACITY = 0.45;
/** The one path the pairing list has picked, and every other path while it is picked. */
const PATH_LIT_OPACITY = 0.95;
const PATH_DIM_OPACITY = 0.08;
/** A path already paired: grey, so the eye can skip it. */
const PAIRED_COLOUR = 0x6d747f;
/** Their stick-figure skeleton at rest. */
const BONE_LINE_OPACITY = 0.85;
/** Their bone meshes at rest, see-through so the muscles over them stay visible. */
const BONE_MESH_OPACITY = 0.55;

/**
 * A MuJoCo quaternion as three's.
 *
 * MuJoCo stores a quaternion w first and three stores it w last, and reading one in the other's
 * order is a rotation that is almost never obviously wrong -- a bone turned about some skew axis
 * still looks like a bone. So there is one place that reads the order, and everything else goes
 * through it.
 */
export function fromWxyz(q: readonly number[]): Quaternion {
  return new Quaternion(q[1] ?? 0, q[2] ?? 0, q[3] ?? 0, q[0] ?? 1);
}

/**
 * Where a bone mesh sits in their world: its body's pose, then the geom's offset inside it.
 *
 * The composed world pose is what both uses need. Drawn as it is, the mesh sits there. Retargeted,
 * it goes through a fit, and a fit maps their world to ours -- the geom's offset alone is a
 * body-local quantity and means nothing to a world map.
 */
export function meshWorldPose(
  body: SourceBody,
  wear: SourceMesh,
): { position: Vector3; quaternion: Quaternion } {
  const bodySpin = fromWxyz(body.quat);
  const quaternion = bodySpin.clone().multiply(fromWxyz(wear.quat));
  const position = new Vector3(wear.pos[0] ?? 0, wear.pos[1] ?? 0, wear.pos[2] ?? 0)
    .applyQuaternion(bodySpin)
    .add(new Vector3(body.pos[0] ?? 0, body.pos[1] ?? 0, body.pos[2] ?? 0));
  return { position, quaternion };
}

/**
 * A first guess at where a model belongs: the change of axes, which is a fact rather than a
 * judgement, and nothing else.
 *
 * Measured off the models rather than taken from any one's documentation, by asking which axis
 * separates a right femur from a left and which one drops from the pelvis to the toes. The legs
 * and the torso agree with each other:
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
 * The arm is not in those axes. It keeps OpenSim's -- anterior +X, up +Y, lateral +Z -- and the
 * legs' placement laid it down along our Z. Measured off the positions in `sourceSites.json` the
 * same way: the fingertips hang 0.7 m below the sternoclavicular joint along -Y, the shoulder
 * sits 0.14 m out from it along +Z (a right arm, so lateral is our +X), and the biceps and the
 * anterior deltoid lie 35 to 60 mm ahead of the triceps and the posterior deltoid along +X.
 *
 *              lateral          vertical        forward
 *   theirs     Z, right is +    Y, up is +      +X
 *   ours       X, right is +    Y, up is +      -Z
 *
 * So the arm's point becomes ours as `(x, y, z) -> (z, y, -x)`: a quarter turn about Y, `Ry(90)`.
 *
 * A model this table does not know gets the legs' axes, MuJoCo's usual Z-up, and a person
 * corrects it by eye as before. Where along the body it belongs, and whether the stature
 * matches, stay at neutral for a person to set. Guessing those would put the two bodies somewhere
 * plausible and wrong.
 */
const CHANGE_OF_AXES: Readonly<Record<string, Placement>> = {
  legs: { ...NEUTRAL, rx: -90, rz: 180 },
  torso: { ...NEUTRAL, rx: -90, rz: 180 },
  arm: { ...NEUTRAL, ry: 90 },
};

/** The change of axes that stands a model up in ours, as a fresh placement the caller may edit. */
export function changeOfAxes(model: string): Placement {
  return { ...(CHANGE_OF_AXES[model] ?? CHANGE_OF_AXES.legs ?? NEUTRAL) };
}

/**
 * Where the Align tab puts a model when it is picked, and again on Reset placement.
 *
 * Nothing but its change of axes: `place` applies no change of axes of its own, so the placement
 * *is* the change of axes, and a model placed this way stands up in ours with its long axis down
 * our -Y. The panel used the legs' axes for every model, which laid the arm, whose axes are
 * already Y-up, flat along the floor. It does not seat the model on our body -- it may well hang
 * below the floor -- because where along the body it belongs is a person's to set.
 */
export function defaultPlacement(model: string): Placement {
  return changeOfAxes(model);
}

/** What a mesh is: the geom it draws, the body wearing it, and its place in the declaration. */
interface Worn {
  readonly body: SourceBody;
  readonly wear: SourceMesh;
  readonly index: number;
}

export class SourceOverlay {
  readonly group = new Group();
  /** Their skeleton, drawn separately so muscles and bones can be shown on their own. */
  readonly bones = new Group();
  private readonly lines = new Map<string, LineSegments>();
  private readonly boneLines = new Map<string, LineSegments>();
  private boneJoints: Points | undefined;
  /** The meshes on screen, in the order the model declares them whatever order they arrived in. */
  private meshes: Mesh[] = [];
  /** How many meshes the model on screen declares, for `meshCount`. */
  private meshTotal = 0;
  /** The bone last emphasised, so meshes arriving later can catch up with it. */
  private emphasisedBone: string | undefined;
  /** The muscle last emphasised, so a redraw of the paths keeps it lit. */
  private emphasisedMuscle: string | undefined;
  /** The muscles already paired, so a redraw of the paths keeps them grey. */
  private paired = new Set<string>();
  /** Each mesh's geom and body, kept so a retarget can recompute from them. */
  private readonly wearing = new WeakMap<Mesh, Worn>();
  /**
   * The retarget in force, if any. A mesh that arrives after the retarget was made goes through
   * it as well, rather than landing at their pose, sideways at our origin.
   */
  private fit:
    | { readonly fits: ReadonlyMap<string, BodyFit>; readonly bodies: Map<string, SourceBody> }
    | undefined;
  /**
   * Which load is current. A load reads this when it starts and again after every wait, and does
   * nothing once it has moved on -- which is what stops a slow load for one model putting its
   * bones up over the next model's.
   */
  private generation = 0;
  /**
   * Every mesh file asked for, once. A model's bones are shown each time it is picked and each
   * time a slider drops a retarget, and parsing thirty STL files for a picture already seen is
   * seconds of nothing. The geometry is shared between every mesh drawn from it, so only
   * `dispose` frees it.
   */
  private readonly geometryCache = new Map<string, Promise<BufferGeometry>>();
  private data: SourceSites | undefined;

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

  /** The change of axes that stands this model up in ours; see `changeOfAxes`. */
  axes(model: string): Placement {
    return changeOfAxes(model);
  }

  /**
   * How many of the shown model's bone meshes are on screen, out of how many it declares.
   *
   * While a load is running the difference is still arriving; once it has finished, the
   * difference is meshes that are not there to be had.
   */
  meshCount(): MeshCount {
    return { total: this.meshTotal, loaded: this.meshes.length };
  }

  /**
   * Draw the paths a retarget has already moved onto our bones, rather than their own.
   *
   * A muscle whose path could not be retargeted -- because one of the bodies it runs over is not
   * paired yet -- is left out, because half a path on our bones and half on theirs is a picture
   * of nothing. What is paired and what is picked carry over from the drawing it replaces.
   */
  showRetargeted(paths: ReadonlyMap<string, readonly number[]>): void {
    this.clear();
    for (const [name, path] of paths) this.addPath(name, path);
    this.restyle();
  }

  /**
   * Draw one model's muscles; anything drawn before is taken down.
   *
   * A new model starts with nothing picked, since the pick was one of the old model's muscles.
   * What is paired is kept, because the pairing list re-marks it for the new model itself.
   */
  show(model: string): void {
    this.clear();
    for (const muscle of this.muscles(model)) this.addPath(muscle.name, muscle.path);
    this.emphasisedMuscle = undefined;
    this.restyle();
  }

  /** Light one muscle up and dim the rest, or clear the emphasis with undefined. */
  emphasise(name: string | undefined): void {
    this.emphasisedMuscle = name;
    this.restyle();
  }

  /** Which muscles are already paired, so the eye can skip them. */
  markPaired(paired: ReadonlySet<string>): void {
    this.paired = new Set(paired);
    this.restyle();
  }

  /**
   * One muscle's path as line segments, drawn at rest.
   *
   * A path of n points is n - 1 segments, each its two ends; a path of fewer than two points
   * draws nothing and is left out.
   */
  private addPath(name: string, path: readonly number[]): void {
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
    if (points.length === 0) return;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
    const material = new LineBasicMaterial({
      color: this.colour,
      transparent: true,
      opacity: PATH_OPACITY,
      depthTest: false,
    });
    const line = new LineSegments(geometry, material);
    line.name = name;
    this.lines.set(name, line);
    this.group.add(line);
  }

  /**
   * Colour and opacity for every path, from what is paired and what is picked.
   *
   * Both are kept as state and applied here together, rather than each written straight onto
   * the lines, because a redraw builds new lines: written straight on, the grey and the
   * highlight were lost every time the paths were redrawn on our bones.
   */
  private restyle(): void {
    const lit = this.emphasisedMuscle;
    for (const [id, line] of this.lines) {
      const material = line.material as LineBasicMaterial;
      material.color.set(this.paired.has(id) ? PAIRED_COLOUR : this.colour.getHex());
      material.opacity =
        lit === undefined ? PATH_OPACITY : id === lit ? PATH_LIT_OPACITY : PATH_DIM_OPACITY;
      material.needsUpdate = true;
    }
  }

  /**
   * Their skeleton: a bone from each body to each of its children, and a dot at every joint.
   *
   * The tree first -- every body's pose and what it hangs off, which is the skeleton's structure
   * exactly -- and then the meshes over it. The tree is drawn synchronously and stands on its
   * own, so a mesh that will not load leaves the structure visible rather than an empty
   * viewport. A leaf body with no children still gets a dot, so a toe or a patella can be seen.
   *
   * Returns the mesh load, which settles with how many meshes it put on screen out of how many
   * the model declares. Nothing has to wait for it: the tree is already up.
   */
  showBones(model: string): Promise<MeshCount> {
    this.clearBones();
    const source = this.model(model);
    if (!source) return Promise.resolve({ total: 0, loaded: 0 });
    const at = new Map(source.bodies.map((b) => [b.name, b.pos]));
    const material = () =>
      new LineBasicMaterial({
        color: 0xe8e2d6,
        transparent: true,
        opacity: BONE_LINE_OPACITY,
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
    return this.loadMeshes(source);
  }

  /**
   * Their actual bones, loaded from the meshes vendored beside the models.
   *
   * Asynchronous and best-effort: the stick figure is drawn first and stands on its own, so a
   * mesh that will not load leaves the tree visible rather than an empty viewport. Every file is
   * asked for at once and each mesh goes up as it arrives, placed and styled for whatever is in
   * force by then -- a retarget or a picked bone made while it was on its way.
   *
   * The load belongs to the model it started for. It checks after every wait that no later
   * `showBones` or `dispose` has replaced it, and once one has it adds nothing more, so its count
   * is of what it put up before then.
   */
  private async loadMeshes(source: SourceModel): Promise<MeshCount> {
    const gen = this.generation;
    const worn: Worn[] = [];
    for (const body of source.bodies) {
      for (const wear of body.meshes) worn.push({ body, wear, index: worn.length });
    }
    this.meshTotal = worn.length;
    if (worn.length === 0) return { total: 0, loaded: 0 };
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
    if (gen !== this.generation) return { total: worn.length, loaded: 0 };
    const loader = new STLLoader();
    let loaded = 0;
    // Settled, not all: one mesh that is not there must not take the rest down with it. A
    // failure is counted -- it is the difference between `loaded` and `total` -- rather than
    // thrown, so a missing file is visible in the count and not merely absent from the picture.
    await Promise.allSettled(
      worn.map(async (w) => {
        const geometry = await this.geometry(w.wear.file, loader);
        if (gen !== this.generation) return;
        // A material each, not one shared: an emphasis has to be able to pick one bone out of
        // the rest, and a shared material lights the whole skeleton or none of it.
        const mesh = new Mesh(
          geometry,
          new MeshStandardMaterial({
            color: 0xd8d2c6,
            roughness: 0.85,
            metalness: 0,
            transparent: true,
            opacity: BONE_MESH_OPACITY,
            depthWrite: false,
          }),
        );
        mesh.name = w.body.name;
        this.wearing.set(mesh, w);
        this.insertMesh(mesh, w.index);
        this.bones.add(mesh);
        this.placeMesh(mesh);
        this.styleMesh(mesh);
        loaded += 1;
      }),
    );
    return { total: worn.length, loaded };
  }

  /**
   * One mesh file's geometry, fetched and parsed once however many times it is asked for.
   *
   * Fetched by hand rather than through the loader because of what a missing file looks like.
   * Vite answers a path it has no file for with the app's own `index.html` and a 200, which the
   * loader happily parses as an ASCII STL of nothing; a page is a missing mesh, and so is any
   * answer that is not ok. A failure leaves the cache, so the next show asks again rather than
   * remembering a file that has since been put in place.
   */
  private geometry(file: string, loader: { parse(data: ArrayBuffer): BufferGeometry }) {
    const cached = this.geometryCache.get(file);
    if (cached) return cached;
    const pending = (async () => {
      const response = await fetch(`refMeshes/${file}`);
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || type.startsWith('text/html')) {
        throw new Error(
          `refMeshes/${file} is not there (${response.status}, ${type || 'no type'})`,
        );
      }
      return loader.parse(await response.arrayBuffer());
    })();
    this.geometryCache.set(file, pending);
    pending.catch(() => {
      if (this.geometryCache.get(file) === pending) this.geometryCache.delete(file);
    });
    return pending;
  }

  /** Keep the meshes in declaration order, so the order they arrived in does not show anywhere. */
  private insertMesh(mesh: Mesh, index: number): void {
    let at = this.meshes.length;
    while (at > 0) {
      const before = this.meshes[at - 1];
      if (!before || (this.wearing.get(before)?.index ?? 0) < index) break;
      at -= 1;
    }
    this.meshes.splice(at, 0, mesh);
  }

  /**
   * Put one mesh where it belongs: at its pose in their world, or, once a retarget is in force,
   * through its body's fit onto our bones -- or out of sight if its body has no fit.
   */
  private placeMesh(mesh: Mesh): void {
    const worn = this.wearing.get(mesh);
    if (!worn) return;
    if (!this.fit) {
      const pose = meshWorldPose(worn.body, worn.wear);
      mesh.position.copy(pose.position);
      mesh.quaternion.copy(pose.quaternion);
      mesh.scale.setScalar(1);
      mesh.visible = true;
      return;
    }
    const fit = this.fit.fits.get(mesh.name);
    const them = this.fit.bodies.get(mesh.name);
    if (!fit || !them) {
      mesh.visible = false;
      return;
    }
    const world = meshWorldPose(them, worn.wear);
    mesh.visible = true;
    mesh.quaternion.copy(fit.rotation).multiply(world.quaternion);
    mesh.position
      .copy(world.position)
      .multiplyScalar(fit.scale)
      .applyQuaternion(fit.rotation)
      .add(fit.position);
    mesh.scale.setScalar(fit.scale);
  }

  /**
   * Put their bones on ours, through the same fits the paths go through.
   *
   * A retarget that moves the muscles and leaves the bones where they were is a picture of
   * muscles floating beside a skeleton they no longer belong to. Each mesh is taken into its own
   * body's frame, scaled to our bone, and put back out through our segment's -- the same three
   * steps `retargetPath` does to a point, applied to a whole mesh at once.
   *
   * A mesh whose body is not paired is hidden rather than left behind, for the same reason a
   * half-retargeted path is dropped. The fits are kept, so meshes still loading take them too.
   */
  retargetBones(fits: ReadonlyMap<string, BodyFit>, bodies: readonly SourceBody[]): void {
    this.fit = { fits, bodies: new Map(bodies.map((b) => [b.name, b])) };
    for (const mesh of this.meshes) this.placeMesh(mesh);
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
    this.emphasisedBone = name;
    for (const [id, line] of this.boneLines) {
      const material = line.material as LineBasicMaterial;
      const lit = name === undefined || id === name;
      material.opacity = lit ? (name === undefined ? BONE_LINE_OPACITY : 1) : 0.15;
      material.color.set(name !== undefined && id === name ? 0xe0864a : 0xe8e2d6);
      material.needsUpdate = true;
    }
    for (const mesh of this.meshes) this.styleMesh(mesh);
  }

  /** One mesh styled for the bone emphasised now, so a mesh arriving late matches the rest. */
  private styleMesh(mesh: Mesh): void {
    const name = this.emphasisedBone;
    const material = mesh.material as MeshStandardMaterial;
    const lit = name === undefined || mesh.name === name;
    material.opacity = name === undefined ? BONE_MESH_OPACITY : lit ? 0.95 : 0.08;
    material.color.set(name !== undefined && lit ? 0xe0864a : 0xd8d2c6);
    material.emissive.set(name !== undefined && lit ? 0x3a1c08 : 0x000000);
    material.needsUpdate = true;
  }

  set bonesVisible(on: boolean) {
    this.bones.visible = on;
  }

  get bonesVisible(): boolean {
    return this.bones.visible;
  }

  /**
   * Take their skeleton down, and with it any load still running and any retarget in force.
   *
   * The meshes' materials go; their geometry stays, because it is the cache's and shared.
   */
  private clearBones(): void {
    this.generation += 1;
    this.fit = undefined;
    this.meshTotal = 0;
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
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

  /**
   * Everything freed, including the cached geometry. A file still on its way is freed when it
   * arrives, since the load that asked for it has been cancelled and nothing else will.
   */
  dispose(): void {
    this.clear();
    this.clearBones();
    for (const pending of this.geometryCache.values()) {
      pending.then(
        (geometry) => geometry.dispose(),
        () => undefined,
      );
    }
    this.geometryCache.clear();
    this.group.removeFromParent();
    this.bones.removeFromParent();
  }
}
