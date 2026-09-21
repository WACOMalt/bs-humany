/**
 * The brain panel: a trained policy put in charge of the body, and training started from here.
 *
 * Both go through the dashboard server on this machine (`pnpm train:dashboard`) when one is
 * running, and through web workers in this very window when one is not, so a studio with no
 * terminal behind it can still train. The server lists the
 * saved checkpoints, serves any one of them, and starts and stops a training run the way a
 * terminal would. A checkpoint is fitted to whatever body is running by the names of its senses
 * and drives, so a policy trained on one profile drives another, and the panel says how much of
 * it carried. Handing over is a restart of the run with its state carried, the same path a
 * morphology change takes, because the nerves are a module registered at construction.
 */

import type { PolicyFile } from '@bs-humany/modules-nerves';
import { type NervesSetup, SCENARIO_DEFINITIONS } from '@bs-humany/scenarios';
import { type LocalRun, startLocalTraining, suggestedWorkers } from './training/localTraining.js';
import { shippedCheckpoint, shippedCheckpoints } from './training/shipped.js';
import { listLocalCheckpoints, readLocalCheckpoint } from './training/store.js';

export const DEFAULT_DASHBOARD_URL = 'http://localhost:5280';

/** What a checkpoint was trained in; the trainer's `TrainingRecipe`, as the policy file keeps it. */
export type TrainingRecipe = NonNullable<PolicyFile['recipe']>;

/**
 * The showcase's brain, as it writes it ten times a second to
 * `tools/train/runs/<name>-activity.json`: one array a layer, senses first, drives last.
 */
export interface RemoteActivity {
  readonly name: string;
  readonly layers: readonly (readonly number[])[];
  readonly generation: number;
  readonly time: number;
  readonly up: boolean;
}

/** The part of a recipe the studio's own tabs supply: the scene, the body, the joints. */
export type RecipeInput = Pick<
  TrainingRecipe,
  'scenario' | 'parameters' | 'profile' | 'morphology' | 'passive' | 'redistribute'
>;

export interface CheckpointRow {
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly profile: string | null;
  readonly sizes: readonly number[];
  readonly trained: {
    readonly generations: number;
    readonly fitness: number;
    readonly episodes: number;
    readonly at: string;
  } | null;
  readonly recipe?: TrainingRecipe | null;
}

export interface TrainingStatus {
  readonly running: boolean;
  /** Whether the showcase that plays the run is still up; it outlives the trainer. */
  readonly showcase?: boolean;
  /** Whether a trainer someone started in a terminal is up, which this server cannot stop. */
  readonly elsewhere?: boolean;
  readonly startedAt: string | null;
  readonly task: string | null;
  /** The checkpoint being trained, when the server started it. */
  readonly name?: string | null;
  readonly exit: number | null;
  readonly latest: {
    readonly updated: string;
    readonly episodes: number;
    readonly best: {
      readonly fitness: number;
      readonly alive: number;
      readonly generation: number;
    };
    readonly profile: string | null;
    readonly generations: number;
    readonly series: readonly (readonly [number, number, number, number])[];
  } | null;
}

export interface BrainHost {
  /** Restart the run with this policy in the loop, state carried; undefined takes it out. */
  handOver(setup: NervesSetup | undefined): void;
  /** Start following the bridge, where the training's showcase publishes. */
  startFollowing(): void;
  /** Follow the bridge, or stop: the headset's one button, and the desktop's. */
  toggleFollowing(): void;
  /** The scene, body and joints as the tabs have them now: what a new checkpoint trains in. */
  recipe(): RecipeInput;
  /**
   * The checkpoint whose showcase is publishing to the bridge, if one is -- the showcase puts its
   * name in the status it writes -- so the brain being watched can be named even when this
   * server did not start it.
   */
  publishedTrainingName(): string | undefined;
  /** Set the tabs up from a checkpoint's recipe, so the body handed over is the one it knows. */
  applyRecipe(recipe: TrainingRecipe): void;
  /** What the running body could use of the policy, once it is in. */
  fit():
    | { carried: { inputs: number; outputs: number }; inputs: number; outputs: number }
    | undefined;
  /** Ticks between evaluations for the body about to run: a hundred hertz at its rate. */
  controlDivisor(): number;
  /** Whether the run is currently following the bridge rather than its own. */
  following(): boolean;
  /**
   * Set the cord's reflex gains on the running body. Optional: a host with no muscles has no
   * cord to set, and the panel is drawn either way.
   */
  setReflex?(gains: {
    stretch: number;
    velocity: number;
    setPoint: number;
    inhibition: number;
    forceCeiling: number;
    forceInhibition: number;
    delaySeconds: number;
  }): void;
}

export interface BrainState {
  readonly serverUp: boolean;
  readonly active: boolean;
  readonly authority: number;
  readonly selected: string;
  readonly checkpoints: readonly { readonly id: string; readonly name: string }[];
  readonly fit: string;
  readonly training: string;
  readonly trainingRunning: boolean;
  /** Whether Stop would do anything: the trainer, or the showcase that outlives it. */
  readonly trainingStoppable: boolean;
  readonly following: boolean;
  /** The cord's gains, so the headset's Spine panel shows what the desktop has. */
  readonly reflex: {
    readonly stretch: number;
    readonly velocity: number;
    readonly setPoint: number;
    readonly inhibition: number;
    readonly delaySeconds: number;
  };
  /** Context units the next run will train with. */
  readonly memory: number;
}

export interface BrainPanel {
  /** Refresh the checkpoint list and the training status; cheap, safe to call often. */
  poll(): Promise<void>;
  /**
   * The training showcase's brain as of the last tenth of a second, while one is publishing --
   * what the Activity panel draws when the policy in the loop is not this page's own.
   */
  remoteActivity(): RemoteActivity | undefined;
  /** What the panel would put in the loop for a new run, if a policy is chosen. */
  readonly setup: NervesSetup | undefined;
  /** What the chosen checkpoint was trained in, when its file says: the run should match it. */
  chosenRecipe(): TrainingRecipe | undefined;
  /** The panel as the headset sees it. */
  state(): BrainState;
  /** The headset's hands on the panel: the same buttons the mouse presses. */
  act(
    action:
      | 'select'
      | 'handover'
      | 'release'
      | 'authority'
      | 'trainStart'
      | 'trainStop'
      | 'follow'
      | 'reflexStretch'
      | 'reflexVelocity'
      | 'reflexSetPoint'
      | 'reflexInhibition'
      | 'reflexDelay'
      | 'memory',
    id?: string,
    value?: number,
  ): void;
}

const must = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

export function createBrainPanel(host: BrainHost, dashboard = DEFAULT_DASHBOARD_URL): BrainPanel {
  const ui = {
    policy: must<HTMLSelectElement>('#brain-policy'),
    policyNote: must<HTMLElement>('#brain-policy-note'),
    authority: must<HTMLInputElement>('#brain-authority'),
    authorityValue: must<HTMLOutputElement>('#brain-authority-value'),
    handover: must<HTMLButtonElement>('#brain-handover'),
    release: must<HTMLButtonElement>('#brain-release'),
    fitNote: must<HTMLElement>('#brain-fit-note'),
    idleNote: must<HTMLElement>('#brain-idle-note'),
    generations: must<HTMLInputElement>('#train-generations'),
    population: must<HTMLInputElement>('#train-population'),
    seconds: must<HTMLInputElement>('#train-seconds'),
    workers: must<HTMLInputElement>('#train-workers'),
    noiseMotor: must<HTMLInputElement>('#train-noise-motor'),
    noiseSense: must<HTMLInputElement>('#train-noise-sense'),
    memory: must<HTMLInputElement>('#train-memory'),
    spineStretch: must<HTMLInputElement>('#spine-stretch'),
    spineVelocity: must<HTMLInputElement>('#spine-velocity'),
    spineSetPoint: must<HTMLInputElement>('#spine-setpoint'),
    spineInhibition: must<HTMLInputElement>('#spine-inhibition'),
    spineDelay: must<HTMLInputElement>('#spine-delay'),
    resume: must<HTMLInputElement>('#train-resume'),
    name: must<HTMLInputElement>('#train-name'),
    task: must<HTMLSelectElement>('#train-task'),
    feedforward: must<HTMLSelectElement>('#train-feedforward'),
    recipeNote: must<HTMLElement>('#train-recipe-note'),
    start: must<HTMLButtonElement>('#train-start'),
    stop: must<HTMLButtonElement>('#train-stop'),
    status: must<HTMLElement>('#train-status'),
    chart: must<HTMLCanvasElement>('#train-chart'),
  };
  let rows: CheckpointRow[] = [];
  let setup: NervesSetup | undefined;
  let serverUp = false;
  let trainingRunning = false;
  let trainingStoppable = false;
  /** The checkpoint the server is training, for the run files' names. */
  let trainingName: string | undefined;
  /** The checkpoint whoever is on the bridge is playing, when it is not this server's run. */
  let publishedName: string | undefined;
  let activity: RemoteActivity | undefined;
  /** A run going in this window, with no server: its handle, and what it has said so far. */
  let localRun: LocalRun | undefined;
  let localSeries: [number, number, number, number][] = [];
  let localStatus = '';
  /** Asked to stop, and not stopped yet: a generation has to finish first. */
  let localStopping = false;
  /** When the activity last actually changed: a file nobody is writing any more goes stale. */
  let activityChangedAt = 0;
  /** The last payload seen, whether or not it was shown: what "changed" is measured against. */
  let activitySeen = '';

  const readouts: [HTMLInputElement, string][] = [
    [ui.generations, '#train-generations-value'],
    [ui.population, '#train-population-value'],
    [ui.seconds, '#train-seconds-value'],
    [ui.workers, '#train-workers-value'],
  ];
  for (const [input, selector] of readouts) {
    const out = must<HTMLOutputElement>(selector);
    const show = () => {
      out.textContent = input.value;
    };
    input.addEventListener('input', show);
    show();
  }
  // The noise sliders read in hundredths, so they want their own places rather than the
  // whole numbers the counts above are shown in.
  for (const [input, selector] of [
    [ui.noiseMotor, '#train-noise-motor-value'],
    [ui.noiseSense, '#train-noise-sense-value'],
  ] as [HTMLInputElement, string][]) {
    const out = must<HTMLOutputElement>(selector);
    const show = () => {
      const value = Number(input.value);
      out.textContent = value === 0 ? 'off' : value.toFixed(3);
    };
    input.addEventListener('input', show);
    show();
  }
  const showAuthority = () => {
    ui.authorityValue.textContent = Number(ui.authority.value).toFixed(2);
  };
  ui.authority.addEventListener('input', showAuthority);
  showAuthority();

  // Memory reads as a count, and "none" at zero, because 0 context units is a different kind of
  // policy rather than a small amount of one.
  const showMemory = () => {
    const n = Number(ui.memory.value);
    must<HTMLOutputElement>('#train-memory-value').textContent = n === 0 ? 'none' : String(n);
  };
  ui.memory.addEventListener('input', showMemory);
  showMemory();

  /** What the cord's sliders say, in the shape the recipe and the module both take. */
  const reflexFromUi = () => ({
    stretch: Number(ui.spineStretch.value),
    velocity: Number(ui.spineVelocity.value),
    setPoint: Number(ui.spineSetPoint.value),
    inhibition: Number(ui.spineInhibition.value),
    forceCeiling: 1.2,
    forceInhibition: 0.5,
    delaySeconds: Number(ui.spineDelay.value),
  });

  const showSpine = () => {
    const stretch = Number(ui.spineStretch.value);
    must<HTMLOutputElement>('#spine-stretch-value').textContent =
      stretch === 0 ? 'off' : stretch.toFixed(3);
    must<HTMLOutputElement>('#spine-velocity-value').textContent = Number(
      ui.spineVelocity.value,
    ).toFixed(1);
    must<HTMLOutputElement>('#spine-setpoint-value').textContent = Number(
      ui.spineSetPoint.value,
    ).toFixed(2);
    must<HTMLOutputElement>('#spine-inhibition-value').textContent = Number(
      ui.spineInhibition.value,
    ).toFixed(2);
    must<HTMLOutputElement>('#spine-delay-value').textContent = `${Math.round(
      Number(ui.spineDelay.value) * 1000,
    )} ms`;
    // The running body takes the gains at once: the cord is the body's, not the policy's, and
    // turning the reflexes up is something to watch happen rather than to restart for.
    host.setReflex?.(reflexFromUi());
  };
  for (const input of [
    ui.spineStretch,
    ui.spineVelocity,
    ui.spineSetPoint,
    ui.spineInhibition,
    ui.spineDelay,
  ]) {
    input.addEventListener('input', showSpine);
  }
  showSpine();

  const scenarioTitle = (id: string) =>
    id === ''
      ? 'the reference stand'
      : (SCENARIO_DEFINITIONS.find((d) => d.id === id)?.title ?? id);
  const describe = (row: CheckpointRow): string => {
    const t = row.trained;
    const where = row.profile ? row.profile.replace(/_.*/, '').toUpperCase() : 'body unknown';
    const scene = row.recipe ? `, ${scenarioTitle(row.recipe.scenario)}` : '';
    return t
      ? `${row.name} — ${row.task}, ${where}${scene}, gen ${t.generations}, fitness ${t.fitness.toFixed(2)}`
      : `${row.name} — ${row.task}, ${where}${scene}`;
  };

  /** What Start would train, from the tabs as they are, so it is said before it is done. */
  const NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;
  const showRecipe = () => {
    const input = host.recipe();
    const name = ui.name.value.trim();
    const exists = rows.some((r) => r.recipe?.name === name || r.name === `${name}.json`);
    const under =
      ui.feedforward.value === 'script'
        ? "with the scenario's script under it"
        : ui.feedforward.value === 'clip'
          ? 'over the quiet-standing clip'
          : 'alone';
    const where = input.profile.replace(/_.*/, '').toUpperCase();
    const body = `${input.morphology.stature.toFixed(2)} m, ${input.morphology.mass.toFixed(0)} kg`;
    const scored = ui.task.value === 'balance' ? 'a still, level head' : 'standing';
    ui.recipeNote.textContent = !NAME.test(name)
      ? 'A name is lower-case letters, digits, dashes and underscores.'
      : `${exists ? (ui.resume.checked ? 'Continues' : 'Refused: exists. Tick Resume to continue') : 'Starts'} ${name}: the brain ${under}, in ${scenarioTitle(input.scenario)} on ${where} (${body}), scored on ${scored}.`;
  };
  ui.name.addEventListener('input', showRecipe);
  ui.feedforward.addEventListener('change', showRecipe);
  ui.task.addEventListener('change', showRecipe);
  ui.resume.addEventListener('change', showRecipe);

  const showRows = () => {
    const chosen = ui.policy.value;
    ui.policy.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'None';
    ui.policy.append(none);
    for (const row of rows) {
      const option = document.createElement('option');
      option.value = row.id;
      option.textContent = describe(row);
      ui.policy.append(option);
    }
    if (rows.some((r) => r.id === chosen)) ui.policy.value = chosen;
    ui.policyNote.textContent = serverUp
      ? `${rows.length} checkpoint${rows.length === 1 ? '' : 's'} on this machine.`
      : 'No dashboard server: checkpoints trained here are kept in this browser. Run pnpm train:dashboard to list the ones on disk.';
    ui.handover.disabled = !serverUp || ui.policy.value === '';
  };
  /**
   * Choosing a checkpoint sets the tabs up the way it was trained -- its scenario, its body, its
   * joints -- when its file says, so what is handed over is the body it knows, and puts its name
   * in the name box so Resume continues it. An older checkpoint without a recipe changes nothing.
   */
  ui.policy.addEventListener('change', () => {
    ui.handover.disabled = !serverUp || ui.policy.value === '';
    const row = rows.find((r) => r.id === ui.policy.value);
    if (row?.recipe) {
      host.applyRecipe(row.recipe);
      ui.name.value = row.recipe.name;
      ui.feedforward.value = row.recipe.feedforward.kind;
      ui.task.value = row.recipe.task === 'balance' ? 'balance' : 'stand';
      // The noise it was brought up in, so continuing a checkpoint continues the conditions
      // rather than quietly training the next generations in a different body's world. A
      // checkpoint saved before there was any noise says nothing, and gets the default.
      const noise = row.recipe.noise;
      ui.noiseMotor.value = String(noise?.motor ?? 0.05);
      ui.noiseSense.value = String(noise?.sense ?? 0.01);
      for (const input of [ui.noiseMotor, ui.noiseSense]) {
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      ui.policyNote.textContent = `Scene, body and joints set from ${row.recipe.name}; they take effect on the next run.`;
    }
    showRecipe();
  });

  const showFit = () => {
    const fit = host.fit();
    if (!fit) {
      ui.fitNote.textContent = setup ? 'Policy chosen; it goes in with the next run.' : '';
      // A showcase's brain is a brain in the loop, even though it is not this page's: the panel
      // draws it, so the idle note would be saying the opposite of what is on the screen.
      ui.idleNote.hidden = activity !== undefined;
      return;
    }
    ui.idleNote.hidden = true;
    ui.fitNote.textContent =
      `In the loop: ${fit.carried.inputs} of ${fit.inputs} senses and ` +
      `${fit.carried.outputs} of ${fit.outputs} drives carried from the checkpoint.`;
  };

  ui.handover.addEventListener('click', async () => {
    const id = ui.policy.value;
    if (!id) return;
    ui.handover.disabled = true;
    try {
      let policy: NervesSetup['policy'];
      if (serverUp) {
        const response = await fetch(`${dashboard}/policies/${encodeURIComponent(id)}`, {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`${response.status}`);
        policy = (await response.json()) as NervesSetup['policy'];
      } else {
        const held = (await readLocalCheckpoint(id)) ?? (await shippedCheckpoint(id));
        if (!held) throw new Error(`this studio has no checkpoint called '${id}'`);
        policy = held as NervesSetup['policy'];
      }
      setup = {
        policy,
        authority: Number(ui.authority.value),
        goal: 0,
        // The checkpoint's own, when it recorded one: a policy evaluated at another rate is not
        // the controller that was trained, however right the body around it is.
        controlDivisor:
          rows.find((r) => r.id === id)?.recipe?.controlDivisor ?? host.controlDivisor(),
      };
      host.handOver(setup);
      ui.release.disabled = false;
      window.setTimeout(showFit, 500);
    } catch (error) {
      ui.fitNote.textContent = `Could not load the checkpoint: ${String(error)}`;
    } finally {
      ui.handover.disabled = ui.policy.value === '';
    }
  });
  ui.release.addEventListener('click', () => {
    setup = undefined;
    ui.release.disabled = true;
    host.handOver(undefined);
    ui.fitNote.textContent = '';
    ui.idleNote.hidden = false;
  });
  ui.authority.addEventListener('change', () => {
    if (setup) {
      setup = { ...setup, authority: Number(ui.authority.value) };
      host.handOver(setup);
    }
  });

  /**
   * Start and Stop, when the run is this window's. Without a server Start is always offered --
   * there is nothing to ask permission of -- and Stop only while a run is going.
   */
  const setButtons = (): void => {
    if (serverUp && !localRun) return;
    ui.start.disabled = localRun !== undefined;
    ui.stop.disabled = localRun === undefined || localStopping;
  };

  const drawSeries = (series: readonly (readonly [number, number, number, number])[]) => {
    ui.chart.hidden = series.length < 2;
    if (ui.chart.hidden) return;
    const context = ui.chart.getContext('2d');
    if (!context) return;
    const { width, height } = ui.chart;
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#14161a';
    context.fillRect(0, 0, width, height);
    let top = 0;
    for (const [, mean, best] of series) top = Math.max(top, mean, best);
    top = Math.max(top, 0.1);
    const x = (i: number) => (i / Math.max(1, series.length - 1)) * (width - 2) + 1;
    const y = (v: number) => height - 2 - (v / top) * (height - 4);
    const line = (
      pick: (row: readonly [number, number, number, number]) => number,
      colour: string,
    ) => {
      context.strokeStyle = colour;
      context.lineWidth = 1.2;
      context.beginPath();
      series.forEach((row, i) => {
        if (i === 0) context.moveTo(x(i), y(pick(row)));
        else context.lineTo(x(i), y(pick(row)));
      });
      context.stroke();
    };
    line((row) => row[2], '#e0a44a');
    line((row) => row[1], '#6aa9ff');
    context.fillStyle = '#6b7280';
    context.font = '10px ui-monospace, monospace';
    context.fillText(`top ${top.toFixed(2)}`, 4, 11);
  };

  const drawChart = (status: TrainingStatus) => {
    drawSeries(status.latest?.series ?? []);
  };

  const showStatus = (status: TrainingStatus | undefined) => {
    trainingRunning = status?.running === true;
    trainingName = status?.name ?? undefined;
    // The showcase that plays the run keeps publishing after the trainer has gone, and the studio
    // goes on following it, so Stop stays offered while there is anything left to stop.
    trainingStoppable = trainingRunning || status?.showcase === true;
    ui.start.disabled = !serverUp || trainingRunning || status?.elsewhere === true;
    ui.stop.disabled = !serverUp || !trainingStoppable;
    // A run in this window overrides all of that: it needs no server, and only it can stop it.
    if (localRun || !serverUp) setButtons();
    if (!status) {
      // Without a server the panel trains here instead, so it says that rather than refusing.
      ui.status.textContent = serverUp
        ? ''
        : localRun
          ? localStatus
          : localStatus ||
            `No dashboard server: Start trains in this window, in ${suggestedWorkers()} workers, ` +
              'saving to this browser. A terminal server is faster and writes real files.';
      ui.chart.hidden = true;
      return;
    }
    const latest = status.latest;
    const record = latest?.best
      ? `record ${latest.best.fitness.toFixed(2)} (${latest.best.alive.toFixed(2)} s up) at generation ${latest.best.generation}`
      : 'no record yet';
    ui.status.textContent = status.elsewhere
      ? 'A trainer started from a terminal is running; stop it there.'
      : status.running
        ? `Training ${status.task}: generation ${latest?.generations ?? 0}, ${record}.`
        : status.showcase
          ? `Not training; the showcase is still playing the run. ${record}.`
          : latest
            ? `Not training. Last run: generation ${latest.generations}, ${record}.`
            : 'Not training.';
    drawChart(status);
  };

  /**
   * Start and stop are functions, not clicks: the headset asks for them through `act`, and a
   * button disabled by a status the desktop has not polled since would swallow the click.
   */
  async function startTraining(): Promise<void> {
    ui.start.disabled = true;
    // No server: the search runs here, in web workers, saving to this window's own store. The
    // dashboard is still better from a terminal -- every core, and real files -- so it wins
    // when it is there.
    if (!serverUp) {
      startTrainingHere();
      return;
    }
    try {
      const feedforward: TrainingRecipe['feedforward'] =
        ui.feedforward.value === 'script'
          ? { kind: 'script' }
          : ui.feedforward.value === 'clip'
            ? { kind: 'clip', clip: 'quiet-standing' }
            : { kind: 'none' };
      const response = await fetch(`${dashboard}/train/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          task: ui.task.value,
          name: ui.name.value.trim(),
          recipe: {
            ...host.recipe(),
            feedforward,
            noise: {
              motor: Number(ui.noiseMotor.value),
              sense: Number(ui.noiseSense.value),
              tau: 0.25,
            },
            reflex: reflexFromUi(),
            memory: Number(ui.memory.value),
          },
          generations: Number(ui.generations.value),
          population: Number(ui.population.value),
          seconds: Number(ui.seconds.value),
          workers: Number(ui.workers.value),
          seeds: 2,
          authority: Number(ui.authority.value),
          resume: ui.resume.checked,
        }),
      });
      const result = (await response.json()) as { error?: string };
      if (result.error) ui.status.textContent = `Could not start: ${result.error}`;
      else if (!host.following()) host.startFollowing();
    } catch (error) {
      ui.status.textContent = `Could not start: ${String(error)}`;
    }
    await poll();
  }

  /** Train in this window: no fetch, no server, nothing spawned. */
  function startTrainingHere(): void {
    if (localRun) return;
    localSeries = [];
    const recipe: TrainingRecipe = {
      ...host.recipe(),
      name: ui.name.value.trim() || ui.task.value,
      task: ui.task.value,
      feedforward:
        ui.feedforward.value === 'script'
          ? { kind: 'script' }
          : ui.feedforward.value === 'clip'
            ? { kind: 'clip', clip: 'quiet-standing' }
            : { kind: 'none' },
      authority: Number(ui.authority.value),
      noise: {
        motor: Number(ui.noiseMotor.value),
        sense: Number(ui.noiseSense.value),
        tau: 0.25,
      },
      reflex: reflexFromUi(),
      memory: Number(ui.memory.value),
    };
    const workers = Math.min(Number(ui.workers.value), suggestedWorkers());
    localStatus = `Building ${workers} bodies in this window...`;
    ui.status.textContent = localStatus;
    localRun = startLocalTraining({
      recipe,
      generations: Number(ui.generations.value),
      population: Number(ui.population.value),
      seconds: Number(ui.seconds.value),
      workers,
      seeds: 2,
      resume: ui.resume.checked,
      onNote: (text) => {
        localStatus = text.trim();
        ui.status.textContent = localStatus;
      },
      onGeneration: (report) => {
        localSeries.push([
          report.generation,
          Number(report.mean.toFixed(4)),
          Number(report.top.toFixed(4)),
          Number(report.topAlive.toFixed(3)),
        ]);
        localStatus =
          `Training ${recipe.task} here: generation ${report.generation}, ` +
          `mean ${report.mean.toFixed(3)}, top ${report.top.toFixed(3)} ` +
          `(${report.topAlive.toFixed(2)} s up)${report.note}`;
        // Once Stop has been asked for, say so and keep saying it. A generation takes seconds
        // and the line that replaced the acknowledgement made the button look like it had done
        // nothing, which is the one thing a Stop button must never look like.
        ui.status.textContent = localStopping
          ? `${localStatus} — stopping after this generation.`
          : localStatus;
        drawSeries(localSeries);
      },
      onDone: (summary) => {
        localRun = undefined;
        localStopping = false;
        localStatus = summary;
        ui.status.textContent = summary;
        setButtons();
      },
      onError: (message) => {
        localRun = undefined;
        localStopping = false;
        localStatus = `Could not train here: ${message}`;
        ui.status.textContent = localStatus;
        setButtons();
      },
    });
    setButtons();
  }

  async function stopTraining(): Promise<void> {
    if (localRun) {
      localRun.stop();
      localStopping = true;
      ui.status.textContent = `${localStatus} — stopping after this generation.`;
      ui.stop.disabled = true;
      return;
    }
    ui.stop.disabled = true;
    try {
      await fetch(`${dashboard}/train/stop`, { method: 'POST' });
    } catch {
      // The status poll says what happened.
    }
    await poll();
  }

  ui.start.addEventListener('click', () => void startTraining());
  ui.stop.addEventListener('click', () => void stopTraining());

  /**
   * The showcase's brain, ten times a second while there is one to watch.
   *
   * Its own poll rather than the status one's: the status is a second or three apart, which is a
   * slideshow, and the activity file is small and rewritten at ten hertz. Which checkpoint's file
   * to read comes from the server when it started the run, and otherwise from the name the
   * showcase puts in the bridge status, so a run started in a terminal is watched too.
   */
  /** A showcase that has stopped leaves its last file behind; this long unchanged is gone. */
  const ACTIVITY_STALE_MS = 3000;
  let activityInFlight = false;
  const pollActivity = async (): Promise<void> => {
    const name = trainingName ?? publishedName ?? host.publishedTrainingName();
    if (!serverUp || !name) {
      activity = undefined;
      return;
    }
    if (activityInFlight) return;
    activityInFlight = true;
    try {
      const response = await fetch(`${dashboard}/runs/${encodeURIComponent(name)}-activity.json`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`${response.status}`);
      const fresh = (await response.json()) as Omit<RemoteActivity, 'name'>;
      if (!Array.isArray(fresh.layers) || fresh.layers.length === 0) throw new Error('no layers');
      const now = performance.now();
      // Against what was last read rather than what is being shown: a stale file cleared and
      // then read again would otherwise look like a change every time and flicker back on.
      const seen = `${fresh.generation}:${fresh.time}`;
      if (seen !== activitySeen) {
        activitySeen = seen;
        activityChangedAt = now;
      }
      // Between episodes the showcase rests a moment, so the file is allowed to stand still for
      // a few seconds; longer than that and nobody is writing it.
      activity = now - activityChangedAt > ACTIVITY_STALE_MS ? undefined : { ...fresh, name };
    } catch {
      // No showcase, or a file caught between writes: nothing to draw.
      activity = undefined;
    } finally {
      activityInFlight = false;
    }
  };
  window.setInterval(() => void pollActivity(), 100);

  /** The checkpoints this studio holds itself, in the shape the list draws. */
  async function localRows(): Promise<CheckpointRow[]> {
    // What this studio trained itself, and what it shipped with. A name trained here wins: a
    // person who has retrained `stand` means the one they retrained.
    const held = await listLocalCheckpoints();
    const mine = new Set(held.map((row) => row.name));
    const shipped = (await shippedCheckpoints()).filter((row) => !mine.has(row.name));
    return [...held, ...shipped].map(({ name, file }) => {
      const policy = file as PolicyFile;
      return {
        id: name,
        name,
        task: policy.task ?? 'stand',
        profile: policy.profile ?? null,
        sizes: policy.sizes ?? [],
        trained: policy.trained ?? null,
        recipe: (policy.recipe as TrainingRecipe | undefined) ?? null,
      };
    });
  }

  async function poll(): Promise<void> {
    try {
      const [policies, status] = await Promise.all([
        fetch(`${dashboard}/policies`, { cache: 'no-store' }).then(
          (r) => r.json() as Promise<{ policies: CheckpointRow[] }>,
        ),
        fetch(`${dashboard}/train/status`, { cache: 'no-store' }).then(
          (r) => r.json() as Promise<TrainingStatus>,
        ),
      ]);
      serverUp = true;
      rows = policies.policies;
      showRows();
      showStatus(status);
      // Who is on the bridge, when this server is not the one training: the showcase names the
      // checkpoint it is playing, and that is the run file to read the brain from.
      if (!trainingName) {
        try {
          const bridge = await fetch(`${dashboard}/bridge/status`, { cache: 'no-store' });
          const played = bridge.ok
            ? ((await bridge.json()) as { training?: { task?: string } }).training?.task
            : undefined;
          publishedName = typeof played === 'string' && played !== '' ? played : undefined;
        } catch {
          publishedName = undefined;
        }
      } else {
        publishedName = undefined;
      }
    } catch {
      // No server. The studio still has whatever it trained itself -- files in the binary, this
      // browser's own store in a tab -- and those are checkpoints like any other, so they go in
      // the list rather than the list going empty.
      serverUp = false;
      rows = await localRows();
      showRows();
      showStatus(undefined);
    }
    showFit();
    showRecipe();
  }

  return {
    poll,
    get setup() {
      return setup;
    },
    remoteActivity() {
      return activity;
    },
    chosenRecipe() {
      return rows.find((r) => r.id === ui.policy.value)?.recipe ?? undefined;
    },
    state() {
      return {
        serverUp,
        active: host.fit() !== undefined,
        authority: Number(ui.authority.value),
        selected: ui.policy.value,
        checkpoints: rows.map((r) => ({ id: r.id, name: describe(r) })),
        fit: ui.fitNote.textContent ?? '',
        training: ui.status.textContent ?? '',
        trainingRunning,
        trainingStoppable,
        following: host.following(),
        reflex: {
          stretch: Number(ui.spineStretch.value),
          velocity: Number(ui.spineVelocity.value),
          setPoint: Number(ui.spineSetPoint.value),
          inhibition: Number(ui.spineInhibition.value),
          delaySeconds: Number(ui.spineDelay.value),
        },
        memory: Number(ui.memory.value),
      };
    },
    act(action, id, value) {
      switch (action) {
        case 'select':
          ui.policy.value = id ?? '';
          ui.policy.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        case 'handover':
          if (id !== undefined) {
            ui.policy.value = id;
            ui.policy.dispatchEvent(new Event('change', { bubbles: true }));
          }
          ui.handover.click();
          break;
        case 'release':
          ui.release.click();
          break;
        case 'authority':
          ui.authority.value = String(value ?? Number(ui.authority.value));
          ui.authority.dispatchEvent(new Event('input', { bubbles: true }));
          ui.authority.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        case 'trainStart':
          void startTraining();
          break;
        case 'trainStop':
          void stopTraining();
          break;
        case 'follow':
          host.toggleFollowing();
          break;
        // The cord and the memory: the headset moves the desktop's own sliders, so there is one
        // place the value lives and both panels read it back the same way.
        case 'reflexStretch':
        case 'reflexVelocity':
        case 'reflexSetPoint':
        case 'reflexInhibition':
        case 'reflexDelay':
        case 'memory': {
          const input = {
            reflexStretch: ui.spineStretch,
            reflexVelocity: ui.spineVelocity,
            reflexSetPoint: ui.spineSetPoint,
            reflexInhibition: ui.spineInhibition,
            reflexDelay: ui.spineDelay,
            memory: ui.memory,
          }[action];
          if (value !== undefined) input.value = String(value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
        default:
          break;
      }
    },
  };
}
