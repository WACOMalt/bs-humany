/**
 * bs-humany studio: the page that shows a body, runs it, and says what it is doing.
 *
 * The measured skeleton on screen, reshaped live by the Body sliders; a run of this page's own on
 * MuJoCo, with muscles, the cord and a trained policy when they are asked for; the timeline that
 * replays and scrubs what the run captured; the exports to a recording and to Blender; sessions
 * saved and loaded; the Align tab's reference models; and, instead of a run of its own, a run
 * followed off the pose bridge. The Tauri shell adds the VR viewer, driven from the same controls.
 *
 * This file only puts the page together and starts it. The simulation is the `Simulation` of
 * `@bs-humany/session` (packages/session), the same one `publish-pose` runs headless, and the rest
 * is one module a concern, each made by a `create*` function from a host that hands it what it
 * needs of the others:
 *
 * - `scene.ts`: the renderer, camera, lights, grid and scenery, and a run as it is drawn.
 * - `runController.ts`: which run is going, its playhead, and every start, restart and pause.
 * - `ui/transport.ts` and `ui/timeline.ts`: the top bar, the status bar, the keyboard, and the
 *   timeline under the viewport.
 * - `ui/bodyPanel.ts`, `ui/simPanel.ts`, `ui/musclePanel.ts` and `ui/healthPanel.ts`: the tabs.
 * - `sessionWiring.ts`: the settings a session holds, saving, loading and the exports.
 * - `followView.ts`, `vrHost.ts`, `alignHost.ts`, `brainHost.ts` and `nervesView.ts`: following
 *   the bridge, the headset, the Align, Brain and Training tabs, and the brain's activity on
 *   screen.
 *
 * The order they are made in below is the order the page needs them in: each is made after
 * everything it calls while it is being made. Where two need each other -- a session applies the
 * Brain panel's cord, and a checkpoint's recipe applies a session's settings -- the one made first
 * asks for the other only when a person acts, never while the page is being put together.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { morphologyKey } from '@bs-humany/compiler';
import { Simulation } from '@bs-humany/session';
import { buildDocument } from '@bs-humany/skeleton';
import { createAlign } from './alignHost.js';
import { buildBlenderExport } from './blenderExport.js';
import { createBrain } from './brainHost.js';
import { BridgeFollower } from './follow.js';
import { createFollowView } from './followView.js';
import { createNervesView } from './nervesView.js';
import { RestoreRefused, type StudioRuns, createRunController } from './runController.js';
import { VIEWS, createRunView, createScene } from './scene.js';
import {
  RESTORE_REFUSED,
  channelPrints,
  deserializeSnapshot,
  restoreMismatch,
  savedRunPrint,
  serializeSnapshot,
} from './session.js';
import { BACKEND, createSessionWiring, findControls } from './sessionWiring.js';
import type { SkinnedSkeleton } from './skinning.js';
import { createBodyPanel } from './ui/bodyPanel.js';
import { blurAfterMouse, must, paintYield } from './ui/dom.js';
import { createHealthPanel } from './ui/healthPanel.js';
import { createMemory } from './ui/memory.js';
import { createMusclePanel } from './ui/musclePanel.js';
import { createResizer } from './ui/resizer.js';
import { createSimPanel } from './ui/simPanel.js';
import { drawSpine } from './ui/spineActivity.js';
import { TAB_CHANGE, createTabs } from './ui/tabs.js';
import { createTimeline } from './ui/timeline.js';
import { createStatusLine, createTransport, wireShortcuts } from './ui/transport.js';
import { createVrHost } from './vrHost.js';

/** What the Health tab calls the backend, beside the compile report. */
const BACKEND_NAME = 'MuJoCo';

function boot(): void {
  // The document is built once. Measured placement only: the procedural recipes remain as the
  // internal fallback for bones the dataset lacks (the ossicles, OQ-004) and as a future
  // low-detail LOD; they are not a user option.
  const document_ = buildDocument();
  const status = createStatusLine();
  const controls = findControls();
  const follower = new BridgeFollower();

  // The camera holds still for the Align gizmo, and for a Ctrl-press that takes hold of the body.
  const scene = createScene(must<HTMLDivElement>('#viewport'), {
    claimPointer: (event) => align.claimsPointer() || body.beginGrab(event),
  });

  /**
   * Every set of run buttons on the page, which answer two questions: Start and Pause, whether
   * the simulation is computing; the timeline's, where in what it computed you are looking. With
   * the Export buttons and the Sim tab's strip of changes waiting for a restart.
   */
  const setRunControls = (running: boolean): void => {
    transport.setControls(running);
    session.setExportControls(running);
    timeline.setPlaybackControls(running);
    sim.showPendingChanges();
  };

  /**
   * Dim the newest-tick readouts and say so while the playhead is off the live edge; undo both at
   * it. Off the live edge the picture is a recorded frame and these are not -- nothing records
   * energies, stops, contacts or tendon forces -- so the readouts stay, because they are still
   * true of the run, but dim and say which frame they are of. Cheap to call every frame: nothing
   * is written unless it changes.
   */
  const showReadoutsLive = (run: Simulation | null, live: boolean): void => {
    const stale = run !== null && !live;
    const caption = stale
      ? `Readings are at the newest frame (t = ${(run.ticks * run.dt).toFixed(2)} s), not the replayed one.`
      : '';
    sim.showLive(stale, caption);
    muscles.showLive(stale, caption);
  };

  const runs: StudioRuns = createRunController({
    ready: () => body.skeletonMesh !== null && body.skinned !== null,
    following: () => follower.active,
    stopFollowing: () => follow.stop(),
    // The cord the Spine panel shows, so a Start, a Reset-and-Start, a carry restart and a
    // restored session all run the reflexes the sliders say rather than none at all.
    reflex: () => brain.panel.state().reflex,
    settings: () => sim.runSettings(),
    build: (reflex) => {
      const chosen = sim.currentScenario();
      return new Simulation(document_, resolveMorphology(body.currentMorphology()), {
        profileId: controls.profile.value,
        backend: BACKEND,
        passiveJoints: controls.passive.checked,
        redistribute: controls.redistribute.checked,
        scenario: chosen,
        dropHeight: Number(controls.dropHeight.value),
        groundHeight: body.groundY,
        // A scenario that asks for muscles gets them whether the box is ticked or not: the box is
        // there to keep them off the runs that do not need them, not to make a muscle scenario
        // silently run a bare skeleton.
        muscles: controls.muscles.checked || chosen?.muscles === true,
        // Only when somebody moved it. Left alone, each profile keeps the step rate its solver was
        // tuned for, which is the number that ought to win by default.
        ...(sim.fidelityTouched ? { stepsPerSecond: Number(controls.stepsPerSecond.value) } : {}),
        outputFramerate: Number(controls.outputFramerate.value),
        nerves: brain.panel.setup,
        reflex,
      });
    },
    prepare: (run, restoreFrom) => {
      // A fresh backend always starts with gravity and a solid floor; both toggles are session
      // settings rather than run ones.
      if (!controls.gravity.checked) run.setGravity(false);
      if (!controls.floor.checked) run.setGroundCollision(false);
      muscles.applyMuscleDrive(run);
      // A fresh run opens at the profile's own step rate, unless the slider has been moved off it.
      if (!sim.fidelityTouched) controls.stepsPerSecond.value = String(run.stepsPerSecond);
      sim.applyFidelity(run);
      sim.showRates();
      // A session's run goes back in only when the body built for it can take it. Checked here,
      // before anything is restored, so a mismatch leaves this run as it started -- at its first
      // tick, with the session's settings -- and the page says what differed rather than the
      // kernel's list of channel ids. A refusal from inside the restore spends the run.
      if (!restoreFrom) return undefined;
      const snapshot = deserializeSnapshot(restoreFrom.snapshot);
      const refused = restoreMismatch(savedRunPrint(snapshot, restoreFrom.channels), {
        dt: run.dt,
        channels: channelPrints(run.kernel.channels),
        modules: run.kernel.order(),
      });
      if (refused === undefined) {
        try {
          run.restore(snapshot, restoreFrom.ticks);
        } catch (error) {
          throw new RestoreRefused(RESTORE_REFUSED, { cause: error });
        }
      }
      return refused;
    },
    installed: (run, refused, unmatched) => {
      runView.install(run);
      // The Align tab draws our own joints and attachments, which are this body's: when the body
      // is rebuilt they are a different body's and have to be read again.
      align.panel.refresh();
      health.showCapabilities(run);
      sim.showRun(true);
      timeline.control.hidden = false;
      health.showReports(run);
      health.showValidationNote();
      // A body carried into a profile with other joints leaves some of the old pose behind. That
      // is expected and not an error, but it is a difference in the body that is running, so it
      // is listed with the other things the compile had to say rather than only on the console.
      if (unmatched.length > 0) {
        health.addReportLine(
          `[carry] ${unmatched.length} DoFs had no counterpart in ${run.recording.profile} ` +
            `and start at neutral: ${unmatched.join(', ')}`,
        );
      }
      body.refreshSelection();
      setRunControls(true);
      status.setSimulationStatus('Running.');
      // After the start has cleared the last run's notices, and as an error, because the run
      // going is not the one the file holds.
      if (refused !== undefined) status.announce(refused, { error: true });
    },
    forgot: () => {
      body.forgetGrab();
      runView.forget();
      sim.showRun(false);
      timeline.control.hidden = true;
      health.setCompileReportEmpty(true);
      health.showValidationNote();
      sim.showCaptureEstimate();
      // The readouts were of the run that has gone, and the headset is sent them too.
      muscles.clear();
      showReadoutsLive(null, true);
      body.skinned?.rest();
      setRunControls(false);
      status.setSimulationStatus(transport.restStatus());
    },
    abandoned: () => {
      setRunControls(false);
      status.setSimulationStatus(transport.restStatus());
      health.setCompileReportEmpty(true);
    },
    compiling: () => {
      setRunControls(false);
      status.setSimulationStatus('Compiling the body…');
      return paintYield();
    },
    startFailed: () => {
      // No run, so no report: the last one was of a run that has gone, and nothing replaced it.
      health.setCompileReportEmpty(true);
      status.setSimulationStatus(transport.restStatus());
    },
    settled: () => setRunControls(runs.simulation !== null),
    releaseGrab: (run) => body.releaseMouseGrab(run),
    sameBody: (run) =>
      morphologyKey(run.resolved) === morphologyKey(resolveMorphology(body.currentMorphology())),
    announce: (text, options) => status.announce(text, options),
    dismissNotices: () => status.dismissAnnouncement(true),
  });
  runs.onChange(() => {
    const run = runs.simulation;
    if (!run) return;
    runView.applyOverlayVisibility();
    showReadoutsLive(run, runs.atLiveEdge);
    setRunControls(true);
    timeline.update(run);
  });

  const health = createHealthPanel({
    document: document_,
    profile: controls.profile,
    backendName: BACKEND_NAME,
    resolvedMorphology: () => resolveMorphology(body.currentMorphology()),
    stature: () => Number(controls.stature.value),
    mass: () => Number(controls.mass.value),
    runningProfile: () => runs.simulation?.recording.profile,
  });
  const muscles = createMusclePanel({ simulation: () => runs.simulation });
  const transport = createTransport({
    runs,
    status,
    boxes: controls,
    fullDetailPending: () => body.fullDetailPending,
    following: () => follower.active,
    setRunControls,
  });
  const timeline = createTimeline({ runs, stalled: transport.stalled });
  const sim = createSimPanel({
    runs,
    controls,
    document: document_,
    announce: (text) => status.announce(text),
    showMusclesOff: muscles.showMusclesOff,
  });
  const body = createBodyPanel({
    document: document_,
    scene,
    controls,
    runs,
    status,
    health,
    follower,
    skinBuilt: () => follow.skinRebuilt(),
    restStatus: transport.restStatus,
  });
  const runView = createRunView(scene, {
    runs,
    boxes: controls,
    follower,
    alignHoldsRest: () => align.holdsRest(),
    restBounds: () => body.restBounds,
    sliderStature: () => Number(controls.stature.value),
    datasetStature: () => body.assets?.manifest.subjectStature,
  });
  const session = createSessionWiring({
    document: document_,
    controls,
    runs,
    status,
    body,
    sim,
    muscles,
    brain: () => brain.panel,
    setRunControls,
    confirmDiscard: transport.confirmDiscard,
  });
  const follow = createFollowView({
    follower,
    scene,
    controls,
    runs,
    body,
    status,
    transport,
    setRunControls,
  });

  // The viewport's header: the view presets, Frame, the grid and the overlay boxes.
  const frameBody = (view?: { theta: number; phi: number }) =>
    runView.frameBody(scene.controls, view);
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
  controls.showGrid.addEventListener('change', () => {
    scene.grid.visible = controls.showGrid.checked;
  });
  for (const input of [
    controls.showProxies,
    controls.showAxes,
    controls.showCom,
    controls.showContacts,
    controls.showMuscles,
    controls.showMuscleVolumes,
    controls.showTissue,
  ]) {
    input.addEventListener('change', runView.applyOverlayVisibility);
  }

  // --- The editors' chrome: tabs, what the page remembers, the overlays popover ----------------

  // Explanatory text is off by default: every panel has paragraphs of it, and a reader wants at
  // most one of them at a time. The notes that carry a live value are marked `live` and stay.
  controls.showNotes.addEventListener('change', () => {
    window.document.body.classList.toggle('notes', controls.showNotes.checked);
  });
  const memory = createMemory();
  const tabs = createTabs(must<HTMLElement>('#tabs'), must<HTMLElement>('#panels'), memory, 'body');
  createResizer(must<HTMLElement>('#properties-resizer'), memory);
  for (const [input, key] of [
    [controls.showNotes, 'notes'],
    [controls.showGrid, 'grid'],
    [controls.spin, 'turntable'],
    [controls.showProxies, 'overlay.proxies'],
    [controls.showAxes, 'overlay.axes'],
    [controls.showCom, 'overlay.com'],
    [controls.showContacts, 'overlay.contacts'],
    [controls.showTissue, 'overlay.tissue'],
    [controls.showMuscles, 'overlay.muscles'],
    [controls.showMuscleVolumes, 'overlay.muscleVolumes'],
  ] as const) {
    // A remembered box is restored by dispatching `change`, so whatever listens to one --
    // Explain's class on the body above all -- has to be attached before this line, or the box
    // comes back ticked and nothing it drives follows it.
    memory.checkbox(input, key);
  }
  // As a defence as well: Explain's state and the body's class must agree whatever order the page
  // was put together in.
  window.document.body.classList.toggle('notes', controls.showNotes.checked);
  // Each panel's open or closed state, under the key the page gives it. The key used to be made
  // from the panel's heading, so the two Recording panels -- Sim's and Export's -- shared one
  // memory and collapsing either collapsed both. A panel with no key, or one another already took,
  // is left unremembered and said on the console, where whoever added it will look.
  {
    const bound = new Set<string>();
    for (const panel of window.document.querySelectorAll<HTMLDetailsElement>('details.panel')) {
      const key = panel.dataset.memory;
      if (!key || bound.has(key)) {
        console.warn(
          key
            ? `Two panels share the memory key ${key}; the second is not remembered.`
            : 'A panel has no data-memory key and is not remembered.',
          panel,
        );
        continue;
      }
      bound.add(key);
      memory.details(panel, `panel.${key}`);
    }
  }
  {
    const button = must<HTMLButtonElement>('#overlays-button');
    const popover = must<HTMLElement>('#overlays-popover');
    // Opening puts focus on the first box, so a keyboard is inside what it opened; closing by
    // Escape or by the button gives focus back to the button, rather than to the page's start. A
    // press outside closes it and leaves focus wherever that press put it.
    const open = (on: boolean, returnFocus = false) => {
      popover.hidden = !on;
      button.setAttribute('aria-expanded', String(on));
      if (on) popover.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus();
      else if (returnFocus) button.focus();
    };
    button.addEventListener('click', () => open(popover.hidden, true));
    window.document.addEventListener('pointerdown', (event) => {
      if (popover.hidden) return;
      const target = event.target as Node;
      if (!popover.contains(target) && !button.contains(target)) open(false);
    });
    window.addEventListener('keydown', (event) => {
      // Only while it is open: Escape means other things elsewhere -- the Align gizmo's Off.
      if (event.key !== 'Escape' || popover.hidden) return;
      open(false, true);
    });
  }
  wireShortcuts({ runs, transport, timeline: timeline.buttons, frameBody: () => frameBody() });

  // --- The headset, the Align tab, the Brain and Training tabs ---------------------------------

  const vr = createVrHost({
    document: document_,
    controls,
    runs,
    follower,
    body,
    sim,
    muscles,
    runView,
    status,
    transport,
    timeline,
    brain: () => brain.panel,
  });
  const align = createAlign({ runs, scene, body, status, saving: session.saving });
  const brain = createBrain({
    document: document_,
    runs,
    controls,
    follower,
    body,
    sim,
    muscles,
    session,
    status,
    follow,
    // A press at the desktop asks before a set-up's restart throws a long recording away; the
    // headset's presses reach the panel through `act`, which never asks.
    confirmDiscard: transport.confirmDiscard,
    // The Training tab reads the same poll as the Brain tab, now that training has a tab of its
    // own: the training status and its chart come back with the checkpoint list.
    pollIsRead: () =>
      tabs.active === 'brain' ||
      tabs.active === 'training' ||
      follower.active ||
      vr.link()?.connected === true,
  });
  // The Brain panel asks the server again at once when its own tab is opened, which it sees for
  // itself; the Training tab is a person looking for the training status just as much, and the
  // panel cannot see that tab, so opening it asks here. Without this the status would wait for
  // the next three-second poll, the first after the tab opened.
  must<HTMLElement>('#tabs').addEventListener(TAB_CHANGE, (event) => {
    if ((event as CustomEvent<string>).detail === 'training') void brain.panel.poll();
  });
  const nerves = createNervesView(brain.panel);

  // A handle for scripted checks of the running page; never used by the page itself.
  Object.assign(window, {
    __studio: {
      simulation: () => runs.simulation,
      pick: (x: number, y: number) => body.pickBone(x, y)?.boneId,
      skinned: () => body.skinned,
      camera: scene.camera,
      controls: scene.controls,
      raycaster: body.raycaster,
      session: { serializeSnapshot, deserializeSnapshot },
      blenderExport: () => {
        const run = runs.simulation;
        const assets = body.assets;
        return run && assets ? buildBlenderExport(run, document_, assets) : null;
      },
    },
  });

  // --- The frame loop ----------------------------------------------------------------------------

  /** One frame of a run: advance or replay it, draw it, and update everything that reads it. */
  const runFrame = (run: Simulation, skinned: SkinnedSkeleton, elapsed: number): void => {
    const frameSeconds = Math.min(elapsed, 250) / 1000;
    if (runs.atLiveEdge) {
      // The elapsed time is measurement only: what the frame advances is one output frame's
      // worth of simulated time, whatever the clock says.
      try {
        run.advance(frameSeconds);
      } catch (error) {
        transport.stalled(run, error);
      }
      // A tick that threw, or a solver reset, pauses the run inside `advance`; this says so, once.
      transport.reportStop(run);
    } else {
      // Playback is the other way round -- paced by the clock, because what is being watched is
      // finished and watching it should take the time it took.
      runs.playback.advance(frameSeconds, run.outputFramerate, runs.capturedFrames());
      if (!runs.playback.playing) setRunControls(true);
    }
    const frame = runView.pose(run, skinned);
    vr.sendFrame(run, frame);
    runView.drawOverlays(run, frame);
    showReadoutsLive(run, runs.atLiveEdge);
    sim.updateDiagnostics(run);
    muscles.update(run);
    timeline.update(run);
    sim.showCaptureStatus(run);
    transport.showRunStatus(run);
  };

  let lastFrame = performance.now();
  let frameMs = 0;
  const animate = (): void => {
    requestAnimationFrame(animate);
    const now = performance.now();
    const elapsed = now - lastFrame;
    lastFrame = now;
    // Smoothed, because a raw per-frame number is unreadable.
    frameMs += (elapsed - frameMs) * 0.08;

    scene.update(controls.spin.checked);
    const run = runs.simulation;
    if (!run) {
      // Following a publisher, the headset is sent what the desktop follows, relayed on the
      // studio's own bridge; otherwise it is told there is no run.
      const link = vr.link();
      if (follower.active && link) link.relay(follower);
      else link?.idle();
    }
    // The brain panel's picture: this page's policy, or the training showcase's.
    nerves.draw(run ?? undefined);
    // The cord under it, for a run of this page's own at the live edge only: its drive is a tick
    // wide and nothing records it.
    drawSpine(run ?? undefined, runs.atLiveEdge && !follower.active);
    // Scenery that moves -- a platform tilting under the body -- drawn where the solver has it.
    if (run) scene.furniture.place(run.staticBoxes);
    if (follower.active) follow.frame();
    const skinned = body.skinned;
    if (run && skinned) {
      // Everything the run puts on screen, in one guard: whatever in it throws, the run pauses
      // and says so, and the render below still happens. Before, one throw here took the frame
      // loop's render with it every frame after, and the viewport froze on its last picture with
      // nothing on the page saying why.
      try {
        runFrame(run, skinned, elapsed);
      } catch (error) {
        transport.frameFailed(run, error);
      }
    }
    scene.render();
    health.showFrameCost(frameMs, scene.renderer.info.render.calls);
  };

  // Everything above is made; now set it going. The frame loop's first frame runs as soon as it is
  // called and reaches into every part of the page, so it is started last of all.
  animate();
  body.load();
  brain.startPolling();
}

boot();
