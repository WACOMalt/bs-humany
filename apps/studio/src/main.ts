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
  SCENARIO_DEFINITIONS,
  type ScenarioDefinition,
  inertiaAudit,
  jointSweep,
} from '@bs-humany/scenarios';
import { buildDocument, modelLimitations } from '@bs-humany/skeleton';
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
import { buildBlenderExport } from './blenderExport.js';
import { createOrbitControls } from './orbit.js';
import { type Overlays, createOverlays } from './overlays.js';
import {
  type SessionFile,
  type SessionSettings,
  deserializeSnapshot,
  download,
  downloadBytes,
  isSessionFile,
  serializeSnapshot,
} from './session.js';
import { type BackendId, Simulation } from './simulation.js';
import { type SkinnedSkeleton, createSkinnedSkeleton } from './skinning.js';

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
renderer.setSize(window.innerWidth, window.innerHeight);
viewport.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0x14161a);

const camera = new PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.05, 60);

/**
 * The camera starts at negative Z.
 *
 * The canonical frame puts anterior at `-Z` (ADR-010), matching three.js object-forward, so a
 * front view means standing in front of the subject at negative Z rather than the default positive.
 */
camera.position.set(1.5, 1.1, -2.6);

const controls = createOrbitControls(camera, renderer.domElement, new Vector3(0, 0.9, 0), {
  claimPointer: (event) => beginGrab(event),
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

const grid = new GridHelper(6, 24, 0x3a4250, 0x252a33);
scene.add(grid);

const boneMaterial = new MeshStandardMaterial({
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

let skeletonMesh: SkeletonMesh | null = null;
let skinned: SkinnedSkeleton | null = null;
let selectedObject: Mesh | null = null;
let selectedBoneId: string | null = null;
let simulation: Simulation | null = null;
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
  drop: must<HTMLButtonElement>('#drop'),
  pause: must<HTMLButtonElement>('#pause'),
  stepOnce: must<HTMLButtonElement>('#step'),
  reset: must<HTMLButtonElement>('#reset'),
  backend: must<HTMLSelectElement>('#backend'),
  scenario: must<HTMLSelectElement>('#scenario'),
  scenarioParameters: must<HTMLDivElement>('#scenario-parameters'),
  timeline: must<HTMLInputElement>('#timeline'),
  exportRecording: must<HTMLButtonElement>('#export'),
  exportBlender: must<HTMLButtonElement>('#export-blender'),
  exportBlenderScript: must<HTMLButtonElement>('#export-blender-script'),
  save: must<HTMLButtonElement>('#save'),
  load: must<HTMLButtonElement>('#load'),
  loadFile: must<HTMLInputElement>('#load-file'),
  showProxies: must<HTMLInputElement>('#showProxies'),
  showAxes: must<HTMLInputElement>('#showAxes'),
  showCom: must<HTMLInputElement>('#showCom'),
  showContacts: must<HTMLInputElement>('#showContacts'),
};

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
    scene.remove(skinned.mesh);
    skinned.dispose();
  }
  skinned = createSkinnedSkeleton(skeletonMesh, toSkeletonGeometry(skeletonMesh), boneMaterial);
  scene.add(skinned.mesh);

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
    scene.remove(selectedObject);
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
    scene.add(selectedObject);
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
  if (furniture) {
    scene.remove(furniture);
    for (const child of furniture.children) if (child instanceof Mesh) child.geometry.dispose();
    furniture = null;
  }
  must<HTMLElement>('#diagnostics').hidden = true;
  must<HTMLElement>('#timeline-control').hidden = true;
  skinned?.rest();
  setRunControls(false);
  setSimulationStatus('At rest.');
}

function setRunControls(running: boolean): void {
  // Run always restarts with the current settings; a run in progress is replaced.
  ui.drop.disabled = false;
  ui.drop.textContent = running ? 'Restart' : 'Run';
  ui.pause.disabled = !running;
  ui.stepOnce.disabled = !running;
  ui.reset.disabled = !running;
  ui.exportRecording.disabled = !running;
  ui.exportBlender.disabled = !running;
  ui.exportBlenderScript.disabled = !running;
  ui.pause.textContent = simulation?.paused ? 'Resume' : 'Pause';
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

/** Draw a scenario's static boxes so the body has something visible to land on. */
function showFurniture(sim: Simulation): void {
  if (sim.staticBoxes.length === 0) return;
  furniture = new Group();
  const material = new MeshStandardMaterial({ color: 0x4a5566, roughness: 0.9 });
  for (const box of sim.staticBoxes) {
    const mesh = new Mesh(
      new BoxGeometry(2 * box.halfExtents.x, 2 * box.halfExtents.y, 2 * box.halfExtents.z),
      material,
    );
    mesh.position.set(box.position.x, box.position.y, box.position.z);
    if (box.rotation)
      mesh.quaternion.set(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w);
    furniture.add(mesh);
  }
  scene.add(furniture);
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
    });
    await sim.start();
    if (restoreFrom) sim.restore(deserializeSnapshot(restoreFrom.snapshot), restoreFrom.ticks);
    if (carry) {
      const unmatched = sim.carryFrom(carry.state, carry.ticks);
      sim.paused = carry.paused;
      if (unmatched.length > 0)
        console.warn('DoFs without a counterpart, left at neutral:', unmatched);
    }
    simulation = sim;
    overlays = createOverlays(sim.articulation);
    scene.add(overlays.root);
    applyOverlayVisibility();
    showFurniture(sim);
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

function updateTimeline(sim: Simulation): void {
  const seconds = sim.recordedSeconds;
  ui.timeline.max = seconds.toFixed(2);
  if (!scrubbing) ui.timeline.value = seconds.toFixed(2);
  must<HTMLOutputElement>('#timeline-value').textContent =
    `${Number(ui.timeline.value).toFixed(2)} s`;
}

let scrubbing = false;
ui.timeline.addEventListener('pointerdown', () => {
  scrubbing = true;
  if (simulation) {
    simulation.paused = true;
    setRunControls(true);
  }
});
ui.timeline.addEventListener('input', () => {
  if (!simulation) return;
  simulation.scrubTo(Number(ui.timeline.value));
  must<HTMLOutputElement>('#timeline-value').textContent =
    `${Number(ui.timeline.value).toFixed(2)} s`;
});
window.addEventListener('pointerup', () => {
  scrubbing = false;
});

function applyOverlayVisibility(): void {
  if (!overlays) return;
  overlays.proxies.visible = ui.showProxies.checked;
  overlays.axes.visible = ui.showAxes.checked;
  overlays.com.visible = ui.showCom.checked;
  overlays.contacts.visible = ui.showContacts.checked;
}
for (const input of [ui.showProxies, ui.showAxes, ui.showCom, ui.showContacts]) {
  input.addEventListener('change', applyOverlayVisibility);
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
}

ui.drop.addEventListener('click', () => {
  void startSimulation();
});
ui.pause.addEventListener('click', () => {
  if (!simulation) return;
  simulation.paused = !simulation.paused;
  setRunControls(true);
});
ui.stepOnce.addEventListener('click', () => {
  if (!simulation) return;
  simulation.paused = true;
  simulation.tick();
  simulation.pose.step();
  simulation.metrics.step();
  setRunControls(true);
});
ui.reset.addEventListener('click', () => {
  if (!simulation) return;
  simulation.reset();
  simulation.paused = true;
  setRunControls(true);
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

ui.scenario.addEventListener('change', () => {
  const definition = definitionFor(ui.scenario.value);
  must<HTMLElement>('#scenario-note').textContent = definition?.description ?? '';
  must<HTMLElement>('#dropHeight-control').hidden = definition !== undefined;
  ui.passive.disabled = definition !== undefined;
  refreshScenarioParameters();
  const chosen = currentScenario();
  if (chosen) ui.passive.checked = chosen.passiveJoints;
});
ui.exportRecording.addEventListener('click', () => {
  if (!simulation) return;
  download(
    `bs-humany-${simulation.recording.scenario}-${simulation.backendId}.json`,
    simulation.exportRecording(),
  );
});
ui.exportBlender.addEventListener('click', () => {
  if (!simulation || !assets) return;
  const built = buildBlenderExport(simulation, document_, assets);
  downloadBytes(built.glbFileName, built.glb, 'model/gltf-binary');
});
ui.exportBlenderScript.addEventListener('click', () => {
  if (!simulation || !assets) return;
  const built = buildBlenderExport(simulation, document_, assets);
  download(built.scriptFileName, built.script, 'text/x-python');
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
  download('bs-humany-session.json', JSON.stringify(file));
});
ui.load.addEventListener('click', () => ui.loadFile.click());
ui.loadFile.addEventListener('change', async () => {
  const file = ui.loadFile.files?.[0];
  if (!file) return;
  try {
    const parsed: unknown = JSON.parse(await file.text());
    if (!isSessionFile(parsed)) throw new Error('Not a bs-humany session file.');
    applySettings(parsed.settings);
    if (parsed.simulation) await startSimulation(parsed.simulation);
  } catch (error) {
    console.error('The session failed to load.', error);
    setSimulationStatus(error instanceof Error ? error.message : String(error), true);
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
    pointer.x = (x / window.innerWidth) * 2 - 1;
    pointer.y = -(y / window.innerHeight) * 2 + 1;
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
  // Hit point in the segment's own frame: rotate the offset back by the inverse orientation.
  const offset = new Vector3().copy(picked.point).sub(pose.position as Vector3);
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
    {
      x: picked.point.x,
      y: picked.point.y,
      z: picked.point.z,
    },
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
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const target = raycaster.ray.at(grabState.depth, new Vector3());
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

  if (simulation && skinned) {
    const plan = simulation.advance(Math.min(elapsed, 250) / 1000);
    const transforms = simulation.boneTransforms();
    skinned.update(simulation.boneOrder(), transforms.position, transforms.orientation);
    if (overlays) {
      const pose = simulation.channel('body.pose').fields;
      const limits = simulation.channel('diagnostics.limits').fields;
      const contacts = simulation.channel('contact.manifolds');
      overlays.update({
        position: pose.position as Float64Array,
        orientation: pose.orientation as Float64Array,
        proximity: limits.proximity as Float64Array,
        contactCount: contacts.count,
        contactPoint: contacts.fields.point as Float64Array,
        contactNormal: contacts.fields.normal as Float64Array,
        contactCapacity: (contacts.fields.point as Float64Array).length / 3,
      });
    }
    updateDiagnostics(simulation);
    updateTimeline(simulation);
    must<HTMLElement>('#diag-cost').textContent = `${simulation.lastStepMs.toFixed(3)} ms`;
    const capture = simulation.capture;
    must<HTMLElement>('#capture-status').textContent =
      `Captured ${capture.frameCount} frames for export (${(capture.bytes / 1048576).toFixed(0)} MB)` +
      (capture.full ? ' — capture budget reached; earlier frames kept.' : '');
    const seconds = (simulation.ticks * simulation.dt).toFixed(2);
    setSimulationStatus(
      simulation.paused
        ? `Paused at ${seconds} s.`
        : plan.clamped
          ? `Running, ${seconds} s simulated. Slower than real time: frames are being dropped.`
          : `Running, ${seconds} s simulated.`,
      plan.clamped,
    );
  }

  renderer.render(scene, camera);

  must<HTMLElement>('#stat-frame').textContent = `${frameMs.toFixed(1)} ms`;
  must<HTMLElement>('#stat-draws').textContent = String(renderer.info.render.calls);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

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
