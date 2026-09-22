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

import { resolveMorphology, validateResolvedBody } from '@bs-humany/anthropometry';
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
import { compileArticulation } from '@bs-humany/compiler';
import {
  MIN_CAPTURE_BUDGET_BYTES,
  captureCeilingBytes,
  defaultCaptureBudgetBytes,
} from '@bs-humany/export-gltf';
import { transformPoint } from '@bs-humany/frames';
import { type Morphology, SEX_PARAMETER_NOTE } from '@bs-humany/hsdl';
import {
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  type SkeletonMesh,
  type TessellationQuality,
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
import { MUSCLE_GROUPS, driveForSlider } from '@bs-humany/scenarios';
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
import { type AlignPanel, createAlignPanel, loadSourceSites } from './align/alignPanel.js';
import { buildBlenderExport } from './blenderExport.js';
import { createBrainPanel } from './brain.js';
import { BridgeFollower } from './follow.js';
import { FollowTissue } from './followTissue.js';
import { createOrbitControls } from './orbit.js';
import { type Overlays, createOverlays } from './overlays.js';
import { Playback } from './playback.js';
import { RingTubes } from './ringTubes.js';
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
import { type BackendId, Simulation } from './simulation.js';
import { type SkinnedSkeleton, createSkinnedSkeleton } from './skinning.js';
import { type TissueTable, tissueTable } from './tissue.js';
import { createMemory } from './ui/memory.js';
import { createResizer } from './ui/resizer.js';
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

const QUALITIES: Record<string, TessellationQuality> = {
  low: QUALITY_LOW,
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
};

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

const selectedMaterial = new MeshStandardMaterial({
  color: 0x6aa9ff,
  roughness: 0.5,
  metalness: 0.05,
  emissive: 0x14304f,
});

/**
 * The Align tab's own highlight, for the segment picked in its pairing list.
 *
 * A different colour from the inspector's, and from the orange their bones light up in, because
 * the whole point is telling three things apart at once: the bone of ours being paired, the bone
 * of theirs it is being paired to, and whatever the inspector happens to have selected.
 */
const ALIGNED_TINT = new Color(0x3fd6c4);

let skeletonMesh: SkeletonMesh | null = null;
let skinned: SkinnedSkeleton | null = null;
let selectedObject: Mesh | null = null;
let selectedBoneId: string | null = null;
let simulation: Simulation | null = null;
// Declared up here with the run state, because the render loop reads it from its first frame
// on, and that frame runs before the page script reaches the VR section at the bottom.
let vrLink: VrLink | null = null;
// Likewise the bridge follower, read by the loop from its first frame on.
const bridgeFollower = new BridgeFollower();
let overlays: Overlays | null = null;
let furniture: Group | null = null;
let groundY = 0;

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
  quality: must<HTMLSelectElement>('#quality'),
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

/**
 * Which units flex and which extend, at each joint the panel drives, on both sides.
 *
 * Split by anatomy rather than by measuring a moment arm, because the sign of a moment arm is what
 * the validation harness checks and using it here would make the panel agree with itself by
 * construction. Each group answers to one slider on both sides at once: a muscle is a flexor on
 * either side of the body.
 *
 * The elbow and the knee have a slider apiece because they are hinges -- one axis, two directions,
 * and a person already thinks of them that way. The shoulder does not: it has three axes, and
 * "flexor" there names a different muscle depending on where the arm already is. It stays along
 * for the ride until the range-of-motion scenarios give it something better than a slider.
 */
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
    const label = window.document.createElement('label');
    label.htmlFor = group.id;
    const readout = window.document.createElement('output');
    readout.id = `${group.id}-value`;
    readout.textContent = '0%';
    label.append(`${group.title} `, readout);
    const input = window.document.createElement('input');
    input.type = 'range';
    input.id = group.id;
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.value = '0';
    section.append(label, input);
    driveInputs.set(group.id, input);
  }
}
/** The group a readout row is about, by id, since the table's order is not the readout's. */
const groupIndex = (id: string) => MUSCLE_GROUPS.findIndex((g) => g.id === id);

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

function rebuild(): void {
  if (!assets) return;
  const started = performance.now();
  // A running simulation survives a morphology change: its joint state is carried into the
  // recompiled body (M5.6) once the mesh is rebuilt.
  const carry = simulation
    ? { state: simulation.jointState(), ticks: simulation.ticks, paused: simulation.paused }
    : null;

  const morphology = currentMorphology();
  const resolved = resolveMorphology(morphology);

  // Spec section 6.4 step 5. A body that fails these checks would still render; it would simply be
  // wrong, so the failure is surfaced rather than swallowed.
  const validation = validateResolvedBody(resolved);
  if (!validation.valid) {
    console.error('Resolved body failed physical validity checks:', validation.problems);
  }

  const quality = QUALITIES[ui.quality.value] ?? QUALITY_MEDIUM;
  skeletonMesh = buildSkeletonMesh(document_, resolved.context, { quality, assets });

  stopSimulation();
  if (skinned) {
    world.remove(skinned.mesh);
    skinned.dispose();
  }
  skinned = createSkinnedSkeleton(skeletonMesh, toSkeletonGeometry(skeletonMesh), boneMaterial);
  world.add(skinned.mesh);

  // The ground sits under the soles: the dataset places them at y = 0 and stature scales about
  // the origin, so this is close to zero, but it is measured rather than assumed.
  const { min } = skeletonBounds(skeletonMesh);
  groundY = min[1];
  grid.position.y = groundY;

  buildMs = performance.now() - started;
  refreshSelection();
  updateReadouts(resolved.input.stature, resolved.input.mass);
  showValidation();
  if (carry) void startSimulation(undefined, carry);
}

function updateReadouts(stature: number, mass: number): void {
  must<HTMLOutputElement>('#sex-value').textContent = Number(ui.sex.value).toFixed(2);
  must<HTMLOutputElement>('#stature-value').textContent = `${stature.toFixed(2)} m`;
  must<HTMLOutputElement>('#mass-value').textContent = `${mass.toFixed(1)} kg`;
  must<HTMLOutputElement>('#crural-value').textContent = Number(ui.crural.value).toFixed(3);
  must<HTMLOutputElement>('#brachial-value').textContent = Number(ui.brachial.value).toFixed(3);
  must<HTMLOutputElement>('#legLength-value').textContent = Number(ui.legLength.value).toFixed(3);

  const percentile = Number(ui.percentile.value);
  must<HTMLOutputElement>('#percentile-value').textContent = `${Math.round(percentile * 100)}th`;

  must<HTMLElement>('#stat-bones').textContent = String(skeletonMesh?.bones.length ?? 0);
  must<HTMLElement>('#stat-tris').textContent = (skeletonMesh?.triangleCount ?? 0).toLocaleString();
  must<HTMLElement>('#stat-build').textContent = `${buildMs.toFixed(1)} ms`;
}

for (const input of [ui.sex, ui.stature, ui.mass, ui.crural, ui.brachial, ui.legLength]) {
  input.addEventListener('input', rebuild);
}
ui.quality.addEventListener('change', rebuild);
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

for (const button of window.document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
  button.addEventListener('click', () => {
    const view = VIEWS[button.dataset.view ?? ''];
    if (!view) return;
    controls.target.set(0, 0.88, 0);
    controls.setView(view.theta, view.phi, 3.1);
  });
}

ui.showGrid.addEventListener('change', () => {
  grid.visible = ui.showGrid.checked;
});

// The percentile control drives stature and mass together, then hands back to them -- it is a
// convenience input, not a separate axis.
ui.percentile.addEventListener('input', () => {
  const resolved = resolveMorphology({
    sex: Number(ui.sex.value),
    percentile: Number(ui.percentile.value),
  } as Morphology);
  ui.stature.value = resolved.input.stature.toFixed(3);
  ui.mass.value = resolved.input.mass.toFixed(1);
  rebuild();
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

function refreshSelection(): void {
  if (selectedObject) {
    selectedObject.geometry.dispose();
    world.remove(selectedObject);
    selectedObject = null;
  }

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

  // Highlight by rebuilding just this bone's slice of the merged buffer. The highlight is a rest
  // pose object, so it is not shown while the body is moving.
  if (!simulation) {
    const highlight = buildSkeletonMesh(document_, resolveMorphology(currentMorphology()).context, {
      quality: QUALITIES[ui.quality.value] ?? QUALITY_MEDIUM,
      include: new Set([bone.id]),
    });
    selectedObject = new Mesh(toSkeletonGeometry(highlight), selectedMaterial);
    world.add(selectedObject);
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
      <dt>Position</dt><dd>${position.x.toFixed(3)}, ${position.y.toFixed(3)}, ${position.z.toFixed(3)}</dd>
      <dt>Vertices</dt><dd>${bone.vertexCount.toLocaleString()}</dd>
      <dt>Geometry</dt><dd>${bone.geometrySource}</dd>
      <dt>Landmarks</dt><dd>${Object.keys(assets?.landmarks[bone.id] ?? {}).length}</dd>
    </dl>
  `;
}

// ---------------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------------

function setSimulationStatus(text: string, error = false): void {
  const status = must<HTMLElement>('#sim-status');
  status.textContent = text;
  status.classList.toggle('error', error);
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
  if (!simulation) return;
  grabState = null;
  simulation.dispose();
  simulation = null;
  overlays?.dispose();
  overlays = null;
  clearFurniture();
  followFurnitureKey = '';
  must<HTMLElement>('#diagnostics').hidden = true;
  must<HTMLElement>('#timeline-control').hidden = true;
  skinned?.rest();
  setRunControls(false);
  setSimulationStatus('At rest.');
}

/**
 * The two sets of buttons, which answer two different questions.
 *
 * Start and Pause are about whether the simulation is computing. Play, the frame steps and the
 * playhead are about where in what it has already computed you are looking. They were one set
 * before -- Run, Pause, Step, Reset and a timeline that re-simulated what you scrubbed over --
 * and the reason that was confusing is that it was two things wearing one set of labels.
 */
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

function setRunControls(running: boolean): void {
  // Start always begins a run with the current settings; a run in progress is replaced.
  setMode(!running ? 'rest' : simulation?.paused ? 'paused' : 'running');
  ui.simStart.disabled = false;
  ui.simStart.textContent = !running ? 'Start sim' : simulation?.paused ? 'Resume sim' : 'Restart';
  ui.simPause.disabled = !running || simulation?.paused === true;
  ui.reset.disabled = !running;
  ui.exportRecording.disabled = !running;
  ui.exportBlender.disabled = !running;
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
  // Rapier is disabled and hidden (ADR-003 reassessment); a saved session naming it falls back.
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
  rebuild();
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
  carry?: { state: ReturnType<Simulation['jointState']>; ticks: number; paused: boolean },
): Promise<void> {
  if (!skeletonMesh || !skinned) return;
  if (bridgeFollower.active) stopFollowing();
  stopSimulation();
  setSimulationStatus('Compiling…');
  try {
    const chosen = currentScenario();
    const sim = new Simulation(document_, resolveMorphology(currentMorphology()), {
      profileId: ui.profile.value,
      backend: ui.backend.value as BackendId,
      passiveJoints: ui.passive.checked,
      redistribute: ui.redistribute.checked,
      scenario: chosen,
      dropHeight: Number(ui.dropHeight.value),
      groundHeight: groundY,
      // A scenario that drives muscles gets them whether the box is ticked or not: the box is
      // there to keep them off the runs that do not need them, not to make a muscle scenario
      // silently run a bare skeleton.
      muscles: ui.muscles.checked || chosen?.muscles === true,
      // Only when somebody moved it. Left alone, each profile keeps the step rate its solver was
      // tuned for, which is the number that ought to win by default.
      ...(fidelityTouched ? { stepsPerSecond: Number(ui.stepsPerSecond.value) } : {}),
      outputFramerate: Number(ui.outputFramerate.value),
      nerves: brain?.setup,
      // A checkpoint trained with nothing under the brain has never felt a scenario's tone, so
      // the scenario's script does everything else it does and drives no muscle.
      scriptMuscleDrive: brain?.chosenRecipe()?.feedforward.kind !== 'none',
    });
    await sim.start();
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
    if (carry) {
      const unmatched = sim.carryFrom(carry.state, carry.ticks);
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
    refreshSelection();
    setRunControls(true);
    setSimulationStatus('Running.');
  } catch (error) {
    console.error('The simulation failed to start.', error);
    setSimulationStatus(error instanceof Error ? error.message : String(error), true);
    setRunControls(false);
  }
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

/** Leave live, pause the simulation, and put the playhead where it is being asked for. */
function scrubTo(frame: number): void {
  if (!simulation) return;
  const frames = capturedFrames();
  if (frames <= 0) return;
  following = false;
  playback.playing = false;
  simulation.paused = true;
  playback.frame = Math.min(Math.max(frame, 0), frames - 1);
  applyOverlayVisibility();
  setRunControls(true);
  updateTimeline(simulation);
}

/** Back to the newest frame, and following it again. */
function goLive(): void {
  if (!simulation) return;
  following = true;
  playback.playing = false;
  playback.frame = Math.max(0, capturedFrames() - 1);
  applyOverlayVisibility();
  setRunControls(true);
  updateTimeline(simulation);
}

function updateTimeline(sim: Simulation): void {
  const frames = capturedFrames();
  const frame = following ? Math.max(0, frames - 1) : playback.clampedFrame(frames);
  ui.timeline.max = String(Math.max(0, frames - 1));
  if (!scrubbing) ui.timeline.value = String(frame);
  const fps = Math.max(1, sim.outputFramerate);
  must<HTMLOutputElement>('#timeline-value').textContent =
    frames === 0
      ? '—'
      : `frame ${frame} of ${frames - 1} · ${(frame / fps).toFixed(2)} s` +
        (following ? ' · live' : '');
  must<HTMLElement>('#playback-note').textContent =
    frames === 0
      ? ''
      : `${frames} frames recorded at ${fps} fps, ${(frames / fps).toFixed(2)} s` +
        (following ? '.' : ' — the simulation is paused while the playhead is behind it.');
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

ui.playToggle.addEventListener('click', () => {
  if (!simulation || capturedFrames() <= 1) return;
  if (playback.playing) {
    playback.playing = false;
  } else {
    following = false;
    simulation.paused = true;
    // Replaying from the end plays nothing, so a Play pressed there starts over.
    if (playback.clampedFrame(capturedFrames()) >= capturedFrames() - 1) playback.frame = 0;
    playback.playing = true;
  }
  applyOverlayVisibility();
  setRunControls(true);
});
ui.frameBack.addEventListener('click', () => {
  scrubTo(playback.clampedFrame(capturedFrames()) - 1);
});
ui.frameForward.addEventListener('click', () => {
  if (!simulation) return;
  const frames = capturedFrames();
  const at = following ? frames - 1 : playback.clampedFrame(frames);
  // At the newest frame there is nothing ahead to step to, so one is computed. That is what the
  // old Step button did, and it is the same gesture: go one frame further on.
  if (at >= frames - 1) {
    simulation.paused = true;
    const ticks = Math.max(1, Math.round(simulation.ticksPerOutputFrame));
    for (let i = 0; i < ticks; i++) simulation.tick();
    simulation.pose.step();
    simulation.metrics.step();
    // The belly sweep runs on a divisor while the simulation is running; a hand-stepped frame
    // asks for it directly so what is drawn is this tick's shape rather than up to eight back.
    simulation.sweepRenderMesh();
    goLive();
    return;
  }
  scrubTo(at + 1);
});
ui.goLive.addEventListener('click', goLive);

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
  const live = following;
  overlays.proxies.visible = ui.showProxies.checked;
  overlays.axes.visible = ui.showAxes.checked && live;
  overlays.com.visible = ui.showCom.checked && live;
  overlays.contacts.visible = ui.showContacts.checked && live;
  overlays.tissue.visible = ui.showTissue.checked;
  overlays.muscles.visible = ui.showMuscles.checked && live;
  overlays.muscleVolumes.visible = ui.showMuscleVolumes.checked;
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

/**
 * The muscle paths and how hard each is pulling, for the overlay.
 *
 * Tension is the fraction of the unit's own maximum isometric force, so a small muscle working
 * hard reads as hard as a big one. Absolute newtons would colour the whole arm by which muscle
 * happens to be the strongest.
 */
/** The tissue in bone frames, for the headset: a segment's frame is its anchor bone's. */
let tissueCache: { sim: Simulation; table: VrStatus['tissue'] } | undefined;
function tissueForBridge(sim: Simulation): VrStatus['tissue'] {
  if (tissueCache?.sim === sim) return tissueCache.table;
  const table = tissueTable(sim.articulation);
  tissueCache = { sim, table };
  return table;
}

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

/**
 * Bone transforms for the frame the playhead is on, or nothing if it cannot be read.
 *
 * Nothing is stepped to get here: the recording already holds every tick, and the playhead's
 * output frame is one of them.
 */
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
  const mesh = playback.bellyAt(
    sim.muscleCapture,
    tick,
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
 * default is two thirds of it. Done once at startup, because neither number changes.
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
 * What the muscles are pulling with, grouped the way a person thinks about an elbow.
 *
 * "Loaded" counts the units whose tendon is carrying anything at all. It earned its place when
 * three of the seven were not: their straight-line paths were shorter than their own resting
 * length, so the tendon never took up. Via points fixed that and the count now reads full at rest,
 * which is exactly why it is worth keeping on screen. Both arms are counted together.
 */
function updateMuscles(sim: Simulation): void {
  const state = sim.muscleState();
  const units = sim.muscles?.units;
  if (!state || !units) return;
  const pulled: number[] = MUSCLE_GROUPS.map(() => 0);
  let loaded = 0;
  let strained = 0;
  for (let i = 0; i < units.length; i++) {
    const force = state.tendonForce[i] ?? 0;
    if (force > 0) loaded++;
    if ((state.diagnostic[i] ?? 0) !== 0) strained++;
    // Summed per driven group, and nothing outside one is counted. Before the shoulder set
    // arrived "not a flexor" meant "an extensor"; now it would mean the deltoid too, and the
    // readout would say a hanging arm's extensors were pulling ten kilonewtons.
    const id = units[i]?.id ?? '';
    MUSCLE_GROUPS.forEach((group, at) => {
      if (group.units.includes(id)) pulled[at] = (pulled[at] ?? 0) + force;
    });
  }
  const pair = (flex: number, extend: number) =>
    `${(flex ?? 0).toFixed(0)} / ${(extend ?? 0).toFixed(0)} N`;
  must<HTMLElement>('#muscle-flexion').textContent = pair(
    pulled[groupIndex('flexorDrive')] as number,
    pulled[groupIndex('extensorDrive')] as number,
  );
  must<HTMLElement>('#muscle-extension').textContent = pair(
    pulled[groupIndex('kneeFlexorDrive')] as number,
    pulled[groupIndex('kneeExtensorDrive')] as number,
  );
  must<HTMLElement>('#muscle-loaded').textContent = `${loaded} of ${units.length} units`;
  // How many tendons are in contact with a bone right now. A muscle that is wrapping has its
  // path bent over a surface rather than cutting through it, so this is also the quickest way to
  // tell whether the overlay's curves are curves.
  const contacts = sim.musclePath?.contactCount ?? 0;
  must<HTMLElement>('#muscle-wrapping').textContent =
    `${contacts} contact${contacts === 1 ? '' : 's'}`;
  // Units whose equilibrium did not solve cleanly. It is on screen rather than in a log because
  // it is the one number that says "the force you are reading is a fallback": a muscle whose path
  // is longer than its parameters expect sits at the top of its tendon curve, where the model
  // holds it rather than extrapolating, and the force it reports is the cap.
  must<HTMLElement>('#muscle-strained').textContent =
    strained === 0 ? 'none' : `${strained} of ${units.length} units`;
}

function updateDiagnostics(sim: Simulation): void {
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
  must<HTMLElement>('#diag-rate').textContent =
    achieved > 0
      ? `${achieved.toFixed(0)} Hz of ${declared.toFixed(0)} steps · ${(achieved / declared).toFixed(2)}x life`
      : `${declared.toFixed(0)} Hz steps`;
  updateMuscles(sim);
}

ui.muscles.addEventListener('change', () => {
  must<HTMLElement>('#muscle-control').hidden = !ui.muscles.checked;
  // The modules are registered when a run starts, so turning this on mid-run changes nothing
  // until the next one. Saying so beats a checkbox that appears to do nothing.
  if (simulation && ui.muscles.checked && !simulation.muscles) {
    setSimulationStatus('Muscles start with the next run.');
  }
});
// Explanatory text is off by default: the panel has thirteen paragraphs and a reader wants at
// most one of them at a time. The notes that carry a live value are marked `live` and stay.
// The brain panel is made once the follow code below exists; runs read its setup when they start.
// biome-ignore lint/style/useConst: assigned once, but below the code that reads it, so a `const` there would be in its dead zone for the handlers above.
let brain: ReturnType<typeof createBrainPanel> | undefined;
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
// and the numbers for the views. Never while typing into a control.
window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLButtonElement;
  if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
  switch (event.key) {
    case ' ':
      event.preventDefault();
      if (simulation && !simulation.paused && !bridgeFollower.active) ui.simPause.click();
      else ui.simStart.click();
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
    default:
      return;
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

ui.simStart.addEventListener('click', () => {
  // Paused mid-run, or scrubbed back into it: carry on from the newest frame rather than
  // throwing the run away. Anything else starts a fresh one with the settings as they stand.
  if (simulation && (simulation.paused || !following)) {
    simulation.paused = false;
    goLive();
    return;
  }
  void startSimulation();
});
ui.simPause.addEventListener('click', () => {
  if (!simulation) return;
  simulation.paused = true;
  setRunControls(true);
});
ui.reset.addEventListener('click', () => {
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
// The cursor says whether a press will reach into the scene or move around it.
const setReachCursor = (reaching: boolean) => {
  renderer.domElement.style.cursor = reaching ? 'grab' : '';
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
 */
async function saving(what: string, write: Promise<boolean>): Promise<void> {
  try {
    if (await write) setSimulationStatus(`Wrote ${what}.`);
  } catch (error) {
    console.error(`Writing ${what} failed.`, error);
    setSimulationStatus(error instanceof Error ? error.message : String(error), true);
  }
}

ui.exportRecording.addEventListener('click', () => {
  if (!simulation) return;
  const name = `bs-humany-${simulation.recording.scenario}-${simulation.backendId}.json`;
  void saving(name, download(name, simulation.exportRecording()));
});
ui.exportBlender.addEventListener('click', () => {
  if (!simulation || !assets) return;
  const built = buildBlenderExport(simulation, document_, assets);
  // All three together, because none is any use without the others: the glTF holds the bones and
  // the belly mesh, the cache holds the bellies' movement, and the script is what wires the one
  // to the other. One folder in the desktop shell; three downloads in a browser, which is all a
  // page can do.
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
  void saving(`${files.length} files for Blender`, downloadSet(files));
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
    applySettings(parsed.settings);
    if (parsed.simulation) await startSimulation(parsed.simulation);
  } catch (error) {
    console.error('The session failed to load.', error);
    setSimulationStatus(error instanceof Error ? error.message : String(error), true);
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
  } catch {
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

  if (!simulation) vrLink?.idle();
  // The brain panel's picture: this page's policy, or the training showcase's.
  drawNerves(simulation ?? undefined);
  // Scenery that moves -- a platform tilting under the body -- drawn where the solver has it.
  if (simulation) followFurniture(simulation);
  if (bridgeFollower.active && skinned) followFrame(skinned);
  if (simulation && skinned) {
    const frameSeconds = Math.min(elapsed, 250) / 1000;
    if (following) {
      // The elapsed time is measurement only: what the frame advances is one output frame's worth
      // of simulated time, whatever the clock says.
      simulation.advance(frameSeconds);
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
    skinned.update(simulation.boneOrder(), transforms.position, transforms.orientation);
    vrLink?.frame(transforms.position, transforms.orientation);
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
    updateDiagnostics(simulation);
    updateTimeline(simulation);
    must<HTMLElement>('#diag-cost').textContent = `${simulation.lastStepMs.toFixed(3)} ms`;
    const capture = simulation.capture;
    // Both captures, because the muscle one is what usually stops first and it used to stop
    // invisibly: a hundred and forty-eight bellies at twenty-four rings apiece are twenty times
    // a frame of bones, so on the same budget the rings run out after about five seconds while
    // this line went on counting bone frames to ninety.
    const rings = simulation.muscleCapture;
    // Each capture against its own budget, not the two summed against twice it: the muscle
    // capture is twenty times the bone capture and reaches the limit on its own, which summed
    // reads as though the run stopped at half of what it was allowed.
    const mb = (bytes: number) => `${(bytes / MEBIBYTE).toFixed(0)} MB`;
    const held = simulation.muscleVolume
      ? `muscles ${mb(rings.bytes)}, bones ${mb(capture.bytes)}, of ${mb(simulation.captureBudgetBytes)} each`
      : `${mb(capture.bytes)} of ${mb(simulation.captureBudgetBytes)}`;
    must<HTMLElement>('#capture-status').textContent =
      `Captured ${capture.frameCount} frames for export (${held})` +
      (simulation.capturesStoppedBy === undefined
        ? '.'
        : simulation.capturesStoppedBy === 'muscles'
          ? ' — the muscle capture reached its budget and both stopped; earlier frames kept. ' +
            'Pause, raise the budget below, and it carries on.'
          : ' — capture budget reached; earlier frames kept. Pause, raise the budget below, and ' +
            'it carries on.');
    const seconds = (simulation.ticks * simulation.dt).toFixed(2);
    // How fast, never whether anything was lost: nothing is. Below life speed the machine is
    // simply taking longer over the same ticks, and the run it produces is the same run.
    const speed = simulation.achievedRateHz / simulation.declaredRateHz;
    setSimulationStatus(
      simulation.paused
        ? `Paused at ${seconds} s.`
        : speed > 0.01 && Math.abs(speed - 1) >= 0.05
          ? `Running, ${seconds} s simulated, at ${speed.toFixed(2)}x life speed.`
          : `Running, ${seconds} s simulated.`,
    );
  }

  renderer.render(scene, camera);

  must<HTMLElement>('#stat-frame').textContent = `${frameMs.toFixed(1)} ms`;
  must<HTMLElement>('#stat-draws').textContent = String(renderer.info.render.calls);
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
    const trained = sim.scenarioNerves?.policy.trained;
    ui.note.textContent =
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

loadAssets('lod1')
  .then((loaded) => {
    assets = loaded;
    must<HTMLElement>('#attribution').textContent = attributionText(loaded.manifest);
    must<HTMLElement>('#attribution').hidden = false;
    must<HTMLElement>('#loading').hidden = true;
    rebuild();
    if (STAY_ON_SMALL_PACK) return;
    return loadAssets('full').then((full) => {
      assets = full;
      rebuild();
    });
  })
  .catch((error: unknown) => {
    console.error('The measured skeleton failed to load.', error);
    const loading = must<HTMLElement>('#loading');
    loading.textContent = 'The measured skeleton failed to load. See the console.';
    loading.classList.add('error');
  });

function must<T extends Element>(selector: string): T {
  const element = window.document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
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
      muscleReadout: Object.fromEntries(
        (['flexion', 'extension', 'loaded', 'wrapping', 'strained'] as const).map((key) => [
          key,
          must<HTMLElement>(`#muscle-${key}`).textContent ?? '',
        ]),
      ),
      tension: sim ? Array.from(muscleOverlay(sim)?.tension ?? []) : [],
      tissue: sim ? tissueForBridge(sim) : { discs: [], bars: [] },
      brain: brain?.state() ?? {
        serverUp: false,
        active: false,
        authority: 0,
        selected: '',
        checkpoints: [],
        fit: '',
        training: '',
        trainingRunning: false,
        trainingStoppable: false,
        following: bridgeFollower.active,
      },
    };
  },
  command(command: VrCommand): void {
    switch (command.kind) {
      case 'pause':
        ui.simPause.click();
        break;
      case 'resume':
        ui.simStart.click();
        break;
      case 'reset':
        ui.reset.click();
        break;
      case 'step':
        (command.frames > 0 ? ui.frameForward : ui.frameBack).click();
        break;
      case 'scrub':
        if (simulation) scrubTo(Math.round(command.seconds * simulation.outputFramerate));
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
          case 'crural':
          case 'brachial':
          case 'legLength':
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
    setSimulationStatus(message);
    // And on the terminal, beside the viewer's own lines, where a failure can actually be read.
    void invoke('studio_log', { message }).catch(() => undefined);
  },
};

if (isTauri()) {
  connectVr.hidden = false;
  connectVr.addEventListener('click', () => {
    void (async () => {
      if (vrLink) {
        await vrLink.disconnect();
        vrLink = null;
        connectVr.textContent = 'Connect VR viewer';
        setSimulationStatus('VR viewer disconnected.');
        return;
      }
      connectVr.disabled = true;
      try {
        const link = new VrLink(vrHost);
        await link.connect();
        vrLink = link;
        connectVr.textContent = 'Disconnect VR viewer';
      } catch (error) {
        setSimulationStatus(error instanceof Error ? error.message : String(error), true);
      } finally {
        connectVr.disabled = false;
      }
    })();
  });
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
  setSimulationStatus('At rest.');
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
 * The Align tab: the reference models beside ours, and the points of ours that need moving.
 *
 * Built once and given the scene, because it draws into the same world the body is in. Its
 * reference data is fetched rather than bundled, so a studio nobody aligns anything in never
 * pays for it.
 */
align = createAlignPanel(
  {
    articulation: () => simulation?.articulation,
    units: () => simulation?.muscles?.units.map((u) => u.id) ?? [],
    /**
     * Where our joints that touch a segment sit in the world at rest.
     *
     * Each carries the segment on the other side of it, which is how a joint of theirs is
     * matched to one of ours: both models agree a hip is a hip, so the joint between two paired
     * bones is the same joint in both, and matched joints are what a rotation is fitted from. A
     * joint is counted whether the segment is its parent or its child, because a femur is
     * bounded by the hip above it and the knee below.
     */
    jointsOn: (segment) => {
      const sim = simulation;
      if (!sim) return [];
      const index = sim.articulation.segments.findIndex((s) => s.id === segment);
      if (index < 0) return [];
      const out: { at: Vector3; other: string; axes: Vector3[] }[] = [];
      for (const joint of sim.articulation.joints) {
        const onParent = joint.parentSegment === index;
        const onChild = joint.childSegment === index;
        if (!onParent && !onChild) continue;
        const seg = sim.articulation.segments[onParent ? joint.parentSegment : joint.childSegment];
        const other =
          sim.articulation.segments[onParent ? joint.childSegment : joint.parentSegment];
        const frame = onParent ? joint.frameInParent : joint.frameInChild;
        if (!seg || !other) continue;
        const p = transformPoint(seg.restWorld, frame.translation);
        // The hinge axes in the world: stated in the joint frame, carried out through the
        // joint's frame in the segment and the segment's own rest pose.
        const spin = new Quaternion(
          seg.restWorld.rotation.x,
          seg.restWorld.rotation.y,
          seg.restWorld.rotation.z,
          seg.restWorld.rotation.w,
        ).multiply(
          new Quaternion(frame.rotation.x, frame.rotation.y, frame.rotation.z, frame.rotation.w),
        );
        const axes: Vector3[] = [];
        for (const dof of joint.dofs) {
          if (dof.kind !== 'hinge') continue;
          const v = new Vector3(dof.vector.x, dof.vector.y, dof.vector.z)
            .applyQuaternion(spin)
            .normalize();
          if (v.lengthSq() > 1e-9 && !axes.some((a) => Math.abs(a.dot(v)) > 0.999)) axes.push(v);
        }
        out.push({ at: new Vector3(p.x, p.y, p.z), other: other.id, axes });
      }
      return out;
    },
    sites: () => {
      const sim = simulation;
      if (!sim?.muscles) return [];
      const at = new Map(sim.articulation.segments.map((seg) => [seg.id, seg]));
      const out: { id: string; bone: string; world: { x: number; y: number; z: number } }[] = [];
      for (const path of sim.muscles.paths) {
        for (const [end, where] of [
          ['origin', path.origin],
          ['insertion', path.insertion],
        ] as const) {
          const seg = at.get(where.bone);
          if (!seg) continue;
          out.push({
            id: `${path.id}:${end}`,
            bone: where.bone,
            world: transformPoint(seg.restWorld, where.point),
          });
        }
      }
      return out;
    },
    /**
     * Light up one of our segments, or clear it with undefined.
     *
     * Built from the bones the segment owns -- a segment is several bones, and `thigh_r` has to
     * light up as a femur rather than as a dot at an origin. It is a rest-pose object, like the
     * inspector's highlight, which suits: the retargeted paths are drawn at rest too, and
     * pairing is something done to a body standing still.
     */
    highlightSegment: (id) => {
      if (!skinned) return;
      const segment = id ? simulation?.articulation.segments.find((s) => s.id === id) : undefined;
      skinned.tint(segment ? new Set(segment.bones) : undefined, ALIGNED_TINT);
    },
    save: (name, text) => void download(name, text, 'application/json'),
    setGizmoDragging: (dragging) => {
      gizmoDragging = dragging;
    },
  },
  camera,
  renderer,
);
align.attach(world);
void loadSourceSites().then((data) => {
  if (data) align?.adopt(data);
});

brain = createBrainPanel({
  handOver(setup) {
    // Live: the nerves are in every muscle run, so the policy goes in between one control step
    // and the next, and nothing restarts. A run that is not going takes it when it starts.
    if (!simulation) return;
    if (!setup) {
      simulation.releaseBrain();
      return;
    }
    try {
      // The cord the checkpoint was trained over travels with it: a policy brought up on a body
      // that answered its own stretch is not the same controller on a body that does not.
      simulation.handOver(setup.policy, setup.authority, setup.policy.recipe?.reflex);
    } catch (error) {
      setSimulationStatus(String(error), true);
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
    const cord = recipe.reflex;
    if (cord) {
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
    setSimulationStatus(
      `Set from the checkpoint ${recipe.name}: its scene, body and joints` +
        (recipe.stepsPerSecond ? `, and its ${recipe.stepsPerSecond} steps a second` : '') +
        (recipe.feedforward.kind === 'none' ? ', with the muscle sliders back to zero' : '') +
        '. They take effect on the next run.',
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
void brain.poll();
window.setInterval(() => {
  if (tabs.active === 'brain' || bridgeFollower.active) void brain?.poll();
}, 3000);
