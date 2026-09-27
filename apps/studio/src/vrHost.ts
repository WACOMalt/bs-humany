/**
 * The VR viewer, on this run.
 *
 * Tauri only: the viewer is a native process and the bridges live on tmpfs, neither of which a
 * browser tab can reach. The link (`vrLink.ts`) publishes what the screen shows and routes the
 * headset's panel into the same controls the mouse uses, so the two never disagree about what the
 * run is doing. This is the studio's side of it: what the headset is told, and what each of its
 * commands does here.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import type { HsdlDocument } from '@bs-humany/hsdl';
import { CONTROL_RANGES, MUSCLE_GROUPS } from '@bs-humany/scenarios';
import { computeWorldTransforms } from '@bs-humany/skeleton';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { BrainPanel } from './brain.js';
import type { BridgeFollower } from './follow.js';
import { Playback } from './playback.js';
import type { StudioRuns } from './runController.js';
import type { DrawnFrame, RunView } from './scene.js';
import type { Controls } from './sessionWiring.js';
import type { Simulation } from './simulation.js';
import { tissueTable } from './tissue.js';
import type { BodyPanel } from './ui/bodyPanel.js';
import { messageOf, must, setFromPanel } from './ui/dom.js';
import { type MusclePanel, muscleReadoutText } from './ui/musclePanel.js';
import { type SimPanel, definitionFor, diagnosticsOf } from './ui/simPanel.js';
import type { Timeline } from './ui/timeline.js';
import type { StatusLine, Transport } from './ui/transport.js';
import { type VrCommand, type VrHost, VrLink, type VrStatus } from './vrLink.js';

export interface VrHostHost {
  readonly document: HsdlDocument;
  readonly controls: Controls;
  readonly runs: StudioRuns;
  readonly follower: BridgeFollower;
  readonly body: BodyPanel;
  readonly sim: SimPanel;
  readonly muscles: MusclePanel;
  readonly runView: RunView;
  readonly status: StatusLine;
  readonly transport: Transport;
  readonly timeline: Timeline;
  /**
   * The Brain panel, whose state the headset's Brain tab is drawn from and whose buttons its
   * hands press. Asked for, because the panel is made after the VR host, which it reads to know
   * whether the headset is listening.
   */
  brain(): BrainPanel;
}

export interface StudioVr {
  /** The link to the headset while one is connected, or null. */
  link(): VrLink | null;
  /**
   * Send the headset the frame on screen, not the newest one: off the live edge that is the
   * recorded frame under the playhead, bellies included, published under its own tick so the
   * headset's body and timeline move as the desktop's do when replaying or scrubbing.
   */
  sendFrame(sim: Simulation, frame: DrawnFrame): void;
  /** What the headset is told of the studio now; the link sends it ten times a second. */
  status(sim: Simulation | null): VrStatus;
}

export function createVrHost(host: VrHostHost): StudioVr {
  const { controls: ui, runs, follower, status: line } = host;
  const connectVr = must<HTMLButtonElement>('#connect-vr');
  /** The link to the headset while one is connected. */
  let vrLink: VrLink | null = null;

  /**
   * What the VR link has to say that the desktop user should see: in the event line, and on the
   * terminal beside the viewer's own lines, where a failure can actually be read. A command the
   * studio cannot place -- an overlay, a setting or a scenario parameter it has no control for --
   * is said here too, rather than in a console nobody has open.
   */
  const vrLog = (message: string): void => {
    line.announce(message);
    void invoke('studio_log', { message }).catch(() => undefined);
  };

  /** The tissue in bone frames, for the headset: a segment's frame is its anchor bone's. */
  let tissueCache: { sim: Simulation; table: VrStatus['tissue'] } | undefined;
  const tissueForBridge = (sim: Simulation): VrStatus['tissue'] => {
    if (tissueCache?.sim === sim) return tissueCache.table;
    const table = tissueTable(sim.articulation);
    tissueCache = { sim, table };
    return table;
  };

  /** The run time of the newest recorded frame, in the seconds the headset's timeline counts. */
  const recordedSeconds = (sim: Simulation): number => {
    const frames = runs.capturedFrames();
    if (frames <= 0) return 0;
    return (sim.capture.firstTick + Playback.tickOf(frames - 1, sim.ticksPerOutputFrame)) * sim.dt;
  };

  const status = (sim: Simulation | null): VrStatus => {
    const option = (select: HTMLSelectElement) =>
      Array.from(select.options).map((o) => ({
        id: o.value,
        title: o.textContent?.trim() ?? o.value,
      }));
    const chosen = ui.scenario.selectedOptions[0];
    // The studio no longer offers the limb proportions, but the headset's Body tab still says
    // which ones the body uses, reading these keys and taking a missing one as zero. So they go
    // out at the proportions every body now resolves at, the reference ones, from the same
    // resolution a run is built from rather than a second copy of the numbers. The context types
    // every parameter as optional; the resolution always fills these three.
    const { crural, brachial, relativeLegLength } = resolveMorphology(
      host.body.currentMorphology(),
    ).context;
    return {
      scenario: { id: ui.scenario.value, title: chosen?.textContent?.trim() ?? ui.scenario.value },
      scenarios: option(ui.scenario),
      // By title as well as id, so the headset's Body row reads as the desktop's picker does.
      profiles: option(ui.profile),
      profile: ui.profile.value,
      settings: {
        muscles: sim ? sim.muscles !== undefined : ui.muscles.checked,
        sex: Number(ui.sex.value),
        stature: Number(ui.stature.value),
        mass: Number(ui.mass.value),
        ...(crural !== undefined ? { crural } : {}),
        ...(brachial !== undefined ? { brachial } : {}),
        ...(relativeLegLength !== undefined ? { legLength: relativeLegLength } : {}),
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
        level: Number(host.muscles.driveInputs.get(group.id)?.value ?? 0),
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
      paused: !sim || sim.paused || !runs.atLiveEdge,
      mode: follower.active ? 'following' : !sim ? 'rest' : sim.paused ? 'paused' : 'running',
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
        const values = host.sim.scenarioValues.get(definition.id) ?? {};
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
      muscleReadout: sim ? muscleReadoutText(host.muscles.readout) : {},
      // The one table the desktop's sliders are held to, which the headset draws its own from.
      controls: CONTROL_RANGES,
      // Relaxed off the live edge, as the desktop draws a replayed belly: tension is not
      // recorded, and the newest tick's would tint a frame it does not belong to.
      tension:
        sim && runs.atLiveEdge ? Array.from(host.runView.muscleOverlay(sim)?.tension ?? []) : [],
      tissue: sim ? tissueForBridge(sim) : { discs: [], bars: [] },
      brain: host.brain().state(),
      recordedSeconds: sim ? recordedSeconds(sim) : 0,
      playing: runs.playback.playing,
      live: runs.atLiveEdge,
    };
  };

  /**
   * One command from the headset's panel, done the way the mouse would do it: a button is
   * clicked, so a greyed one does nothing, and a slider is set and told, so whatever follows it
   * follows.
   */
  const command = (command: VrCommand): void => {
    const timeline = host.timeline.buttons;
    switch (command.kind) {
      case 'pause':
        // The desktop's toggle would resume a paused run; the headset's Pause only ever pauses.
        runs.pause();
        break;
      case 'resume':
        // Carry on, or start when nothing is running -- the headset shows no run as paused, so
        // its Resume is Start there.
        runs.startOrResume();
        break;
      case 'reset':
        // Not the desktop's button, which asks before it throws a long recording away: the
        // question would open on a screen the person in the headset cannot see.
        host.transport.reset();
        break;
      case 'step':
        (command.frames > 0 ? timeline.frameForward : timeline.frameBack).click();
        break;
      case 'scrub': {
        // The headset's timeline is in seconds of the run -- the time the status reports -- so
        // the frame is found from the tick that time is, counted from where the capture starts.
        const sim = runs.simulation;
        if (sim) {
          const frame = Playback.frameOfTick(
            Math.round(command.seconds / sim.dt),
            sim.capture.firstTick,
            sim.ticksPerOutputFrame,
          );
          runs.scrubTo(Math.min(Math.max(frame, 0), runs.capturedFrames() - 1));
        }
        break;
      }
      case 'brain':
        host.brain().act(command.action, command.id, command.value);
        break;
      case 'drive': {
        const input = host.muscles.driveInputs.get(MUSCLE_GROUPS[command.group]?.id ?? '');
        if (input) setFromPanel(input, Math.max(0, Math.min(100, command.value)));
        break;
      }
      case 'set': {
        const { key, value } = command;
        const restart = () => void runs.start();
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
            // Accepted and ignored. Nothing measured follows the limb proportions yet, so neither
            // the desktop nor the headset offers them any more; an older viewer still may, and a
            // value from it would otherwise rebuild the body and restart the run for no change.
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
            timeline.playToggle.click();
            break;
          case 'live':
            timeline.goLive.click();
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
              else vrLog(`VR panel: no overlay ${overlay}`);
            } else if (parameter) {
              const input = window.document.querySelector<HTMLInputElement>(
                `#scenario-${parameter}`,
              );
              if (input) setFromPanel(input, value);
              else vrLog(`VR panel: no scenario parameter ${parameter}`);
            } else vrLog(`VR panel: no setting ${key}`);
          }
        }
        break;
      }
    }
  };

  const vrHost: VrHost = {
    simulation: () => runs.simulation,
    restPose(sim) {
      const order = sim.boneOrder();
      const rests = computeWorldTransforms(host.document, sim.resolved.context);
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
        datasetScale: Number(ui.stature.value) / (host.body.assets?.manifest.subjectStature ?? 1),
      };
    },
    status,
    command,
    log: vrLog,
    // The panel's command traffic, merged a drag to a line: the terminal's, not the status line's.
    trace: (message: string) => void invoke('studio_log', { message }).catch(() => undefined),
    onViewerExit(code, signal, tail) {
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
        line.announce(`VR viewer closed (${how})${last ? `: ${last}` : ''}`, { error: code !== 0 });
      })();
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
          line.announce('VR viewer disconnected.');
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
          void host.brain().poll();
        } catch (error) {
          line.announce(`The VR viewer did not connect: ${messageOf(error)}`, { error: true });
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
          line.announce('VR viewer still running from before the reload: Connect re-attaches it');
        }
      })
      .catch(() => undefined);
  }

  return {
    link: () => vrLink,
    sendFrame(sim, { transforms, replay }) {
      if (!vrLink) return;
      const shownIndex = replay
        ? Playback.tickOf(
            runs.playback.clampedFrame(runs.capturedFrames()),
            sim.ticksPerOutputFrame,
          )
        : -1;
      vrLink.frame(
        transforms.position,
        transforms.orientation,
        replay ? sim.capture.firstTick + shownIndex : sim.ticks,
        replay
          ? (runs.playback.ringsAt(
              sim.muscleCapture,
              sim.muscleCapture.indexForTick(sim.capture.firstTick + shownIndex),
            ) ?? null)
          : undefined,
      );
    },
    status,
  };
}
