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
import manifestUrl from '@bs-humany/assets-anatomical/data/manifest.json?url';
import skeletonBinUrl from '@bs-humany/assets-anatomical/data/skeleton.bin?url';
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
import { buildDocument, modelLimitations } from '@bs-humany/skeleton';
import {
  AmbientLight,
  Color,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { createOrbitControls } from './orbit.js';

// The document is built once. Only the morphology context changes as the sliders move, which is
// exactly the separation ADR-005 is for: anatomy is fixed, geometry is parametric.
const datasetDocument = buildDocument();
const proceduralDocument = buildDocument({ placement: 'procedural' });
/** The document in use: measured placement with the mesh pack, or the hand-authored layout. */
let document_ = datasetDocument;

/**
 * The measured mesh pack (ADR-005, ADR-011). Loaded once; `null` until it arrives, during which
 * the procedural skeleton renders so the page is never blank.
 */
let assets: SkeletonAssets | null = null;

async function loadAssets(): Promise<SkeletonAssets> {
  const [manifest, bin, landmarks] = await Promise.all([
    fetch(manifestUrl).then((r) => r.json()),
    fetch(skeletonBinUrl).then((r) => r.arrayBuffer()),
    fetch(landmarksUrl).then((r) => r.json()),
  ]);
  return parseSkeletonAssets(manifest, bin, landmarks);
}

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

const controls = createOrbitControls(camera, renderer.domElement, new Vector3(0, 0.9, 0));

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
let boneObject: Mesh | null = null;
let selectedObject: Mesh | null = null;
let selectedBoneId: string | null = null;

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
  geometry: must<HTMLSelectElement>('#geometry'),
  showGrid: must<HTMLInputElement>('#showGrid'),
  spin: must<HTMLInputElement>('#spin'),
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
  const started = performance.now();

  const morphology = currentMorphology();
  const resolved = resolveMorphology(morphology);

  // Spec section 6.4 step 5. A body that fails these checks would still render; it would simply be
  // wrong, so the failure is surfaced rather than swallowed.
  const validation = validateResolvedBody(resolved);
  if (!validation.valid) {
    console.error('Resolved body failed physical validity checks:', validation.problems);
  }

  const quality = QUALITIES[ui.quality.value] ?? QUALITY_MEDIUM;
  const useDataset = ui.geometry.value === 'dataset' && assets !== null;
  document_ = useDataset ? datasetDocument : proceduralDocument;
  skeletonMesh = buildSkeletonMesh(document_, resolved.context, {
    quality,
    ...(useDataset && assets ? { assets } : {}),
  });

  if (boneObject) {
    boneObject.geometry.dispose();
    scene.remove(boneObject);
  }
  boneObject = new Mesh(toSkeletonGeometry(skeletonMesh), boneMaterial);
  scene.add(boneObject);

  // Sit the skeleton on the grid: the feet land a little above the origin because the layout is
  // built from joint centres rather than from the sole.
  const { min } = skeletonBounds(skeletonMesh);
  boneObject.position.y = -min[1];

  buildMs = performance.now() - started;
  refreshSelection();
  updateReadouts(resolved.input.stature, resolved.input.mass);
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
ui.geometry.addEventListener('change', rebuild);
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

renderer.domElement.addEventListener('click', (event) => {
  if (controls.wasDragging()) return;
  if (!boneObject || !skeletonMesh) return;

  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const hits = raycaster.intersectObject(boneObject, false);
  const hit = hits[0];
  if (!hit || hit.face === undefined || hit.face === null) {
    selectedBoneId = null;
    refreshSelection();
    return;
  }

  // The merge into one draw call keeps per-bone identity as a vertex attribute, so a face index
  // still resolves to a bone id.
  const attribute = boneObject.geometry.getAttribute('boneIndex');
  const index = attribute.getX(hit.face.a);
  selectedBoneId = skeletonMesh.bones[index]?.id ?? null;
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

  // Highlight by rebuilding just this bone's slice of the merged buffer.
  const highlight = buildSkeletonMesh(document_, resolveMorphology(currentMorphology()).context, {
    quality: QUALITIES[ui.quality.value] ?? QUALITY_MEDIUM,
    include: new Set([bone.id]),
  });
  selectedObject = new Mesh(toSkeletonGeometry(highlight), selectedMaterial);
  selectedObject.position.y = boneObject?.position.y ?? 0;
  scene.add(selectedObject);

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

rebuild();
animate();

loadAssets()
  .then((loaded) => {
    assets = loaded;
    must<HTMLElement>('#attribution').textContent = attributionText(loaded.manifest);
    must<HTMLElement>('#attribution').hidden = false;
    rebuild();
  })
  .catch((error: unknown) => {
    console.error('Mesh pack failed to load; staying on procedural geometry.', error);
    ui.geometry.value = 'procedural';
    ui.geometry.disabled = true;
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
