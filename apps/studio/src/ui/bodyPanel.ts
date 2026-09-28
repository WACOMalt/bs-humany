/**
 * The body: the Body tab's sliders and what they resolve to, the measured skeleton drawn from
 * them, the inspector, and the hands on the body in the viewport -- a click to inspect a bone, a
 * Ctrl-drag to pull on it.
 *
 * The document is built once, and only the morphology changes as the sliders move, which is
 * exactly the separation ADR-005 is for: anatomy is fixed, geometry is parametric.
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
import {
  type HsdlDocument,
  type Morphology,
  SEX_PARAMETER_LABEL,
  SEX_PARAMETER_NOTE,
} from '@bs-humany/hsdl';
import {
  QUALITY_HIGH,
  type SkeletonMesh,
  buildSkeletonMesh,
  skeletonBounds,
  toSkeletonGeometry,
} from '@bs-humany/render-three';
import type { Simulation } from '@bs-humany/session';
import { Quaternion, Raycaster, Vector2, Vector3 } from 'three';
import type { BridgeFollower } from '../follow.js';
import type { StudioRuns } from '../runController.js';
import { ALIGNED_TINT, type StudioScene, selectionTint } from '../scene.js';
import type { Controls } from '../sessionWiring.js';
import { type SkinnedSkeleton, createSkinnedSkeleton } from '../skinning.js';
import { escapeHtml, messageOf, must } from './dom.js';
import type { HealthPanel } from './healthPanel.js';
import type { StatusLine } from './transport.js';

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

/**
 * How finely the procedural fallback bones are meshed. Only the six ossicles are procedural --
 * every other bone is the measured mesh -- so this is not a user option: the Tessellation select
 * that offered it re-meshed nothing anybody could see, and went. High, because six tiny bones at
 * the finest level cost nothing.
 */
const FALLBACK_QUALITY = QUALITY_HIGH;

/** Pixels out from the pointer to retry a missed pick, and how many tries per ring. */
const PICK_RADII = [6, 14] as const;
const PICK_RING = 8;

/**
 * The inspector with no bone chosen: a live line, so it shows with Explain off. It was an
 * explanatory note, and with the notes hidden the panel was an empty box.
 */
const INSPECTOR_EMPTY = '<p class="note live">Click a bone to inspect it.</p>';

export interface BodyPanelHost {
  readonly document: HsdlDocument;
  readonly scene: StudioScene;
  readonly controls: Controls;
  readonly runs: StudioRuns;
  readonly status: StatusLine;
  readonly health: HealthPanel;
  readonly follower: BridgeFollower;
  /** A new skin was built: a followed body is posed on it afresh. */
  skinBuilt(): void;
  /** What the run readout says with no run. */
  restStatus(): string;
}

export interface BodyPanel {
  /** The measured mesh pack (ADR-005, ADR-011), or null until it has loaded. Nothing renders before. */
  readonly assets: SkeletonAssets | null;
  readonly skeletonMesh: SkeletonMesh | null;
  readonly skinned: SkinnedSkeleton | null;
  /** The rest skeleton's box, measured once a build, for aiming the camera at a body at rest. */
  readonly restBounds: { min: [number, number, number]; max: [number, number, number] } | null;
  /** Where the soles stand, for the next run's floor. */
  readonly groundY: number;
  /** Whether the full mesh pack is still on its way, for the readout at rest. */
  readonly fullDetailPending: boolean;
  /**
   * The body the sliders describe. No limb proportions: nothing measured follows the crural or
   * brachial index or the relative leg length yet (see `modelLimitations`), so the studio no
   * longer offers them and every body resolves at the reference proportions.
   */
  currentMorphology(): Morphology;
  /** Whether the drawn skeleton was last built for the body with this key. */
  builtFor(key: string): boolean;
  /**
   * Build the drawn skeleton for a body, touching neither the sliders nor the run: the one place
   * a skin is made, whether for the sliders' body or for a followed publisher's. The same body
   * with the same pack builds nothing.
   */
  buildSkin(morphology: Morphology): void;
  /** Rebuild the drawn skeleton for the body the sliders show, or a followed publisher's. */
  rebuildMesh(): void;
  /** Cancel a preview still waiting for its frame: whatever asked for it is about to build now. */
  cancelPreview(): void;
  /** Recompile the body after a morphology change, once, when the change is finished. */
  rebuildBody(cause?: string, options?: { always?: boolean }): void;
  /** The Body tab's readouts and the Cost panel's mesh numbers, for these stature and mass. */
  updateReadouts(stature: number, mass: number): void;
  /** The inspector and the tints, again: after a new mesh, or a new run. */
  refreshSelection(): void;
  /** Light up the bones of the segment the Align tab is pairing, under the inspector's own. */
  setAlignedSegment(bones: readonly string[]): void;
  /** The ray the picker casts, for scripted checks of the running page. */
  readonly raycaster: Raycaster;
  /** Pick a bone under the pointer; returns the hit point and bone id, or null. */
  pickBone(clientX: number, clientY: number): { boneId: string; point: Vector3 } | null;
  /** Start holding the segment under the pointer, while Ctrl is down and the body is simulating. */
  beginGrab(event: PointerEvent): boolean;
  /** Let go of whatever the mouse is holding on this run. */
  releaseMouseGrab(sim: Simulation): void;
  /** Forget a grab whose run has gone. */
  forgetGrab(): void;
  /** Fetch the mesh pack and build the body from it. */
  load(): void;
}

export function createBodyPanel(host: BodyPanelHost): BodyPanel {
  const { document: document_, scene: studio, controls: ui, runs, status, health } = host;
  const { world, grid, renderer, camera, controls } = studio;
  const selectionColour = selectionTint(studio.boneMaterial);

  let assets: SkeletonAssets | null = null;
  let skeletonMesh: SkeletonMesh | null = null;
  let skinned: SkinnedSkeleton | null = null;
  let restBounds: { min: [number, number, number]; max: [number, number, number] } | null = null;
  let groundY = 0;
  let buildMs = 0;
  let fullDetailPending = false;
  /**
   * What the drawn skeleton was last built from, so asking again for the same body builds
   * nothing: a slider's release after a drag whose last frame was already previewed is the
   * common case.
   */
  let meshBuiltFor: { key: string; assets: SkeletonAssets } | null = null;
  /** The inspector's bone, tinted on the drawn mesh; see `applyTints`. */
  let selectedBoneId: string | null = null;
  /** The bones of the segment the Align tab is pairing, tinted under the inspector's. */
  let alignedSegmentBones: readonly string[] = [];
  /** The preview rebuild waiting for the next frame, or 0; see `previewMesh`. */
  let previewFrame = 0;
  /**
   * True while the percentile slider is the one moving, so the read-back below does not write a
   * value into the slider under somebody's thumb.
   */
  let percentileDriving = false;
  let grabState: { pointerId: number; depth: number } | null = null;
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const inspector = must<HTMLDivElement>('#inspector');

  const currentMorphology = (): Morphology => ({
    sex: Number(ui.sex.value),
    stature: Number(ui.stature.value),
    mass: Number(ui.mass.value),
  });

  const updateReadouts = (stature: number, mass: number): void => {
    must<HTMLOutputElement>('#sex-value').textContent = Number(ui.sex.value).toFixed(2);
    must<HTMLOutputElement>('#stature-value').textContent = `${stature.toFixed(2)} m`;
    must<HTMLOutputElement>('#mass-value').textContent = `${mass.toFixed(1)} kg`;
    // The percentile reads back where the current stature sits in the distribution for the
    // current blend. It used to keep whatever it was last set to, so after a stature drag or a
    // session load it named a body that was no longer on screen. Written without an event, so
    // nothing rebuilds.
    if (!percentileDriving) {
      const p = Math.min(Math.max(staturePercentile(Number(ui.sex.value), stature), 0.01), 0.99);
      ui.percentile.value = p.toFixed(2);
    }
    const percentile = Number(ui.percentile.value);
    must<HTMLOutputElement>('#percentile-value').textContent = `${Math.round(percentile * 100)}th`;
    health.showMeshStats(
      skeletonMesh?.bones.length ?? 0,
      skeletonMesh?.triangleCount ?? 0,
      buildMs,
    );
  };

  /**
   * Every tint on the drawn skeleton, in one place: the Align tab's segment, and over it the
   * inspector's bone.
   *
   * One function, because both paint the same vertex colours and each used to clear the other's:
   * the Align highlight went every time the inspector changed, and was lost on every rebuild too.
   * Called whenever either changes and after every new mesh, which starts white.
   */
  const applyTints = (): void => {
    skinned?.setTints([
      { bones: alignedSegmentBones, colour: ALIGNED_TINT },
      { bones: selectedBoneId ? [selectedBoneId] : [], colour: selectionColour },
    ]);
  };

  const refreshSelection = (): void => {
    applyTints();
    if (!selectedBoneId || !skeletonMesh) {
      inspector.innerHTML = INSPECTOR_EMPTY;
      return;
    }
    const bone = skeletonMesh.bones.find((b) => b.id === selectedBoneId);
    const definition = document_.bones.find((b) => b.id === selectedBoneId);
    if (!bone || !definition) {
      inspector.innerHTML = INSPECTOR_EMPTY;
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
  };

  const buildSkin = (morphology: Morphology): void => {
    if (!assets) return;
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
    skinned = createSkinnedSkeleton(
      skeletonMesh,
      toSkeletonGeometry(skeletonMesh),
      studio.boneMaterial,
    );
    world.add(skinned.mesh);
    // A followed body is posed when its publisher's next tick arrives. Forgetting the last one
    // poses the new mesh on the very next frame, rather than leaving it standing at rest until
    // the publisher moves.
    host.skinBuilt();

    // The ground sits under the soles: the dataset places them at y = 0 and stature scales about
    // the origin, so this is close to zero, but it is measured rather than assumed.
    restBounds = skeletonBounds(skeletonMesh);
    if (!runs.simulation) {
      groundY = restBounds.min[1];
      grid.position.y = groundY;
    }

    buildMs = performance.now() - started;
    refreshSelection();
  };

  /**
   * Rebuild the drawn skeleton for the body the sliders show, and nothing else.
   *
   * Never the run: a render-only change -- the full-detail pack arriving, a slider being dragged
   * -- used to stop the simulation and carry it into a recompiled body, which threw its recording
   * away for a picture that had nothing to do with the physics. A run draws through `skinned`,
   * which the frame loop reads afresh every frame, so swapping it here is all a running body
   * needs. The ground stays where the run has it while one exists; the run's floor is the run's.
   *
   * A measured bone's normals are cached by the builder and a build is a few milliseconds, which
   * is what lets this run once a frame while a slider is dragged.
   *
   * While following a publisher that says what body it built, the skin is that body's, not the
   * sliders': the sliders are this studio's settings for its own next run, and the poses on screen
   * are somebody else's bones. So a slider moved while following, or the full-detail pack
   * arriving, builds the publisher's body again rather than putting the sliders' back under its
   * poses.
   */
  const rebuildMesh = (): void => {
    if (!assets) return;
    buildSkin(host.follower.body?.morphology ?? currentMorphology());
    updateReadouts(Number(ui.stature.value), Number(ui.mass.value));
  };

  /**
   * Rebuild the mesh at the next frame, however many times this is asked before it.
   *
   * A slider fires `input` for every pixel it moves, far more often than the page draws. Each of
   * those used to rebuild a quarter of a million vertices, recompute every bone's normals and
   * restart the run; now they coalesce into at most one mesh build a frame.
   */
  const previewMesh = (): void => {
    if (previewFrame !== 0) return;
    previewFrame = requestAnimationFrame(() => {
      previewFrame = 0;
      rebuildMesh();
    });
  };

  const cancelPreview = (): void => {
    if (previewFrame === 0) return;
    cancelAnimationFrame(previewFrame);
    previewFrame = 0;
  };

  /**
   * Validity, the Health tables, and a running body carried into the new one. A run whose body is
   * already what the sliders say -- a release that ends where it began -- is left alone, unless
   * `always` asks for the restart anyway, as a whole set of settings arriving does. Both restarts
   * go through the run controller, so however many of these arrive, one run lands.
   */
  const rebuildBody = (cause = 'Body changed', options: { always?: boolean } = {}): void => {
    const resolved = resolveMorphology(currentMorphology());
    // Spec section 6.4 step 5. A body that fails these checks would still render; it would simply
    // be wrong, so the failure is surfaced rather than swallowed: listed in the Health tab's Body
    // validity panel, which shows only while there is something in it, said in the event line,
    // and kept on the console with the detail.
    const validation = validateResolvedBody(resolved);
    health.showBodyValidity(validation.problems);
    if (!validation.valid) {
      console.error('Resolved body failed physical validity checks:', validation.problems);
      status.announce('The resolved body failed its validity checks; see Health.', { error: true });
    }
    health.showValidation();
    void runs.restartWithCarry(cause, options);
  };

  /**
   * A morphology slider is moving.
   *
   * With no run, the mesh follows it, a frame at a time. With a run, only the numbers do: the body
   * on screen is the running one, and a rest mesh of another size bound to its pose would draw
   * every bone scaled about its own centre, which is a picture of nothing. It changes, once, on
   * release.
   */
  const morphologyInput = (): void => {
    if (runs.simulation) {
      updateReadouts(Number(ui.stature.value), Number(ui.mass.value));
      return;
    }
    previewMesh();
  };

  /** A morphology slider was let go: the mesh, then the body behind it. */
  const morphologyChanged = (): void => {
    cancelPreview();
    rebuildMesh();
    rebuildBody();
  };

  // The sliders that move the body. The three limb proportions are not among them: nothing
  // measured follows them yet (see `modelLimitations`), so the panel no longer has them. A value
  // that arrives from an older session, a checkpoint's recipe or the headset is read and ignored.
  for (const input of [ui.sex, ui.stature, ui.mass]) {
    input.addEventListener('input', () => {
      // Another slider moving means the percentile is not, whatever it last said: a percentile
      // drag that ends where it began fires no `change` to say it is over.
      percentileDriving = false;
      morphologyInput();
    });
    input.addEventListener('change', morphologyChanged);
  }

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

  // The spec's own words for the sex parameter (section 6.3), from the one place they are kept, so
  // the panel and the HSDL documentation cannot drift apart.
  must<HTMLElement>('#sex-label').textContent = SEX_PARAMETER_LABEL;
  must<HTMLElement>('#sex-note').textContent = SEX_PARAMETER_NOTE;

  // ------------------------------------------------------------------------------------------
  // Picking and grabbing
  // ------------------------------------------------------------------------------------------

  /**
   * A bone drawn at arm's length is a few pixels wide, and asking the user to hit it exactly makes
   * grabbing feel broken. A miss is retried on a ring of nearby pixels and the nearest of those
   * hits is taken, so a press close to a bone still lands on it. The picker is cheap enough for
   * that to cost nothing worth measuring.
   */
  const pickBone = (
    clientX: number,
    clientY: number,
  ): { boneId: string; point: Vector3 } | null => {
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
  };

  renderer.domElement.addEventListener('click', (event) => {
    if (controls.wasDragging()) return;
    if (!skinned) return;
    const picked = pickBone(event.clientX, event.clientY);
    selectedBoneId = picked?.boneId ?? null;
    refreshSelection();
  });

  /**
   * Ctrl is what separates reaching into the scene from moving around it: without it the drag
   * belongs to the camera, and a body that is only being looked at cannot be knocked over by
   * accident.
   */
  const beginGrab = (event: PointerEvent): boolean => {
    const simulation = runs.simulation;
    if (!event.ctrlKey || !simulation) return false;
    // Claimed, so the camera does not take the drag either, and said why: a Ctrl-drag that did
    // nothing at all read as grabbing being broken. Not resumed on the person's behalf -- they
    // paused or scrubbed for a reason, and a pull is not a request to throw that away.
    if (simulation.paused || !runs.atLiveEdge) {
      status.announce(
        runs.atLiveEdge
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
  };

  renderer.domElement.addEventListener('pointermove', (event) => {
    const simulation = runs.simulation;
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
    runs.simulation?.grab.release();
    grabState = null;
  };
  renderer.domElement.addEventListener('pointerup', endGrab);
  renderer.domElement.addEventListener('pointercancel', endGrab);

  // Ctrl-click is the secondary click on some platforms; the canvas would rather have the drag.
  renderer.domElement.addEventListener('contextmenu', (event) => {
    if (event.ctrlKey) event.preventDefault();
  });
  /**
   * Whether a Ctrl-press on the body would take hold of it: only a run of this page's own,
   * computing and at the live edge. Paused, the pull would be applied to nothing until the run
   * carried on, and then all at once; scrubbed back, it would pull the live body from a pose that
   * is not on screen.
   */
  const canReach = (): boolean => {
    const simulation = runs.simulation;
    return simulation !== null && !simulation.paused && runs.atLiveEdge && !host.follower.active;
  };
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

  // ------------------------------------------------------------------------------------------
  // Loading the mesh pack
  // ------------------------------------------------------------------------------------------

  /** The centre overlay, as an error: nothing else is on screen to carry one. */
  const loadFailed = (message: string, error: unknown): void => {
    console.error(message, error);
    const loading = must<HTMLElement>('#loading');
    loading.hidden = false;
    loading.textContent = `${message} See the console.`;
    loading.classList.add('error');
    status.announce(`${message} ${messageOf(error)}`, { error: true });
  };

  /**
   * The reduced pack went up and the full one did not: keep what is on screen and say so.
   *
   * The reduced bones are a whole skeleton, so this is a coarser picture rather than a broken
   * one, and the run and the physics do not use the render mesh at all. It used to be said only on
   * the console, and a studio showing coarse bones for no visible reason looks like a bug.
   */
  const fullDetailFailed = (error: unknown): void => {
    console.error('The full-detail bones failed to load; staying on the reduced set.', error);
    health.showMeshDetail('reduced (full detail failed to load)', messageOf(error));
    status.announce(
      'Full-detail bones failed to load; showing the reduced set (see the console).',
      {
        error: true,
      },
    );
  };

  /** Whether the page should say it is at rest: no run of its own, and nothing followed. */
  const showRestStatus = (): void => {
    if (!runs.simulation && !host.follower.active) status.setSimulationStatus(host.restStatus());
  };

  return {
    get assets() {
      return assets;
    },
    get skeletonMesh() {
      return skeletonMesh;
    },
    get skinned() {
      return skinned;
    },
    get restBounds() {
      return restBounds;
    },
    get groundY() {
      return groundY;
    },
    get fullDetailPending() {
      return fullDetailPending;
    },
    currentMorphology,
    builtFor: (key) => meshBuiltFor?.key === key,
    buildSkin,
    rebuildMesh,
    cancelPreview,
    rebuildBody,
    updateReadouts,
    refreshSelection,
    setAlignedSegment(bones) {
      alignedSegmentBones = bones;
      applyTints();
    },
    raycaster,
    pickBone,
    beginGrab,
    releaseMouseGrab(sim) {
      sim.grab.release(0);
      grabState = null;
    },
    forgetGrab() {
      grabState = null;
    },
    load() {
      // A device with a coarse pointer, a phone or a tablet, stays on the small pack.
      const stayOnSmallPack = window.matchMedia('(pointer: coarse)').matches;
      loadAssets('lod1').then(
        (loaded) => {
          assets = loaded;
          const attribution = must<HTMLElement>('#attribution');
          attribution.textContent = attributionText(loaded.manifest);
          attribution.hidden = false;
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
          if (stayOnSmallPack) {
            health.showMeshDetail('reduced (this device stays on the small pack)');
            return;
          }
          fullDetailPending = true;
          health.showMeshDetail('reduced; loading full detail…');
          showRestStatus();
          loadAssets('full')
            .then((full) => {
              const reduced = assets;
              assets = full;
              // The mesh only: the bones on screen get finer and nothing about the body changes,
              // so a run going when they arrive goes on, with its recording, drawn in the finer
              // bones.
              try {
                rebuildMesh();
                health.showMeshDetail('full');
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
              showRestStatus();
            });
        },
        (error: unknown) => loadFailed('The measured skeleton failed to load.', error),
      );
    },
  };
}
