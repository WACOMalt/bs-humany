/**
 * Every setting a session holds, and the files the studio writes and reads: the panels' controls
 * as one set, a session saved and loaded, a checkpoint's recipe put on the panels, and the two
 * exports.
 *
 * The file formats and their checks are `session.ts`'s; this is where they meet the page.
 */

import type { HsdlDocument } from '@bs-humany/hsdl';
import type { BackendId } from '@bs-humany/session';
import { REFERENCE_PROFILE } from '@bs-humany/skeleton';
import { buildBlenderExport } from './blenderExport.js';
import type { BrainPanel } from './brain.js';
import type { StudioRuns } from './runController.js';
import {
  type NormalisedSettings,
  SESSION_FORMAT,
  type SessionFile,
  channelPrints,
  download,
  downloadSet,
  isSessionFile,
  normaliseSettings,
  openTextFile,
  serializeSnapshot,
  sessionFormatOf,
  usesNativeFilePickers,
} from './session.js';
import { sameCord } from './training/setUp.js';
import type { BodyPanel } from './ui/bodyPanel.js';
import { messageOf, must, paintYield, setControl } from './ui/dom.js';
import type { MusclePanel } from './ui/musclePanel.js';
import { type SimPanel, definitionFor } from './ui/simPanel.js';
import type { StatusLine } from './ui/transport.js';

/**
 * The physics every run is built on. ADR-003 reassessment: the only enabled backend, and since
 * 2026-09-26 the only one there is, so the top bar no longer offers a choice of one. A session
 * still writes it, as "mujoco", and one naming Rapier is run on MuJoCo like any other.
 */
export const BACKEND: BackendId = 'mujoco';

/**
 * The page's settings controls, found once: the body, the scene, the world, the rates, the
 * overlays and the view toggles. What a session holds is read off these, and what it carries is
 * put back onto them.
 */
export function findControls() {
  return {
    sex: must<HTMLInputElement>('#sex'),
    stature: must<HTMLInputElement>('#stature'),
    mass: must<HTMLInputElement>('#mass'),
    percentile: must<HTMLInputElement>('#percentile'),
    showGrid: must<HTMLInputElement>('#showGrid'),
    spin: must<HTMLInputElement>('#spin'),
    profile: must<HTMLSelectElement>('#profile'),
    passive: must<HTMLInputElement>('#passive'),
    redistribute: must<HTMLInputElement>('#redistribute'),
    dropHeight: must<HTMLInputElement>('#dropHeight'),
    grabStrength: must<HTMLInputElement>('#grabStrength'),
    gravity: must<HTMLInputElement>('#gravity'),
    floor: must<HTMLInputElement>('#floor'),
    scenario: must<HTMLSelectElement>('#scenario'),
    scenarioParameters: must<HTMLDivElement>('#scenario-parameters'),
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
}

export type Controls = ReturnType<typeof findControls>;

/** What a grey Export button and the Export tab say with no run to export. */
const EXPORT_NEEDS_RUN = 'Export needs a run: press Start sim';

/** Megabytes, to one decimal place: an export's size, as the event line reports it. */
function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface SessionHost {
  readonly document: HsdlDocument;
  readonly controls: Controls;
  readonly runs: StudioRuns;
  readonly status: StatusLine;
  readonly body: BodyPanel;
  readonly sim: SimPanel;
  readonly muscles: MusclePanel;
  /**
   * The Brain panel, whose cord, authority and chosen checkpoint a session holds. Asked for
   * rather than handed over, because the panel is made after this and asks this for the settings
   * a checkpoint's recipe puts on the panels; nothing here asks for it until a person acts.
   */
  brain(): BrainPanel;
  /** Every set of run buttons on the page, refreshed together. */
  setRunControls(running: boolean): void;
  /**
   * Whether it is all right to throw the running body's recording away; asks the person when it
   * is long. Loading a session always does throw it away, and only a person at the desktop loads
   * one.
   * @see Transport.confirmDiscard
   */
  confirmDiscard(what: string): Promise<boolean>;
}

export interface SessionWiring {
  /**
   * Every setting a session holds, as the panels show them now.
   *
   * The step rate only when somebody chose one, so a session saved with the slider left alone
   * runs at whatever profile it names. The cord, the authority and the chosen checkpoint are the
   * Brain panel's, read from its state rather than off its elements.
   */
  currentSettings(): NormalisedSettings;
  /**
   * Put a whole set of settings on the panels, and restart a running body with them.
   *
   * The order matters in two places. The Muscles box goes before the scenario, because a scenario
   * that drives muscles ticks it. Passive and Redistribute go after it, because choosing a
   * scenario sets Passive to the one the scenario is tuned with -- and a saved or recipe value
   * applied before that was quietly overwritten, so a session saved with Passive off ran with it
   * on, and its snapshot, which had no passive module, then refused to restore.
   *
   * Returns what it could not put on the panels as asked, in words for the event line, or
   * undefined: the caller says it, with whatever else it has to say, because a message given here
   * would be replaced by the caller's own.
   */
  applySettings(settings: NormalisedSettings): string | undefined;
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
  saving(what: string, write: Promise<boolean>): Promise<boolean>;
  /** The export buttons, grey with no run and while an export is being written. */
  setExportControls(running: boolean): void;
}

export function createSessionWiring(host: SessionHost): SessionWiring {
  const { controls: ui, runs, status, body } = host;
  const exportRecording = must<HTMLButtonElement>('#export');
  const exportBlender = must<HTMLButtonElement>('#export-blender');
  const save = must<HTMLButtonElement>('#save');
  const load = must<HTMLButtonElement>('#load');
  const loadFile = must<HTMLInputElement>('#load-file');
  const exportWhy = must<HTMLElement>('#export-why');
  /** Each Export button's own title, for when there is a run. */
  const exportTitles: readonly (readonly [HTMLButtonElement, string])[] = [
    [exportRecording, 'Write the sampled recording of this run as JSON'],
    [
      exportBlender,
      'Three files: the glTF, the muscle vertex cache, and the script that imports them',
    ],
  ];
  /**
   * Whether an export is being built or written: both export buttons stay grey until it is done.
   *
   * Building the Blender export takes seconds on a long run and blocks the page while it does, and
   * nothing used to say so: the button looked like it had done nothing, so it was pressed again,
   * and each press queued another whole export behind the first.
   */
  let exporting = false;

  const currentSettings = (): NormalisedSettings => {
    const brainState = host.brain().state();
    const drive: Record<string, number> = {};
    for (const [id, input] of host.muscles.driveInputs) {
      const level = Number(input.value);
      if (level !== 0) drive[id] = level;
    }
    return {
      sex: Number(ui.sex.value),
      stature: Number(ui.stature.value),
      mass: Number(ui.mass.value),
      profile: ui.profile.value,
      backend: BACKEND,
      scenario: ui.scenario.value,
      passive: ui.passive.checked,
      redistribute: ui.redistribute.checked,
      dropHeight: Number(ui.dropHeight.value),
      grabStrength: Number(ui.grabStrength.value),
      gravity: ui.gravity.checked,
      floor: ui.floor.checked,
      ...(ui.scenario.value
        ? { scenarioParameters: { ...host.sim.scenarioValues.get(ui.scenario.value) } }
        : {}),
      muscles: ui.muscles.checked,
      ...(host.sim.fidelityTouched ? { stepsPerSecond: Number(ui.stepsPerSecond.value) } : {}),
      outputFramerate: Number(ui.outputFramerate.value),
      captureBudgetMiB: Number(ui.captureBudget.value),
      drive,
      reflex: { ...brainState.reflex },
      brainAuthority: brainState.authority,
      ...(brainState.selected ? { checkpoint: brainState.selected } : {}),
    };
  };

  /**
   * What Save writes: the panels as they are, except that with a run going, the settings the run
   * was built with stand in for the ones a restart would change.
   *
   * The snapshot in the file is of the running body, and it can only go back into a body built
   * the same way. A profile chosen, or Passive unticked, since the run started is listed in the
   * Sim tab as waiting for a restart; saved as it stands, it made a file whose settings built
   * another body than its snapshot came from, which then refused to restore.
   */
  const settingsToSave = (): NormalisedSettings => {
    const now = currentSettings();
    const built = runs.compiledWith;
    if (!runs.simulation || !built) return now;
    const { stepsPerSecond: _, scenarioParameters: __, ...rest } = now;
    return {
      ...rest,
      profile: built.profile,
      scenario: built.scenario,
      ...(built.scenario ? { scenarioParameters: { ...built.scenarioParameters } } : {}),
      passive: built.passive,
      redistribute: built.redistribute,
      muscles: built.muscles,
      dropHeight: built.dropHeight,
      ...(built.stepsPerSecond !== undefined ? { stepsPerSecond: built.stepsPerSecond } : {}),
    };
  };

  /**
   * The cord and the authority onto the Brain panel, through its own hands, and only where they
   * differ: moving Authority on a panel with a policy in charge reaches the running body, and a
   * recipe that re-applies the panel's own values should not touch it.
   */
  const applyBrainSettings = (settings: NormalisedSettings): void => {
    const brain = host.brain();
    const state = brain.state();
    const cord = settings.reflex;
    if (cord) {
      const moves = [
        ['reflexStretch', state.reflex.stretch, cord.stretch],
        ['reflexVelocity', state.reflex.velocity, cord.velocity],
        ['reflexSetPoint', state.reflex.setPoint, cord.setPoint],
        ['reflexInhibition', state.reflex.inhibition, cord.inhibition],
        ['reflexDelay', state.reflex.delaySeconds, cord.delaySeconds],
      ] as const;
      // Stretch, all regions is moved again when the cord differs, even to the value it has:
      // moving it is what puts every region back to following it, before each region the cord
      // names is set. A file with no regions, from before them, so runs its stretch everywhere.
      const regions = cord.regionStretch ?? {};
      const differs = !sameCord(state.reflex, cord);
      for (const [action, was, value] of moves) {
        if (was !== value || (action === 'reflexStretch' && differs)) {
          brain.act(action, undefined, value);
        }
      }
      if (differs) {
        for (const [region, value] of Object.entries(regions)) {
          brain.act('reflexRegionStretch', region, value);
        }
      }
    }
    if (settings.brainAuthority !== undefined && settings.brainAuthority !== state.authority) {
      brain.act('authority', undefined, settings.brainAuthority);
    }
  };

  const applySettings = (settings: NormalisedSettings): string | undefined => {
    ui.sex.value = String(settings.sex);
    ui.stature.value = String(settings.stature);
    ui.mass.value = String(settings.mass);
    // A profile this studio lacks would leave the select on nothing, and the next run would be
    // built from whatever an empty id falls back to. A loaded session is refused before it gets
    // here (`loadSessionText`); a checkpoint's recipe is not, so it gets the reference body -- the
    // one the page opens on -- and the caller says so.
    let unapplied: string | undefined;
    if ([...ui.profile.options].some((o) => o.value === settings.profile)) {
      ui.profile.value = settings.profile;
    } else {
      ui.profile.value = REFERENCE_PROFILE;
      unapplied =
        `The body profile ${settings.profile} is not one this studio has; ` +
        `${ui.profile.selectedOptions[0]?.textContent?.trim() ?? REFERENCE_PROFILE} is used instead.`;
    }
    // The session's backend is not read: MuJoCo is the only one, whatever the file says.
    ui.muscles.checked = settings.muscles;
    host.muscles.showMusclesOff(ui.muscles.checked);
    ui.scenario.value = settings.scenario;
    if (settings.scenario && settings.scenarioParameters) {
      host.sim.scenarioValues.set(settings.scenario, { ...settings.scenarioParameters });
    }
    ui.scenario.dispatchEvent(new Event('change'));
    ui.passive.checked = settings.passive;
    ui.redistribute.checked = settings.redistribute;
    // The box is what the settings say, not what the scenario turned it to, so the note stops
    // saying the scenario turned it.
    host.sim.showScenarioNote();
    setControl(ui.dropHeight, settings.dropHeight);
    ui.gravity.checked = settings.gravity;
    ui.floor.checked = settings.floor;
    setControl(ui.grabStrength, settings.grabStrength);
    // A rate somebody chose is theirs again; none means the profile's own, as in a fresh studio.
    if (settings.stepsPerSecond !== undefined) {
      ui.stepsPerSecond.value = String(settings.stepsPerSecond);
      host.sim.fidelityTouched = true;
    } else {
      host.sim.fidelityTouched = false;
    }
    host.sim.syncStepRate();
    setControl(ui.outputFramerate, settings.outputFramerate);
    if (settings.captureBudgetMiB !== undefined) {
      setControl(ui.captureBudget, settings.captureBudgetMiB);
    }
    for (const [id, input] of host.muscles.driveInputs) setControl(input, settings.drive[id] ?? 0);
    applyBrainSettings(settings);
    body.cancelPreview();
    body.rebuildMesh();
    // Always a restart when a run is going, whether or not the body changed: the settings carry
    // the profile, the scenario and the joints as well, and none of those reach a run already
    // built.
    body.rebuildBody('Settings applied', { always: true });
    return unapplied;
  };

  const saving = async (what: string, write: Promise<boolean>): Promise<boolean> => {
    try {
      if (await write) {
        status.announce(`Wrote ${what}.`);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Writing ${what} failed.`, error);
      status.announce(`Writing ${what} failed: ${messageOf(error)}`, { error: true });
      return false;
    }
  };

  exportRecording.addEventListener('click', async () => {
    const sim = runs.simulation;
    if (!sim || exporting) return;
    exporting = true;
    host.setRunControls(true);
    const name = `bs-humany-${sim.recording.scenario}-${sim.backendId}.json`;
    try {
      // The string is made inside the write, so that the RangeError a very long recording used to
      // throw here -- before `saving` could see it -- is reported as a failed write like any other.
      await saving(name, (async () => download(name, sim.exportRecording()))());
    } finally {
      exporting = false;
      host.setRunControls(runs.simulation !== null);
    }
  });
  exportBlender.addEventListener('click', async () => {
    const sim = runs.simulation;
    const pack = body.assets;
    if (!sim || !pack || exporting) return;
    exporting = true;
    host.setRunControls(true);
    status.announce('Exporting for Blender…');
    try {
      // Let the grey button and the message paint before the build takes the page for seconds.
      await paintYield();
      const began = performance.now();
      const built = buildBlenderExport(sim, host.document, pack);
      const seconds = (performance.now() - began) / 1000;
      // All three together, because none is any use without the others: the glTF holds the bones
      // and the belly mesh, the cache holds the bellies' movement, and the script is what wires
      // the one to the other. One folder in the desktop shell; three downloads in a browser, which
      // is all a page can do.
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
      status.announce(`The Blender export failed: ${messageOf(error)}`, { error: true });
    } finally {
      exporting = false;
      host.setRunControls(runs.simulation !== null);
    }
  });

  save.addEventListener('click', () => {
    const simulation = runs.simulation;
    const file: SessionFile = {
      format: SESSION_FORMAT,
      savedAt: new Date().toISOString(),
      settings: settingsToSave(),
      ...(simulation
        ? {
            simulation: {
              ticks: simulation.ticks,
              snapshot: serializeSnapshot(simulation.snapshot()),
              channels: channelPrints(simulation.kernel.channels),
            },
          }
        : {}),
    };
    void saving('bs-humany-session.json', download('bs-humany-session.json', JSON.stringify(file)));
  });

  /**
   * Choose the session's checkpoint in the Brain panel's list; true when the list lacks it.
   *
   * The list is read first, because a studio that has not opened the Brain tab has not asked for
   * it yet, and a checkpoint missing from an unread list is not missing. A file names a checkpoint
   * rather than carrying one, so a checkpoint from another machine, or one forgotten since, cannot
   * be chosen. Saying so is left to the caller: the load goes on to start the session's run, and a
   * start clears the notices before it, so a notice given here would be gone before anyone read it.
   */
  const chooseSessionCheckpoint = async (id: string): Promise<boolean> => {
    const brain = host.brain();
    await brain.poll();
    const state = brain.state();
    if (state.selected === id) return false;
    if (!state.checkpoints.some((c) => c.id === id)) return true;
    brain.act('select', id);
    return false;
  };

  /** Apply a session file's contents, whichever picker they came through. */
  const loadSessionText = async (text: string): Promise<void> => {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isSessionFile(parsed)) {
        const format = sessionFormatOf(parsed);
        throw new Error(
          format
            ? `it was written by a newer studio (${format}); this one reads ${SESSION_FORMAT} and ` +
                'the format before it.'
            : 'it is not a bs-humany session file.',
        );
      }
      // The saved run decides its own rate and muscles; its step and channel ids are all that is
      // read of it here, so it is decoded once, when it is restored.
      const settings = normaliseSettings(parsed.settings, parsed.simulation?.snapshot);
      // Named, rather than left for the select to fall back to its first option or to nothing: a
      // session that ran on a profile or a scenario this studio lacks cannot be the session it was.
      if (![...ui.profile.options].some((o) => o.value === settings.profile)) {
        throw new Error(`it names the body profile ${settings.profile}, which this studio lacks.`);
      }
      if (settings.scenario !== '' && !definitionFor(settings.scenario)) {
        throw new Error(`it names the scenario ${settings.scenario}, which this studio lacks.`);
      }
      // Asked once the file is known to be one that will load: a file that is refused changes
      // nothing, and a question about a run the load never touches would be asked for nothing.
      if (!(await host.confirmDiscard('Loading this session'))) return;
      // A session with a run in it starts that run. Stopped first, so the settings going in do not
      // carry the old run across into a restart of their own that the snapshot then races.
      if (parsed.simulation) runs.stop();
      // What was said before the load is not about it, and whatever this load says is gathered on
      // the line from here. An error stays, as it does when a run starts.
      status.dismissAnnouncement(true);
      // The checkpoint before the settings. Choosing one in the list only shows it now -- its
      // recipe goes on the tabs only through Set up as trained -- but the session's own settings
      // are the ones that must win, so they still go on last.
      const missing =
        settings.checkpoint && (await chooseSessionCheckpoint(settings.checkpoint))
          ? settings.checkpoint
          : undefined;
      // Nothing can be left unapplied here: a session naming a profile this studio lacks was
      // refused above.
      applySettings(settings);
      if (parsed.simulation) await runs.start(parsed.simulation);
      // Last, once the start has cleared its notices and said what it had to: beside a refused
      // restore, or a capture the applied settings discarded, rather than in place of it.
      if (missing !== undefined) {
        status.announceAlongside(
          `The session's checkpoint ${missing} could not be found in the Brain panel's list; ` +
            'the rest of the session was applied.',
        );
      }
    } catch (error) {
      console.error('The session failed to load.', error);
      status.announce(`The session failed to load: ${messageOf(error)}`, { error: true });
    }
  };

  load.addEventListener('click', async () => {
    // The hidden `<input type="file">` is a browser's only way to ask for a file and a web view's
    // no way at all: clicking it there opens nothing. The shell has a dialog instead.
    if (usesNativeFilePickers()) {
      const text = await openTextFile();
      if (text !== undefined) await loadSessionText(text);
      return;
    }
    loadFile.click();
  });
  loadFile.addEventListener('change', async () => {
    const file = loadFile.files?.[0];
    if (!file) return;
    try {
      await loadSessionText(await file.text());
    } finally {
      loadFile.value = '';
    }
  });

  return {
    currentSettings,
    applySettings,
    saving,
    setExportControls(running) {
      // Grey while an export is being written as well, because this runs every frame while the
      // playhead is behind the live edge and would otherwise hand a second click straight back.
      exportRecording.disabled = !running || exporting;
      exportBlender.disabled = !running || exporting;
      // Grey with no run, and saying why where a grey button's reason is looked for, and on the
      // tab.
      for (const [button, title] of exportTitles) {
        const want = running ? title : EXPORT_NEEDS_RUN;
        if (button.title !== want) button.title = want;
      }
      if (exportWhy.hidden !== running) exportWhy.hidden = running;
    },
  };
}
