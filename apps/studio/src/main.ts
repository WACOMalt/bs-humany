/**
 * bs-humany studio -- milestone M1.9.
 *
 * The first visible milestone: the complete 206-bone anatomical skeleton on screen, with
 * morphology sliders that reshape it live. The specification calls this one of the two milestones
 * that prove the project.
 *
 * There is no physics here yet. This is the anatomical layer of ADR-001 rendered in its rest pose;
 * the dynamic layer arrives with M3.
 */

import {
  resolveMorphology,
  staturePercentile,
  validateResolvedBody,
} from '@bs-humany/anthropometry';
import {
  type SkeletonAssets,
  attributionText,
  parseSkeletonAssets,
} from '@bs-humany/assets-anatomical';
import landmarksUrl from '@bs-humany/assets-anatomical/data/landmarks.json?url';
import manifestLod1Url from '@bs-humany/assets-anatomical/data/manifest-lod1.json?url';
import manifestUrl from '@bs-humany/assets-anatomical/data/manifest.json?url';
import skeletonLod1BinUrl from '@bs-humany/assets-anatomical/data/skeleton-lod1.bin?url';
import skeletonBinUrl from '@bs-humany/assets-anatomical/data/skeleton.bin?url';
import { compileArticulation, morphologyKey } from '@bs-humany/compiler';
import {
  MIN_CAPTURE_BUDGET_BYTES,
  captureCeilingBytes,
  defaultCaptureBudgetBytes,
} from '@bs-humany/export-gltf';
import { type Morphology, SEX_PARAMETER_LABEL, SEX_PARAMETER_NOTE } from '@bs-humany/hsdl';
import type { PolicyFile } from '@bs-humany/modules-nerves';
import {
  QUALITY_HIGH,
  type SkeletonMesh,
  buildSkeletonMesh,
  skeletonBounds,
  toSkeletonGeometry,
} from '@bs-humany/render-three';
import {
  DEFAULT_SCENARIO,
  SCENARIO_DEFINITIONS,
  type ScenarioDefinition,
  inertiaAudit,
  jointSweep,
} from '@bs-humany/scenarios';
import { type DriveSection, MUSCLE_GROUPS, driveForSlider } from '@bs-humany/scenarios';
import { buildDocument, computeWorldTransforms, modelLimitations } from '@bs-humany/skeleton';
import { invoke, isTauri } from '@tauri-apps/api/core';
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
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import {
  type AlignHost,
  type AlignPanel,
  createAlignPanel,
  loadSourceSites,
} from './align/alignPanel.js';
import { attachmentSites, jointsOnSegment } from './align/ourBody.js';
import { buildBlenderExport } from './blenderExport.js';
import { boundsMidpoint, segmentComs, wholeBodyCom } from './bodyCom.js';
import { IDLE_BRAIN_STATE, createBrainPanel } from './brain.js';
import { BridgeFollower } from './follow.js';
import { FollowTissue } from './followTissue.js';
import { createOrbitControls } from './orbit.js';
import { type Overlays, createOverlays } from './overlays.js';
import { Playback } from './playback.js';
import { RingTubes } from './ringTubes.js';
import { createRunGate, startSingleFlight } from './runController.js';
import {
  type SessionFile,
  type SessionSettings,
  deserializeSnapshot,
  download,
  downloadSet,
  isSessionFile,
  openTextFile,
  serializeSnapshot,
  usesNativeFilePickers,
} from './session.js';
import { keyOwnedByTarget } from './shortcuts.js';
import { type BackendId, Simulation } from './simulation.js';
import { type SkinnedSkeleton, createSkinnedSkeleton } from './skinning.js';
import { type TissueTable, tissueTable } from './tissue.js';
import { createMemory } from './ui/memory.js';
import { createResizer } from './ui/resizer.js';
import { drawSpine } from './ui/spineActivity.js';
import { createTabs } from './ui/tabs.js';
import { type VrCommand, VrLink, type VrStatus } from './vrLink.js';

// The document is built once. Only the morphology context changes as the sliders move, which is
// exactly the separation ADR-005 is for: anatomy is fixed, geometry is parametric.
// Measured placement only. The procedural recipes remain as the internal fallback for bones the
// dataset lacks (the ossicles, OQ-004) and as a future low-detail LOD; they are not a user option.
const document_ = buildDocument();

/** The measured mesh pack (ADR-005, ADR-011). Nothing renders until it has loaded. */
let assets: SkeletonAssets | null = null;

/**
 * The pack streams in two steps (M5.8): the quarter-size level of detail first, so the page
 * shows a skeleton after one small fetch, then the full pack in the background. A device with a
 * coarse pointer (a phone or tablet) stays on the small pack; its meshes are one mesh draw either
 * way and the full pack is nine megabytes it does not need.
 */
async function loadAssets(level: 'lod1' | 'full'): Promise<SkeletonAssets> {
  const [manifest, bin, landmarks] = await Promise.all([
    fetch(level === 'lod1' ? manifestLod1Url : manifestUrl).then((r) => r.json()),
    fetch(level === 'lod1' ? skeletonLod1BinUrl : skeletonBinUrl).then((r) => r.arrayBuffer()),
    fetch(landmarksUrl).then((r) => r.json()),
  ]);
  return parseSkeletonAssets(manifest, bin, landmarks);
}

const STAY_ON_SMALL_PACK = window.matchMedia('(pointer: coarse)').matches;

/**
 * How finely the procedural fallback bones are meshed. Only the six ossicles are procedural --
 * every other bone is the measured mesh -- so this is not a user option: the Tessellation select
 * that offered it re-meshed nothing anybody could see, and went. High, because six tiny bones at
 * the finest level cost nothing.
 */
const FALLBACK_QUALITY = QUALITY_HIGH;

// ---------------------------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------------------------

const viewport = must<HTMLDivElement>('#viewport');

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

/**
 * The camera starts at negative Z.
 *
 * The canonical frame puts anterior at `-Z` (ADR-010), matching three.js object-forward, so a
 * front view means standing in front of the subject at negative Z rather than the default positive.
 */
camera.position.set(1.5, 1.1, -2.6);

/**
 * True while the Align tab's gizmo is being dragged, so the camera holds still for it.
 *
 * The flag alone is not enough to claim the press that *starts* a drag: three sets its own
 * `dragging` inside its pointerdown handler, which runs after the orbit controls have already
 * been offered the same press. So the claim asks the panel whether the pointer is over a handle,
 * which is known from hover, and the flag only keeps the camera still for the rest of the drag.
 */
let gizmoDragging = false;
const controls = createOrbitControls(camera, renderer.domElement, new Vector3(0, 0.9, 0), {
  claimPointer: (event) => gizmoDragging || align?.overGizmo() === true || beginGrab(event),
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

/**
 * Everything in the simulation's frame -- the body, its overlays, the furniture, the grid --
 * under one group, so what is drawn and what is simulated share one set of coordinates. Points
 * picked in the scene go through `world` to reach the physics; lights and the camera stay where
 * they are. A scenario that tilts the floor turns the grid alone, because the floor is the only
 * thing that turns (see `tiltingFloor.ts`).
 */
const world = new Group();
scene.add(world);
const grid = new GridHelper(6, 24, 0x3a4250, 0x252a33);
world.add(grid);

/**
 * `vertexColors` so a bone can be tinted where it is drawn.
 *
 * It costs nothing when nothing is tinted: every vertex starts white and white multiplies the
 * base colour to itself.
 */
const boneMaterial = new MeshStandardMaterial({
  vertexColors: true,
  color: 0xe8e2d4,
  roughness: 0.72,
  metalness: 0.02,
  flatShading: false,
});

/**
 * The Align tab's own highlight, for the segment picked in its pairing list.
 *
 * A different colour from the inspector's, and from the orange their bones light up in, because
 * the whole point is telling three things apart at once: the bone of ours being paired, the bone
 * of theirs it is being paired to, and whatever the inspector happens to have selected.
 */
const ALIGNED_TINT = new Color(0x3fd6c4);

/**
 * The inspector's highlight, as a tint on the drawn bone.
 *
 * A vertex colour multiplies the material's, so the tint is the highlight's blue divided by the
 * bone colour, channel by channel: the selected bone is drawn in the same 0x6aa9ff the separate
 * highlight mesh was, rather than a darker blue that only looks like it.
 */
const SELECTION_TINT = (() => {
  const want = new Color(0x6aa9ff);
  const base = boneMaterial.color;
  return new Color(want.r / base.r, want.g / base.g, want.b / base.b);
})();

let skeletonMesh: SkeletonMesh | null = null;
let skinned: SkinnedSkeleton | null = null;
/** The inspector's bone, tinted on the drawn mesh; see `applyTints`. */
let selectedBoneId: string | null = null;
/** The bones of the segment the Align tab is pairing, tinted under the inspector's. */
let alignedSegmentBones: readonly string[] = [];
/** The rest skeleton's box, measured once a build, for aiming the camera at a body at rest. */
let restBounds: { min: [number, number, number]; max: [number, number, number] } | null = null;
let simulation: Simulation | null = null;
/**
 * Whether an export is being built or written: both export buttons stay grey until it is done.
 *
 * Building the Blender export takes seconds on a long run and blocks the page while it does, and
 * nothing used to say so: the button looked like it had done nothing, so it was pressed again, and
 * each press queued another whole export behind the first. Declared with the run state because
 * `setRunControls` reads it, from the first frame on.
 */
let exporting = false;
// Declared up here with the run state, because the render loop reads it from its first frame
// on, and that frame runs before the page script reaches the VR section at the bottom.
let vrLink: VrLink | null = null;
// Likewise the bridge follower, read by the loop from its first frame on.
const bridgeFollower = new BridgeFollower();
let overlays: Overlays | null = null;
let furniture: Group | null = null;
let groundY = 0;
/** Whether the full mesh pack is still on its way, for the readout at rest. */
let fullDetailPending = false;
/** The gate every run start goes through, so only one can land; see `runController.ts`. */
const runGate = createRunGate();
/** The carry a run start in flight was asked for, when it was one. */
type Carry = { state: ReturnType<Simulation['jointState']>; ticks: number; paused: boolean };
/**
 * What the start in flight was asked to do, so a change to the body while it compiles can ask
 * again rather than let a run built from the old body land. Null when nothing is starting.
 */
let pendingStart: { restoreFrom?: SessionFile['simulation']; carry?: Carry } | null = null;
/**
 * True while the Align tab asks for the body at rest, because the points it shows are defined
 * and recorded at rest and are judged against the bone they sit on. Up here with the run state
 * because the frame loop reads it from its first frame on. See `holdRest` in the Align host.
 */
let alignHoldsRest = false;

/**
 * Whether the body is drawn at rest for the Align tab now.
 *
 * Only while the run stays paused: holding pauses it, and a person who resumes it anyway has
 * chosen to watch it move, so it is drawn moving and the hold waits for the next pause.
 */
function heldAtRest(): boolean {
  return alignHoldsRest && (!simulation || simulation.paused);
}
/** What the frame loop last drew for the hold, so it acts only when that changes. */
let drawnHeld = false;

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------

const ui = {
  sex: must<HTMLInputElement>('#sex'),
  stature: must<HTMLInputElement>('#stature'),
  mass: must<HTMLInputElement>('#mass'),
  percentile: must<HTMLInputElement>('#percentile'),
  crural: must<HTMLInputElement>('#crural'),
  brachial: must<HTMLInputElement>('#brachial'),
  legLength: must<HTMLInputElement>('#legLength'),
  showGrid: must<HTMLInputElement>('#showGrid'),
  spin: must<HTMLInputElement>('#spin'),
  profile: must<HTMLSelectElement>('#profile'),
  passive: must<HTMLInputElement>('#passive'),
  redistribute: must<HTMLInputElement>('#redistribute'),
  dropHeight: must<HTMLInputElement>('#dropHeight'),
  grabStrength: must<HTMLInputElement>('#grabStrength'),
  gravity: must<HTMLInputElement>('#gravity'),
  floor: must<HTMLInputElement>('#floor'),
  simStart: must<HTMLButtonElement>('#simStart'),
  simPause: must<HTMLButtonElement>('#simPause'),
  reset: must<HTMLButtonElement>('#reset'),
  playToggle: must<HTMLButtonElement>('#playToggle'),
  frameBack: must<HTMLButtonElement>('#frameBack'),
  frameForward: must<HTMLButtonElement>('#frameForward'),
  goLive: must<HTMLButtonElement>('#goLive'),
  backend: must<HTMLSelectElement>('#backend'),
  scenario: must<HTMLSelectElement>('#scenario'),
  scenarioParameters: must<HTMLDivElement>('#scenario-parameters'),
  timeline: must<HTMLInputElement>('#timeline'),
  exportRecording: must<HTMLButtonElement>('#export'),
  exportBlender: must<HTMLButtonElement>('#export-blender'),
  save: must<HTMLButtonElement>('#save'),
  load: must<HTMLButtonElement>('#load'),
  loadFile: must<HTMLInputElement>('#load-file'),
  showProxies: must<HTMLInputElement>('#showProxies'),
  showAxes: must<HTMLInputElement>('#showAxes'),
  showCom: must<HTMLInputElement>('#showCom'),
  showContacts: must<HTMLInputElement>('#showContacts'),
  showTissue: must<HTMLInputElement>('#showTissue'),
  showMuscles: must<HTMLInputElement>('#showMuscles'),
  showMuscleVolumes: must<HTMLInputElement>('#showMuscleVolumes'),
  muscles: must<HTMLInputElement>('#muscles'),
  outputFramerate: must<HTMLInputElement>('#outputFramerate'),
  stepsPerSecond: must<HTMLInputElement>('#stepsPerSecond'),
  captureBudget: must<HTMLInputElement>('#captureBudget'),
  showNotes: must<HTMLInputElement>('#showNotes'),
};

// The drive groups and their sliders, one an entry of `MUSCLE_GROUPS`, generated so the studio
// and the headset's panel offer the same groups at the same ids.
const driveInputs = new Map<string, HTMLInputElement>();
{
  const host = must<HTMLDivElement>('#muscle-drives');
  const sections = new Map<string, HTMLElement>();
  for (const group of MUSCLE_GROUPS) {
    let section = sections.get(group.section);
    if (!section) {
      const details = window.document.createElement('details');
      details.open = false;
      const summary = window.document.createElement('summary');
      summary.textContent = group.section;
      details.append(summary);
      host.append(details);
      sections.set(group.section, details);
      section = details;
    }
    // The shared control layout, compact because there are thirty-five of them: the label and
    // its level on one line and the slider under it, as Body > Stature has them, with what the
    // group is pulling with beside the level so a slider says what it is doing as well as what
    // it is asking for.
    const control = window.document.createElement('div');
    control.className = 'control compact';
    const label = window.document.createElement('label');
    label.htmlFor = group.id;
    const readout = window.document.createElement('output');
    readout.id = `${group.id}-value`;
    readout.textContent = '0%';
    const force = window.document.createElement('span');
    force.id = `${group.id}-force`;
    force.className = 'force';
    force.title = 'What this group is pulling with at the newest frame, both sides summed';
    label.append(`${group.title} `, force, readout);
    const input = window.document.createElement('input');
    input.type = 'range';
    input.id = group.id;
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.value = '0';
    control.append(label, input);
    section.append(control);
    driveInputs.set(group.id, input);
  }
}

function currentMorphology(): Morphology {
  return {
    sex: Number(ui.sex.value),
    stature: Number(ui.stature.value),
    mass: Number(ui.mass.value),
    proportions: {
      crural: Number(ui.crural.value),
      brachial: Number(ui.brachial.value),
      relativeLegLength: Number(ui.legLength.value),
    },
  };
}

let buildMs = 0;

/**
 * What the drawn skeleton was last built from, so asking again for the same body builds nothing:
 * a slider's release after a drag whose last frame was already previewed is the common case.
 */
let meshBuiltFor: { key: string; assets: SkeletonAssets } | null = null;

/**
 * Rebuild the drawn skeleton for the body the sliders show, and nothing else.
 *
 * Never the run: a render-only change -- the full-detail pack arriving, a slider being dragged --
 * used to stop the simulation and carry it into a recompiled body, which threw its recording
 * away for a picture that had nothing to do with the physics. A run draws through `skinned`,
 * which the frame loop reads afresh every frame, so swapping it here is all a running body needs.
 * The ground stays where the run has it while one exists; the run's floor is the run's.
 *
 * A measured bone's normals are cached by the builder and a build is a few milliseconds, which
 * is what lets this run once a frame while a slider is dragged.
 */
function rebuildMesh(): void {
  if (!assets) return;
  const morphology = currentMorphology();
  const key = JSON.stringify(morphology);
  if (meshBuiltFor?.key === key && meshBuiltFor.assets === assets) return;
  const started = performance.now();
  const resolved = resolveMorphology(morphology);
  skeletonMesh = buildSkeletonMesh(document_, resolved.context, {
    quality: FALLBACK_QUALITY,
    assets,
  });
  meshBuiltFor = { key, assets };
  if (skinned) {
    world.remove(skinned.mesh);
    skinned.dispose();
  }
  skinned = createSkinnedSkeleton(skeletonMesh, toSkeletonGeometry(skeletonMesh), boneMaterial);
  world.add(skinned.mesh);
  // A followed body is posed when its publisher's next tick arrives. Forgetting the last one
  // poses the new mesh on the very next frame, rather than leaving it standing at rest until the
  // publisher moves.
  followLastTick = -1;

  // The ground sits under the soles: the dataset places them at y = 0 and stature scales about
  // the origin, so this is close to zero, but it is measured rather than assumed.
  restBounds = skeletonBounds(skeletonMesh);
  if (!simulation) {
    groundY = restBounds.min[1];
    grid.position.y = groundY;
  }

  buildMs = performance.now() - started;
  refreshSelection();
  updateReadouts(resolved.input.stature, resolved.input.mass);
}

/** The preview rebuild waiting for the next frame, or 0; see `previewMesh`. */
let previewFrame = 0;

/**
 * Rebuild the mesh at the next frame, however many times this is asked before it.
 *
 * A slider fires `input` for every pixel it moves, far more often than the page draws. Each of
 * those used to rebuild a quarter of a million vertices, recompute every bone's normals and
 * restart the run; now they coalesce into at most one mesh build a frame.
 */
function previewMesh(): void {
  if (previewFrame !== 0) return;
  previewFrame = requestAnimationFrame(() => {
    previewFrame = 0;
    rebuildMesh();
  });
}

/**
 * Recompile the body after a morphology change, once, when the change is finished.
 *
 * Validity, the Health tables, and a running body carried into the new one. A run whose body is
 * already what the sliders say -- a release that ends where it began -- is left alone, unless
 * `always` asks for the restart anyway, as a whole set of settings arriving does. A start
 * still compiling was built from the body as it was; it is asked for again with what it was asked
 * for, so the run that lands is the body the sliders now show. Both restarts go through the run
 * gate (`runController.ts`), so however many of these arrive, one run lands.
 *
 * `cause` names what changed, for the message a carry restart owes: it keeps the pose, but the
 * recording starts again, and a person who has been capturing for a minute should hear that from
 * the page rather than find it out at Export.
 */
function rebuildBody(cause = 'Body changed', options: { always?: boolean } = {}): void {
  const resolved = resolveMorphology(currentMorphology());

  // Spec section 6.4 step 5. A body that fails these checks would still render; it would simply be
  // wrong, so the failure is surfaced rather than swallowed: listed in Health, said in the event
  // line, and kept on the console with the detail.
  const validation = validateResolvedBody(resolved);
  showBodyValidity(validation.problems);
  if (!validation.valid) {
    console.error('Resolved body failed physical validity checks:', validation.problems);
    announce('The resolved body failed its validity checks; see Health.', { error: true });
  }
  showValidation();

  if (!simulation) {
    const reissue = runGate.busy ? pendingStart : null;
    if (reissue) void startSimulation(reissue.restoreFrom, reissue.carry);
    return;
  }
  if (!options.always && morphologyKey(simulation.resolved) === morphologyKey(resolved)) return;
  // A running simulation survives a morphology change: its joint state is carried into the
  // recompiled body (M5.6).
  const carry = {
    state: simulation.jointState(),
    ticks: simulation.ticks,
    paused: simulation.paused,
  };
  // Both of what a run keeps: the captured frames Export writes, and the sampled trajectory a
  // recording export writes. A run too short to have captured a frame may still have sampled.
  const frames = simulation.capture.frameCount;
  const samples = simulation.recording.samples.length;
  void startSimulation(undefined, carry);
  // After the start is under way, because a start clears the last run's notices as it begins.
  if (frames > 0 || samples > 0) {
    const what = frames > 0 ? `${frames} captured frames were` : 'its recording was';
    announce(
      `${cause}: the run carried on from its pose; ${what} discarded — export first to keep them.`,
    );
  }
}

/** Cancel a preview still waiting for its frame: whatever asked for it is about to build now. */
function cancelPreview(): void {
  if (previewFrame === 0) return;
  cancelAnimationFrame(previewFrame);
  previewFrame = 0;
}

/**
 * A morphology slider is moving.
 *
 * With no run, the mesh follows it, a frame at a time. With a run, only the numbers do: the body
 * on screen is the running one, and a rest mesh of another size bound to its pose would draw
 * every bone scaled about its own centre, which is a picture of nothing. It changes, once, on
 * release.
 */
function morphologyInput(): void {
  if (simulation) {
    updateReadouts(Number(ui.stature.value), Number(ui.mass.value));
    return;
  }
  previewMesh();
}

/** A morphology slider was let go: the mesh, then the body behind it. */
function morphologyChanged(): void {
  cancelPreview();
  rebuildMesh();
  rebuildBody();
}

/**
 * The resolved body's validity problems, listed in Health above the inertia audit, or nothing.
 *
 * They used to reach the console and nowhere else, which in the desktop shell is nowhere at all.
 */
function showBodyValidity(problems: readonly string[]): void {
  const list = must<HTMLUListElement>('#body-validity');
  list.replaceChildren(
    ...problems.map((problem) => {
      const item = window.document.createElement('li');
      item.textContent = problem;
      return item;
    }),
  );
  must<HTMLElement>('#body-validity-panel').hidden = problems.length === 0;
}

/**
 * True while the percentile slider is the one moving, so the read-back below does not write a
 * value into the slider under somebody's thumb.
 */
let percentileDriving = false;

function updateReadouts(stature: number, mass: number): void {
  must<HTMLOutputElement>('#sex-value').textContent = Number(ui.sex.value).toFixed(2);
  must<HTMLOutputElement>('#stature-value').textContent = `${stature.toFixed(2)} m`;
  must<HTMLOutputElement>('#mass-value').textContent = `${mass.toFixed(1)} kg`;
  must<HTMLOutputElement>('#crural-value').textContent = Number(ui.crural.value).toFixed(3);
  must<HTMLOutputElement>('#brachial-value').textContent = Number(ui.brachial.value).toFixed(3);
  must<HTMLOutputElement>('#legLength-value').textContent = Number(ui.legLength.value).toFixed(3);

  // The percentile reads back where the current stature sits in the distribution for the current
  // blend. It used to keep whatever it was last set to, so after a stature drag or a session load
  // it named a body that was no longer on screen. Written without an event, so nothing rebuilds.
  if (!percentileDriving) {
    const p = Math.min(Math.max(staturePercentile(Number(ui.sex.value), stature), 0.01), 0.99);
    ui.percentile.value = p.toFixed(2);
  }
  const percentile = Number(ui.percentile.value);
  must<HTMLOutputElement>('#percentile-value').textContent = `${Math.round(percentile * 100)}th`;

  must<HTMLElement>('#stat-bones').textContent = String(skeletonMesh?.bones.length ?? 0);
  must<HTMLElement>('#stat-tris').textContent = (skeletonMesh?.triangleCount ?? 0).toLocaleString();
  must<HTMLElement>('#stat-build').textContent = `${buildMs.toFixed(1)} ms`;
}

// The sliders that move the body. The three limb proportions are not among them: nothing measured
// follows them yet (see `modelLimitations`), so they are disabled in the panel. A value that
// arrives from a session or a checkpoint is still kept, and goes into the next compile with the
// rest of the settings, so those files round-trip unchanged.
for (const input of [ui.sex, ui.stature, ui.mass]) {
  input.addEventListener('input', () => {
    // Another slider moving means the percentile is not, whatever it last said: a percentile drag
    // that ends where it began fires no `change` to say it is over.
    percentileDriving = false;
    morphologyInput();
  });
  input.addEventListener('change', morphologyChanged);
}

/**
 * View presets.
 *
 * Azimuth is measured from +Z in three.js's spherical convention, and anterior is -Z (ADR-010),
 * so a front view is at theta = pi: standing in front of the subject, looking toward +Z.
 */
const VIEWS: Record<string, { theta: number; phi: number }> = {
  front: { theta: Math.PI, phi: Math.PI / 2 },
  left: { theta: -Math.PI / 2, phi: Math.PI / 2 },
  back: { theta: 0, phi: Math.PI / 2 },
  'three-quarter': { theta: Math.PI * 0.78, phi: Math.PI * 0.42 },
};

/**
 * The camera distance that frames a body of the reference stature head to feet: at the 38 degree
 * field of view, 3.1 m shows about 2.1 m of height, a margin around 1.70 m. It was the fixed
 * distance of every preset; now it scales with the body, so a 2.05 m body is not cut off and a
 * 1.40 m one does not stand small in the middle.
 */
const FRAME_DISTANCE = 3.1;
const FRAME_STATURE = 1.7;

/**
 * Where the body on screen is, written into `out`, and its stature.
 *
 * The centre of mass of whatever frame is drawn -- the live run, the frame under the playhead --
 * because that is where a body is, wherever it has fallen or been dragged: the presets used to
 * aim at a fixed point above the origin, and a body at the bottom of the stairs was out of frame
 * in every one of them. A followed body's masses are not known here, so it is the middle of its
 * bones instead. At rest, the middle of the rest skeleton.
 */
function aimAtBody(out: Vector3): number {
  if (bridgeFollower.active) {
    const pose = bridgeFollower.pose;
    const settings = (bridgeFollower.status as { settings?: { stature?: unknown } } | null)
      ?.settings;
    const stature =
      typeof settings?.stature === 'number' ? settings.stature : Number(ui.stature.value);
    if (pose && boundsMidpoint(pose.position, out)) {
      world.localToWorld(out);
      return stature;
    }
  }
  const sim = simulation;
  if (sim && !heldAtRest()) {
    const replay = following ? undefined : replayFrame(sim);
    const live = sim.channel('body.pose').fields;
    const pose = replay
      ? segmentPosesFrom(sim, replay)
      : { position: live.position as Float64Array, orientation: live.orientation as Float64Array };
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
      world.localToWorld(out);
      return sim.resolved.input.stature;
    }
  }
  const stature = Number(ui.stature.value);
  if (restBounds) {
    const { min, max } = restBounds;
    out.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  } else {
    // Nothing built yet: about where a standing body's middle would be.
    out.set(0, (0.88 * stature) / FRAME_STATURE, 0);
  }
  world.localToWorld(out);
  return stature;
}

/**
 * Aim the camera at the body and stand off far enough to see all of it: from a preset's angle
 * when one is given, and from wherever the camera already looks from when not, which is F.
 */
function frameBody(view?: { theta: number; phi: number }): void {
  const stature = aimAtBody(controls.target);
  const radius = (FRAME_DISTANCE * stature) / FRAME_STATURE;
  if (view) controls.setView(view.theta, view.phi, radius);
  else controls.setDistance(radius);
}

for (const button of window.document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
  button.addEventListener('click', (event) => {
    blurAfterMouse(event);
    const view = VIEWS[button.dataset.view ?? ''];
    if (view) frameBody(view);
  });
}
must<HTMLButtonElement>('#frame-view').addEventListener('click', (event) => {
  blurAfterMouse(event);
  frameBody();
});

ui.showGrid.addEventListener('change', () => {
  grid.visible = ui.showGrid.checked;
});

// The percentile control drives stature and mass together, then hands back to them -- it is a
// convenience input, not a separate axis. While it moves, the read-back leaves it alone.
ui.percentile.addEventListener('input', () => {
  percentileDriving = true;
  const resolved = resolveMorphology({
    sex: Number(ui.sex.value),
    percentile: Number(ui.percentile.value),
  } as Morphology);
  ui.stature.value = resolved.input.stature.toFixed(3);
  ui.mass.value = resolved.input.mass.toFixed(1);
  morphologyInput();
});
ui.percentile.addEventListener('change', () => {
  percentileDriving = false;
  morphologyChanged();
});

// ---------------------------------------------------------------------------------------------
// Picking and the inspector
// ---------------------------------------------------------------------------------------------

const raycaster = new Raycaster();
const pointer = new Vector2();

/** Pixels out from the pointer to retry a missed pick, and how many tries per ring. */
const PICK_RADII = [6, 14] as const;
const PICK_RING = 8;

renderer.domElement.addEventListener('click', (event) => {
  if (controls.wasDragging()) return;
  if (!skinned) return;
  const picked = pickBone(event.clientX, event.clientY);
  selectedBoneId = picked?.boneId ?? null;
  refreshSelection();
});

/**
 * Every tint on the drawn skeleton, in one place: the Align tab's segment, and over it the
 * inspector's bone.
 *
 * One function, because both paint the same vertex colours and each used to clear the other's:
 * the Align highlight went every time the inspector changed, and was lost on every rebuild too.
 * Called whenever either changes and after every new mesh, which starts white.
 */
function applyTints(): void {
  skinned?.setTints([
    { bones: alignedSegmentBones, colour: ALIGNED_TINT },
    { bones: selectedBoneId ? [selectedBoneId] : [], colour: SELECTION_TINT },
  ]);
}

function refreshSelection(): void {
  applyTints();
  const inspector = must<HTMLDivElement>('#inspector');
  if (!selectedBoneId || !skeletonMesh) {
    inspector.innerHTML = '<p class="note">Click a bone.</p>';
    return;
  }

  const bone = skeletonMesh.bones.find((b) => b.id === selectedBoneId);
  const definition = document_.bones.find((b) => b.id === selectedBoneId);
  if (!bone || !definition) {
    inspector.innerHTML = '<p class="note">Click a bone.</p>';
    return;
  }

  const parent = definition.parent
    ? (document_.bones.find((b) => b.id === definition.parent)?.displayName ?? definition.parent)
    : 'none (root)';
  const position = bone.worldTransform.translation;

  inspector.innerHTML = `
    <p class="bone-name">${escapeHtml(bone.displayName)}</p>
    <p class="bone-ta">${escapeHtml(bone.ta)}</p>
    <dl>
      <dt>ID</dt><dd>${escapeHtml(bone.id)}</dd>
      <dt>Region</dt><dd>${escapeHtml(bone.region)}</dd>
      <dt>Parent</dt><dd>${escapeHtml(parent)}</dd>
      <dt>Rest position</dt><dd>${position.x.toFixed(3)}, ${position.y.toFixed(3)}, ${position.z.toFixed(3)}</dd>
      <dt>Vertices</dt><dd>${bone.vertexCount.toLocaleString()}</dd>
      <dt>Geometry</dt><dd>${bone.geometrySource}</dd>
      <dt>Landmarks</dt><dd>${Object.keys(assets?.landmarks[bone.id] ?? {}).length}</dd>
    </dl>
  `;
}

// ---------------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------------

/**
 * Write an element's text only when it has changed.
 *
 * The frame loop writes its readouts sixty times a second, and most frames they say what they
 * said the frame before. A write of the same string still replaces the text node, which a screen
 * reader may announce again and which throws away a selection somebody was making in it.
 */
function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/**
 * The run readout: what the run is doing right now, rewritten every frame.
 *
 * Only for the state of the run -- running, paused, at rest, following -- because anything else
 * written here is gone a sixtieth of a second later, when the frame loop writes the readout over
 * it. One-off messages and errors go to `announce`, which has a line of its own.
 */
function setSimulationStatus(text: string, error = false): void {
  const status = must<HTMLElement>('#sim-status');
  setText(status, text);
  status.classList.toggle('error', error);
}

/**
 * Say something once, in the status bar's event line, and leave it there.
 *
 * The readout beside it is rewritten every frame, and everything that used to be written into it
 * -- "Wrote the session", "Muscles start with the next run", a failed save, a checkpoint that
 * would not load -- was on screen for one frame and then overwritten by "Running, 3.21 s
 * simulated". So messages have their own line: it holds until the next message replaces it or
 * somebody clicks it away. An error is marked as one and read out at once; the same message sent
 * twice does not rewrite the line, so a log that repeats itself does not churn the page.
 */
function announce(text: string, options: { error?: boolean } = {}): void {
  const slot = must<HTMLElement>('#sim-event');
  const error = options.error === true;
  if (!slot.hidden && slot.textContent === text && slot.classList.contains('error') === error) {
    return;
  }
  slot.textContent = text;
  slot.classList.toggle('error', error);
  slot.setAttribute('role', error ? 'alert' : 'status');
  slot.title = error
    ? 'Stays until you click it or another message replaces it'
    : 'Click to dismiss';
  slot.hidden = false;
}

/** Clear the event line; with `noticesOnly`, leave an error where it is. */
function dismissAnnouncement(noticesOnly = false): void {
  const slot = must<HTMLElement>('#sim-event');
  if (noticesOnly && slot.classList.contains('error')) return;
  slot.hidden = true;
  slot.textContent = '';
  slot.classList.remove('error');
}
must<HTMLElement>('#sim-event').addEventListener('click', () => dismissAnnouncement());

// Whatever else throws on the page -- a handler, a promise nobody awaited -- says so on the event
// line too, rather than only in a console nobody has open. Not prevented: the console still gets
// it, with its stack. The one error that is not an error is the resize observer's notice that it
// deferred a notification, which browsers raise as one and which a layout that resizes itself in
// a resize callback (the viewport's does) meets routinely.
window.addEventListener('error', (event) => {
  if (event.error === null && /ResizeObserver/.test(event.message)) return;
  announce(`Something on the page failed: ${event.message || messageOf(event.error)}`, {
    error: true,
  });
});
window.addEventListener('unhandledrejection', (event) => {
  announce(`Something on the page failed: ${messageOf(event.reason)}`, { error: true });
});

/** What the readout says with no run: at rest, and whether the full mesh is still on its way. */
function restStatus(): string {
  return fullDetailPending ? 'Loading full detail…' : 'At rest.';
}

/** Surface every warning from the compiler and the backend (spec section 9.3). */
function showReports(sim: Simulation): void {
  const list = must<HTMLUListElement>('#sim-report');
  list.innerHTML = '';
  const notes = [
    ...sim.compileReport.notes.map((n) => ({ ...n, from: 'compiler' })),
    ...(sim.backendReport?.notes ?? []).map((n) => ({
      ...n,
      from: sim.backendReport?.backend ?? 'backend',
    })),
  ].filter((n) => n.severity !== 'info');
  const info = [...sim.compileReport.notes, ...(sim.backendReport?.notes ?? [])].filter(
    (n) => n.severity === 'info',
  ).length;
  must<HTMLElement>('#sim-report-summary').textContent =
    `${notes.length} warning${notes.length === 1 ? '' : 's'}, ${info} note${info === 1 ? '' : 's'}`;
  for (const note of notes) {
    const item = window.document.createElement('li');
    item.textContent = `[${note.from}] ${note.message}`;
    list.appendChild(item);
  }
  if (sim.passive && sim.passive.defaulted.length > 0) {
    const item = window.document.createElement('li');
    item.textContent =
      `[passive joints] ${sim.passive.defaulted.length} of ${sim.articulation.dofs.length} DoFs ` +
      'run on the default curve derived from range and inertia (OQ-008).';
    list.appendChild(item);
  }
}

function stopSimulation(): void {
  // A start still compiling is abandoned too: a stop, a follow or a new start wants no run from
  // before it to land afterwards.
  const wasStarting = runGate.busy;
  runGate.invalidate();
  pendingStart = null;
  if (!simulation) {
    if (wasStarting) {
      setRunControls(false);
      setSimulationStatus(restStatus());
    }
    return;
  }
  simulation.dispose();
  forgetRun();
}

/** Take a run's traces off the page, without disposing it: whoever calls this has, or will. */
function forgetRun(): void {
  grabState = null;
  simulation = null;
  overlays?.dispose();
  overlays = null;
  clearFurniture();
  followFurnitureKey = '';
  must<HTMLElement>('#diagnostics').hidden = true;
  must<HTMLElement>('#timeline-control').hidden = true;
  // The readouts were of the run that has gone, and the headset is sent them too.
  clearMuscleReadout();
  showReadoutsLive(null, true);
  skinned?.rest();
  setRunControls(false);
  setSimulationStatus(restStatus());
}

/** The top bar's mode: at rest, a run of our own, or following the bridge. */
function setMode(mode: 'rest' | 'running' | 'paused' | 'following'): void {
  const indicator = must<HTMLElement>('#mode-indicator');
  indicator.classList.toggle('running', mode === 'running');
  indicator.classList.toggle('following', mode === 'following');
  must<HTMLElement>('#mode-label').textContent =
    mode === 'following'
      ? 'Following the bridge'
      : mode === 'running'
        ? 'Own run'
        : mode === 'paused'
          ? 'Own run, paused'
          : 'At rest';
}

/**
 * What pressing Start does, in words, one face for each thing it can do.
 *
 * The button is three buttons in one -- start a run, carry a paused one on, or throw a live one
 * away and start again -- and it used to be labelled as though it were always the first. Each face
 * has its own title, because Restart is the one that discards a recording and the title is where
 * somebody hovering to find out would look. Space is named only where Space does the same thing:
 * on a live run it pauses, it never restarts.
 */
const START_FACES = {
  start: { label: '\u25b6 Start sim', title: 'Start a run with the current settings (Space)' },
  resume: {
    label: '\u25b6 Resume sim',
    title: 'Carry the run on from its newest frame; nothing computed is lost (Space)',
  },
  restart: {
    label: '\u21bb Restart',
    title: 'Throw this run and its recording away and start a new one with the current settings',
  },
  compiling: {
    label: 'Compiling\u2026',
    title: 'Building the body and the solver for a new run; the page may stop for a moment',
  },
} as const;

/** Write a button's label and title, only when they change: this runs every frame. */
function setFace(button: HTMLButtonElement, face: { label: string; title: string }): void {
  if (button.textContent !== face.label) button.textContent = face.label;
  if (button.title !== face.title) button.title = face.title;
}

/**
 * The two sets of buttons, which answer two different questions.
 *
 * Start and Pause are about whether the simulation is computing. Play, the frame steps and the
 * playhead are about where in what it has already computed you are looking. They were one set
 * before -- Run, Pause, Step, Reset and a timeline that re-simulated what you scrubbed over --
 * and the reason that was confusing is that it was two things wearing one set of labels.
 */
function setRunControls(running: boolean): void {
  setMode(!running ? 'rest' : simulation?.paused ? 'paused' : 'running');
  // Busy while a start compiles, so a second press cannot begin a second start and the page says
  // why it is about to stop answering for a moment.
  const compiling = runGate.busy;
  ui.simStart.disabled = compiling;
  if (compiling) ui.simStart.setAttribute('aria-busy', 'true');
  else ui.simStart.removeAttribute('aria-busy');
  // Nothing computed yet -- no run, or one Reset back to its first tick -- is a start, whatever
  // the paused flag says: there is nothing to carry on from.
  setFace(
    ui.simStart,
    compiling
      ? START_FACES.compiling
      : !running || !simulation || simulation.ticks === 0
        ? START_FACES.start
        : simulation.paused
          ? START_FACES.resume
          : START_FACES.restart,
  );
  ui.simPause.disabled = !running || simulation?.paused === true;
  ui.reset.disabled = !running;
  // Grey while an export is being written as well, because this runs every frame while the
  // playhead is behind the live edge and would otherwise hand a second click straight back.
  ui.exportRecording.disabled = !running || exporting;
  ui.exportBlender.disabled = !running || exporting;
  setPlaybackControls(running);
}

/**
 * The playback buttons, refreshed every frame rather than only when one is pressed.
 *
 * Whether there is anything to play back changes as the run computes, and nothing presses a
 * button when it does: left to `setRunControls` alone, Play stayed greyed out through a whole run
 * because the last thing to call it was the run starting, when the recording was empty.
 */
function setPlaybackControls(running: boolean): void {
  const frames = capturedFrames();
  ui.playToggle.disabled = frames <= 1;
  ui.playToggle.textContent = playback.playing ? 'Pause' : 'Play';
  ui.frameBack.disabled = frames <= 0 || (following ? frames <= 1 : playback.frame < 1);
  ui.frameForward.disabled = !running;
  // What ▶ does at the end of the recording depends on whether the recording is still being
  // taken, and its title is where somebody hovering to find out would look.
  const title =
    simulation && !captureAtLiveEdge(simulation)
      ? 'One output frame on; the recording has stopped, so at its end this goes back to live ' +
        'without computing (Right)'
      : 'One output frame on; at the end of the recording, computes one (Right)';
  if (ui.frameForward.title !== title) ui.frameForward.title = title;
  ui.goLive.disabled = !running || following;
}

function currentSettings(): SessionSettings {
  return {
    sex: Number(ui.sex.value),
    stature: Number(ui.stature.value),
    mass: Number(ui.mass.value),
    crural: Number(ui.crural.value),
    brachial: Number(ui.brachial.value),
    legLength: Number(ui.legLength.value),
    profile: ui.profile.value,
    backend: ui.backend.value,
    scenario: ui.scenario.value,
    passive: ui.passive.checked,
    redistribute: ui.redistribute.checked,
    dropHeight: Number(ui.dropHeight.value),
    grabStrength: Number(ui.grabStrength.value),
    gravity: ui.gravity.checked,
    floor: ui.floor.checked,
    ...(ui.scenario.value
      ? { scenarioParameters: { ...scenarioValues.get(ui.scenario.value) } }
      : {}),
  };
}

function applySettings(settings: SessionSettings): void {
  ui.sex.value = String(settings.sex);
  ui.stature.value = String(settings.stature);
  ui.mass.value = String(settings.mass);
  ui.crural.value = String(settings.crural);
  ui.brachial.value = String(settings.brachial);
  ui.legLength.value = String(settings.legLength);
  ui.profile.value = settings.profile;
  // Rapier was deleted on 2026-09-26 (ADR-003); a saved session naming it runs on MuJoCo.
  ui.backend.value = settings.backend === 'rapier' ? 'mujoco' : settings.backend;
  ui.scenario.value = settings.scenario;
  ui.passive.checked = settings.passive;
  ui.redistribute.checked = settings.redistribute;
  ui.dropHeight.value = String(settings.dropHeight);
  must<HTMLOutputElement>('#dropHeight-value').textContent = `${settings.dropHeight.toFixed(2)} m`;
  if (settings.gravity !== undefined) ui.gravity.checked = settings.gravity;
  if (settings.floor !== undefined) ui.floor.checked = settings.floor;
  if (settings.grabStrength !== undefined) {
    ui.grabStrength.value = String(settings.grabStrength);
    must<HTMLOutputElement>('#grabStrength-value').textContent =
      `${settings.grabStrength.toFixed(1)}\u00d7`;
  }
  if (settings.scenario && settings.scenarioParameters) {
    scenarioValues.set(settings.scenario, { ...settings.scenarioParameters });
  }
  ui.scenario.dispatchEvent(new Event('change'));
  cancelPreview();
  rebuildMesh();
  // Always a restart when a run is going, whether or not the body changed: the settings carry the
  // profile, the scenario and the joints as well, and none of those reach a run already built.
  rebuildBody('Settings applied', { always: true });
}

/**
 * Keep the drawn scenery where the solver has it.
 *
 * Most scenery never moves and this costs nothing; a tilting platform moves every tick, and a
 * box drawn where it started while the body stands on where it is now is the kind of picture
 * that makes a real force look like a trick of the rendering.
 */
function followFurniture(sim: Simulation): void {
  if (!furniture) return;
  sim.staticBoxes.forEach((box, at) => {
    const mesh = furniture?.children[at];
    if (!mesh) return;
    mesh.position.set(box.position.x, box.position.y, box.position.z);
    if (box.rotation) {
      mesh.quaternion.set(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w);
    }
  });
}

/**
 * A box to draw, however it arrived: from a run of this studio's own, or from the status a
 * publisher on the bridge writes. The two say the same thing in different shapes.
 */
interface DrawnBox {
  readonly halfExtents: { x: number; y: number; z: number };
  readonly position: { x: number; y: number; z: number };
  readonly rotation?: { x: number; y: number; z: number; w: number } | undefined;
}

/** Draw a scenario's static boxes so the body has something visible to land on. */
function showFurniture(boxes: readonly DrawnBox[]): void {
  // Whatever was up comes down first: two starts landing close together each drew their own set,
  // and the first set stayed in the scene with nothing left to take it down.
  clearFurniture();
  if (boxes.length === 0) return;
  furniture = new Group();
  const material = new MeshStandardMaterial({ color: 0x4a5566, roughness: 0.9 });
  for (const box of boxes) {
    const mesh = new Mesh(
      new BoxGeometry(2 * box.halfExtents.x, 2 * box.halfExtents.y, 2 * box.halfExtents.z),
      material,
    );
    mesh.position.set(box.position.x, box.position.y, box.position.z);
    if (box.rotation)
      mesh.quaternion.set(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w);
    furniture.add(mesh);
  }
  world.add(furniture);
}

/** Take the furniture down, whoever put it up. */
function clearFurniture(): void {
  if (!furniture) return;
  furniture.removeFromParent();
  for (const child of furniture.children) if (child instanceof Mesh) child.geometry.dispose();
  furniture = null;
}

/**
 * The scenery a publisher on the bridge is standing its body on.
 *
 * Followed runs used to have none: the studio drew furniture from its own simulation, and while
 * following there is no simulation. So a body balancing on a tilting platform appeared to be
 * balancing on nothing, and the thing a balance run is about was the one thing not on screen.
 *
 * The status carries the boxes where the publisher's solver has them, ten times a second. The
 * meshes are rebuilt only when the shapes change -- a tilting platform keeps its size and moves
 * every frame -- so the common case is moving what is already there.
 */
let followFurnitureKey = '';
function followedFurniture(): void {
  const status = bridgeFollower.status as {
    staticBoxes?: readonly {
      halfExtents: readonly number[];
      position: readonly number[];
      rotation?: readonly number[];
    }[];
  } | null;
  const boxes = (status?.staticBoxes ?? []).map((b) => ({
    halfExtents: { x: b.halfExtents[0] ?? 0, y: b.halfExtents[1] ?? 0, z: b.halfExtents[2] ?? 0 },
    position: { x: b.position[0] ?? 0, y: b.position[1] ?? 0, z: b.position[2] ?? 0 },
    rotation: b.rotation
      ? {
          x: b.rotation[0] ?? 0,
          y: b.rotation[1] ?? 0,
          z: b.rotation[2] ?? 0,
          w: b.rotation[3] ?? 1,
        }
      : undefined,
  }));
  const key = boxes
    .map((b) => `${b.halfExtents.x},${b.halfExtents.y},${b.halfExtents.z}`)
    .join('|');
  if (key !== followFurnitureKey) {
    clearFurniture();
    followFurnitureKey = key;
    showFurniture(boxes);
    return;
  }
  if (!furniture) return;
  boxes.forEach((box, at) => {
    const mesh = furniture?.children[at];
    if (!mesh) return;
    mesh.position.set(box.position.x, box.position.y, box.position.z);
    if (box.rotation) {
      mesh.quaternion.set(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w);
    }
  });
}

/** Capabilities as a definition list (spec section 9.3). */
function showCapabilities(sim: Simulation): void {
  const list = must<HTMLDListElement>('#capabilities');
  list.innerHTML = '';
  for (const [key, value] of Object.entries(sim.capabilities)) {
    const dt = window.document.createElement('dt');
    dt.textContent = key.replace(/([A-Z])/g, ' $1').toLowerCase();
    const dd = window.document.createElement('dd');
    dd.textContent = String(value);
    list.append(dt, dd);
  }
}

async function startSimulation(
  restoreFrom?: SessionFile['simulation'],
  carry?: Carry,
): Promise<void> {
  if (!skeletonMesh || !skinned) {
    // Pressed before the bones arrived. It used to do nothing at all, which on a slow connection
    // is indistinguishable from a Start button that does not work.
    announce('The skeleton is still loading; Start works once it appears.');
    return;
  }
  if (bridgeFollower.active) stopFollowing();
  stopSimulation();
  // What was said about the last run is not about this one. An error stays, because nobody has
  // necessarily read it yet; and a carry is the same run going on, so what was said stays too --
  // a slider dragged through a run carries it several times, and the first carry's notice that
  // the capture was discarded is the one that matters.
  if (!carry) dismissAnnouncement(true);
  pendingStart = { ...(restoreFrom ? { restoreFrom } : {}), ...(carry ? { carry } : {}) };
  // Kept so a failure after the run was put in place can take it out again.
  let built: Simulation | undefined;
  try {
    await startSingleFlight(runGate, {
      before: async () => {
        setRunControls(false);
        setSimulationStatus('Compiling the body…');
        await paintYield();
      },
      // Built after the yield, so it reads the settings as they are when it is built: a slider
      // still moving when Start was pressed lands at its final value.
      build: () => {
        const chosen = currentScenario();
        built = new Simulation(document_, resolveMorphology(currentMorphology()), {
          profileId: ui.profile.value,
          backend: ui.backend.value as BackendId,
          passiveJoints: ui.passive.checked,
          redistribute: ui.redistribute.checked,
          scenario: chosen,
          dropHeight: Number(ui.dropHeight.value),
          groundHeight: groundY,
          // A scenario that drives muscles gets them whether the box is ticked or not: the box
          // is there to keep them off the runs that do not need them, not to make a muscle
          // scenario silently run a bare skeleton.
          muscles: ui.muscles.checked || chosen?.muscles === true,
          // Only when somebody moved it. Left alone, each profile keeps the step rate its solver
          // was tuned for, which is the number that ought to win by default.
          ...(fidelityTouched ? { stepsPerSecond: Number(ui.stepsPerSecond.value) } : {}),
          outputFramerate: Number(ui.outputFramerate.value),
          nerves: brain?.setup,
          // The cord the Spine panel shows, so a Start, a Reset-and-Start, a carry restart and
          // a restored session all run the reflexes the sliders say rather than none at all.
          reflex: brain?.state().reflex,
          // A checkpoint trained with nothing under the brain has never felt a scenario's tone,
          // so the scenario's script does everything else it does and drives no muscle.
          scriptMuscleDrive: brain?.chosenRecipe()?.feedforward.kind !== 'none',
        });
        return built;
      },
      install: (sim) => installRun(sim, restoreFrom, carry),
    });
  } catch (error) {
    // The run may have been put in place before something in the installing failed; the gate has
    // disposed it, so it only has to come off the page.
    if (built && simulation === built) forgetRun();
    console.error('The simulation failed to start.', error);
    announce(`The run failed to start: ${messageOf(error)}`, {
      error: true,
    });
    setSimulationStatus(restStatus());
  } finally {
    if (!runGate.busy) pendingStart = null;
    // Whichever start this was, the controls follow what is true now: a run, a newer start still
    // compiling, or nothing.
    setRunControls(simulation !== null);
  }
}

/**
 * Wait until the busy Start has been painted, then a little more.
 *
 * Building the body freezes the page for as long as it takes, and a freeze that begins before
 * the button has turned grey looks like a click that did nothing. One animation frame is not
 * enough -- the callback runs before that frame paints -- so the wait is a frame and then a task.
 * The timeout is for a page that is not painting at all, hidden or minimised, which would
 * otherwise never start.
 */
function paintYield(): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      setTimeout(resolve, 0);
    };
    requestAnimationFrame(go);
    setTimeout(go, 100);
  });
}

/**
 * Put a started run in place: its settings, its restored or carried state, and everything on the
 * page that shows it. Only ever called for the start that is still current.
 *
 * What can fail is done first, before the run is assigned, so a failure leaves nothing of it on
 * the page.
 */
function installRun(sim: Simulation, restoreFrom?: SessionFile['simulation'], carry?: Carry): void {
  // A fresh backend always starts with gravity and a solid floor; both toggles are session
  // settings rather than run ones.
  if (!ui.gravity.checked) sim.setGravity(false);
  if (!ui.floor.checked) sim.setGroundCollision(false);
  applyMuscleDrive(sim);
  // A fresh run opens at the profile's own step rate, unless the slider has been moved off it.
  if (!fidelityTouched) ui.stepsPerSecond.value = String(sim.stepsPerSecond);
  applyFidelity(sim);
  showRates();
  if (restoreFrom) sim.restore(deserializeSnapshot(restoreFrom.snapshot), restoreFrom.ticks);
  let unmatched: string[] = [];
  if (carry) {
    unmatched = sim.carryFrom(carry.state, carry.ticks);
    sim.paused = carry.paused;
    if (unmatched.length > 0)
      console.warn('DoFs without a counterpart, left at neutral:', unmatched);
  }
  simulation = sim;
  following = true;
  playback.rewind();
  overlays = createOverlays(sim.articulation, {
    musclePolylineCapacity: sim.musclePath?.compileReport.polylineCapacity,
  });
  world.add(overlays.root);
  applyOverlayVisibility();
  showFurniture(sim.staticBoxes);
  // The Align tab draws our own joints and attachments, which are this body's: when the body
  // is rebuilt they are a different body's and have to be read again.
  align?.refresh();
  showCapabilities(sim);
  must<HTMLElement>('#diagnostics').hidden = false;
  must<HTMLElement>('#timeline-control').hidden = false;
  showReports(sim);
  // A body carried into a profile with other joints leaves some of the old pose behind. That
  // is expected and not an error, but it is a difference in the body that is running, so it is
  // listed with the other things the compile had to say rather than only on the console.
  if (unmatched.length > 0) {
    const item = window.document.createElement('li');
    item.textContent =
      `[carry] ${unmatched.length} DoFs had no counterpart in ${sim.recording.profile} ` +
      `and start at neutral: ${unmatched.join(', ')}`;
    must<HTMLUListElement>('#sim-report').appendChild(item);
  }
  refreshSelection();
  setRunControls(true);
  setSimulationStatus('Running.');
}

/**
 * The playhead, and whether it is following the newest frame or sitting somewhere behind it.
 *
 * `following` is the whole of the mode: true and the picture is the live simulation, false and it
 * is a frame read back out of the recording. Scrubbing, stepping and playing all set it false and
 * pause the simulation, because the playhead being somewhere the run has already been is exactly
 * what "not live" means.
 */
const playback = new Playback();
let following = true;

/** Output frames the recording holds, which is what the playhead counts in. */
function capturedFrames(): number {
  if (!simulation) return 0;
  return Playback.frames(simulation.capture.frameCount, simulation.ticksPerOutputFrame);
}

/**
 * The frame on screen, which every control that moves relative to it starts from: the newest
 * while following, the playhead otherwise. See `Playback.at` for why `playback.frame` alone is
 * not it.
 */
function playheadFrame(): number {
  return playback.at(capturedFrames(), following);
}

/**
 * Whether the capture's newest frame is the run's newest tick: false once the capture budget has
 * stopped it and the run has gone on past it. Then the newest frame is not live, and nothing
 * computed from here on is recorded, so the timeline stops calling itself live and ▶ stops
 * offering to compute a frame onto the end of it. An empty capture nothing has stopped is at the
 * edge, because the next tick is its first; see `Playback.atLiveEdge`.
 */
function captureAtLiveEdge(sim: Simulation): boolean {
  const stopped = sim.capturesStoppedBy !== undefined || sim.capture.full;
  return Playback.atLiveEdge(sim.capture, stopped, sim.ticks);
}

/**
 * Let go of whatever the mouse is holding. The headset's hands hold other slots and keep theirs.
 *
 * For anything that stops the run being live under the pointer -- Pause, a scrub, Play -- because
 * a grab held across it pulls on a body that is not the one on screen, and resumes pulling on
 * the live one wherever the pointer happened to be left.
 */
function releaseMouseGrab(sim: Simulation): void {
  sim.grab.release(0);
  grabState = null;
}

/** Leave live, pause the simulation, and put the playhead where it is being asked for. */
function scrubTo(frame: number): void {
  if (!simulation) return;
  const frames = capturedFrames();
  if (frames <= 0) return;
  releaseMouseGrab(simulation);
  following = false;
  playback.playing = false;
  simulation.paused = true;
  playback.frame = Math.min(Math.max(frame, 0), frames - 1);
  applyOverlayVisibility();
  setRunControls(true);
  updateTimeline(simulation);
}

/**
 * A tick threw: pause the run where it stopped and say so.
 *
 * Left alone, the frame loop would call the same tick again next frame and the one after, sixty
 * times a second, each throwing into the console while the readout went on saying "Running" over
 * a body that had not moved. Paused, what was computed up to the failure is still there to scrub
 * and export, and the event line says what went wrong and when.
 *
 * `Simulation.advance` catches its own ticks' failures and records them on the run; this is for
 * the ticks run outside it -- a frame stepped by hand -- which are recorded the same way, so the
 * status line and the event line say the one thing whichever path the failure came by.
 */
function stalled(sim: Simulation, error: unknown): void {
  sim.paused = true;
  sim.failure ??= { message: messageOf(error), tick: sim.ticks };
  console.error('A simulation tick failed; the run is paused.', error);
  reportStop(sim);
}

/**
 * What a run that stopped itself says, in the status line and the event line: a failed tick when
 * there was one, since that stops the run for good, and otherwise the solver's reset.
 */
function stopText(sim: Simulation, only?: 'failure' | 'diverged'): string | undefined {
  if (sim.failure && only !== 'diverged') {
    return (
      `Stopped at ${(sim.failure.tick * sim.dt).toFixed(3)} s: ${sim.failure.message}. ` +
      'Reset or Restart to go on.'
    );
  }
  if (sim.divergedAt !== undefined && only !== 'failure') {
    return (
      `Diverged at ${(sim.divergedAt * sim.dt).toFixed(3)} s: MuJoCo reset the body ` +
      '(bad acceleration). Paused.'
    );
  }
  return undefined;
}

/**
 * The stop last said, so it is said once: the frame loop asks every frame, and the event line is
 * for saying a thing when it happens, not sixty times a second.
 */
let reportedStop:
  | { sim: Simulation; failure: Simulation['failure']; diverged: number | undefined }
  | undefined;

/**
 * Say, once, that the run stopped itself -- a tick threw, or the solver reset the body -- and put
 * the buttons in the state a paused run has. The run records why it stopped (`failure`,
 * `divergedAt`); this is only the telling, and it tells each new reason once.
 */
function reportStop(sim: Simulation): void {
  const last = reportedStop;
  if (last?.sim === sim && last.failure === sim.failure && last.diverged === sim.divergedAt) {
    return;
  }
  // Only the solver's reset is new when the failure is the one already told.
  const text =
    last?.sim === sim && last.failure === sim.failure ? stopText(sim, 'diverged') : stopText(sim);
  reportedStop = { sim, failure: sim.failure, diverged: sim.divergedAt };
  if (!text) return;
  announce(text, { error: true });
  setRunControls(true);
}

/**
 * The stop's text while the run is still standing where it stopped, for the status line; once
 * it has been reset or carried on past that tick, the run is an ordinary one again and the
 * event line alone remembers what happened.
 */
function stoppedHere(sim: Simulation): string | undefined {
  if (!sim.paused) return undefined;
  if (sim.failure && sim.ticks === sim.failure.tick) return stopText(sim, 'failure');
  if (sim.divergedAt !== undefined && sim.ticks === sim.divergedAt) {
    return stopText(sim, 'diverged');
  }
  return undefined;
}

/** Back to the newest frame, and following it again. */
function goLive(): void {
  if (!simulation) return;
  following = true;
  playback.playing = false;
  playback.frame = Math.max(0, capturedFrames() - 1);
  applyOverlayVisibility();
  showReadoutsLive(simulation, true);
  setRunControls(true);
  updateTimeline(simulation);
}

/**
 * The timeline's playhead and its label.
 *
 * The time is the run's -- the tick the frame shows, times the tick length -- and not the frame
 * divided by the output rate, which counted from the start of the capture: after a carry or a
 * session load the capture starts where the body arrived, and the label then disagreed with the
 * status line's "Paused at" by however far in that was.
 *
 * "Live" only when the frame on screen is the run's newest tick. With the capture budget spent
 * the run can carry on unrecorded, and the timeline used to go on saying "live" over a frame that
 * was seconds behind the body; it now says the recording stopped and where the run is.
 */
function updateTimeline(sim: Simulation): void {
  const frames = capturedFrames();
  const frame = playheadFrame();
  ui.timeline.max = String(Math.max(0, frames - 1));
  if (!scrubbing) ui.timeline.value = String(frame);
  const fps = Math.max(1, sim.outputFramerate);
  const seconds =
    Playback.runTickOf(frame, sim.capture.firstTick, sim.ticksPerOutputFrame) * sim.dt;
  const edge = !following
    ? ''
    : captureAtLiveEdge(sim)
      ? ' · live'
      : ` · recording stopped; run at ${(sim.ticks * sim.dt).toFixed(2)} s`;
  setText(
    must<HTMLOutputElement>('#timeline-value'),
    frames === 0 ? '—' : `frame ${frame} of ${frames - 1} · ${seconds.toFixed(2)} s${edge}`,
  );
  setText(
    must<HTMLElement>('#playback-note'),
    frames === 0
      ? ''
      : `${frames} frames recorded at ${fps} fps, ${(frames / fps).toFixed(2)} s` +
          (following ? '.' : ' — the simulation is paused while the playhead is behind it.'),
  );
  setPlaybackControls(true);
}

let scrubbing = false;
ui.timeline.addEventListener('pointerdown', () => {
  scrubbing = true;
});
ui.timeline.addEventListener('input', () => {
  scrubTo(Number(ui.timeline.value));
});
window.addEventListener('pointerup', () => {
  scrubbing = false;
});

ui.playToggle.addEventListener('click', (event) => {
  blurAfterMouse(event);
  if (!simulation || capturedFrames() <= 1) return;
  if (playback.playing) {
    playback.playing = false;
  } else {
    // From the frame on screen: live, that is the newest, and replaying from the end plays
    // nothing, so a Play pressed there starts over. It used to start from wherever the playhead
    // was last left, which after going live and running on was nowhere in particular.
    const from = playheadFrame();
    releaseMouseGrab(simulation);
    following = false;
    simulation.paused = true;
    playback.frame = from >= capturedFrames() - 1 ? 0 : from;
    playback.playing = true;
  }
  applyOverlayVisibility();
  setRunControls(true);
});
ui.frameBack.addEventListener('click', (event) => {
  blurAfterMouse(event);
  // One back from the frame on screen. From live this used to step back from the stale playhead,
  // which after a few seconds of running was the start of the capture.
  scrubTo(playheadFrame() - 1);
});
ui.frameForward.addEventListener('click', (event) => {
  blurAfterMouse(event);
  if (!simulation) return;
  const frames = capturedFrames();
  const at = playheadFrame();
  if (at < frames - 1) {
    scrubTo(at + 1);
    return;
  }
  // At the newest recorded frame with the capture stopped behind the run, a computed frame would
  // not be recorded and the playhead could not show it; all that is ahead is live.
  if (!captureAtLiveEdge(simulation)) {
    goLive();
    return;
  }
  // At the newest frame there is nothing ahead to step to, so one is computed. That is what the
  // old Step button did, and it is the same gesture: go one frame further on.
  simulation.paused = true;
  const ticks = Math.max(1, Math.round(simulation.ticksPerOutputFrame));
  try {
    for (let i = 0; i < ticks; i++) simulation.tick();
  } catch (error) {
    stalled(simulation, error);
    return;
  }
  simulation.pose.step();
  simulation.metrics.step();
  // The belly sweep runs on a divisor while the simulation is running; a hand-stepped frame
  // asks for it directly so what is drawn is this tick's shape rather than up to eight back.
  simulation.sweepRenderMesh();
  goLive();
});
ui.goLive.addEventListener('click', (event) => {
  blurAfterMouse(event);
  goLive();
});

/**
 * Which overlays are drawn, and which cannot be while the playhead is behind the newest frame.
 *
 * Bones and bellies are recorded, so they replay. Joint axes, the centre of mass, the contact
 * manifolds and the muscle path polylines are live readings a tick wide and nothing holds a
 * history of them; drawn during playback they would show the newest tick's answer against a body
 * in a pose from four seconds ago, which is worse than not drawing them. The checkboxes keep
 * whatever they were set to and come back on at Live.
 */
function applyOverlayVisibility(): void {
  if (!overlays) return;
  // Held at rest for the Align tab, the bones are drawn at rest and every overlay drawn from the
  // run's pose would stand somewhere else, so all of those go too.
  const held = heldAtRest();
  const live = following && !held;
  overlays.proxies.visible = ui.showProxies.checked && !held;
  overlays.axes.visible = ui.showAxes.checked && live;
  overlays.com.visible = ui.showCom.checked && live;
  overlays.contacts.visible = ui.showContacts.checked && live;
  overlays.tissue.visible = ui.showTissue.checked && !held;
  overlays.muscles.visible = ui.showMuscles.checked && live;
  overlays.muscleVolumes.visible = ui.showMuscleVolumes.checked && !held;
}
for (const input of [
  ui.showProxies,
  ui.showAxes,
  ui.showCom,
  ui.showContacts,
  ui.showMuscles,
  ui.showMuscleVolumes,
  ui.showTissue,
]) {
  input.addEventListener('change', applyOverlayVisibility);
}

/** The tissue in bone frames, for the headset: a segment's frame is its anchor bone's. */
let tissueCache: { sim: Simulation; table: VrStatus['tissue'] } | undefined;
function tissueForBridge(sim: Simulation): VrStatus['tissue'] {
  if (tissueCache?.sim === sim) return tissueCache.table;
  const table = tissueTable(sim.articulation);
  tissueCache = { sim, table };
  return table;
}

/**
 * The muscle paths and how hard each is pulling, for the overlay.
 *
 * Tension is the fraction of the unit's own maximum isometric force, so a small muscle working
 * hard reads as hard as a big one. Absolute newtons would colour the whole arm by which muscle
 * happens to be the strongest.
 */
function muscleOverlay(sim: Simulation) {
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
}

/** Segment poses from bone transforms: each segment's frame is its anchor bone's. */
let segmentAnchorIndex: { sim: Simulation; anchors: Int32Array } | undefined;
function segmentPosesFrom(
  sim: Simulation,
  bones: { position: Float64Array; orientation: Float64Array },
): { position: Float64Array; orientation: Float64Array } {
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
}

/**
 * Bone transforms for the frame the playhead is on, or nothing if it cannot be read.
 *
 * Nothing is stepped to get here: the recording already holds every tick, and the playhead's
 * output frame is one of them.
 */
function replayFrame(
  sim: Simulation,
): { position: Float64Array; orientation: Float64Array } | undefined {
  const frames = capturedFrames();
  if (frames <= 0) return undefined;
  const tick = Playback.tickOf(playback.clampedFrame(frames), sim.ticksPerOutputFrame);
  return playback.bonesAt(sim.capture, tick);
}

/**
 * The bellies for the frame the playhead is on, rebuilt from the ring recording.
 *
 * Path polylines and tension are not recorded, so `pointCount` is left at zero -- which draws no
 * lines -- and every unit is drawn relaxed. The panel says so.
 */
function replayedMuscles(sim: Simulation) {
  const volume = sim.muscleVolume;
  const units = sim.muscles?.units.length ?? 0;
  const live = sim.muscleMesh();
  const frames = capturedFrames();
  if (!volume || !live || units === 0 || frames <= 0) return undefined;
  const tick = Playback.tickOf(playback.clampedFrame(frames), sim.ticksPerOutputFrame);
  // The bone capture is a frame a tick and the ring capture a frame a sweep, so the bone frame's
  // tick is looked up among the sweeps: the newest at or before it is the belly that was showing.
  const mesh = playback.bellyAt(
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
    tension: playback.units(units),
    mesh,
  };
}

/** Zero lengths for every unit's polyline, grown once. */
let emptyCounts = new Int32Array(0);
function emptyPointCounts(units: number): Int32Array {
  if (emptyCounts.length !== units) emptyCounts = new Int32Array(units);
  return emptyCounts;
}

/** Scratch for the tension fractions, grown once to fit whatever set is running. */
let tensionScratch = new Float64Array(0);
function muscleTension(
  force: ArrayLike<number>,
  units: readonly { readonly parameters: { readonly maxIsometricForce: number } }[],
): Float64Array {
  if (tensionScratch.length !== units.length) tensionScratch = new Float64Array(units.length);
  for (let i = 0; i < units.length; i++) {
    const maximum = units[i]?.parameters.maxIsometricForce ?? 1;
    tensionScratch[i] = maximum > 0 ? (force[i] ?? 0) / maximum : 0;
  }
  return tensionScratch;
}

/**
 * Push the live controls into the running simulation. Safe before a run, and on change.
 *
 * The output frame rate is live because it only says how much simulated time one rendered frame
 * covers. The step rate is not here, and cannot be: `dt` is fixed for the life of a run, which is
 * what makes two runs of a scenario the same run, so changing it restarts.
 */
function applyFidelity(sim: Simulation | null | undefined): void {
  if (!sim) return;
  sim.outputFramerate = Number(ui.outputFramerate.value);
  sim.captureBudgetBytes = Number(ui.captureBudget.value) * 1024 * 1024;
}

const MEBIBYTE = 1024 * 1024;

/** The slider's own reading, and the sentence under it that says where its top end came from. */
function showCaptureBudget(): void {
  const mib = Number(ui.captureBudget.value);
  must<HTMLOutputElement>('#captureBudget-value').textContent =
    mib >= 1024 ? `${(mib / 1024).toFixed(1)} GB` : `${mib} MB`;
}

/**
 * Fit the slider to this machine and start it where a fresh simulation would.
 *
 * The range is the platform's answer rather than a guess: `captureCeilingBytes` reads the tab's
 * heap limit where the runtime reports one and falls back to `navigator.deviceMemory`, and the
 * default is a fifth of it (`defaultCaptureBudgetBytes`: the export needs about five copies live
 * at once). Done once at startup, because neither number changes.
 */
function sizeCaptureBudget(): void {
  const ceiling = Math.floor(captureCeilingBytes() / MEBIBYTE);
  const step = Number(ui.captureBudget.step) || 32;
  ui.captureBudget.max = String(Math.max(step, Math.floor(ceiling / step) * step));
  ui.captureBudget.min = String(Math.floor(MIN_CAPTURE_BUDGET_BYTES / MEBIBYTE));
  ui.captureBudget.value = String(
    Math.min(Number(ui.captureBudget.max), Math.round(defaultCaptureBudgetBytes() / MEBIBYTE)),
  );
  showCaptureBudget();
}
sizeCaptureBudget();
ui.captureBudget.addEventListener('input', () => {
  showCaptureBudget();
  applyFidelity(simulation);
});

/** Whether the step rate has been set by hand, so a new run does not overwrite the choice. */
let fidelityTouched = false;
ui.outputFramerate.addEventListener('input', () => {
  showRates();
  applyFidelity(simulation);
});
ui.stepsPerSecond.addEventListener('input', () => {
  fidelityTouched = true;
  showRates();
});
// Once at startup, so the pair reads as a pair before anyone has touched either or started a run.
showRates();

/**
 * What the two rates come to together, in the terms somebody exporting cares about.
 *
 * Three things, because three things follow from the pair and none of them is obvious from either
 * alone: how many keyframes land inside one output frame, how long a second of run is on the
 * timeline (always a second, and saying so is the point), and how far the simulation moves per
 * rendered frame, which is what playback speed actually is here.
 */
function showRates(): void {
  const fps = Number(ui.outputFramerate.value);
  const steps = Number(ui.stepsPerSecond.value);
  must<HTMLOutputElement>('#outputFramerate-value').textContent = `${fps} fps`;
  must<HTMLOutputElement>('#stepsPerSecond-value').textContent = `${steps}`;
  const perFrame = steps / Math.max(1, fps);
  const running = simulation?.stepsPerSecond;
  const pending =
    running !== undefined && running !== steps
      ? ` · running at ${running}; restart to use ${steps}`
      : '';
  must<HTMLElement>('#rate-note').textContent =
    `${perFrame === Math.round(perFrame) ? perFrame : perFrame.toFixed(2)} steps a frame, ` +
    `${steps} keyframes a second of timeline, ${fps} frames a second of timeline${pending}.`;
}

/** Push every slider into the drive module. Safe to call before a run, and on every change. */
function applyMuscleDrive(sim: Simulation | null | undefined): void {
  const drive = sim?.muscleDrive;
  if (!drive) return;
  for (const group of MUSCLE_GROUPS) {
    const level = driveForSlider(Number(driveInputs.get(group.id)?.value ?? 0));
    for (const unit of group.units) drive.setOverride(unit, level);
  }
}

/**
 * The body sections the drive groups fall into, in the order the table first names them: the
 * readout's section rows, and the `section.*` keys the headset is sent.
 */
const DRIVE_SECTIONS: readonly DriveSection[] = [...new Set(MUSCLE_GROUPS.map((g) => g.section))];
/** Each group's section, as an index into `DRIVE_SECTIONS`, resolved once. */
const SECTION_OF_GROUP = Int8Array.from(MUSCLE_GROUPS, (g) => DRIVE_SECTIONS.indexOf(g.section));
/**
 * The four groups the headset's two old rows are about -- elbow and knee, flexors against
 * extensors -- resolved once rather than looked up by id every frame. Those rows stay on the wire
 * until the headset's panel reads the section rows instead; see `muscleReadoutText`.
 */
const PAIR_GROUPS = (
  ['flexorDrive', 'extensorDrive', 'kneeFlexorDrive', 'kneeExtensorDrive'] as const
).map((id) => MUSCLE_GROUPS.findIndex((g) => g.id === id));

/**
 * What the muscles are pulling with, as numbers: every drive group, every body section, and the
 * three counts under them.
 *
 * Data first, so that the desktop's readout and the headset's are the same reading rather than
 * the headset scraping text back off the desktop's page -- which it used to, and which went on
 * sending the last run's numbers after the run had gone, because nothing cleared the text.
 *
 * "Loaded" counts the units whose tendon is carrying anything at all. It earned its place when
 * three of the seven were not: their straight-line paths were shorter than their own resting
 * length, so the tendon never took up. Via points fixed that and the count now reads full at rest,
 * which is exactly why it is worth keeping on screen. Both sides are counted together, as the
 * sliders drive them.
 */
interface MuscleReadout {
  /** Units in the run. */
  units: number;
  /** Tendon force summed over each drive group's units, newtons, in `MUSCLE_GROUPS` order. */
  readonly groupForce: Float64Array;
  /** The same summed over each section's groups, in `DRIVE_SECTIONS` order. */
  readonly sectionForce: Float64Array;
  loaded: number;
  /** Tendons in contact with a bone: bent over a surface rather than cutting through it. */
  contacts: number;
  /** Units whose equilibrium did not solve cleanly, so the force read for them is a fallback. */
  strained: number;
}

/** The readout the frame loop last took, or null with no run or no muscles in it. */
let muscleReadout: MuscleReadout | null = null;
/** The one readout every frame fills, so taking it allocates nothing. */
const readoutScratch: MuscleReadout = {
  units: 0,
  groupForce: new Float64Array(MUSCLE_GROUPS.length),
  sectionForce: new Float64Array(DRIVE_SECTIONS.length),
  loaded: 0,
  contacts: 0,
  strained: 0,
};
/**
 * Each unit's drive group, as an index into `MUSCLE_GROUPS` or -1 for a unit in none, built once
 * a run and kept by the identity of that run's unit list. The table lists groups by unit id; the
 * readout used to ask every group whether it held every unit, every frame -- thirty-five
 * `includes` over a handful of ids for each of 272 units, sixty times a second.
 */
let unitGroups: { units: readonly { readonly id: string }[]; group: Int16Array } | undefined;
function groupOfUnits(units: readonly { readonly id: string }[]): Int16Array {
  if (unitGroups?.units !== units) {
    const byId = new Map<string, number>();
    MUSCLE_GROUPS.forEach((group, at) => {
      for (const id of group.units) byId.set(id, at);
    });
    unitGroups = { units, group: Int16Array.from(units, (u) => byId.get(u.id) ?? -1) };
  }
  return unitGroups.group;
}

/**
 * Take the readout off the run's newest tick, in one pass over the units, into the scratch
 * readout. Null when the run has no muscles or they have not published yet.
 *
 * Summed per driven group, and nothing outside one is counted. Before the shoulder set arrived
 * "not a flexor" meant "an extensor"; now it would mean the deltoid too, and the readout would
 * say a hanging arm's extensors were pulling ten kilonewtons.
 */
function muscleReadoutOf(sim: Simulation): MuscleReadout | null {
  const state = sim.muscleState();
  const units = sim.muscles?.units;
  if (!state || !units) return null;
  const group = groupOfUnits(units);
  const out = readoutScratch;
  out.groupForce.fill(0);
  out.sectionForce.fill(0);
  let loaded = 0;
  let strained = 0;
  for (let i = 0; i < units.length; i++) {
    const force = state.tendonForce[i] ?? 0;
    if (force > 0) loaded++;
    if ((state.diagnostic[i] ?? 0) !== 0) strained++;
    const at = group[i] as number;
    if (at >= 0) out.groupForce[at] = (out.groupForce[at] as number) + force;
  }
  for (let at = 0; at < MUSCLE_GROUPS.length; at++) {
    const section = SECTION_OF_GROUP[at] as number;
    if (section >= 0) {
      out.sectionForce[section] =
        (out.sectionForce[section] as number) + (out.groupForce[at] as number);
    }
  }
  out.units = units.length;
  out.loaded = loaded;
  out.strained = strained;
  out.contacts = sim.musclePath?.contactCount ?? 0;
  return out;
}

const newtons = (force: number) => `${force.toFixed(0)} N`;
const loadedText = (r: MuscleReadout) => `${r.loaded} of ${r.units} units`;
const wrappingText = (r: MuscleReadout) => `${r.contacts} contact${r.contacts === 1 ? '' : 's'}`;
const strainedText = (r: MuscleReadout) =>
  r.strained === 0 ? 'none' : `${r.strained} of ${r.units} units`;

/**
 * The readout as the headset's panel is sent it: text by key, the keys a `HashMap` on the Rust
 * side, so adding one changes no protocol type.
 *
 * The section rows and the three counts are what the desktop shows. `flexion` and `extension`
 * are the elbow and knee rows the desktop used to show and the headset still draws, so they are
 * kept on the wire, from the same numbers, until the headset reads the section rows instead.
 * With no readout the map is empty and the headset shows its dashes.
 */
function muscleReadoutText(r: MuscleReadout | null): Record<string, string> {
  if (!r) return {};
  const force = (at: number | undefined) =>
    at !== undefined && at >= 0 ? (r.groupForce[at] as number) : 0;
  const pair = (flex: number | undefined, extend: number | undefined) =>
    `${force(flex).toFixed(0)} / ${force(extend).toFixed(0)} N`;
  const text: Record<string, string> = {};
  DRIVE_SECTIONS.forEach((section, at) => {
    text[`section.${section.toLowerCase()}`] = newtons(r.sectionForce[at] as number);
  });
  text.loaded = loadedText(r);
  text.wrapping = wrappingText(r);
  text.strained = strainedText(r);
  text.flexion = pair(PAIR_GROUPS[0], PAIR_GROUPS[1]);
  text.extension = pair(PAIR_GROUPS[2], PAIR_GROUPS[3]);
  return text;
}

// The section rows, made from the same table as the sliders and put above the three counts.
const sectionReadouts: HTMLElement[] = [];
{
  const list = must<HTMLElement>('#muscle-readout');
  const first = list.firstElementChild;
  for (const section of DRIVE_SECTIONS) {
    const term = window.document.createElement('dt');
    term.textContent = section;
    term.title =
      `Tendon force summed over every drive group in the ${section.toLowerCase()} section, ` +
      'both sides';
    const value = window.document.createElement('dd');
    value.id = `muscle-section-${section.toLowerCase()}`;
    value.textContent = '—';
    list.insertBefore(term, first);
    list.insertBefore(value, first);
    sectionReadouts.push(value);
  }
}
/** Each slider's force readout, in `MUSCLE_GROUPS` order, found once. */
const groupReadouts = MUSCLE_GROUPS.map((g) => must<HTMLElement>(`#${g.id}-force`));
/**
 * The whole newtons each row last showed, so a row's text is made and written only when the
 * number on it changes: forty rows of formatting sixty times a second was most of what the
 * readout cost, and most frames change few of them. NaN is "shows a dash", which no reading is.
 */
const shownGroupForce = new Float64Array(MUSCLE_GROUPS.length).fill(Number.NaN);
const shownSectionForce = new Float64Array(DRIVE_SECTIONS.length).fill(Number.NaN);
/** Loaded, contacts, strained and units, as last shown. */
const shownCounts = new Float64Array(4).fill(Number.NaN);

/** Write one row's newtons, when the whole number on it has changed. */
function showForce(element: HTMLElement, force: number, shown: Float64Array, at: number): void {
  const rounded = Math.round(force);
  if (shown[at] === rounded) return;
  shown[at] = rounded;
  element.textContent = newtons(rounded);
}

/** What the muscles are pulling with, on the Muscles tab and beside each slider. */
function updateMuscles(sim: Simulation): void {
  const r = muscleReadoutOf(sim);
  if (!r) {
    clearMuscleReadout();
    return;
  }
  muscleReadout = r;
  for (let at = 0; at < groupReadouts.length; at++) {
    showForce(groupReadouts[at] as HTMLElement, r.groupForce[at] as number, shownGroupForce, at);
  }
  for (let at = 0; at < sectionReadouts.length; at++) {
    const element = sectionReadouts[at] as HTMLElement;
    showForce(element, r.sectionForce[at] as number, shownSectionForce, at);
  }
  if (shownCounts[0] !== r.loaded || shownCounts[3] !== r.units) {
    must<HTMLElement>('#muscle-loaded').textContent = loadedText(r);
  }
  // How many tendons are in contact with a bone right now. A muscle that is wrapping has its
  // path bent over a surface rather than cutting through it, so this is also the quickest way to
  // tell whether the overlay's curves are curves.
  if (shownCounts[1] !== r.contacts) {
    must<HTMLElement>('#muscle-wrapping').textContent = wrappingText(r);
  }
  // Units whose equilibrium did not solve cleanly. It is on screen rather than in a log because
  // it is the one number that says "the force you are reading is a fallback": a muscle whose path
  // is longer than its parameters expect sits at the top of its tendon curve, where the model
  // holds it rather than extrapolating, and the force it reports is the cap.
  if (shownCounts[2] !== r.strained || shownCounts[3] !== r.units) {
    must<HTMLElement>('#muscle-strained').textContent = strainedText(r);
  }
  shownCounts[0] = r.loaded;
  shownCounts[1] = r.contacts;
  shownCounts[2] = r.strained;
  shownCounts[3] = r.units;
}

/**
 * No readout: dashes on every row and nothing beside the sliders. For no run, a run without
 * muscles, and a followed bridge, none of which this page can read muscles off -- where the
 * readout used to go on showing the last run's numbers, to the page and to the headset.
 */
function clearMuscleReadout(): void {
  if (muscleReadout === null && Number.isNaN(shownCounts[3] as number)) return;
  muscleReadout = null;
  shownGroupForce.fill(Number.NaN);
  shownSectionForce.fill(Number.NaN);
  shownCounts.fill(Number.NaN);
  for (const element of groupReadouts) element.textContent = '';
  for (const element of sectionReadouts) element.textContent = '—';
  for (const id of ['#muscle-loaded', '#muscle-wrapping', '#muscle-strained']) {
    must<HTMLElement>(id).textContent = '—';
  }
}

/**
 * The Run tab's diagnostics and the Muscles tab's readout, from the run's newest tick.
 *
 * `live` is whether the picture is that tick. Off the live edge the picture is a recorded frame
 * and these are not -- nothing records energies, stops, contacts or tendon forces -- so the
 * readouts stay, because they are still true of the run, but dim and say which frame they are
 * of. Before, they went on reading as though they were measurements of the replayed pose.
 */
function updateDiagnostics(sim: Simulation, live: boolean): void {
  showReadoutsLive(sim, live);
  const energy = sim.channel('diagnostics.energy').fields;
  const limits = sim.channel('diagnostics.limits').fields;
  const contacts = sim.channel('contact.manifolds');
  let worst = 0;
  let violations = 0;
  const proximity = limits.proximity as Float64Array;
  const violation = limits.violation as Uint8Array;
  for (let i = 0; i < proximity.length; i++) {
    worst = Math.max(worst, proximity[i] ?? 0);
    violations += violation[i] ?? 0;
  }
  must<HTMLElement>('#diag-kinetic').textContent =
    `${((energy.kinetic as Float64Array)[0] ?? 0).toFixed(1)} J`;
  must<HTMLElement>('#diag-potential').textContent =
    `${((energy.potential as Float64Array)[0] ?? 0).toFixed(1)} J`;
  must<HTMLElement>('#diag-drift').textContent =
    `${(((energy.drift as Float64Array)[0] ?? 0) * 1000).toFixed(1)} mm`;
  must<HTMLElement>('#diag-limits').textContent =
    violations > 0 ? `${violations} past a stop` : `${Math.round(worst * 100)}% of range`;
  must<HTMLElement>('#diag-contacts').textContent =
    sim.physics.contactsSeen > contacts.count
      ? `${contacts.count} shown of ${sim.physics.contactsSeen}`
      : String(contacts.count);
  // How fast simulated time is coming out, against how finely it is divided. Below the step rate
  // means the run is taking longer in wall-clock seconds than the time it covers -- not that
  // anything was skipped, because nothing is: every step is taken and every step is captured.
  const declared = sim.declaredRateHz;
  const achieved = sim.achievedRateHz;
  // Paused, nothing is being produced, and the last half-second's rate would read as though it
  // still were.
  must<HTMLElement>('#diag-rate').textContent = sim.paused
    ? `${declared.toFixed(0)} Hz steps · paused`
    : achieved > 0
      ? `${achieved.toFixed(0)} Hz of ${declared.toFixed(0)} steps · ${(achieved / declared).toFixed(2)}x life`
      : `${declared.toFixed(0)} Hz steps`;
  // The solver's own resets: MuJoCo puts the body back at its reference after a bad acceleration,
  // and the run pauses at the first so it cannot carry on as if it had just begun.
  const resets = sim.physics.backendResets;
  setText(
    must<HTMLElement>('#diag-resets'),
    resets === 0
      ? 'none'
      : `${resets}${sim.divergedAt === undefined ? '' : `, first at ${(sim.divergedAt * sim.dt).toFixed(3)} s`}`,
  );
  updateMuscles(sim);
}

/**
 * Dim the newest-tick readouts and say so while the playhead is off the live edge; undo both at
 * it. Cheap to call every frame: nothing is written unless it changes.
 */
function showReadoutsLive(sim: Simulation | null, live: boolean): void {
  const stale = sim !== null && !live;
  must<HTMLElement>('#diagnostics').classList.toggle('stale', stale);
  must<HTMLElement>('#muscle-readout').classList.toggle('stale', stale);
  must<HTMLElement>('#muscle-drives').classList.toggle('forces-stale', stale);
  const caption = stale
    ? `Readings are at the newest frame (t = ${((sim?.ticks ?? 0) * (sim?.dt ?? 0)).toFixed(2)} s), not the replayed one.`
    : '';
  for (const id of ['#readout-note', '#muscle-readout-note']) {
    const note = must<HTMLElement>(id);
    setText(note, caption);
    if (note.hidden !== !stale) note.hidden = !stale;
  }
}

ui.muscles.addEventListener('change', () => {
  must<HTMLElement>('#muscle-control').hidden = !ui.muscles.checked;
  // The modules are registered when a run starts, so turning this on mid-run changes nothing
  // until the next one. Saying so beats a checkbox that appears to do nothing.
  if (simulation && ui.muscles.checked && !simulation.muscles) {
    announce('Muscles start with the next run.');
  }
});
// Explanatory text is off by default: the panel has thirteen paragraphs and a reader wants at
// most one of them at a time. The notes that carry a live value are marked `live` and stay.
// The brain panel is made once the follow code below exists; runs read its setup when they start.
// biome-ignore lint/style/useConst: assigned once, but below the code that reads it, so a `const` there would be in its dead zone for the handlers above.
let brain: ReturnType<typeof createBrainPanel> | undefined;
// biome-ignore lint/style/useConst: as above -- assigned once, below the handlers that read it.
let align: AlignPanel | undefined;

// --- The editors' chrome: tabs, what the page remembers, the overlays popover ------------------
const memory = createMemory();
const tabs = createTabs(must<HTMLElement>('#tabs'), must<HTMLElement>('#panels'), memory, 'body');
createResizer(must<HTMLElement>('#properties-resizer'), memory);
for (const [input, key] of [
  [ui.showNotes, 'notes'],
  [ui.showGrid, 'grid'],
  [ui.spin, 'turntable'],
  [ui.showProxies, 'overlay.proxies'],
  [ui.showAxes, 'overlay.axes'],
  [ui.showCom, 'overlay.com'],
  [ui.showContacts, 'overlay.contacts'],
  [ui.showTissue, 'overlay.tissue'],
  [ui.showMuscles, 'overlay.muscles'],
  [ui.showMuscleVolumes, 'overlay.muscleVolumes'],
] as const) {
  memory.checkbox(input, key);
}
for (const panel of window.document.querySelectorAll<HTMLDetailsElement>('details.panel')) {
  const key = panel
    .querySelector('summary')
    ?.textContent?.trim()
    .toLowerCase()
    .replace(/\W+/g, '-');
  if (key) memory.details(panel, `panel.${key}`);
}
{
  const button = must<HTMLButtonElement>('#overlays-button');
  const popover = must<HTMLElement>('#overlays-popover');
  const open = (on: boolean) => {
    popover.hidden = !on;
    button.setAttribute('aria-expanded', String(on));
  };
  button.addEventListener('click', () => open(popover.hidden));
  window.document.addEventListener('pointerdown', (event) => {
    if (popover.hidden) return;
    const target = event.target as Node;
    if (!popover.contains(target) && !button.contains(target)) open(false);
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') open(false);
  });
}

// Keyboard, as the reference has it: Space for the transport, arrows for a frame, Home for live,
// the numbers for the views, and F to frame the body from where the camera already is. A focused
// control keeps the keys it acts on -- Space on a checkbox toggles it, the arrows move a slider --
// and gives the rest to these.
window.addEventListener('keydown', (event) => {
  // Space on Start or Pause is the transport, not the button. The button would otherwise take it
  // as a press, and a press of Start on a live run is Restart: after a mouse click on Start,
  // focus stayed on it, and the Space meant to pause threw the run away instead.
  if (event.key === ' ' && (event.target === ui.simStart || event.target === ui.simPause)) {
    event.preventDefault();
    if (!event.repeat) toggleTransport();
    return;
  }
  if (keyOwnedByTarget(event.target, event.key)) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  switch (event.key) {
    case ' ':
      event.preventDefault();
      // Held down, Space repeats; a transport that toggled at the key-repeat rate would flicker
      // between paused and running and land wherever the finger happened to lift.
      if (event.repeat) return;
      toggleTransport();
      break;
    case 'ArrowLeft':
      if (!ui.frameBack.disabled) ui.frameBack.click();
      break;
    case 'ArrowRight':
      if (!ui.frameForward.disabled) ui.frameForward.click();
      break;
    case 'Home':
      if (!ui.goLive.disabled) ui.goLive.click();
      break;
    case '1':
      window.document.querySelector<HTMLButtonElement>('[data-view="front"]')?.click();
      break;
    case '3':
      window.document.querySelector<HTMLButtonElement>('[data-view="left"]')?.click();
      break;
    case '7':
      window.document.querySelector<HTMLButtonElement>('[data-view="three-quarter"]')?.click();
      break;
    case '9':
      window.document.querySelector<HTMLButtonElement>('[data-view="back"]')?.click();
      break;
    case 'f':
    case 'F':
      frameBody();
      break;
    default:
      return;
  }
});
// A button activates on Space's release, so the keydown above is not enough on its own to keep
// Start from being pressed by the Space that paused the run.
window.addEventListener('keyup', (event) => {
  if (event.key === ' ' && (event.target === ui.simStart || event.target === ui.simPause)) {
    event.preventDefault();
  }
});

ui.showNotes.addEventListener('change', () => {
  document.body.classList.toggle('notes', ui.showNotes.checked);
});

for (const slider of driveInputs.values()) {
  slider.addEventListener('input', () => {
    const level = driveForSlider(Number(slider.value));
    must<HTMLElement>(`#${slider.id}-value`).textContent =
      level > 0 && level < 0.01 ? `${(level * 100).toFixed(1)}%` : `${Math.round(level * 100)}%`;
    applyMuscleDrive(simulation);
  });
}

/**
 * Give focus back to the page after a mouse click on a transport or view button.
 *
 * A clicked button keeps focus, and a focused button owns Space and Enter; left there, the next
 * Space would press the button again rather than reach the transport. A keyboard activation has a
 * `detail` of zero and keeps its focus, so somebody tabbing through the buttons stays where they
 * are.
 */
function blurAfterMouse(event: MouseEvent): void {
  if (event.detail > 0) (event.currentTarget as HTMLElement | null)?.blur();
}

/** Stop computing, keeping everything computed. */
function pause(): void {
  if (!simulation) return;
  releaseMouseGrab(simulation);
  simulation.paused = true;
  setRunControls(true);
}

/**
 * Carry the run on from its newest frame, which is live again; nothing to do for a run that is
 * already live and running. The tick rate starts a fresh reading, so the first one after a pause
 * is of the run going again rather than half of it from before the pause.
 */
function resume(): void {
  if (!simulation || (!simulation.paused && following)) return;
  simulation.paused = false;
  simulation.resetRateWindow();
  goLive();
}

/**
 * What Space does: pause a live run, carry a paused one on, start one when there is none.
 *
 * Never a restart, which is only ever a deliberate press of the Restart button, and nothing at
 * all while following the bridge: the body on screen is somebody else's run, and Space used to
 * start one of this page's own over it and end the follow.
 */
function toggleTransport(): void {
  // Nor while a run is compiling: the start in flight is the answer to the last press.
  if (bridgeFollower.active || runGate.busy) return;
  if (simulation && !simulation.paused) pause();
  else startOrResume();
}

/** Carry a run on, or start one when there is none; never a restart. */
function startOrResume(): void {
  if (bridgeFollower.active || runGate.busy) return;
  if (simulation) resume();
  else void startSimulation();
}

ui.simStart.addEventListener('click', (event) => {
  blurAfterMouse(event);
  // Paused mid-run, or scrubbed back into it: carry on from the newest frame rather than
  // throwing the run away. Anything else starts a fresh one with the settings as they stand.
  if (simulation && (simulation.paused || !following)) {
    resume();
    return;
  }
  void startSimulation();
});
ui.simPause.addEventListener('click', (event) => {
  blurAfterMouse(event);
  pause();
});
ui.reset.addEventListener('click', (event) => {
  blurAfterMouse(event);
  if (!simulation) return;
  simulation.reset();
  simulation.paused = true;
  goLive();
});
// Gravity can go off mid-flight: the body keeps whatever motion it had and coasts.
ui.gravity.addEventListener('change', () => {
  simulation?.setGravity(ui.gravity.checked);
});
// The floor likewise: the grid stays drawn, the body falls through it.
ui.floor.addEventListener('change', () => {
  simulation?.setGroundCollision(ui.floor.checked);
});
ui.grabStrength.addEventListener('input', () => {
  must<HTMLOutputElement>('#grabStrength-value').textContent =
    `${Number(ui.grabStrength.value).toFixed(1)}\u00d7`;
});
// Ctrl-click is the secondary click on some platforms; the canvas would rather have the drag.
renderer.domElement.addEventListener('contextmenu', (event) => {
  if (event.ctrlKey) event.preventDefault();
});
/**
 * Whether a Ctrl-press on the body would take hold of it: only a run of this page's own, computing
 * and at the live edge. Paused, the pull would be applied to nothing until the run carried on, and
 * then all at once; scrubbed back, it would pull the live body from a pose that is not on screen.
 */
function canReach(): boolean {
  return simulation !== null && !simulation.paused && following && !bridgeFollower.active;
}
// The cursor says whether a press will reach into the scene or move around it.
const setReachCursor = (reaching: boolean) => {
  renderer.domElement.style.cursor = reaching && canReach() ? 'grab' : '';
};
window.addEventListener('keydown', (event) => {
  if (event.key === 'Control') setReachCursor(true);
});
window.addEventListener('keyup', (event) => {
  if (event.key === 'Control') setReachCursor(false);
});
window.addEventListener('blur', () => setReachCursor(false));

ui.dropHeight.addEventListener('input', () => {
  must<HTMLOutputElement>('#dropHeight-value').textContent =
    `${Number(ui.dropHeight.value).toFixed(2)} m`;
});
for (const d of SCENARIO_DEFINITIONS) {
  const option = window.document.createElement('option');
  option.value = d.id;
  option.textContent = d.title;
  ui.scenario.appendChild(option);
}
// Standing, rather than the bare drop this opened with for the whole of phase one. A muscle
// module's front page should show muscles doing something, and the tone a quietly standing
// person holds is the one posture everybody already knows the look of.
ui.scenario.value = DEFAULT_SCENARIO;

/**
 * Parameter values the sliders are currently showing, per scenario.
 *
 * Kept here rather than read off the inputs so that switching scenarios and coming back keeps
 * what was set, and so a saved session can carry the values.
 */
const scenarioValues = new Map<string, Record<string, number>>();

function definitionFor(id: string): ScenarioDefinition | undefined {
  return SCENARIO_DEFINITIONS.find((d) => d.id === id);
}

/** Build the chosen scenario at the values its sliders are showing. */
function currentScenario() {
  const definition = definitionFor(ui.scenario.value);
  return definition?.build(scenarioValues.get(definition.id));
}

/** Draw a slider per parameter of the chosen scenario, or nothing when none is chosen. */
function refreshScenarioParameters(): void {
  const definition = definitionFor(ui.scenario.value);
  ui.scenarioParameters.replaceChildren();
  if (!definition) return;
  const values = scenarioValues.get(definition.id) ?? {};
  for (const p of definition.parameters) {
    const value = values[p.id] ?? p.value;
    values[p.id] = value;
    const control = window.document.createElement('div');
    control.className = 'control';
    const label = window.document.createElement('label');
    label.htmlFor = `scenario-${p.id}`;
    const readout = window.document.createElement('output');
    const show = (v: number) => {
      readout.textContent = `${p.step >= 1 ? v.toFixed(0) : v.toFixed(2)}${p.unit}`;
    };
    label.append(`${p.label} `, readout);
    const input = window.document.createElement('input');
    input.type = 'range';
    input.id = `scenario-${p.id}`;
    input.min = String(p.min);
    input.max = String(p.max);
    input.step = String(p.step);
    input.value = String(value);
    show(value);
    input.addEventListener('input', () => {
      const next = Number(input.value);
      values[p.id] = next;
      show(next);
    });
    control.append(label, input);
    ui.scenarioParameters.append(control);
  }
  scenarioValues.set(definition.id, values);
}

function scenarioChanged(): void {
  const definition = definitionFor(ui.scenario.value);
  must<HTMLElement>('#scenario-note').textContent = definition?.description ?? '';
  must<HTMLElement>('#dropHeight-control').hidden = definition !== undefined;

  refreshScenarioParameters();
  const chosen = currentScenario();
  if (chosen) ui.passive.checked = chosen.passiveJoints;
  // A scenario that drives muscles turns them on, and says so by ticking the box rather than
  // leaving the panel claiming they are off while the arms move.
  if (chosen?.muscles === true) {
    ui.muscles.checked = true;
    must<HTMLElement>('#muscle-control').hidden = false;
  }
}
ui.scenario.addEventListener('change', scenarioChanged);
// Once at startup, because the picker opens on a scenario rather than on nothing and the note,
// the sliders and the muscle box all follow from which one that is.
scenarioChanged();
/**
 * Write a file and say what happened, because in the desktop shell it can fail.
 *
 * A browser download cannot be refused and cannot report anything; a native save dialog can be
 * cancelled and a native write can hit a full disk or a read-only directory. Both of those used
 * to be silent -- the button did nothing and the panel said nothing, which is indistinguishable
 * from the button being broken.
 *
 * Resolves true when the file was written, and false when it was cancelled or failed, so a
 * caller that keeps track of unsaved work -- the Align tab -- knows whether it still has some.
 */
async function saving(what: string, write: Promise<boolean>): Promise<boolean> {
  try {
    if (await write) {
      announce(`Wrote ${what}.`);
      return true;
    }
    return false;
  } catch (error) {
    console.error(`Writing ${what} failed.`, error);
    announce(`Writing ${what} failed: ${messageOf(error)}`, {
      error: true,
    });
    return false;
  }
}

/**
 * The sampled recording's part of the capture status: how much of the run it holds and what it
 * costs, and when it has stopped, the same promise the captures make -- what is held is kept and
 * still exports.
 */
function recordingStatus(sim: Simulation): string {
  const samples = sim.recording.samples;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = first && last ? last.time - first.time : 0;
  const size = `${(sim.recordingBytes / MEBIBYTE).toFixed(0)} MB`;
  return (
    ` The recording holds ${span.toFixed(2)} s, ${size}` +
    (sim.recordingStopped
      ? ` — the budget reached at ${(last?.time ?? 0).toFixed(2)} s; the ${samples.length} ` +
        'samples held are kept and still export.'
      : '.')
  );
}

/** Megabytes, to one decimal place: an export's size, as the event line reports it. */
function megabytes(bytes: number): string {
  return `${(bytes / MEBIBYTE).toFixed(1)} MB`;
}

ui.exportRecording.addEventListener('click', async () => {
  if (!simulation || exporting) return;
  const sim = simulation;
  exporting = true;
  setRunControls(true);
  const name = `bs-humany-${sim.recording.scenario}-${sim.backendId}.json`;
  try {
    // The string is made inside the write, so that the RangeError a very long recording used to
    // throw here -- before `saving` could see it -- is reported as a failed write like any other.
    await saving(name, (async () => download(name, sim.exportRecording()))());
  } finally {
    exporting = false;
    setRunControls(simulation !== null);
  }
});
ui.exportBlender.addEventListener('click', async () => {
  if (!simulation || !assets || exporting) return;
  const sim = simulation;
  const pack = assets;
  exporting = true;
  setRunControls(true);
  announce('Exporting for Blender\u2026');
  try {
    // Let the grey button and the message paint before the build takes the page for seconds.
    await paintYield();
    const began = performance.now();
    const built = buildBlenderExport(sim, document_, pack);
    const seconds = (performance.now() - began) / 1000;
    // All three together, because none is any use without the others: the glTF holds the bones
    // and the belly mesh, the cache holds the bellies' movement, and the script is what wires the
    // one to the other. One folder in the desktop shell; three downloads in a browser, which is
    // all a page can do.
    const files = [
      { name: built.glbFileName, bytes: built.glb, type: 'model/gltf-binary' },
      ...(built.pointCache
        ? [
            {
              name: built.pointCache.name,
              bytes: built.pointCache.bytes,
              type: 'application/octet-stream',
            },
          ]
        : []),
      {
        name: built.scriptFileName,
        bytes: new TextEncoder().encode(built.script),
        type: 'text/x-python',
      },
    ];
    const size = files.reduce((total, file) => total + file.bytes.length, 0);
    await saving(
      `${files.length} files for Blender, ${megabytes(size)}, built in ${seconds.toFixed(1)} s`,
      downloadSet(files),
    );
  } catch (error) {
    console.error('Building the Blender export failed.', error);
    announce(`The Blender export failed: ${messageOf(error)}`, { error: true });
  } finally {
    exporting = false;
    setRunControls(simulation !== null);
  }
});
ui.save.addEventListener('click', () => {
  const file: SessionFile = {
    format: 'bs-humany.session/1',
    savedAt: new Date().toISOString(),
    settings: currentSettings(),
    ...(simulation
      ? {
          simulation: {
            ticks: simulation.ticks,
            snapshot: serializeSnapshot(simulation.snapshot()),
          },
        }
      : {}),
  };
  void saving('bs-humany-session.json', download('bs-humany-session.json', JSON.stringify(file)));
});
/** Apply a session file's contents, whichever picker they came through. */
async function loadSessionText(text: string): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isSessionFile(parsed)) throw new Error('Not a bs-humany session file.');
    // A session with a run in it starts that run. Stopped first, so the settings going in do not
    // carry the old run across into a restart of their own that the snapshot then races.
    if (parsed.simulation) stopSimulation();
    applySettings(parsed.settings);
    if (parsed.simulation) await startSimulation(parsed.simulation);
  } catch (error) {
    console.error('The session failed to load.', error);
    announce(`The session failed to load: ${messageOf(error)}`, { error: true });
  }
}

ui.load.addEventListener('click', async () => {
  // The hidden `<input type="file">` is a browser's only way to ask for a file and a web view's
  // no way at all: clicking it there opens nothing. The shell has a dialog instead.
  if (usesNativeFilePickers()) {
    const text = await openTextFile();
    if (text !== undefined) await loadSessionText(text);
    return;
  }
  ui.loadFile.click();
});
ui.loadFile.addEventListener('change', async () => {
  const file = ui.loadFile.files?.[0];
  if (!file) return;
  try {
    await loadSessionText(await file.text());
  } finally {
    ui.loadFile.value = '';
  }
});

/** Validation views (M4.8): the two report scenarios, for the current morphology and profile. */
function showValidation(): void {
  const morphology = resolveMorphology(currentMorphology());
  let compiled: ReturnType<typeof compileArticulation>['articulation'];
  try {
    compiled = compileArticulation(document_, ui.profile.value, morphology).articulation;
  } catch (error) {
    // Both tables say so, rather than go on showing the last body's numbers as though they were
    // this one's -- which is what returning quietly here used to do.
    const why = `Validation unavailable for ${ui.profile.value}: ${messageOf(error)}`;
    const row = `<tbody><tr><td>${escapeHtml(why)}</td></tr></tbody>`;
    must<HTMLTableElement>('#inertia-audit').innerHTML = row;
    must<HTMLTableElement>('#joint-sweep').innerHTML = row;
    return;
  }
  const audit = inertiaAudit(compiled, morphology);
  const inertiaTable = must<HTMLTableElement>('#inertia-audit');
  inertiaTable.innerHTML = `
    <thead><tr><th>Segment</th><th>Mass</th><th>Bones</th><th>CoM height</th><th>Ixx</th><th>Iyy</th><th>Izz</th></tr></thead>
    <tbody>${audit.rows
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.segment)}</td><td>${r.mass.toFixed(3)}</td><td>${r.bones}</td><td>${r.comHeight.toFixed(3)}</td>` +
          `<td>${r.principal[0].toExponential(2)}</td><td>${r.principal[1].toExponential(2)}</td><td>${r.principal[2].toExponential(2)}</td></tr>`,
      )
      .join('')}
      <tr><th>Total</th><td>${audit.totalMass.toFixed(3)}</td><td></td><td>${audit.comHeight.toFixed(3)}</td><td colspan="3">target ${audit.targetMass.toFixed(1)} kg</td></tr>
    </tbody>`;
  const sweep = jointSweep(compiled);
  const sweepTable = must<HTMLTableElement>('#joint-sweep');
  sweepTable.innerHTML = `
    <thead><tr><th>Joint</th><th>Axis</th><th>Range</th><th>At lower</th><th>At upper</th><th>Curve</th></tr></thead>
    <tbody>${sweep
      .map((r) => {
        const peak = Math.max(...r.moments.map((m) => Math.abs(m)), 1e-9);
        const points = r.moments
          .map(
            (m, i) =>
              `${((i / (r.moments.length - 1)) * 60).toFixed(1)},${(10 - (m / peak) * 9).toFixed(1)}`,
          )
          .join(' ');
        return (
          `<tr><td>${escapeHtml(r.joint)}</td><td>${escapeHtml(r.axis)}${r.defaulted ? '*' : ''}</td>` +
          `<td>${r.range[0].toFixed(2)} … ${r.range[1].toFixed(2)}</td><td>${r.atLower.toFixed(1)}</td><td>${r.atUpper.toFixed(1)}</td>` +
          `<td><svg class="sparkline" width="60" height="20" viewBox="0 0 60 20"><polyline fill="none" stroke="#6aa9ff" stroke-width="1" points="${points}"/></svg></td></tr>`
        );
      })
      .join('')}
    </tbody>`;
}
ui.profile.addEventListener('change', showValidation);

// ---------------------------------------------------------------------------------------------
// Grabbing
// ---------------------------------------------------------------------------------------------

let grabState: { pointerId: number; depth: number } | null = null;

/**
 * Pick a bone under the pointer; returns the hit point and bone id, or null.
 *
 * A bone drawn at arm's length is a few pixels wide, and asking the user to hit it exactly makes
 * grabbing feel broken. A miss is retried on a ring of nearby pixels and the nearest of those
 * hits is taken, so a press close to a bone still lands on it. The picker is cheap enough for
 * that to cost nothing worth measuring.
 */
function pickBone(clientX: number, clientY: number): { boneId: string; point: Vector3 } | null {
  if (!skinned) return null;
  const at = (x: number, y: number) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((x - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((y - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    return skinned?.pick(raycaster.ray.origin, raycaster.ray.direction) ?? null;
  };
  const exact = at(clientX, clientY);
  if (exact) return exact;
  let best: { boneId: string; point: Vector3; distance: number } | null = null;
  for (const radius of PICK_RADII) {
    for (let i = 0; i < PICK_RING; i++) {
      const angle = (2 * Math.PI * i) / PICK_RING;
      const hit = at(clientX + radius * Math.cos(angle), clientY + radius * Math.sin(angle));
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    if (best) return best;
  }
  return null;
}

/**
 * Start holding the segment under the pointer, while Ctrl is down and the body is simulating.
 *
 * Ctrl is what separates reaching into the scene from moving around it: without it the drag
 * belongs to the camera, and a body that is only being looked at cannot be knocked over by
 * accident.
 */
function beginGrab(event: PointerEvent): boolean {
  if (!event.ctrlKey || !simulation) return false;
  // Claimed, so the camera does not take the drag either, and said why: a Ctrl-drag that did
  // nothing at all read as grabbing being broken. Not resumed on the person's behalf -- they
  // paused or scrubbed for a reason, and a pull is not a request to throw that away.
  if (simulation.paused || !following) {
    announce(
      following
        ? 'Paused: resume (Space) to pull the body.'
        : 'Scrubbed back: go live and resume to pull the body.',
    );
    return true;
  }
  const picked = pickBone(event.clientX, event.clientY);
  if (!picked) return false;
  const segment = simulation.segmentOfBone(picked.boneId);
  if (segment < 0) return false;
  const pose = simulation.segmentPose(segment);
  // The pick is in the scene; the simulation's frame is the world group's, which a tilted floor
  // has turned. Everything from here is in the simulation's frame.
  const hit = world.worldToLocal(picked.point.clone());
  // Hit point in the segment's own frame: rotate the offset back by the inverse orientation.
  const offset = new Vector3().copy(hit).sub(pose.position as Vector3);
  const inverse = new Quaternion(
    pose.rotation.x,
    pose.rotation.y,
    pose.rotation.z,
    pose.rotation.w,
  ).invert();
  offset.applyQuaternion(inverse);
  simulation.grab.grab(
    segment,
    { x: offset.x, y: offset.y, z: offset.z },
    { x: hit.x, y: hit.y, z: hit.z },
    Number(ui.grabStrength.value),
  );
  grabState = { pointerId: event.pointerId, depth: picked.point.distanceTo(camera.position) };
  try {
    renderer.domElement.setPointerCapture(event.pointerId);
  } catch {
    // A synthetic pointer has no capture; the drag still works while it stays over the canvas.
  }
  selectedBoneId = picked.boneId;
  refreshSelection();
  return true;
}

renderer.domElement.addEventListener('pointermove', (event) => {
  if (!grabState || !simulation || event.pointerId !== grabState.pointerId) return;
  // Keep the target at the depth the grab started at, on the ray under the pointer.
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const target = world.worldToLocal(raycaster.ray.at(grabState.depth, new Vector3()));
  simulation.grab.moveTo({ x: target.x, y: target.y, z: target.z });
});

const endGrab = (event: PointerEvent) => {
  if (!grabState || event.pointerId !== grabState.pointerId) return;
  simulation?.grab.release();
  grabState = null;
};
renderer.domElement.addEventListener('pointerup', endGrab);
renderer.domElement.addEventListener('pointercancel', endGrab);

// ---------------------------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------------------------

let lastFrame = performance.now();
let frameMs = 0;

function animate(): void {
  requestAnimationFrame(animate);

  const now = performance.now();
  const elapsed = now - lastFrame;
  lastFrame = now;
  // Smoothed, because a raw per-frame number is unreadable.
  frameMs += (elapsed - frameMs) * 0.08;

  if (ui.spin.checked) controls.orbit(0.0032);
  controls.update();

  if (!simulation) {
    // Following a publisher, the headset is sent what the desktop follows, relayed on the
    // studio's own bridge; otherwise it is told there is no run.
    if (bridgeFollower.active && vrLink) vrLink.relay(bridgeFollower);
    else vrLink?.idle();
  }
  // The brain panel's picture: this page's policy, or the training showcase's.
  drawNerves(simulation ?? undefined);
  // The cord under it, for a run of this page's own at the live edge only: its drive is a tick
  // wide and nothing records it.
  drawSpine(simulation ?? undefined, following && !bridgeFollower.active);
  // Scenery that moves -- a platform tilting under the body -- drawn where the solver has it.
  if (simulation) followFurniture(simulation);
  if (bridgeFollower.active && skinned) followFrame(skinned);
  if (simulation && skinned) {
    // Everything the run puts on screen, in one guard: whatever in it throws, the run pauses and
    // says so, and the render below still happens. Before, one throw here took the frame loop's
    // render with it every frame after, and the viewport froze on its last picture with nothing
    // on the page saying why.
    try {
      runFrame(simulation, skinned, elapsed);
    } catch (error) {
      frameFailed(simulation, error);
    }
  }

  renderer.render(scene, camera);

  must<HTMLElement>('#stat-frame').textContent = `${frameMs.toFixed(1)} ms`;
  must<HTMLElement>('#stat-draws').textContent = String(renderer.info.render.calls);
}

/** The last message `frameFailed` logged, so a frame that throws every frame logs it once. */
let lastFrameFailure = '';

/**
 * Something in the run's part of the frame threw. Pause the run where it is -- a paused run draws
 * the same frame every frame, which is the likeliest way out of whatever threw -- and say so on
 * the event line, which does not rewrite itself for the same message.
 */
function frameFailed(sim: Simulation, error: unknown): void {
  const message = messageOf(error);
  if (message !== lastFrameFailure) {
    lastFrameFailure = message;
    console.error('Drawing the run failed; the run is paused.', error);
  }
  sim.paused = true;
  announce(
    `Drawing the run failed at ${(sim.ticks * sim.dt).toFixed(3)} s and it is paused: ${message}.`,
    { error: true },
  );
  setRunControls(true);
}

/** One frame of a run: advance or replay it, draw it, and update everything that reads it. */
function runFrame(simulation: Simulation, skinned: SkinnedSkeleton, elapsed: number): void {
  const frameSeconds = Math.min(elapsed, 250) / 1000;
  if (following) {
    // The elapsed time is measurement only: what the frame advances is one output frame's worth
    // of simulated time, whatever the clock says.
    try {
      simulation.advance(frameSeconds);
    } catch (error) {
      stalled(simulation, error);
    }
    // A tick that threw, or a solver reset, pauses the run inside `advance`; this says so, once.
    reportStop(simulation);
  } else {
    // Playback is the other way round -- paced by the clock, because what is being watched is
    // finished and watching it should take the time it took.
    playback.advance(frameSeconds, simulation.outputFramerate, capturedFrames());
    if (!playback.playing) setRunControls(true);
  }
  const replay = following ? undefined : replayFrame(simulation);
  const transforms = replay ?? simulation.boneTransforms();
  // Off the live edge, the segment poses the overlays draw from are the replayed bones': a
  // segment's frame is its anchor bone's, so the discs, the cartilage and the proxies follow
  // the playhead the way the bones and bellies do.
  const replayedPose = replay ? segmentPosesFrom(simulation, replay) : undefined;
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
    skinned.update(simulation.boneOrder(), transforms.position, transforms.orientation);
  }
  if (vrLink) {
    // The headset is sent the frame on screen, not the newest one: off the live edge that is
    // the recorded frame under the playhead, bellies included, published under its own tick so
    // the headset's body and timeline move as the desktop's do when replaying or scrubbing.
    const shownIndex = replay
      ? Playback.tickOf(playback.clampedFrame(capturedFrames()), simulation.ticksPerOutputFrame)
      : -1;
    vrLink.frame(
      transforms.position,
      transforms.orientation,
      replay ? simulation.capture.firstTick + shownIndex : simulation.ticks,
      replay
        ? (playback.ringsAt(
            simulation.muscleCapture,
            simulation.muscleCapture.indexForTick(simulation.capture.firstTick + shownIndex),
          ) ?? null)
        : undefined,
    );
  }
  if (overlays) {
    const pose = simulation.channel('body.pose').fields;
    const limits = simulation.channel('diagnostics.limits').fields;
    const contacts = simulation.channel('contact.manifolds');
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
      muscles: replay ? replayedMuscles(simulation) : muscleOverlay(simulation),
    });
  }
  updateDiagnostics(simulation, following);
  updateTimeline(simulation);
  must<HTMLElement>('#diag-cost').textContent = `${simulation.lastStepMs.toFixed(3)} ms`;
  const capture = simulation.capture;
  // Both captures, because the muscle one is what usually stops first and it used to stop
  // invisibly: with the whole muscle set running, a frame of rings is dozens of times a frame
  // of bones. It is taken once a sweep rather than once a tick -- one tick in eight at
  // 1000 Hz, one in four at 500 Hz -- so it grows several times faster than the bone capture
  // rather than dozens, and on the same budget it still runs out first while this line went on
  // counting bone frames.
  const rings = simulation.muscleCapture;
  // Each capture against its own budget, not the two summed against twice it: the muscle
  // capture reaches the limit on its own, which summed reads as though the run stopped at a
  // fraction of what it was allowed.
  const mb = (bytes: number) => `${(bytes / MEBIBYTE).toFixed(0)} MB`;
  const held = simulation.muscleVolume
    ? `muscles ${mb(rings.bytes)}, bones ${mb(capture.bytes)}, of ${mb(simulation.captureBudgetBytes)} each`
    : `${mb(capture.bytes)} of ${mb(simulation.captureBudgetBytes)}`;
  // Which capture stopped, if one has. A bones-only run has nothing to level the two captures
  // against, so nothing records which one stopped; a full bone capture is then the one.
  const stoppedBy = simulation.capturesStoppedBy ?? (capture.full ? 'bones' : undefined);
  // What raising the budget does after a stop is keep what is held, never carry on: the run has
  // gone past the last captured tick, and a capture with a gap in it is not one the export can
  // write. So the text says what a longer capture takes, which is a new run -- and a new run of
  // the same settings is the same run, unless somebody reached into this one.
  const stoppedAt = (capture.firstTick + capture.frameCount - 1) * simulation.dt;
  setText(
    must<HTMLElement>('#capture-status'),
    `Captured ${capture.frameCount} frames for export (${held})` +
      (stoppedBy === undefined
        ? '.'
        : ` — the ${stoppedBy === 'muscles' ? 'muscle' : 'bone'} budget reached at ` +
          `${stoppedAt.toFixed(2)} s; the ${capture.frameCount} frames held are kept and still ` +
          'export. For a longer capture raise the budget, then Reset and Start: the run is ' +
          'deterministic and replays the same unless you grabbed, dragged or changed ' +
          'drive/gravity during it.') +
      recordingStatus(simulation),
  );
  const seconds = (simulation.ticks * simulation.dt).toFixed(2);
  // How fast, never whether anything was lost: nothing is. Below life speed the machine is
  // simply taking longer over the same ticks, and the run it produces is the same run.
  const speed = simulation.achievedRateHz / simulation.declaredRateHz;
  // A run that stopped itself says why for as long as it stands where it stopped, in red.
  const stopped = stoppedHere(simulation);
  setSimulationStatus(
    stopped ??
      (simulation.paused
        ? `Paused at ${seconds} s.`
        : speed > 0.01 && Math.abs(speed - 1) >= 0.05
          ? `Running, ${seconds} s simulated, at ${speed.toFixed(2)}x life speed.`
          : `Running, ${seconds} s simulated.`),
    stopped !== undefined,
  );
}

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

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

// The spec's own words for the sex parameter (section 6.3), from the one place they are kept, so
// the panel and the HSDL documentation cannot drift apart.
must<HTMLElement>('#sex-label').textContent = SEX_PARAMETER_LABEL;
must<HTMLElement>('#sex-note').textContent = SEX_PARAMETER_NOTE;

const limitations = must<HTMLUListElement>('#limitations');
for (const limitation of modelLimitations()) {
  const item = window.document.createElement('li');
  item.textContent = limitation;
  limitations.appendChild(item);
}

// ---------------------------------------------------------------------------------------------
// The brain on screen: the policy's layers as pixels, redrawn every frame the nerves are in.
// ---------------------------------------------------------------------------------------------

/**
 * The panel's elements, found on first use rather than at module scope.
 *
 * The frame loop draws this panel and the loop's first frame is run as this file is evaluated,
 * which is before a `const` down here would exist. Looked up when first drawn, it does not
 * matter which of the two happens first.
 */
let nervesUi: {
  control: HTMLElement;
  canvas: HTMLCanvasElement;
  note: HTMLElement;
  image: ImageData | null;
} | null = null;
function nervesElements() {
  if (!nervesUi) {
    nervesUi = {
      control: must<HTMLElement>('#nerves-control'),
      canvas: must<HTMLCanvasElement>('#nerves-activity'),
      note: must<HTMLElement>('#nerves-note'),
      image: null,
    };
  }
  return nervesUi;
}

/**
 * The brain on screen, from whichever one is in a loop: this page's own policy when one has been
 * handed the running body, and otherwise the training showcase's, polled from the dashboard by
 * the brain panel. Without either the panel hides and says so.
 */
function drawNerves(sim: Simulation | undefined): void {
  const local = sim?.brainActive ? sim.nerves : undefined;
  const remote = local ? undefined : brain?.remoteActivity();
  const layers: readonly ArrayLike<number>[] | undefined = local?.policy.layers ?? remote?.layers;
  const ui = nervesElements();
  if (!layers || layers.length === 0) {
    if (!ui.control.hidden) ui.control.hidden = true;
    return;
  }
  if (ui.control.hidden) ui.control.hidden = false;
  const context = ui.canvas.getContext('2d');
  if (!context) return;
  const width = ui.canvas.width;
  const height = ui.canvas.height;
  if (!ui.image || ui.image.width !== width || ui.image.height !== height) {
    ui.image = context.createImageData(width, height);
  }
  const data = ui.image.data;
  const rowHeight = Math.floor(height / layers.length);
  layers.forEach((layer: ArrayLike<number>, row: number) => {
    const n = layer.length;
    for (let px = 0; px < width; px++) {
      const v = layer[Math.floor((px / width) * n)] ?? 0;
      const m = Math.max(-1, Math.min(1, v));
      const red = m > 0 ? 40 + 215 * m : 40;
      const blue = m < 0 ? 40 - 215 * m : 40;
      const green = 40 + 30 * Math.abs(m);
      for (let py = row * rowHeight; py < (row + 1) * rowHeight - 1; py++) {
        const i = 4 * (py * width + px);
        data[i] = red;
        data[i + 1] = green;
        data[i + 2] = blue;
        data[i + 3] = 255;
      }
    }
  });
  context.putImageData(ui.image, 0, 0);
  if (local && sim) {
    // The policy in charge now, which after a hand-over is not the one the run opened with.
    const inCharge = sim.policyInCharge;
    const trained = inCharge?.trained;
    ui.note.textContent =
      `${inCharge?.task ? `${inCharge.task}: ` : ''}` +
      `${local.policy.sizes.join(' × ')} weights, ${local.evaluationsSoFar} evaluations` +
      (trained
        ? `; trained ${trained.generations} generations to fitness ${trained.fitness.toFixed(2)}`
        : '') +
      (local.unreadableSoFar ? `; ${local.unreadableSoFar} unreadable inputs` : '');
  } else if (remote) {
    ui.note.textContent =
      `${remote.name}, generation ${remote.generation}: ` +
      `${layers.map((l) => l.length).join(' × ')}, ` +
      `${remote.time.toFixed(2)} s into the episode${remote.up ? '' : ', down'}`;
  }
}

animate();

// A handle for scripted checks of the running page; never used by the page itself.
Object.assign(window, {
  __studio: {
    simulation: () => simulation,
    pick: (x: number, y: number) => pickBone(x, y)?.boneId,
    skinned: () => skinned,
    camera,
    controls,
    raycaster,
    session: { serializeSnapshot, deserializeSnapshot },
    blenderExport: () =>
      simulation && assets ? buildBlenderExport(simulation, document_, assets) : null,
  },
});

/** The Cost panel's Mesh row: which pack the bones on screen are from, and why. */
function showMeshDetail(text: string, title = ''): void {
  const row = must<HTMLElement>('#stat-mesh');
  setText(row, text);
  row.title = title;
}

/** The centre overlay, as an error: nothing else is on screen to carry one. */
function loadFailed(message: string, error: unknown): void {
  console.error(message, error);
  const loading = must<HTMLElement>('#loading');
  loading.hidden = false;
  loading.textContent = `${message} See the console.`;
  loading.classList.add('error');
  announce(`${message} ${messageOf(error)}`, {
    error: true,
  });
}

/**
 * The reduced pack went up and the full one did not: keep what is on screen and say so.
 *
 * The reduced bones are a whole skeleton, so this is a coarser picture rather than a broken one,
 * and the run and the physics do not use the render mesh at all. It used to be said only on the
 * console, and a studio showing coarse bones for no visible reason looks like a bug.
 */
function fullDetailFailed(error: unknown): void {
  console.error('The full-detail bones failed to load; staying on the reduced set.', error);
  const why = messageOf(error);
  showMeshDetail('reduced (full detail failed to load)', why);
  announce('Full-detail bones failed to load; showing the reduced set (see the console).', {
    error: true,
  });
}

loadAssets('lod1').then(
  (loaded) => {
    assets = loaded;
    must<HTMLElement>('#attribution').textContent = attributionText(loaded.manifest);
    must<HTMLElement>('#attribution').hidden = false;
    try {
      rebuildMesh();
      rebuildBody();
    } catch (error) {
      loadFailed('The measured skeleton loaded but failed to build.', error);
      return;
    }
    // Only now: hidden before the first build, the overlay went away and a failure to build
    // left an empty viewport with nothing in it to say why.
    must<HTMLElement>('#loading').hidden = true;
    if (STAY_ON_SMALL_PACK) {
      showMeshDetail('reduced (this device stays on the small pack)');
      return;
    }
    fullDetailPending = true;
    showMeshDetail('reduced; loading full detail…');
    if (!simulation && !bridgeFollower.active) setSimulationStatus(restStatus());
    loadAssets('full')
      .then((full) => {
        const reduced = assets;
        assets = full;
        // The mesh only: the bones on screen get finer and nothing about the body changes, so a
        // run going when they arrive goes on, with its recording, drawn in the finer bones.
        try {
          rebuildMesh();
          showMeshDetail('full');
        } catch (error) {
          // Back to the pack that built, so the viewport has a skeleton in it.
          assets = reduced;
          try {
            rebuildMesh();
          } catch {
            // Already said below; a second failure adds nothing a person can act on.
          }
          fullDetailFailed(error);
        }
      }, fullDetailFailed)
      .finally(() => {
        fullDetailPending = false;
        if (!simulation && !bridgeFollower.active) setSimulationStatus(restStatus());
      });
  },
  (error: unknown) => loadFailed('The measured skeleton failed to load.', error),
);

function must<T extends Element>(selector: string): T {
  const element = window.document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

/** An error's message, or whatever was thrown as a string. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

// ---------------------------------------------------------------------------------------------
// The VR viewer, on this run.
//
// Tauri only: the viewer is a native process and the bridges live on tmpfs, neither of which a
// browser tab can reach. The link publishes what the screen shows and routes the headset's panel
// into the same controls the mouse uses, so the two never disagree about what the run is doing.
// ---------------------------------------------------------------------------------------------

const connectVr = must<HTMLButtonElement>('#connect-vr');

/** The studio's diagnostics strip, as numbers, for the panel. */
function diagnosticsOf(sim: Simulation): Record<string, number> {
  const energy = sim.channel('diagnostics.energy').fields;
  const limits = sim.channel('diagnostics.limits').fields;
  const contacts = sim.channel('contact.manifolds');
  let worst = 0;
  let violations = 0;
  const proximity = limits.proximity as Float64Array;
  const violation = limits.violation as Uint8Array;
  for (let i = 0; i < proximity.length; i++) {
    worst = Math.max(worst, proximity[i] ?? 0);
    violations += violation[i] ?? 0;
  }
  return {
    kinetic: (energy.kinetic as Float64Array)[0] ?? 0,
    potential: (energy.potential as Float64Array)[0] ?? 0,
    driftMm: ((energy.drift as Float64Array)[0] ?? 0) * 1000,
    limitsWorst: worst,
    violations,
    contacts: contacts.count,
    costMs: sim.lastStepMs,
  };
}

/** A slider or checkbox set from the headset, told about it the way the mouse would tell it. */
function setFromPanel(input: HTMLInputElement | HTMLSelectElement, value: unknown): void {
  if (input instanceof HTMLInputElement && input.type === 'checkbox') {
    input.checked = Boolean(value);
  } else {
    input.value = String(value);
  }
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('change'));
}

const vrHost = {
  simulation: () => simulation,
  restPose(sim: Simulation) {
    const order = sim.boneOrder();
    const rests = computeWorldTransforms(document_, sim.resolved.context);
    const position = new Float64Array(order.length * 3);
    const orientation = new Float64Array(order.length * 4);
    order.forEach((id, i) => {
      const t = rests.get(id);
      position.set(t ? [t.translation.x, t.translation.y, t.translation.z] : [0, 0, 0], i * 3);
      orientation.set(
        t ? [t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w] : [0, 0, 0, 1],
        i * 4,
      );
    });
    return {
      bones: order,
      position,
      orientation,
      datasetScale: Number(ui.stature.value) / (assets?.manifest.subjectStature ?? 1),
    };
  },
  status(sim: Simulation | null): VrStatus {
    const option = (select: HTMLSelectElement) =>
      Array.from(select.options).map((o) => ({
        id: o.value,
        title: o.textContent?.trim() ?? o.value,
      }));
    const chosen = ui.scenario.selectedOptions[0];
    return {
      scenario: { id: ui.scenario.value, title: chosen?.textContent?.trim() ?? ui.scenario.value },
      scenarios: option(ui.scenario),
      profiles: Array.from(ui.profile.options).map((o) => o.value),
      profile: ui.profile.value,
      settings: {
        muscles: sim ? sim.muscles !== undefined : ui.muscles.checked,
        sex: Number(ui.sex.value),
        stature: Number(ui.stature.value),
        mass: Number(ui.mass.value),
        crural: Number(ui.crural.value),
        brachial: Number(ui.brachial.value),
        legLength: Number(ui.legLength.value),
        percentile: Number(ui.percentile.value),
        dropHeight: Number(ui.dropHeight.value),
        passive: ui.passive.checked,
        redistribute: ui.redistribute.checked,
        gravity: ui.gravity.checked,
        floor: ui.floor.checked,
        fps: Number(ui.outputFramerate.value),
        stepsPerSecond: sim?.stepsPerSecond ?? Number(ui.stepsPerSecond.value),
      },
      driveGroups: MUSCLE_GROUPS.map((group) => ({
        title: group.title,
        level: Number(driveInputs.get(group.id)?.value ?? 0),
        section: group.section,
      })),
      groundHeight: sim?.groundHeight ?? 0,
      staticBoxes: (sim?.staticBoxes ?? []).map((b) => ({
        halfExtents: [b.halfExtents.x, b.halfExtents.y, b.halfExtents.z],
        position: [b.position.x, b.position.y, b.position.z],
        rotation: b.rotation
          ? [b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w]
          : [0, 0, 0, 1],
      })),
      grabStrength: Number(ui.grabStrength.value),
      diagnostics: sim ? diagnosticsOf(sim) : {},
      // No run at all reads as paused: the panel's Resume is then Start Sim.
      paused: !sim || sim.paused || !following,
      mode: bridgeFollower.active ? 'following' : !sim ? 'rest' : sim.paused ? 'paused' : 'running',
      overlays: {
        muscles: ui.showMuscles.checked,
        muscleVolumes: ui.showMuscleVolumes.checked,
        tissue: ui.showTissue.checked,
        proxies: ui.showProxies.checked,
        axes: ui.showAxes.checked,
        com: ui.showCom.checked,
        contacts: ui.showContacts.checked,
        grid: ui.showGrid.checked,
      },
      scenarioParameters: (() => {
        const definition = definitionFor(ui.scenario.value);
        if (!definition) return [];
        const values = scenarioValues.get(definition.id) ?? {};
        return definition.parameters.map((p) => ({
          id: p.id,
          title: p.label,
          value: values[p.id] ?? p.value,
          min: p.min,
          max: p.max,
          step: p.step,
          unit: p.unit,
        }));
      })(),
      // The numbers the desktop's readout is drawn from, not its text read back off the page:
      // with no run, or a run without muscles, there are none and the headset shows dashes.
      muscleReadout: sim ? muscleReadoutText(muscleReadout) : {},
      // Relaxed off the live edge, as the desktop draws a replayed belly: tension is not recorded,
      // and the newest tick's would tint a frame it does not belong to.
      tension: sim && following ? Array.from(muscleOverlay(sim)?.tension ?? []) : [],
      tissue: sim ? tissueForBridge(sim) : { discs: [], bars: [] },
      brain: brain?.state() ?? { ...IDLE_BRAIN_STATE, following: bridgeFollower.active },
      recordedSeconds: sim ? recordedSeconds(sim) : 0,
      playing: playback.playing,
      live: following,
    };
  },
  command(command: VrCommand): void {
    switch (command.kind) {
      case 'pause':
        ui.simPause.click();
        break;
      case 'resume':
        // Carry on, or start when nothing is running -- the headset shows no run as paused, so
        // its Resume is Start there. Never the Restart a click on Start is on a live run.
        startOrResume();
        break;
      case 'reset':
        ui.reset.click();
        break;
      case 'step':
        (command.frames > 0 ? ui.frameForward : ui.frameBack).click();
        break;
      case 'scrub':
        // The headset's timeline is in seconds of the run -- the time the status reports -- so
        // the frame is found from the tick that time is, counted from where the capture starts.
        if (simulation) {
          const frame = Playback.frameOfTick(
            Math.round(command.seconds / simulation.dt),
            simulation.capture.firstTick,
            simulation.ticksPerOutputFrame,
          );
          scrubTo(Math.min(Math.max(frame, 0), capturedFrames() - 1));
        }
        break;
      case 'brain':
        brain?.act(command.action, command.id, command.value);
        break;
      case 'drive': {
        const input = driveInputs.get(MUSCLE_GROUPS[command.group]?.id ?? '');
        if (input) setFromPanel(input, Math.max(0, Math.min(100, command.value)));
        break;
      }
      case 'set': {
        const { key, value } = command;
        const restart = () => void startSimulation();
        switch (key) {
          case 'scenario':
            setFromPanel(ui.scenario, value);
            restart();
            break;
          case 'profile':
            setFromPanel(ui.profile, value);
            restart();
            break;
          case 'muscles':
            setFromPanel(ui.muscles, value);
            restart();
            break;
          case 'sex':
          case 'stature':
          case 'mass':
            // The slider's own events rebuild the body and carry a running one across; a restart
            // on top of that was a second run racing the first.
            setFromPanel(ui[key], value);
            break;
          case 'crural':
          case 'brachial':
          case 'legLength':
            // Accepted and ignored. Nothing measured follows the limb proportions yet, so the
            // desktop's sliders are disabled; an older viewer still offers them, and a value from
            // it would otherwise rebuild the body and restart the run for no change at all.
            break;
          case 'dropHeight':
          case 'passive':
          case 'redistribute':
          case 'stepsPerSecond':
            setFromPanel(ui[key], value);
            restart();
            break;
          case 'fps':
            setFromPanel(ui.outputFramerate, value);
            break;
          case 'gravity':
          case 'floor':
          case 'grabStrength':
          case 'percentile':
            setFromPanel(ui[key], value);
            break;
          case 'grid':
            setFromPanel(ui.showGrid, value);
            break;
          case 'play':
            ui.playToggle.click();
            break;
          case 'live':
            ui.goLive.click();
            break;
          default: {
            // `overlay.<name>` is the viewport's checkbox of that name; `scenario.<id>` is one
            // of the chosen scenario's own sliders.
            const overlay = /^overlay\.(\w+)$/.exec(key)?.[1];
            const parameter = /^scenario\.([\w-]+)$/.exec(key)?.[1];
            if (overlay) {
              const box = window.document.querySelector<HTMLInputElement>(
                `#show${overlay.charAt(0).toUpperCase()}${overlay.slice(1)}`,
              );
              if (box) setFromPanel(box, value);
              else console.warn('VR panel: no overlay', overlay);
            } else if (parameter) {
              const input = window.document.querySelector<HTMLInputElement>(
                `#scenario-${parameter}`,
              );
              if (input) setFromPanel(input, value);
              else console.warn('VR panel: no scenario parameter', parameter);
            } else console.warn('VR panel: no setting', key);
          }
        }
        break;
      }
    }
  },
  log: (message: string) => {
    announce(message);
    // And on the terminal, beside the viewer's own lines, where a failure can actually be read.
    void invoke('studio_log', { message }).catch(() => undefined);
  },
  onViewerExit(code: number | null, signal: number | null, tail: readonly string[]): void {
    void (async () => {
      const link = vrLink;
      vrLink = null;
      connectVr.textContent = 'Connect VR viewer';
      // Clears and releases the bridge; the viewer is already gone.
      await link?.disconnect();
      const last = tail.at(-1) ?? '';
      const how = code !== null ? `exit ${code}` : `ended by signal ${signal ?? '?'}`;
      // In the event line rather than the run's readout, which is rewritten every frame while a
      // run is going and would take this away before anybody read it.
      announce(`VR viewer closed (${how})${last ? `: ${last}` : ''}`, { error: code !== 0 });
    })();
  },
};

/** The run time of the newest recorded frame, in the seconds the headset's timeline counts. */
function recordedSeconds(sim: Simulation): number {
  const frames = capturedFrames();
  if (frames <= 0) return 0;
  return (sim.capture.firstTick + Playback.tickOf(frames - 1, sim.ticksPerOutputFrame)) * sim.dt;
}

if (isTauri()) {
  connectVr.hidden = false;
  connectVr.addEventListener('click', () => {
    void (async () => {
      if (vrLink) {
        await vrLink.disconnect();
        vrLink = null;
        connectVr.textContent = 'Connect VR viewer';
        announce('VR viewer disconnected.');
        return;
      }
      connectVr.disabled = true;
      try {
        const link = new VrLink(vrHost);
        await link.connect();
        vrLink = link;
        connectVr.textContent = 'Disconnect VR viewer';
        // At once, rather than at the next three-second tick: the headset's Brain tab is drawn
        // from what the desktop's panel knows, and it should not open on a stale list.
        void brain?.poll();
      } catch (error) {
        announce(`The VR viewer did not connect: ${messageOf(error)}`, { error: true });
      } finally {
        connectVr.disabled = false;
      }
    })();
  });
  // A reload keeps the Tauri side, and the viewer it launched, running: say so, so the button's
  // "Connect" is not read as "nothing is connected".
  void invoke<{ running: boolean }>('xr_viewer_state')
    .then((state) => {
      if (state.running) {
        announce('VR viewer still running from before the reload: Connect re-attaches it');
      }
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Following the bridge: the body on screen is whoever is publishing, not a run of our own.
// ---------------------------------------------------------------------------------------------

const followButton = must<HTMLButtonElement>('#follow-bridge');
let followTubes: RingTubes | null = null;
/** The followed body's connective tissue, and what it was built for. */
let followTissue: FollowTissue | null = null;
let followTissueKey = '';
let followLastTick = -1;
let followLastMuscleTick = -1;

function followFrame(skin: SkinnedSkeleton): void {
  const pose = bridgeFollower.pose;
  if (pose && pose.tick !== followLastTick) {
    followLastTick = pose.tick;
    skin.update(pose.bones, pose.position, pose.orientation);
  }
  followTissueFrame(pose);
  const muscles = bridgeFollower.muscles;
  if (muscles && muscles.tick !== followLastMuscleTick) {
    followLastMuscleTick = muscles.tick;
    if (
      !followTubes ||
      followTubes.mesh.geometry.getAttribute('position').count !==
        muscles.units * muscles.rings * muscles.segments
    ) {
      if (followTubes) {
        followTubes.dispose();
      }
      followTubes = new RingTubes(muscles.units, muscles.rings, muscles.segments);
      world.add(followTubes.mesh);
    }
    followTubes.update(muscles.position, muscles.orientation, muscles.radius);
  }
  if (followTubes && bridgeFollower.tension) followTubes.tint(bridgeFollower.tension);
  followedFurniture();
  const status = bridgeFollower.status as {
    scenario?: { title?: string };
    training?: { generation?: number; episode?: number };
  } | null;
  const title = status?.scenario?.title ?? 'a publisher';
  const training = status?.training;
  setSimulationStatus(
    bridgeFollower.problem
      ? `Following the bridge: ${bridgeFollower.problem}`
      : `Following ${title}${training ? `, episode ${training.episode}` : ''}` +
          (pose ? ` · ${(pose.tick / 500).toFixed(1)} s` : ''),
  );
}

/**
 * The followed body's tissue: built from the table the publisher puts in its status, rebuilt
 * when the publisher or its body changes, and hidden with the overlay it belongs to. A
 * publisher that says nothing of tissue -- an older one -- simply has none to draw.
 */
function followTissueFrame(pose: typeof bridgeFollower.pose): void {
  const table = (bridgeFollower.status as { tissue?: TissueTable } | null)?.tissue;
  const key =
    pose && table ? `${pose.bones.length}:${table.discs.length}:${table.bars.length}` : '';
  if (key !== followTissueKey) {
    followTissueKey = key;
    if (followTissue) {
      followTissue.dispose();
      followTissue = null;
    }
    if (pose && table && (table.discs.length > 0 || table.bars.length > 0)) {
      followTissue = new FollowTissue(table, pose.bones);
      world.add(followTissue.root);
    }
  }
  if (!followTissue || !pose) return;
  followTissue.root.visible = ui.showTissue.checked;
  if (followTissue.root.visible) followTissue.update(pose.position, pose.orientation);
}

function stopFollowing(): void {
  bridgeFollower.stop();
  if (followTissue) {
    followTissue.dispose();
    followTissue = null;
    followTissueKey = '';
  }
  if (followTubes) {
    followTubes.dispose();
    followTubes = null;
  }
  followLastTick = -1;
  followLastMuscleTick = -1;
  // The publisher's scenery was theirs, not this studio's: it goes with them.
  clearFurniture();
  followFurnitureKey = '';
  skinned?.rest();
  followButton.textContent = 'Follow bridge';
  // Back to whatever this page's own run is doing, which with nothing running is nothing.
  setMode(!simulation ? 'rest' : simulation.paused ? 'paused' : 'running');
  setSimulationStatus(restStatus());
}

followButton.addEventListener('click', () => {
  if (bridgeFollower.active) {
    stopFollowing();
    return;
  }
  // A run of our own and a followed one cannot share the skeleton.
  stopSimulation();
  setRunControls(false);
  bridgeFollower.start();
  followButton.textContent = 'Stop following';
  setMode('following');
  setSimulationStatus('Following the bridge…');
});

// ---------------------------------------------------------------------------------------------
// The brain panel: a policy in charge, and training from here.
// ---------------------------------------------------------------------------------------------

/**
 * What the studio offers the Align tab beyond what its `AlignHost` declares today: hooks the
 * panel's next change reads, provided here because they reach into the run, the frame loop and
 * the file helpers, which live in this file and nowhere the panel can get at.
 */
interface AlignHostHooks {
  /** Our compiled muscle set, for the panel to read attachment and via sites from itself. */
  muscles(): Simulation['muscles'];
  /**
   * Hold the body at rest while the Align points are shown, or let it go.
   *
   * Points are defined and recorded at rest, so a point is only judged fairly against the bone it
   * sits on when that bone is at rest too. Holding pauses a live run -- never discarding it -- and
   * draws the skeleton at rest with the pose overlays hidden. Letting go draws the run's paused
   * pose again and does not resume it: nobody asked for it to move.
   */
  holdRest(on: boolean): void;
  /** Write a file through the studio's saving helper; true once it is written. */
  save(name: string, text: string): Promise<boolean>;
  /** The body a saved alignment was made against: the running one's profile and morphology. */
  body(): { profile: string; morphology: Simulation['recording']['morphology'] } | undefined;
  /** Ask for a JSON file to load, however this studio asks; its text, or undefined if none. */
  open(): Promise<string | undefined>;
}

/**
 * The browser picker still waiting for its answer, if any: a way to settle it with nothing.
 * See `openAlignFile`.
 */
let abandonAlignPick: (() => void) | null = null;

/**
 * Ask for a JSON file for the Align tab: the desktop shell's dialog, or the page's hidden input.
 *
 * Resolves undefined when the dialog is dismissed. Not every browser reports a dismissed picker,
 * so an ask that is never answered is settled with undefined by the next one instead, rather than
 * left listening on the input and handed the next file as well.
 */
function openAlignFile(): Promise<string | undefined> {
  if (usesNativeFilePickers()) return openTextFile();
  const input = must<HTMLInputElement>('#align-load-file');
  abandonAlignPick?.();
  return new Promise((resolve, reject) => {
    const settle = () => {
      input.removeEventListener('change', picked);
      input.removeEventListener('cancel', dismissed);
      abandonAlignPick = null;
    };
    const dismissed = () => {
      settle();
      resolve(undefined);
    };
    const picked = () => {
      settle();
      const file = input.files?.[0];
      input.value = '';
      if (file) file.text().then(resolve, reject);
      else resolve(undefined);
    };
    abandonAlignPick = dismissed;
    input.addEventListener('change', picked);
    input.addEventListener('cancel', dismissed);
    input.click();
  });
}

/**
 * The Align tab: the reference models beside ours, and the points of ours that need moving.
 *
 * Built once and given the scene, because it draws into the same world the body is in. Its
 * reference data is fetched rather than bundled, so a studio nobody aligns anything in never
 * pays for it.
 */
const alignHost: AlignHost & AlignHostHooks = {
  articulation: () => simulation?.articulation,
  units: () => simulation?.muscles?.units.map((u) => u.id) ?? [],
  muscles: () => simulation?.muscles,
  // Our joints and attachments at rest are pure functions of the compiled body, in
  // `align/ourBody.ts` where they are tested. The joints used to be worked out here, and the
  // sites too -- looked up as though every bone were a segment, which dropped the 288 of 544
  // sites whose bone is not one, the femur's and the humerus's among them.
  jointsOn: (segment) => {
    const sim = simulation;
    if (!sim) return [];
    // The hinge axes the panel's shape still carries are read by nothing any more (settling a
    // bone's roll by them measured worse than inheriting it; see `fit.ts`), so none are given.
    return jointsOnSegment(sim.articulation, segment).map((joint) => ({ ...joint, axes: [] }));
  },
  sites: () => (simulation ? attachmentSites(simulation.articulation, simulation.muscles) : []),
  /**
   * Light up one of our segments, or clear it with undefined.
   *
   * All the bones the segment owns -- a segment is several bones, and `thigh_r` has to light up
   * as a femur rather than as a dot at an origin -- tinted on the drawn mesh, under the
   * inspector's own tint, by `applyTints`.
   */
  highlightSegment: (id) => {
    const segment = id ? simulation?.articulation.segments.find((s) => s.id === id) : undefined;
    alignedSegmentBones = segment ? segment.bones : [];
    applyTints();
  },
  save: (name, text) => saving(name, download(name, text, 'application/json')),
  setGizmoDragging: (dragging) => {
    gizmoDragging = dragging;
  },
  holdRest: (on) => {
    if (on === alignHoldsRest) return;
    alignHoldsRest = on;
    if (on && simulation && !simulation.paused) {
      pause();
      announce('Paused: the Align points are drawn at rest.');
    }
    // The frame loop draws the change, and hides or shows the overlays with it.
  },
  body: () =>
    simulation
      ? { profile: simulation.recording.profile, morphology: simulation.recording.morphology }
      : undefined,
  open: openAlignFile,
};
align = createAlignPanel(alignHost, camera, renderer);
align.attach(world);
void loadSourceSites().then((data) => {
  if (data) align?.adopt(data);
});

/**
 * Put a cord on the Spine sliders, as though somebody had moved them.
 *
 * The sliders are the one owner of the cord: each one's `input` event sets the running body's
 * gains, and every run the studio starts is built with what they show. So a checkpoint's cord
 * goes onto the sliders rather than into the body behind them, and the panel and the body cannot
 * disagree about which reflexes are running.
 */
function putSpine(cord: NonNullable<NonNullable<PolicyFile['recipe']>['reflex']>): void {
  const put = (selector: string, value: number): void => {
    const input = document.querySelector<HTMLInputElement>(selector);
    if (!input) return;
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  put('#spine-stretch', cord.stretch);
  put('#spine-velocity', cord.velocity);
  put('#spine-setpoint', cord.setPoint);
  put('#spine-inhibition', cord.inhibition);
  put('#spine-delay', cord.delaySeconds);
}

/**
 * The policy file last handed over from the panel, to tell a new hand-over from a change of
 * authority. The panel sends both through `handOver` with the same setup shape; only a new file
 * should bring its cord onto the sliders or be adopted again, because adopting refits the weights
 * and starts a remembering policy's context over, and a person who moved the sliders after the
 * hand-over did not ask for the checkpoint's cord back because they touched Authority.
 */
let handedPolicy: PolicyFile | undefined;

brain = createBrainPanel({
  handOver(setup) {
    if (!setup) {
      handedPolicy = undefined;
      simulation?.releaseBrain();
      return;
    }
    const fresh = setup.policy !== handedPolicy;
    handedPolicy = setup.policy;
    // Onto the sliders before anything else, run or no run: the cord the checkpoint was trained
    // over is part of the body it knows, and the next run is built with what the sliders say.
    const cord = setup.policy.recipe?.reflex;
    if (fresh && cord) putSpine(cord);
    // Live: the nerves are in every muscle run, so the policy goes in between one control step
    // and the next, and nothing restarts. A run that is not going takes it when it starts.
    if (!simulation) return;
    if (!fresh) {
      simulation.setAuthority(setup.authority);
      return;
    }
    try {
      simulation.handOver(setup.policy, setup.authority);
    } catch (error) {
      announce(`The checkpoint could not be handed over: ${messageOf(error)}`, { error: true });
      // And back to the panel, whose Hand over catches it and says the checkpoint could not be
      // loaded -- rather than "Policy chosen", which is what it said while nothing was in charge.
      throw error;
    }
  },
  setReflex(gains) {
    simulation?.setReflex(gains);
  },
  startFollowing() {
    if (!bridgeFollower.active) followButton.click();
  },
  // The headset's Follow is the desktop's button, both ways: without this there is no way to
  // stop following from in there.
  toggleFollowing() {
    followButton.click();
  },
  recipe() {
    return {
      scenario: ui.scenario.value,
      parameters: { ...(scenarioValues.get(ui.scenario.value) ?? {}) },
      profile: ui.profile.value,
      morphology: currentMorphology(),
      passive: ui.passive.checked,
      redistribute: ui.redistribute.checked,
    };
  },
  // A checkpoint's recipe is a session's settings for the scene and the body; the rest stays.
  applyRecipe(recipe) {
    const p = recipe.morphology.proportions ?? {};
    // The timescale it was trained at. A policy learned against one timestep behaves differently
    // against another -- the contacts and the muscles' own dynamics both follow the step -- so
    // this is set rather than offered, and the Sim tab shows what it was set to.
    if (recipe.stepsPerSecond) {
      ui.stepsPerSecond.value = String(recipe.stepsPerSecond);
      must<HTMLOutputElement>('#stepsPerSecond-value').textContent = String(recipe.stepsPerSecond);
      fidelityTouched = true;
    }
    // The cord and the memory it was brought up with, onto their sliders, so the panel says
    // what this checkpoint knows rather than what the last one did.
    if (recipe.reflex) putSpine(recipe.reflex);
    const memory = document.querySelector<HTMLInputElement>('#train-memory');
    if (memory && recipe.memory !== undefined) {
      memory.value = String(recipe.memory);
      memory.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // Trained with nothing under the brain: the sliders start where the training had them, at
    // zero, so what the body does is the policy's doing and not the policy plus a held pose.
    if (recipe.feedforward.kind === 'none') {
      for (const slider of driveInputs.values()) {
        slider.value = '0';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    // Whether this lands on a running body, which the settings below restart with the body carried
    // across, or waits for the next run: the message says which.
    const running = simulation !== null;
    applySettings({
      ...currentSettings(),
      sex: recipe.morphology.sex,
      stature: recipe.morphology.stature,
      mass: recipe.morphology.mass,
      crural: p.crural ?? Number(ui.crural.value),
      brachial: p.brachial ?? Number(ui.brachial.value),
      legLength: p.relativeLegLength ?? Number(ui.legLength.value),
      profile: recipe.profile,
      scenario: recipe.scenario,
      passive: recipe.passive,
      redistribute: recipe.redistribute,
      scenarioParameters: { ...recipe.parameters },
    });
    announce(
      `Set from the checkpoint ${recipe.name}: its scene, body and joints` +
        (recipe.stepsPerSecond ? `, and its ${recipe.stepsPerSecond} steps a second` : '') +
        (recipe.feedforward.kind === 'none' ? ', with the muscle sliders back to zero' : '') +
        (running
          ? '; the running body was restarted with them.'
          : '. They take effect on the next run.'),
    );
  },
  fit() {
    const nerves = simulation?.nerves;
    if (!nerves || !simulation?.brainActive) return undefined;
    const inputs = nerves.observation.size;
    const outputs = nerves.outputs.length;
    return { carried: nerves.carried ?? { inputs, outputs }, inputs, outputs };
  },
  controlDivisor() {
    const profile = document_.segmentation.find((p) => p.id === ui.profile.value);
    const rate = fidelityTouched ? Number(ui.stepsPerSecond.value) : (profile?.solver?.rate ?? 500);
    return Math.max(1, Math.round(rate / 100));
  },
  following() {
    return bridgeFollower.active;
  },
  publishedTrainingName() {
    // The showcase names the checkpoint it is playing in the status it writes.
    const status = bridgeFollower.status as { training?: { task?: string } } | null;
    const name = status?.training?.task;
    return typeof name === 'string' && name !== '' ? name : undefined;
  },
});
// Three things read what the poll refreshes: the Brain tab while it is open; the follow mode,
// whose status names the checkpoint the showcase plays; and the headset while the VR link is
// live, whose Brain tab is drawn from this panel's state whichever desktop tab is showing. With
// none of them there is nobody to ask for, and an absent dashboard is not asked every 3 s -- nor
// at startup, where an unconditional first poll made every page open with two refused requests in
// the console. A studio that reopens on the Brain tab is still asked at once, and opening the tab
// later wakes the panel's own poll.
const pollBrainIfRead = (): void => {
  if (tabs.active === 'brain' || bridgeFollower.active || vrLink?.connected) void brain?.poll();
};
pollBrainIfRead();
window.setInterval(pollBrainIfRead, 3000);
