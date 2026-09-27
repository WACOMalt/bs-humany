/**
 * What the Brain tab says about the dashboard's training run, and whose brain it reads.
 *
 * The dashboard's `GET /train/status` is the one shape both of its readers take -- this panel, and
 * through the panel's state the headset -- and its own page reads the same fields. The line used to
 * be a ternary inside `brain.ts`, and it could not say the one thing a person most needed to hear:
 * a trainer the dashboard started that died on start left it reading "Not training. Last run: ..."
 * about some earlier run, while the reason sat in a terminal nobody was looking at. The dashboard
 * now keeps the trainer's last lines and says why it stopped, and this says it first.
 *
 * No DOM here, so every state the dashboard can report is pinned by a test in Node. A dashboard from
 * before these fields -- no error, no progress, no checkout -- still gets the line it always got.
 */

import { formatRemaining } from '@bs-humany/train/trainer';

/** The checkout a dashboard runs from: what it trains is that tree's code, not this page's. */
export interface DashboardCheckout {
  readonly root: string;
  readonly branch: string | null;
  readonly commit: string | null;
}

/** A run's progress record (`<data>/runs/<name>-latest.json`), as the dashboard passes it on. */
export interface TrainingLatest {
  /** The checkpoint the record is for; absent from dashboards that read only their own run. */
  readonly name?: string | null;
  readonly updated: string;
  readonly episodes: number;
  readonly best: {
    readonly fitness: number;
    readonly alive: number;
    readonly generation: number;
  };
  readonly profile: string | null;
  /**
   * The last generation written, which after a resume is not the number of rows: a run resumed at
   * 500 has written generation 501 in its first row. Older dashboards send only `generations`.
   */
  readonly generation?: number;
  /** What older dashboards sent as the generation: the number of rows in the series. */
  readonly generations: number;
  readonly series: readonly (readonly [number, number, number, number])[];
  /** The generation the run means to stop at, counting what a resume carried over. */
  readonly target?: number | null;
  /** Wall seconds a generation, the mean of the last few; 0 until one has finished. */
  readonly secondsPerGeneration?: number | null;
  /** What the trainer last said of itself: still going, got to its target, or stopped short. */
  readonly state?: 'running' | 'finished' | 'stopped' | null;
  readonly startedAt?: string | null;
  /** The recipe it trains in, in one line. */
  readonly recipeSummary?: string | null;
}

export interface TrainingStatus {
  readonly running: boolean;
  /** Whether the showcase that plays the run is still up; it outlives the trainer. */
  readonly showcase?: boolean;
  /** Whether a trainer someone started in a terminal is up, which this server cannot stop. */
  readonly elsewhere?: boolean;
  readonly startedAt: string | null;
  readonly task: string | null;
  /** The checkpoint being trained, when the server started it; kept after the run ends. */
  readonly name?: string | null;
  /** The trainer's exit code, or the signal that took it; null while it runs. */
  readonly exit: number | string | null;
  /**
   * Why the server's trainer stopped, in one line from its own output, when it stopped by itself
   * and not with a clean exit; null while it runs and after a Stop somebody asked for.
   */
  readonly error?: string | null;
  /** The trainer's last lines, stderr marked, for whoever wants more than the one line. */
  readonly tail?: readonly string[];
  readonly checkout?: DashboardCheckout | null;
  readonly latest: TrainingLatest | null;
}

/** A checkpoint and the task it is scored on, the task only when the name does not say it. */
export function runLabel(name: string | null | undefined, task: string | null | undefined): string {
  const shown = name || task || 'a run';
  return task && shown !== task ? `${shown} (${task})` : shown;
}

/**
 * How far a run is, as a person asks it: `generation 42 of 600, about 3 h 10 m left`, or
 * `finished` or `stopped` once it has ended. What is left is said only while the run is going and
 * its pace is known; a record from before the trainer kept a target is the bare generation.
 */
export function progressPhrase(p: {
  readonly generation: number;
  readonly target?: number | null | undefined;
  readonly secondsPerGeneration?: number | null | undefined;
  readonly state?: TrainingLatest['state'] | undefined;
}): string {
  const { generation, target, secondsPerGeneration, state } = p;
  if (typeof target !== 'number' || !(target > 0)) return `generation ${generation}`;
  const of = `generation ${generation} of ${target}`;
  if (state === 'finished') return `${of}, finished`;
  if (state === 'stopped') return `${of}, stopped`;
  const pace = secondsPerGeneration ?? 0;
  if (state === 'running' && pace > 0 && target > generation) {
    return `${of}, about ${formatRemaining((target - generation) * pace)} left`;
  }
  return of;
}

/** The last generation a record holds: the new field, else the row count older dashboards sent. */
const generationOf = (latest: TrainingLatest): number => latest.generation ?? latest.generations;

/** A record's progress, as it last said of itself unless the caller knows better. */
const progressOf = (latest: TrainingLatest, state = latest.state): string =>
  progressPhrase({
    generation: generationOf(latest),
    target: latest.target,
    secondsPerGeneration: latest.secondsPerGeneration,
    state,
  });

const recordOf = (latest: TrainingLatest | null): string | undefined => {
  const best = latest?.best;
  // JSON has no infinity: a run whose record nothing has beaten yet sends null for its fitness.
  if (!best || typeof best.fitness !== 'number' || !Number.isFinite(best.fitness)) return undefined;
  return `record ${best.fitness.toFixed(2)} (${best.alive.toFixed(2)} s up) at generation ${best.generation}`;
};

/** The last path component of a checkout, which is what tells two worktrees apart. */
const baseName = (root: string): string => {
  const parts = root.split(/[\\/]+/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? root;
};

/**
 * `main@c77c40a (bs-humany)`: which tree a dashboard runs from. A dashboard left running in one
 * worktree trains that worktree's code, and nothing on the page used to say so.
 */
export function checkoutPhrase(checkout: DashboardCheckout): string {
  const at =
    checkout.branch && checkout.commit
      ? `${checkout.branch}@${checkout.commit}`
      : (checkout.branch ?? checkout.commit);
  return at ? `${at} (${baseName(checkout.root)})` : baseName(checkout.root);
}

/**
 * The status line, in this order: a trainer somebody else started; a run going; a run that
 * stopped with an error, ahead of anything else about it; a showcase still playing; the last
 * run's record; nothing at all. A refusal of the last Start is not in here: it is news about a
 * button, and the panel shows it in place of all of these until something changes.
 */
export function trainingStatusLine(status: TrainingStatus): string {
  const latest = status.latest;
  const record = recordOf(latest);
  if (status.elsewhere) {
    // The dashboard sends the record written last, which with a terminal's trainer up is almost
    // always that trainer's; said only when the record says it is still going.
    return latest?.name && latest.state === 'running'
      ? `A trainer started from a terminal is training ${latest.name}: ${progressOf(latest)}, ${record ?? 'no record yet'}; stop it there.`
      : 'A trainer started from a terminal is running; stop it there.';
  }
  if (status.running) {
    // The server knows it is running, whatever the record last said of itself.
    const progress = latest ? progressOf(latest, 'running') : 'generation 0';
    const through = status.checkout ? `; training through ${checkoutPhrase(status.checkout)}` : '';
    return `Training ${runLabel(status.name ?? latest?.name, status.task)}: ${progress}, ${record ?? 'no record yet'}${through}.`;
  }
  const error = status.error
    ? `Training stopped with an error: ${status.error.replace(/[.\s]+$/, '')}. The dashboard's terminal has the full message.`
    : '';
  if (status.showcase) {
    const playing = `the showcase is still playing the run. ${record ?? 'no record yet'}.`;
    return error ? `${error} Not training; ${playing}` : `Not training; ${playing}`;
  }
  if (error) return record ? `${error} Its ${record}.` : error;
  if (latest) {
    const name = latest.name ?? status.name;
    return `Not training. Last run${name ? ` of ${name}` : ''}: ${progressOf(latest)}, ${record ?? 'no record yet'}.`;
  }
  return 'Not training.';
}

/**
 * Whose activity file the panel reads: the server's run while its trainer or its showcase is up,
 * and otherwise whoever the bridge says is publishing, or nobody.
 *
 * The dashboard keeps the last run's name after the run ends -- it is what the status line names
 * the record by -- so taking that name whenever there was one kept the panel reading a finished
 * run's file for ever, and a showcase started later from a terminal was never drawn.
 */
export function activitySource(
  status: TrainingStatus | undefined,
  publishedName: string | undefined,
): string | undefined {
  const live = status !== undefined && (status.running || status.showcase === true);
  return (live ? (status.name ?? undefined) : undefined) ?? publishedName ?? undefined;
}
