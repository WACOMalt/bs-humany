/**
 * The brain panel: a trained policy put in charge of the body, and training started from here.
 *
 * Both go through the dashboard server on this machine (`pnpm train:dashboard`): it lists the
 * saved checkpoints, serves any one of them, and starts and stops a training run the way a
 * terminal would. A checkpoint is fitted to whatever body is running by the names of its senses
 * and drives, so a policy trained on one profile drives another, and the panel says how much of
 * it carried. Handing over is a restart of the run with its state carried, the same path a
 * morphology change takes, because the nerves are a module registered at construction.
 */

import type { NervesSetup } from '@bs-humany/scenarios';

export const DEFAULT_DASHBOARD_URL = 'http://localhost:5280';

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
}

export interface TrainingStatus {
  readonly running: boolean;
  readonly startedAt: string | null;
  readonly task: string | null;
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
  follow(): void;
  /** What the running body could use of the policy, once it is in. */
  fit():
    | { carried: { inputs: number; outputs: number }; inputs: number; outputs: number }
    | undefined;
  /** Ticks between evaluations for the body about to run: a hundred hertz at its rate. */
  controlDivisor(): number;
  /** Whether the run is currently following the bridge rather than its own. */
  following(): boolean;
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
  readonly following: boolean;
}

export interface BrainPanel {
  /** Refresh the checkpoint list and the training status; cheap, safe to call often. */
  poll(): Promise<void>;
  /** What the panel would put in the loop for a new run, if a policy is chosen. */
  readonly setup: NervesSetup | undefined;
  /** The panel as the headset sees it. */
  state(): BrainState;
  /** The headset's hands on the panel: the same buttons the mouse presses. */
  act(
    action: 'select' | 'handover' | 'release' | 'authority' | 'trainStart' | 'trainStop' | 'follow',
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
    resume: must<HTMLInputElement>('#train-resume'),
    start: must<HTMLButtonElement>('#train-start'),
    stop: must<HTMLButtonElement>('#train-stop'),
    status: must<HTMLElement>('#train-status'),
    chart: must<HTMLCanvasElement>('#train-chart'),
  };
  let rows: CheckpointRow[] = [];
  let setup: NervesSetup | undefined;
  let serverUp = false;
  let trainingRunning = false;

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
  const showAuthority = () => {
    ui.authorityValue.textContent = Number(ui.authority.value).toFixed(2);
  };
  ui.authority.addEventListener('input', showAuthority);
  showAuthority();

  const describe = (row: CheckpointRow): string => {
    const t = row.trained;
    const where = row.profile ? row.profile.replace(/_.*/, '').toUpperCase() : 'body unknown';
    return t
      ? `${row.name} — ${row.task}, ${where}, gen ${t.generations}, fitness ${t.fitness.toFixed(2)}`
      : `${row.name} — ${row.task}, ${where}`;
  };

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
      : 'No dashboard server: run pnpm train:dashboard to list checkpoints and train from here.';
    ui.handover.disabled = !serverUp || ui.policy.value === '';
  };
  ui.policy.addEventListener('change', () => {
    ui.handover.disabled = !serverUp || ui.policy.value === '';
  });

  const showFit = () => {
    const fit = host.fit();
    if (!fit) {
      ui.fitNote.textContent = setup ? 'Policy chosen; it goes in with the next run.' : '';
      ui.idleNote.hidden = false;
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
      const response = await fetch(`${dashboard}/policies/${encodeURIComponent(id)}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`${response.status}`);
      const policy = (await response.json()) as NervesSetup['policy'];
      setup = {
        policy,
        authority: Number(ui.authority.value),
        goal: 0,
        controlDivisor: host.controlDivisor(),
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

  const drawChart = (status: TrainingStatus) => {
    const series = status.latest?.series ?? [];
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

  const showStatus = (status: TrainingStatus | undefined) => {
    trainingRunning = status?.running === true;
    ui.start.disabled = !serverUp || status?.running === true;
    ui.stop.disabled = !serverUp || status?.running !== true;
    if (!status) {
      ui.status.textContent = serverUp ? '' : 'Training needs the dashboard server.';
      ui.chart.hidden = true;
      return;
    }
    const latest = status.latest;
    const record = latest?.best
      ? `record ${latest.best.fitness.toFixed(2)} (${latest.best.alive.toFixed(2)} s up) at generation ${latest.best.generation}`
      : 'no record yet';
    ui.status.textContent = status.running
      ? `Training ${status.task}: generation ${latest?.generations ?? 0}, ${record}.`
      : latest
        ? `Not training. Last run: generation ${latest.generations}, ${record}.`
        : 'Not training.';
    drawChart(status);
  };

  ui.start.addEventListener('click', async () => {
    ui.start.disabled = true;
    try {
      const response = await fetch(`${dashboard}/train/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          task: 'stand',
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
      else if (!host.following()) host.follow();
    } catch (error) {
      ui.status.textContent = `Could not start: ${String(error)}`;
    }
    await poll();
  });
  ui.stop.addEventListener('click', async () => {
    ui.stop.disabled = true;
    try {
      await fetch(`${dashboard}/train/stop`, { method: 'POST' });
    } catch {
      // The status poll says what happened.
    }
    await poll();
  });

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
    } catch {
      serverUp = false;
      rows = [];
      showRows();
      showStatus(undefined);
    }
    showFit();
  }

  return {
    poll,
    get setup() {
      return setup;
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
        following: host.following(),
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
          ui.start.click();
          break;
        case 'trainStop':
          ui.stop.click();
          break;
        case 'follow':
          host.follow();
          break;
        default:
          break;
      }
    },
  };
}
