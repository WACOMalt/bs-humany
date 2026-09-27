/**
 * The viewport's scene: the renderer, the camera and its controls, the lights, the grid and the
 * world group everything simulated is drawn under, and the scenery a run stands its body on.
 *
 * And a run as it is drawn there (`createRunView`): the overlays, the frame under the playhead read
 * back out of the recording, the Align tab's hold at rest, and where the camera aims to frame the
 * body. What the run is and where its playhead sits are the run controller's; this only draws.
 */

import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { boundsMidpoint, segmentComs, wholeBodyCom } from './bodyCom.js';
import type { BridgeFollower } from './follow.js';
import { type OrbitControls, createOrbitControls } from './orbit.js';
import { type Overlays, createOverlays } from './overlays.js';
import { Playback } from './playback.js';
import type { StudioRuns } from './runController.js';
import type { Simulation } from './simulation.js';
import type { SkinnedSkeleton } from './skinning.js';

/**
 * A box to draw, however it arrived: from a run of this studio's own, or from the status a
 * publisher on the bridge writes. The two say the same thing in different shapes.
 */
export interface DrawnBox {
  readonly halfExtents: { x: number; y: number; z: number };
  readonly position: { x: number; y: number; z: number };
  readonly rotation?: { x: number; y: number; z: number; w: number } | undefined;
}

/** The scenery a run stands its body on: a scenario's static boxes, drawn in the world group. */
export interface Furniture {
  /** Draw these boxes, taking down whatever was up first. */
  show(boxes: readonly DrawnBox[]): void;
  /**
   * Move the drawn boxes to where these say, one mesh a box in order, without building anything:
   * a run's own scenery and a followed publisher's both come through here.
   */
  place(boxes: readonly DrawnBox[]): void;
  /**
   * Draw these boxes, building meshes only when their shapes change and moving the ones already
   * up otherwise: for a publisher's scenery, which arrives ten times a second and whose shapes
   * seldom change.
   */
  keep(boxes: readonly DrawnBox[]): void;
  /** Take the furniture down, whoever put it up. */
  clear(): void;
}

export interface StudioScene {
  readonly viewport: HTMLDivElement;
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  /**
   * Everything in the simulation's frame -- the body, its overlays, the furniture, the grid --
   * under one group, so what is drawn and what is simulated share one set of coordinates. Points
   * picked in the scene go through `world` to reach the physics; lights and the camera stay where
   * they are. A scenario that tilts the floor turns the grid alone, because the floor is the only
   * thing that turns (see `tiltingFloor.ts`).
   */
  readonly world: Group;
  readonly grid: GridHelper;
  /**
   * `vertexColors` so a bone can be tinted where it is drawn.
   *
   * It costs nothing when nothing is tinted: every vertex starts white and white multiplies the
   * base colour to itself.
   */
  readonly boneMaterial: MeshStandardMaterial;
  readonly furniture: Furniture;
  /** Turn the camera a little when the turntable is on, and let the controls settle. */
  update(spin: boolean): void;
  render(): void;
}

/**
 * The Align tab's own highlight, for the segment picked in its pairing list.
 *
 * A different colour from the inspector's, and from the orange their bones light up in, because
 * the whole point is telling three things apart at once: the bone of ours being paired, the bone
 * of theirs it is being paired to, and whatever the inspector happens to have selected.
 */
export const ALIGNED_TINT = new Color(0x3fd6c4);

/**
 * The inspector's highlight, as a tint on a bone drawn in this material.
 *
 * A vertex colour multiplies the material's, so the tint is the highlight's blue divided by the
 * bone colour, channel by channel: the selected bone is drawn in the same 0x6aa9ff the separate
 * highlight mesh was, rather than a darker blue that only looks like it.
 */
export function selectionTint(material: MeshStandardMaterial): Color {
  const want = new Color(0x6aa9ff);
  const base = material.color;
  return new Color(want.r / base.r, want.g / base.g, want.b / base.b);
}

export function createScene(
  viewport: HTMLDivElement,
  options: { claimPointer: (event: PointerEvent) => boolean },
): StudioScene {
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(
    viewport.clientWidth || window.innerWidth,
    viewport.clientHeight || window.innerHeight,
    false,
  );
  viewport.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(0x14161a);

  const camera = new PerspectiveCamera(
    38,
    (viewport.clientWidth || window.innerWidth) / (viewport.clientHeight || window.innerHeight),
    0.05,
    60,
  );
  // The camera starts at negative Z. The canonical frame puts anterior at `-Z` (ADR-010), matching
  // three.js object-forward, so a front view means standing in front of the subject at negative Z
  // rather than the default positive.
  camera.position.set(1.5, 1.1, -2.6);

  const controls = createOrbitControls(camera, renderer.domElement, new Vector3(0, 0.9, 0), {
    claimPointer: options.claimPointer,
  });

  scene.add(new HemisphereLight(0xb8c6e0, 0x2a2118, 0.55));
  scene.add(new AmbientLight(0xffffff, 0.18));
  const keyLight = new DirectionalLight(0xfff4e6, 1.5);
  keyLight.position.set(-2.5, 4, -3);
  scene.add(keyLight);
  const fillLight = new DirectionalLight(0x9fc2ff, 0.5);
  fillLight.position.set(3, 1.5, 2.5);
  scene.add(fillLight);
  const rimLight = new DirectionalLight(0xffffff, 0.65);
  rimLight.position.set(0, 2, 4);
  scene.add(rimLight);

  const world = new Group();
  scene.add(world);
  const grid = new GridHelper(6, 24, 0x3a4250, 0x252a33);
  world.add(grid);

  const boneMaterial = new MeshStandardMaterial({
    vertexColors: true,
    color: 0xe8e2d4,
    roughness: 0.72,
    metalness: 0.02,
    flatShading: false,
  });

  // The canvas is the viewport region's, not the window's: the editors around it take their share.
  const fitViewport = () => {
    const width = viewport.clientWidth || window.innerWidth;
    const height = viewport.clientHeight || window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };
  window.addEventListener('resize', fitViewport);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fitViewport).observe(viewport);

  return {
    viewport,
    renderer,
    scene,
    camera,
    controls,
    world,
    grid,
    boneMaterial,
    furniture: createFurniture(world),
    update(spin) {
      if (spin) controls.orbit(0.0032);
      controls.update();
    },
    render() {
      renderer.render(scene, camera);
    },
  };
}

function createFurniture(world: Group): Furniture {
  let furniture: Group | null = null;
  /** The shapes `keep` last built for, so it builds only when they change. */
  let keptKey = '';
  const material = new MeshStandardMaterial({ color: 0x4a5566, roughness: 0.9 });

  const clear = (): void => {
    keptKey = '';
    if (!furniture) return;
    furniture.removeFromParent();
    for (const child of furniture.children) if (child instanceof Mesh) child.geometry.dispose();
    furniture = null;
  };

  const show = (boxes: readonly DrawnBox[]): void => {
    // Whatever was up comes down first: two starts landing close together each drew their own
    // set, and the first set stayed in the scene with nothing left to take it down.
    clear();
    if (boxes.length === 0) return;
    furniture = new Group();
    for (const box of boxes) {
      const mesh = new Mesh(
        new BoxGeometry(2 * box.halfExtents.x, 2 * box.halfExtents.y, 2 * box.halfExtents.z),
        material,
      );
      mesh.position.set(box.position.x, box.position.y, box.position.z);
      if (box.rotation) {
        mesh.quaternion.set(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w);
      }
      furniture.add(mesh);
    }
    world.add(furniture);
  };

  const place = (boxes: readonly DrawnBox[]): void => {
    if (!furniture) return;
    boxes.forEach((box, at) => {
      const mesh = furniture?.children[at];
      if (!mesh) return;
      mesh.position.set(box.position.x, box.position.y, box.position.z);
      if (box.rotation) {
        mesh.quaternion.set(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w);
      }
    });
  };

  return {
    show,
    place,
    keep(boxes) {
      const key = boxes
        .map((b) => `${b.halfExtents.x},${b.halfExtents.y},${b.halfExtents.z}`)
        .join('|');
      if (key !== keptKey) {
        show(boxes);
        keptKey = key;
        return;
      }
      place(boxes);
    },
    clear,
  };
}

// ---------------------------------------------------------------------------------------------
// A run, as it is drawn
// ---------------------------------------------------------------------------------------------

/** The overlay checkboxes, as the viewport's Overlays popover has them. */
export interface OverlayBoxes {
  readonly showProxies: HTMLInputElement;
  readonly showAxes: HTMLInputElement;
  readonly showCom: HTMLInputElement;
  readonly showContacts: HTMLInputElement;
  readonly showTissue: HTMLInputElement;
  readonly showMuscles: HTMLInputElement;
  readonly showMuscleVolumes: HTMLInputElement;
}

export interface RunViewHost {
  readonly runs: StudioRuns;
  readonly boxes: OverlayBoxes;
  readonly follower: BridgeFollower;
  /** Whether the Align tab asks for the body at rest. */
  alignHoldsRest(): boolean;
  /** The rest skeleton's box, once one is built, for aiming at a body at rest. */
  restBounds(): { min: [number, number, number]; max: [number, number, number] } | null;
  /** The stature the Stature slider shows. */
  sliderStature(): number;
  /** The stature of the subject the mesh pack was measured from, once the pack has loaded. */
  datasetStature(): number | undefined;
}

/** What `pose` put on screen: the bone transforms, and the recorded frame when it is not live. */
export interface DrawnFrame {
  readonly transforms: { readonly position: Float64Array; readonly orientation: Float64Array };
  readonly replay: { position: Float64Array; orientation: Float64Array } | undefined;
  /** Off the live edge, the segment poses the overlays draw from, read off the replayed bones. */
  readonly replayedPose: { position: Float64Array; orientation: Float64Array } | undefined;
}

/** The muscle paths and bellies as the overlay draws them. */
export interface MuscleDrawing {
  count: number;
  pointStart: Int32Array;
  pointCount: Int32Array;
  point: Float64Array;
  tension: Float64Array;
  mesh: ReturnType<Simulation['muscleMesh']>;
}

export interface RunView {
  /** Make the overlays for a run just installed, and draw its scenery. */
  install(sim: Simulation): void;
  /** Take a run's overlays down. */
  forget(): void;
  /**
   * Which overlays are drawn, and which cannot be while the playhead is behind the newest frame.
   *
   * Bones and bellies are recorded, so they replay. Joint axes, the centre of mass, the contact
   * manifolds and the muscle path polylines are live readings a tick wide and nothing holds a
   * history of them; drawn during playback they would show the newest tick's answer against a
   * body in a pose from four seconds ago, which is worse than not drawing them. The checkboxes
   * keep whatever they were set to and come back on at Live.
   */
  applyOverlayVisibility(): void;
  /**
   * Whether the body is drawn at rest for the Align tab now.
   *
   * Only while the run stays paused: holding pauses it, and a person who resumes it anyway has
   * chosen to watch it move, so it is drawn moving and the hold waits for the next pause.
   */
  heldAtRest(): boolean;
  /** Pose the skin for the frame on screen: the newest tick, or the one under the playhead. */
  pose(sim: Simulation, skinned: SkinnedSkeleton): DrawnFrame;
  /** Feed the overlays the frame `pose` put on screen. */
  drawOverlays(sim: Simulation, frame: DrawnFrame): void;
  /** The muscle paths and how hard each is pulling, live, for the overlay and the headset. */
  muscleOverlay(sim: Simulation): MuscleDrawing | undefined;
  /**
   * Aim the camera at the body and stand off far enough to see all of it: from a preset's angle
   * when one is given, and from wherever the camera already looks from when not, which is F.
   */
  frameBody(controls: OrbitControls, view?: { theta: number; phi: number }): void;
}

/**
 * The camera distance that frames a body of the reference stature head to feet: at the 38 degree
 * field of view, 3.1 m shows about 2.1 m of height, a margin around 1.70 m. It was the fixed
 * distance of every preset; now it scales with the body, so a 2.05 m body is not cut off and a
 * 1.40 m one does not stand small in the middle.
 */
const FRAME_DISTANCE = 3.1;
const FRAME_STATURE = 1.7;

/**
 * View presets.
 *
 * Azimuth is measured from +Z in three.js's spherical convention, and anterior is -Z (ADR-010),
 * so a front view is at theta = pi: standing in front of the subject, looking toward +Z.
 */
export const VIEWS: Record<string, { theta: number; phi: number }> = {
  front: { theta: Math.PI, phi: Math.PI / 2 },
  left: { theta: -Math.PI / 2, phi: Math.PI / 2 },
  back: { theta: 0, phi: Math.PI / 2 },
  'three-quarter': { theta: Math.PI * 0.78, phi: Math.PI * 0.42 },
};

export function createRunView(studio: StudioScene, host: RunViewHost): RunView {
  const { runs, boxes, follower } = host;
  let overlays: Overlays | null = null;
  /** What the frame loop last drew for the hold, so it acts only when that changes. */
  let drawnHeld = false;

  const heldAtRest = (): boolean => {
    const sim = runs.simulation;
    return host.alignHoldsRest() && (!sim || sim.paused);
  };

  const applyOverlayVisibility = (): void => {
    if (!overlays) return;
    // Held at rest for the Align tab, the bones are drawn at rest and every overlay drawn from the
    // run's pose would stand somewhere else, so all of those go too.
    const held = heldAtRest();
    const live = runs.atLiveEdge && !held;
    overlays.proxies.visible = boxes.showProxies.checked && !held;
    overlays.axes.visible = boxes.showAxes.checked && live;
    overlays.com.visible = boxes.showCom.checked && live;
    overlays.contacts.visible = boxes.showContacts.checked && live;
    overlays.tissue.visible = boxes.showTissue.checked && !held;
    overlays.muscles.visible = boxes.showMuscles.checked && live;
    overlays.muscleVolumes.visible = boxes.showMuscleVolumes.checked && !held;
  };

  /** Segment poses from bone transforms: each segment's frame is its anchor bone's. */
  let segmentAnchorIndex: { sim: Simulation; anchors: Int32Array } | undefined;
  const segmentPosesFrom = (
    sim: Simulation,
    bones: { position: Float64Array; orientation: Float64Array },
  ): { position: Float64Array; orientation: Float64Array } => {
    if (segmentAnchorIndex?.sim !== sim) {
      const order = new Map(sim.boneOrder().map((id, i) => [id, i]));
      segmentAnchorIndex = {
        sim,
        anchors: Int32Array.from(sim.articulation.segments, (s) => order.get(s.anchor) ?? -1),
      };
    }
    const anchors = segmentAnchorIndex.anchors;
    const position = new Float64Array(anchors.length * 3);
    const orientation = new Float64Array(anchors.length * 4);
    for (let i = 0; i < anchors.length; i++) {
      const b = anchors[i] as number;
      if (b < 0) {
        orientation[4 * i + 3] = 1;
        continue;
      }
      position[3 * i] = bones.position[3 * b] ?? 0;
      position[3 * i + 1] = bones.position[3 * b + 1] ?? 0;
      position[3 * i + 2] = bones.position[3 * b + 2] ?? 0;
      orientation[4 * i] = bones.orientation[4 * b] ?? 0;
      orientation[4 * i + 1] = bones.orientation[4 * b + 1] ?? 0;
      orientation[4 * i + 2] = bones.orientation[4 * b + 2] ?? 0;
      orientation[4 * i + 3] = bones.orientation[4 * b + 3] ?? 1;
    }
    return { position, orientation };
  };

  /**
   * Bone transforms for the frame the playhead is on, or nothing if it cannot be read.
   *
   * Nothing is stepped to get here: the recording already holds every tick, and the playhead's
   * output frame is one of them.
   */
  const replayFrame = (
    sim: Simulation,
  ): { position: Float64Array; orientation: Float64Array } | undefined => {
    const frames = runs.capturedFrames();
    if (frames <= 0) return undefined;
    const tick = Playback.tickOf(runs.playback.clampedFrame(frames), sim.ticksPerOutputFrame);
    return runs.playback.bonesAt(sim.capture, tick);
  };

  /** Scratch for the tension fractions, grown once to fit whatever set is running. */
  let tensionScratch = new Float64Array(0);
  const muscleTension = (
    force: ArrayLike<number>,
    units: readonly { readonly parameters: { readonly maxIsometricForce: number } }[],
  ): Float64Array => {
    if (tensionScratch.length !== units.length) tensionScratch = new Float64Array(units.length);
    for (let i = 0; i < units.length; i++) {
      const maximum = units[i]?.parameters.maxIsometricForce ?? 1;
      tensionScratch[i] = maximum > 0 ? (force[i] ?? 0) / maximum : 0;
    }
    return tensionScratch;
  };

  /**
   * The muscle paths and how hard each is pulling, for the overlay.
   *
   * Tension is the fraction of the unit's own maximum isometric force, so a small muscle working
   * hard reads as hard as a big one. Absolute newtons would colour the whole arm by which muscle
   * happens to be the strongest.
   */
  const muscleOverlay = (sim: Simulation): MuscleDrawing | undefined => {
    const state = sim.muscleState();
    const units = sim.muscles?.units;
    if (!state || !units) return undefined;
    const path = sim.channel('muscle.path').fields;
    const tension = muscleTension(state.tendonForce, units);
    return {
      count: units.length,
      pointStart: path.pointStart as unknown as Int32Array,
      pointCount: path.pointCount as unknown as Int32Array,
      point: sim.channel('muscle.polyline').fields.point as Float64Array,
      tension,
      mesh: sim.muscleMesh(),
    };
  };

  /** Zero lengths for every unit's polyline, grown once. */
  let emptyCounts = new Int32Array(0);
  const emptyPointCounts = (units: number): Int32Array => {
    if (emptyCounts.length !== units) emptyCounts = new Int32Array(units);
    return emptyCounts;
  };

  /**
   * The bellies for the frame the playhead is on, rebuilt from the ring recording.
   *
   * Path polylines and tension are not recorded, so `pointCount` is left at zero -- which draws no
   * lines -- and every unit is drawn relaxed. The panel says so.
   */
  const replayedMuscles = (sim: Simulation) => {
    const volume = sim.muscleVolume;
    const units = sim.muscles?.units.length ?? 0;
    const live = sim.muscleMesh();
    const frames = runs.capturedFrames();
    if (!volume || !live || units === 0 || frames <= 0) return undefined;
    const tick = Playback.tickOf(runs.playback.clampedFrame(frames), sim.ticksPerOutputFrame);
    // The bone capture is a frame a tick and the ring capture a frame a sweep, so the bone frame's
    // tick is looked up among the sweeps: the newest at or before it is the belly that was showing.
    const mesh = runs.playback.bellyAt(
      sim.muscleCapture,
      sim.muscleCapture.indexForTick(sim.capture.firstTick + tick),
      { index: live.index, verticesPerUnit: live.verticesPerUnit },
      volume.rings,
      live.verticesPerUnit / volume.rings,
    );
    if (!mesh) return undefined;
    const path = sim.channel('muscle.path').fields;
    return {
      count: units,
      pointStart: path.pointStart as unknown as Int32Array,
      pointCount: emptyPointCounts(units),
      point: sim.channel('muscle.polyline').fields.point as Float64Array,
      tension: runs.playback.units(units),
      mesh,
    };
  };

  /**
   * Where the body on screen is, written into `out`, and its stature.
   *
   * The centre of mass of whatever frame is drawn -- the live run, the frame under the playhead --
   * because that is where a body is, wherever it has fallen or been dragged: the presets used to
   * aim at a fixed point above the origin, and a body at the bottom of the stairs was out of frame
   * in every one of them. A followed body's masses are not known here, so it is the middle of its
   * bones instead. At rest, the middle of the rest skeleton.
   */
  const aimAtBody = (out: Vector3): number => {
    if (follower.active) {
      const pose = follower.pose;
      // The body the publisher says it is; failing that, the height its bridge's header gives,
      // which every publisher writes. Its `settings` used to be read here, and the showcase sends
      // none, so a showcase's body was framed at whatever the sliders said.
      const scale = follower.datasetScale;
      const measured = host.datasetStature();
      const stature =
        follower.body?.morphology.stature ??
        (scale !== null && measured !== undefined ? scale * measured : undefined) ??
        host.sliderStature();
      if (pose && boundsMidpoint(pose.position, out)) {
        studio.world.localToWorld(out);
        return stature;
      }
    }
    const sim = runs.simulation;
    if (sim && !heldAtRest()) {
      const replay = runs.atLiveEdge ? undefined : replayFrame(sim);
      const live = sim.channel('body.pose').fields;
      const pose = replay
        ? segmentPosesFrom(sim, replay)
        : {
            position: live.position as Float64Array,
            orientation: live.orientation as Float64Array,
          };
      const segments = sim.articulation.segments;
      const coms = new Float64Array(segments.length * 3);
      segmentComs(
        segments.map((s) => s.com),
        pose.position,
        pose.orientation,
        coms,
      );
      if (
        wholeBodyCom(
          Float64Array.from(segments, (s) => s.mass),
          coms,
          out,
        )
      ) {
        studio.world.localToWorld(out);
        return sim.resolved.input.stature;
      }
    }
    const stature = host.sliderStature();
    const restBounds = host.restBounds();
    if (restBounds) {
      const { min, max } = restBounds;
      out.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    } else {
      // Nothing built yet: about where a standing body's middle would be.
      out.set(0, (0.88 * stature) / FRAME_STATURE, 0);
    }
    studio.world.localToWorld(out);
    return stature;
  };

  return {
    install(sim) {
      overlays = createOverlays(sim.articulation, {
        musclePolylineCapacity: sim.musclePath?.compileReport.polylineCapacity,
      });
      studio.world.add(overlays.root);
      applyOverlayVisibility();
      studio.furniture.show(sim.staticBoxes);
    },
    forget() {
      overlays?.dispose();
      overlays = null;
      studio.furniture.clear();
    },
    applyOverlayVisibility,
    heldAtRest,
    pose(sim, skinned) {
      const replay = runs.atLiveEdge ? undefined : replayFrame(sim);
      const transforms = replay ?? sim.boneTransforms();
      // Off the live edge, the segment poses the overlays draw from are the replayed bones': a
      // segment's frame is its anchor bone's, so the discs, the cartilage and the proxies follow
      // the playhead the way the bones and bellies do.
      const replayedPose = replay ? segmentPosesFrom(sim, replay) : undefined;
      // Held at rest for the Align tab, the bones are put at rest once and left there. Checked
      // every frame rather than only when the hold is asked for, because a run is paused by many
      // things -- Pause, a scrub, a failed tick -- and resumed by as many, and each of them moves
      // the answer.
      const atRest = heldAtRest();
      if (atRest !== drawnHeld) {
        drawnHeld = atRest;
        if (atRest) skinned.rest();
        applyOverlayVisibility();
      }
      if (!atRest) {
        skinned.update(sim.boneOrder(), transforms.position, transforms.orientation);
      }
      return { transforms, replay, replayedPose };
    },
    drawOverlays(sim, { replay, replayedPose }) {
      if (overlays) {
        const pose = sim.channel('body.pose').fields;
        const limits = sim.channel('diagnostics.limits').fields;
        const contacts = sim.channel('contact.manifolds');
        overlays.update({
          // Off the live edge the pose overlays have no history to draw, so they are hidden rather
          // than fed the newest tick's -- see `applyOverlayVisibility`. What is passed here is what
          // they would draw if they were visible.
          position: replayedPose?.position ?? (pose.position as Float64Array),
          orientation: replayedPose?.orientation ?? (pose.orientation as Float64Array),
          proximity: limits.proximity as Float64Array,
          contactCount: replay ? 0 : contacts.count,
          contactPoint: contacts.fields.point as Float64Array,
          contactNormal: contacts.fields.normal as Float64Array,
          contactCapacity: (contacts.fields.point as Float64Array).length / 3,
          muscles: replay ? replayedMuscles(sim) : muscleOverlay(sim),
        });
      }
    },
    muscleOverlay,
    frameBody(controls, view) {
      const stature = aimAtBody(controls.target);
      const radius = (FRAME_DISTANCE * stature) / FRAME_STATURE;
      if (view) controls.setView(view.theta, view.phi, radius);
      else controls.setDistance(radius);
    },
  };
}
