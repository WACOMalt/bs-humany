/**
 * What the next run is built from, and how the running one is doing: the Scene tab's scenario and
 * its parameters, the World tab's gravity, floor and joints, and the Sim tab's rates, capture
 * budget, the strip of settings waiting for a restart, and the diagnostics.
 */

import {
  MIN_CAPTURE_BUDGET_BYTES,
  captureCeilingBytes,
  defaultCaptureBudgetBytes,
} from '@bs-humany/export-gltf';
import type { HsdlDocument } from '@bs-humany/hsdl';
import { DEFAULT_RINGS, DEFAULT_UPDATE_HZ, rateDivisorFor } from '@bs-humany/modules-muscle';
import { ALL_MUSCLE_UNITS } from '@bs-humany/muscle-data';
import {
  DEFAULT_SCENARIO,
  SCENARIO_DEFINITIONS,
  type ScenarioDefinition,
  profileRateHz,
} from '@bs-humany/scenarios';
import type { Simulation } from '@bs-humany/session';
import { SEGMENTATION_PROFILES } from '@bs-humany/skeleton';
import { type RunSettings, pendingChanges } from '../pending.js';
import type { StudioRuns } from '../runController.js';
import { clampToStep, controlKind, isChanged } from '../scenarioControls.js';
import type { Controls } from '../sessionWiring.js';
import { must, setText } from './dom.js';

const MEBIBYTE = 1024 * 1024;
/** Four bytes a float: both captures store single precision. */
const FLOAT_BYTES = 4;
/** A bone's frame in the capture: a position and a quaternion. */
const BONE_FLOATS = 7;
/** A ring's frame in the muscle capture: a centre, a quaternion and a radius. */
const RING_FLOATS = 8;

/**
 * The run's diagnostics strip, as numbers: what the Sim tab formats and the headset is sent.
 *
 * One reading for both, so the two cannot disagree about what the energies or the joint limits
 * are. A type rather than an interface, so it goes into the headset's status as the plain record
 * of numbers the status declares.
 */
export type Diagnostics = {
  kinetic: number;
  potential: number;
  /** Energy drift, in millimetres of height. */
  driftMm: number;
  /** The joint nearest its stop, as a fraction of its range. */
  limitsWorst: number;
  /** DoFs past a stop. */
  violations: number;
  contacts: number;
  costMs: number;
};

/** A reading of nothing yet, with its keys in the order the headset has always been sent them. */
function emptyDiagnostics(): Diagnostics {
  return {
    kinetic: 0,
    potential: 0,
    driftMm: 0,
    limitsWorst: 0,
    violations: 0,
    contacts: 0,
    costMs: 0,
  };
}

/**
 * Read the diagnostics off the run's newest tick; into `out` when given, so a frame allocates
 * nothing.
 */
export function diagnosticsOf(sim: Simulation, out?: Diagnostics): Diagnostics {
  const energy = sim.channel('diagnostics.energy').fields;
  const limits = sim.channel('diagnostics.limits').fields;
  let worst = 0;
  let violations = 0;
  const proximity = limits.proximity as Float64Array;
  const violation = limits.violation as Uint8Array;
  for (let i = 0; i < proximity.length; i++) {
    worst = Math.max(worst, proximity[i] ?? 0);
    violations += violation[i] ?? 0;
  }
  const reading = out ?? emptyDiagnostics();
  reading.kinetic = (energy.kinetic as Float64Array)[0] ?? 0;
  reading.potential = (energy.potential as Float64Array)[0] ?? 0;
  reading.driftMm = ((energy.drift as Float64Array)[0] ?? 0) * 1000;
  reading.limitsWorst = worst;
  reading.violations = violations;
  reading.contacts = sim.channel('contact.manifolds').count;
  reading.costMs = sim.lastStepMs;
  return reading;
}

export function definitionFor(id: string): ScenarioDefinition | undefined {
  return SCENARIO_DEFINITIONS.find((d) => d.id === id);
}

export interface SimPanelHost {
  readonly runs: StudioRuns;
  readonly controls: Controls;
  readonly document: HsdlDocument;
  /** Say something on the event line. */
  announce(text: string): void;
  /** The Muscles tab's panels, gone while the Muscles box is unticked. */
  showMusclesOff(musclesOn: boolean): void;
}

export interface SimPanel {
  /**
   * Parameter values the sliders are currently showing, per scenario.
   *
   * Kept here rather than read off the inputs so that switching scenarios and coming back keeps
   * what was set, and so a saved session can carry the values.
   */
  readonly scenarioValues: Map<string, Record<string, number>>;
  /** Whether the step rate has been set by hand, so a new run does not overwrite the choice. */
  fidelityTouched: boolean;
  /** Build the chosen scenario at the values its sliders are showing. */
  currentScenario(): ReturnType<ScenarioDefinition['build']> | undefined;
  /** The settings the next run would be built with, as the Sim tab compares them. */
  runSettings(): RunSettings;
  /**
   * The Sim tab's strip: what has changed since the running body was built, and the button that
   * builds the body the panels now describe. Hidden with no run of this page's own, and when a
   * restart would build the same body.
   */
  showPendingChanges(): void;
  /**
   * The chosen scenario's description, the profile it was validated at, and what choosing it did
   * to the Passive box when it did anything: the box is on another tab, and a setting that changes
   * out of sight should be said.
   *
   * The profile is said because a scenario's committed numbers -- its goldens, the gains it was
   * tuned with -- hold at that profile, and the studio runs whatever profile the picker shows,
   * which choosing a scenario does not change.
   */
  showScenarioNote(passive?: boolean): void;
  /**
   * Put the slider on the rate the next run will use, and say what that comes to.
   *
   * Left alone, the slider follows the profile, because an untouched slider is not a choice and
   * the run will step at the profile's own rate: it used to open at 500 while the L3 run it
   * started stepped at 1000, and jump when the run began. Moved by hand, it stays where it was put.
   */
  syncStepRate(): void;
  /**
   * What the two rates come to together, in the terms somebody exporting cares about.
   *
   * Three things, because three things follow from the pair and none of them is obvious from
   * either alone: how many keyframes land inside one output frame, how long a second of run is on
   * the timeline (always a second, and saying so is the point), and how far the simulation moves
   * per rendered frame, which is what playback speed actually is here.
   */
  showRates(): void;
  /**
   * Push the live controls into the running simulation. Safe before a run, and on change.
   *
   * The output frame rate is live because it only says how much simulated time one rendered frame
   * covers. The step rate is not here, and cannot be: `dt` is fixed for the life of a run, which
   * is what makes two runs of a scenario the same run, so a new rate is used from the next run and
   * the one running keeps its own. The Sim tab lists it as waiting for a restart until then.
   */
  applyFidelity(sim: Simulation | null | undefined): void;
  /**
   * What a tick costs each capture, and how much of a run the budget holds at that cost.
   *
   * The figures used to be written into the Recording note by hand -- so many kilobytes a tick,
   * so many seconds at one rate -- and went stale with every muscle added and every change of
   * rate. So they are worked out: during a run from what the captures actually hold, divided by
   * the ticks they cover; before one, from what a run with the current settings would capture --
   * every bone's position and orientation a tick, and with muscles every unit's rings once a
   * sweep, which is one tick in `rateDivisorFor` of the step rate. The budget is per capture, so
   * what it holds is set by the dearer of the two, and at the step rate the run uses that is so
   * many seconds of run.
   */
  showCaptureEstimate(): void;
  /** Both captures and the recording: what they hold, and whether a budget has stopped one. */
  showCaptureStatus(sim: Simulation): void;
  /** The diagnostics panel, or the line saying it fills with a run. */
  showRun(running: boolean): void;
  /** The Sim tab's diagnostics, from the run's newest tick. */
  updateDiagnostics(sim: Simulation): void;
  /** Dim the diagnostics and say which frame they are of, while the playhead is off the edge. */
  showLive(stale: boolean, caption: string): void;
}

export function createSimPanel(host: SimPanelHost): SimPanel {
  const { runs, controls: ui } = host;
  const readouts = {
    diagnostics: must<HTMLElement>('#diagnostics'),
    diagnosticsEmpty: must<HTMLElement>('#diagnostics-empty'),
    readoutNote: must<HTMLElement>('#readout-note'),
    kinetic: must<HTMLElement>('#diag-kinetic'),
    potential: must<HTMLElement>('#diag-potential'),
    drift: must<HTMLElement>('#diag-drift'),
    limits: must<HTMLElement>('#diag-limits'),
    contacts: must<HTMLElement>('#diag-contacts'),
    rate: must<HTMLElement>('#diag-rate'),
    resets: must<HTMLElement>('#diag-resets'),
    cost: must<HTMLElement>('#diag-cost'),
    captureEstimate: must<HTMLElement>('#capture-estimate'),
    captureStatus: must<HTMLElement>('#capture-status'),
    pending: must<HTMLElement>('#pending-changes'),
    pendingList: must<HTMLElement>('#pending-changes-list'),
  };
  /** The one reading the frame loop fills. */
  const diagnosticsScratch = emptyDiagnostics();

  // ------------------------------------------------------------------------------------------
  // The World tab
  // ------------------------------------------------------------------------------------------

  // Gravity can go off mid-flight: the body keeps whatever motion it had and coasts.
  ui.gravity.addEventListener('change', () => {
    runs.simulation?.setGravity(ui.gravity.checked);
  });
  // The floor likewise: the grid stays drawn, the body falls through it.
  ui.floor.addEventListener('change', () => {
    runs.simulation?.setGroundCollision(ui.floor.checked);
  });
  ui.grabStrength.addEventListener('input', () => {
    must<HTMLOutputElement>('#grabStrength-value').textContent =
      `${Number(ui.grabStrength.value).toFixed(1)}×`;
  });
  ui.dropHeight.addEventListener('input', () => {
    must<HTMLOutputElement>('#dropHeight-value').textContent =
      `${Number(ui.dropHeight.value).toFixed(2)} m`;
  });

  // ------------------------------------------------------------------------------------------
  // The Sim tab: rates and the capture budget
  // ------------------------------------------------------------------------------------------

  const panel: SimPanel = {
    scenarioValues: new Map<string, Record<string, number>>(),
    fidelityTouched: false,
    currentScenario() {
      const definition = definitionFor(ui.scenario.value);
      return definition?.build(panel.scenarioValues.get(definition.id));
    },
    runSettings() {
      return {
        profile: ui.profile.value,
        scenario: ui.scenario.value,
        scenarioParameters: { ...(panel.scenarioValues.get(ui.scenario.value) ?? {}) },
        passive: ui.passive.checked,
        redistribute: ui.redistribute.checked,
        // As a run is built: a scenario that asks for muscles has them, whatever the box says.
        muscles: ui.muscles.checked || scenarioAsksForMuscles,
        dropHeight: Number(ui.dropHeight.value),
        stepsPerSecond: panel.fidelityTouched ? Number(ui.stepsPerSecond.value) : undefined,
      };
    },
    showPendingChanges() {
      const built = runs.compiledWith;
      const changed = runs.simulation && built ? pendingChanges(built, panel.runSettings()) : [];
      const text = changed.join(', ');
      if (text === shownPending) return;
      shownPending = text;
      readouts.pendingList.textContent = text;
      readouts.pending.hidden = changed.length === 0;
    },
    showScenarioNote(passive) {
      const definition = definitionFor(ui.scenario.value);
      const said =
        passive === undefined
          ? ''
          : passive
            ? ' Passive joint resistance turned on: this scenario is tuned with it.'
            : ' Passive joint resistance turned off: this scenario is tuned without it.';
      const validated = scenarioProfile ? ` Validated at ${scenarioProfile}.` : '';
      must<HTMLElement>('#scenario-note').textContent =
        `${definition?.description ?? ''}${validated}${said}`;
    },
    syncStepRate() {
      if (!panel.fidelityTouched) ui.stepsPerSecond.value = String(profileStepRate());
      panel.showRates();
      panel.showCaptureEstimate();
    },
    showRates() {
      const fps = Number(ui.outputFramerate.value);
      const steps = Number(ui.stepsPerSecond.value);
      must<HTMLOutputElement>('#outputFramerate-value').textContent = `${fps} fps`;
      must<HTMLOutputElement>('#stepsPerSecond-value').textContent = `${steps}`;
      const perFrame = steps / Math.max(1, fps);
      const running = runs.simulation?.stepsPerSecond;
      const pending =
        running !== undefined && running !== steps
          ? ` · running at ${running}; restart to use ${steps}`
          : '';
      must<HTMLElement>('#rate-note').textContent =
        `${perFrame === Math.round(perFrame) ? perFrame : perFrame.toFixed(2)} steps a frame, ` +
        `${steps} keyframes a second of timeline, ${fps} frames a second of timeline${pending}.`;
    },
    applyFidelity(sim) {
      if (!sim) return;
      sim.outputFramerate = Number(ui.outputFramerate.value);
      sim.captureBudgetBytes = Number(ui.captureBudget.value) * 1024 * 1024;
    },
    showCaptureEstimate() {
      const sim = runs.simulation;
      const rate = sim?.stepsPerSecond ?? Number(ui.stepsPerSecond.value);
      let bones: number;
      let muscles: number;
      if (sim && sim.capture.frameCount > 0) {
        // A bone frame is a tick, so the bone capture's frame count is the ticks both captures
        // cover.
        const ticks = sim.capture.frameCount;
        bones = sim.capture.bytes / ticks;
        muscles = sim.muscleVolume ? sim.muscleCapture.bytes / ticks : 0;
      } else {
        // Each frame also carries its tick number, as one more four-byte value.
        bones = host.document.bones.length * BONE_FLOATS * FLOAT_BYTES + FLOAT_BYTES;
        const units = ui.muscles.checked ? ALL_MUSCLE_UNITS.length : 0;
        muscles =
          units > 0
            ? (units * DEFAULT_RINGS * RING_FLOATS * FLOAT_BYTES + FLOAT_BYTES) /
              rateDivisorFor(rate, DEFAULT_UPDATE_HZ)
            : 0;
      }
      const budget = Number(ui.captureBudget.value) * MEBIBYTE;
      const perTick = Math.max(bones, muscles);
      const seconds = perTick > 0 && rate > 0 ? budget / perTick / rate : 0;
      const kilobytes = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
      setText(
        readouts.captureEstimate,
        `${sim ? 'This run captures' : 'A run would capture'} ${kilobytes(bones)} a tick for the bones` +
          (muscles > 0 ? ` and ${kilobytes(muscles)} for the muscles` : '') +
          `: the budget holds about ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s ` +
          `at ${rate} steps a second.`,
      );
    },
    showCaptureStatus(sim) {
      const capture = sim.capture;
      // Both captures, because the muscle one is what usually stops first and it used to stop
      // invisibly: with the whole muscle set running, a frame of rings is dozens of times a frame
      // of bones. It is taken once a sweep rather than once a tick -- one tick in eight at
      // 1000 Hz, one in four at 500 Hz -- so it grows several times faster than the bone capture
      // rather than dozens, and on the same budget it still runs out first while this line went
      // on counting bone frames.
      const rings = sim.muscleCapture;
      // Each capture against its own budget, not the two summed against twice it: the muscle
      // capture reaches the limit on its own, which summed reads as though the run stopped at a
      // fraction of what it was allowed.
      const mb = (bytes: number) => `${(bytes / MEBIBYTE).toFixed(0)} MB`;
      const held = sim.muscleVolume
        ? `muscles ${mb(rings.bytes)}, bones ${mb(capture.bytes)}, of ${mb(sim.captureBudgetBytes)} each`
        : `${mb(capture.bytes)} of ${mb(sim.captureBudgetBytes)}`;
      // Which capture stopped, if one has. A bones-only run has nothing to level the two captures
      // against, so nothing records which one stopped; a full bone capture is then the one.
      const stoppedBy = sim.capturesStoppedBy ?? (capture.full ? 'bones' : undefined);
      // What raising the budget does after a stop is keep what is held, never carry on: the run
      // has gone past the last captured tick, and a capture with a gap in it is not one the
      // export can write. So the text says what a longer capture takes, which is a new run -- and
      // a new run of the same settings is the same run, unless somebody reached into this one.
      const stoppedAt = (capture.firstTick + capture.frameCount - 1) * sim.dt;
      setText(
        readouts.captureStatus,
        `Captured ${capture.frameCount} frames for export (${held})` +
          (stoppedBy === undefined
            ? '.'
            : ` — the ${stoppedBy === 'muscles' ? 'muscle' : 'bone'} budget reached at ` +
              `${stoppedAt.toFixed(2)} s; the ${capture.frameCount} frames held are kept and still ` +
              'export. For a longer capture raise the budget, then Reset and Start: the run is ' +
              'deterministic and replays the same unless you grabbed, dragged or changed ' +
              'drive/gravity during it.') +
          recordingStatus(sim),
      );
      panel.showCaptureEstimate();
    },
    showRun(running) {
      readouts.diagnostics.hidden = !running;
      readouts.diagnosticsEmpty.hidden = running;
    },
    updateDiagnostics(sim) {
      const d = diagnosticsOf(sim, diagnosticsScratch);
      readouts.kinetic.textContent = `${d.kinetic.toFixed(1)} J`;
      readouts.potential.textContent = `${d.potential.toFixed(1)} J`;
      readouts.drift.textContent = `${d.driftMm.toFixed(1)} mm`;
      readouts.limits.textContent =
        d.violations > 0
          ? `${d.violations} past a stop`
          : `${Math.round(d.limitsWorst * 100)}% of range`;
      readouts.contacts.textContent =
        sim.physics.contactsSeen > d.contacts
          ? `${d.contacts} shown of ${sim.physics.contactsSeen}`
          : String(d.contacts);
      // How fast simulated time is coming out, against how finely it is divided. Below the step
      // rate means the run is taking longer in wall-clock seconds than the time it covers -- not
      // that anything was skipped, because nothing is: every step is taken and every step is
      // captured.
      const declared = sim.declaredRateHz;
      const achieved = sim.achievedRateHz;
      // Paused, nothing is being produced, and the last half-second's rate would read as though
      // it still were.
      readouts.rate.textContent = sim.paused
        ? `${declared.toFixed(0)} Hz steps · paused`
        : achieved > 0
          ? `${achieved.toFixed(0)} Hz of ${declared.toFixed(0)} steps · ${(achieved / declared).toFixed(2)}x life`
          : `${declared.toFixed(0)} Hz steps`;
      // The solver's own resets: MuJoCo puts the body back at its reference after a bad
      // acceleration, and the run pauses at the first so it cannot carry on as if it had just
      // begun.
      const resets = sim.physics.backendResets;
      setText(
        readouts.resets,
        resets === 0
          ? 'none'
          : `${resets}${sim.divergedAt === undefined ? '' : `, first at ${(sim.divergedAt * sim.dt).toFixed(3)} s`}`,
      );
      readouts.cost.textContent = `${sim.lastStepMs.toFixed(3)} ms`;
    },
    showLive(stale, caption) {
      readouts.diagnostics.classList.toggle('stale', stale);
      setText(readouts.readoutNote, caption);
      if (readouts.readoutNote.hidden !== !stale) readouts.readoutNote.hidden = !stale;
    },
  };

  /** What the strip last said, so the page is written only when that changes: it runs a frame. */
  let shownPending = '';

  /** The step rate the chosen profile's solver was tuned for, which a run gets unless told. */
  const profileStepRate = (): number =>
    profileRateHz(host.document.segmentation.find((p) => p.id === ui.profile.value));

  /**
   * The sampled recording's part of the capture status: how much of the run it holds and what it
   * costs, and when it has stopped, the same promise the captures make -- what is held is kept
   * and still exports.
   */
  const recordingStatus = (sim: Simulation): string => {
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
  };

  /** The slider's own reading. */
  const showCaptureBudget = (): void => {
    const mib = Number(ui.captureBudget.value);
    must<HTMLOutputElement>('#captureBudget-value').textContent =
      mib >= 1024 ? `${(mib / 1024).toFixed(1)} GB` : `${mib} MB`;
    panel.showCaptureEstimate();
  };

  // Fit the slider to this machine and start it where a fresh simulation would. The range is the
  // platform's answer rather than a guess: `captureCeilingBytes` reads the tab's heap limit where
  // the runtime reports one and falls back to `navigator.deviceMemory`, and the default is a fifth
  // of it (`defaultCaptureBudgetBytes`: the export needs about five copies live at once). Done
  // once at startup, because neither number changes.
  {
    const ceiling = Math.floor(captureCeilingBytes() / MEBIBYTE);
    const step = Number(ui.captureBudget.step) || 32;
    ui.captureBudget.max = String(Math.max(step, Math.floor(ceiling / step) * step));
    ui.captureBudget.min = String(Math.floor(MIN_CAPTURE_BUDGET_BYTES / MEBIBYTE));
    ui.captureBudget.value = String(
      Math.min(Number(ui.captureBudget.max), Math.round(defaultCaptureBudgetBytes() / MEBIBYTE)),
    );
    showCaptureBudget();
  }
  ui.captureBudget.addEventListener('input', () => {
    showCaptureBudget();
    panel.applyFidelity(runs.simulation);
  });
  ui.outputFramerate.addEventListener('input', () => {
    panel.showRates();
    panel.applyFidelity(runs.simulation);
  });
  ui.stepsPerSecond.addEventListener('input', () => {
    panel.fidelityTouched = true;
    panel.showRates();
    panel.showCaptureEstimate();
  });
  ui.profile.addEventListener('change', () => panel.syncStepRate());
  // Once at startup, so the pair reads as a pair before anyone has touched either or started a
  // run.
  panel.syncStepRate();

  // ------------------------------------------------------------------------------------------
  // The Scene tab: the scenario and its parameters, and the Muscles box
  // ------------------------------------------------------------------------------------------

  ui.muscles.addEventListener('change', () => {
    host.showMusclesOff(ui.muscles.checked);
    panel.showCaptureEstimate();
    // The modules are registered when a run starts, so turning this on mid-run changes nothing
    // until the next one. Saying so beats a checkbox that appears to do nothing.
    const sim = runs.simulation;
    if (sim && ui.muscles.checked && !sim.muscles) {
      host.announce('Muscles start with the next run.');
    }
  });
  must<HTMLButtonElement>('#muscles-on').addEventListener('click', () => {
    ui.muscles.checked = true;
    ui.muscles.dispatchEvent(new Event('change', { bubbles: true }));
  });

  for (const d of SCENARIO_DEFINITIONS) {
    const option = window.document.createElement('option');
    option.value = d.id;
    option.textContent = d.title;
    ui.scenario.appendChild(option);
  }
  // "Drop, standing" at 0 m, the scenario the one shipped behaviour, balance, is trained in (the
  // owner's decision of 2026-09-27), so the studio opens on the body a Hand over expects. It opened
  // on quiet standing before that, and on the bare drop for the whole of phase one.
  ui.scenario.value = DEFAULT_SCENARIO;

  const defaultsRow = must<HTMLElement>('#scenario-defaults-row');

  /**
   * Draw a control per parameter of the chosen scenario, or nothing when none is chosen: a
   * slider, or a number box for a parameter with more notches than a slider can reach one by one
   * (the tilting floor's seed). A parameter moved off the value the scenario was validated with is
   * marked, its label's tooltip says what that value is, and the Defaults button under them shows
   * while any is.
   */
  const refreshScenarioParameters = (): void => {
    const definition = definitionFor(ui.scenario.value);
    ui.scenarioParameters.replaceChildren();
    defaultsRow.hidden = true;
    if (!definition) return;
    const values = panel.scenarioValues.get(definition.id) ?? {};
    const showDefaults = () => {
      defaultsRow.hidden = !definition.parameters.some((p) =>
        isChanged(p, values[p.id] ?? p.value),
      );
    };
    for (const p of definition.parameters) {
      const value = values[p.id] ?? p.value;
      values[p.id] = value;
      const control = window.document.createElement('div');
      control.className = 'control';
      const label = window.document.createElement('label');
      label.htmlFor = `scenario-${p.id}`;
      const name = window.document.createElement('span');
      name.className = 'parameter-name';
      name.textContent = p.label;
      const readout = window.document.createElement('output');
      const decimals = p.step >= 1 ? 0 : 2;
      label.title = `Default: ${p.value.toFixed(decimals)}${p.unit}`;
      const show = (v: number) => {
        readout.textContent = `${v.toFixed(decimals)}${p.unit}`;
        control.classList.toggle('changed', isChanged(p, v));
        showDefaults();
      };
      label.append(name, readout);
      const input = window.document.createElement('input');
      const kind = controlKind(p);
      input.type = kind === 'number' ? 'number' : 'range';
      input.id = `scenario-${p.id}`;
      input.min = String(p.min);
      input.max = String(p.max);
      input.step = String(p.step);
      input.value = String(value);
      show(value);
      if (kind === 'number') {
        // Taken when the box is left or Enter is pressed, held to the step and the range, and put
        // back into the box as taken: a seed typed as 4242.5 or 0 must not reach a run as that.
        input.addEventListener('change', () => {
          const next = clampToStep(p, Number(input.value));
          input.value = String(next);
          values[p.id] = next;
          show(next);
        });
      } else {
        input.addEventListener('input', () => {
          const next = Number(input.value);
          values[p.id] = next;
          show(next);
        });
      }
      control.append(label, input);
      ui.scenarioParameters.append(control);
    }
    panel.scenarioValues.set(definition.id, values);
  };

  // Every parameter of the chosen scenario back to the value it was validated with. Forgetting the
  // scenario's values, rather than writing the defaults over them, is what a fresh studio has.
  must<HTMLButtonElement>('#scenario-defaults').addEventListener('click', () => {
    const definition = definitionFor(ui.scenario.value);
    if (!definition) return;
    panel.scenarioValues.delete(definition.id);
    refreshScenarioParameters();
    host.announce(
      `${definition.title}: every parameter back to the value it was validated with. ` +
        (runs.simulation ? 'They apply from the next run.' : 'They apply when the run starts.'),
    );
  });

  /**
   * Whether the chosen scenario asks for muscles, and so gets them whatever the box says. Kept from
   * the last choice rather than worked out again, because working it out builds the scenario, and
   * the Sim tab's list of pending changes asks every frame.
   */
  let scenarioAsksForMuscles = false;

  /**
   * The profile the chosen scenario was written and validated on, by the name the Profile picker
   * gives it, or undefined for the free drop. Kept from the last choice, as
   * `scenarioAsksForMuscles` is, because working it out builds the scenario.
   */
  let scenarioProfile: string | undefined;

  const scenarioChanged = (): void => {
    const definition = definitionFor(ui.scenario.value);
    must<HTMLElement>('#dropHeight-control').hidden = definition !== undefined;

    refreshScenarioParameters();
    const chosen = panel.currentScenario();
    scenarioProfile = chosen
      ? (SEGMENTATION_PROFILES.find((p) => p.id === chosen.profileId)?.displayName ??
        chosen.profileId)
      : undefined;
    // Set to what the scenario is tuned with, as before -- a scenario is chosen to be watched as
    // it was made -- and now said, when it differs from what the box had.
    const turned =
      chosen && chosen.passiveJoints !== ui.passive.checked ? chosen.passiveJoints : undefined;
    if (chosen) ui.passive.checked = chosen.passiveJoints;
    panel.showScenarioNote(turned);
    scenarioAsksForMuscles = chosen?.muscles === true;
    // A scenario that asks for muscles turns them on, and says so by ticking the box rather than
    // leaving the panel claiming they are off while the arms move.
    if (chosen?.muscles === true) {
      ui.muscles.checked = true;
      host.showMusclesOff(true);
    }
  };
  ui.scenario.addEventListener('change', scenarioChanged);
  // Once at startup, because the picker opens on a scenario rather than on nothing and the note,
  // the sliders and the muscle box all follow from which one that is.
  scenarioChanged();
  // A box ticked by hand is the person's choice, not the scenario's, so the note stops saying the
  // scenario turned it.
  ui.passive.addEventListener('change', () => panel.showScenarioNote());

  // The strip of settings waiting for a restart follows every control that reaches a run only
  // when it is built, as it moves, rather than at the next frame; the scenario's own sliders are
  // made afresh with each scenario, so their container is watched instead.
  for (const control of [
    ui.profile,
    ui.scenario,
    ui.scenarioParameters,
    ui.passive,
    ui.redistribute,
    ui.muscles,
    ui.dropHeight,
    ui.stepsPerSecond,
  ]) {
    control.addEventListener('input', () => panel.showPendingChanges());
    control.addEventListener('change', () => panel.showPendingChanges());
  }
  // The strip's "Restart with current settings" is the transport's (`ui/transport.ts`): it is the
  // one press that throws a run away to start another, and it asks first as Reset does.

  return panel;
}
