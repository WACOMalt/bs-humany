/**
 * Training inside the window, with no server anywhere.
 *
 * The search, the rigs and the store are all here: `trainer.ts` for the loop, a pool of web
 * workers for the episodes, IndexedDB for what is kept. Nothing is spawned, nothing is listened
 * on, and the whole of it ships in the one binary the studio already is.
 *
 * The dashboard is still the right thing to use from a terminal -- it has as many cores as the
 * machine has and it writes real files a person can keep -- so the panel prefers it when it is
 * there. This is what happens when it is not, which until now was nothing.
 */

// From the recipe module rather than the rig, which re-exports the same things: the rig is the
// body, MuJoCo and all, and only the workers need one, while the recipe module imports nothing
// that runs, so asking it for a type or a default brings no body with it.
import {
  type RigOptions,
  SEARCH_DEFAULTS,
  type TrainingRecipe,
  rigOptionsFor,
} from '@bs-humany/train/recipe';
import {
  type CheckpointStore,
  type GenerationReport,
  describeResult,
  train,
} from '@bs-humany/train/trainer';
import { createWorkerPool } from './pool.js';
import { createCheckpointStore } from './store.js';

/** How far a generation has got: `done` of `total` episodes, or of the centre's when `centre`. */
export interface EpisodeProgress {
  readonly generation: number;
  readonly done: number;
  readonly total: number;
  readonly centre: boolean;
}

export interface LocalTrainingOptions {
  readonly recipe: TrainingRecipe;
  readonly generations: number;
  readonly population: number;
  readonly seconds: number;
  readonly workers: number;
  readonly seeds: number;
  readonly resume: boolean;
  readonly hidden?: readonly number[];
  readonly onGeneration?: (report: GenerationReport) => void;
  readonly onNote?: (text: string) => void;
  readonly onDone?: (summary: string) => void;
  readonly onError?: (message: string) => void;
  /** How many workers have their body yet, of how many, while the pool is being built. */
  readonly onReady?: (ready: number, total: number) => void;
  /** Each episode as it is scored, so a generation is seen filling up. */
  readonly onProgress?: (progress: EpisodeProgress) => void;
  /**
   * Told once, the first time something the run means to keep could not be kept, with why. The
   * run carries on; the panel says it is not saving rather than let it look as if it were.
   */
  readonly onSaveFailed?: (message: string) => void;
}

export interface LocalRun {
  /** Ask the run to stop after the generation it is in; it keeps everything it has. */
  stop(): void;
  readonly done: Promise<void>;
}

/**
 * How many workers a window should actually make.
 *
 * Every one of them holds a whole body -- a compiled articulation, a MuJoCo model, every muscle
 * in `ALL_MUSCLES` -- and a tab's memory is the tab's, not the machine's. Bounded by the cores the
 * browser admits to and by eight, past which the tab is likelier to be killed than to finish a
 * generation faster.
 */
export function suggestedWorkers(): number {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(8, cores - 1));
}

/**
 * The workers a run in this window makes when `wanted` are asked for: no more than the window
 * should hold. The Workers slider is the terminal's as well, where every core is there to use, so
 * its value is left as it is and this is what the window does with it -- and what the panel says
 * it does, rather than showing sixteen over a run of seven.
 */
export function workersHere(wanted: number): number {
  return Math.max(1, Math.min(Math.round(wanted) || 1, suggestedWorkers()));
}

/**
 * What the summary adds when the record was not kept: the last `unsaved` records the run made,
 * of which the summary's is the last, were refused for `reason`.
 */
function unsavedSentence(unsaved: number, reason: string): string {
  if (unsaved === 0) return '';
  return unsaved === 1
    ? ` It was not saved: ${reason}.`
    : ` The last ${unsaved} records were not saved: ${reason}.`;
}

export function startLocalTraining(options: LocalTrainingOptions): LocalRun {
  let stopping = false;
  const hidden = options.hidden ?? SEARCH_DEFAULTS.hidden;
  const rigOptions: RigOptions = rigOptionsFor(options.recipe, {
    hidden,
    seconds: options.seconds,
  });
  /**
   * Records the run made and could not keep since the last one it could, and the latest reason.
   * A record is written only when it beats the one before, so the last of these is the one the
   * summary names: counting them is what lets the summary say whether the best it reports is on
   * disk or only in the search.
   */
  let unsavedRecords = 0;
  let lastFailure = '';
  let toldFailure = false;
  /** Generations finished in this run, so a failure can say whether anything was kept. */
  let generationsDone = 0;
  const onWriteFailed = (_kind: string, message: string): void => {
    lastFailure = message;
    if (!toldFailure) {
      toldFailure = true;
      options.onSaveFailed?.(message);
    }
  };
  const inner = createCheckpointStore(options.recipe.name, onWriteFailed);
  // The store the search sees: the window's own, with the records counted as they are written.
  const store: CheckpointStore = {
    read: (kind) => inner.read(kind),
    appendLog: (line) => inner.appendLog(line),
    async write(kind, value) {
      const kept = await inner.write(kind, value);
      if (kind === 'policy') unsavedRecords = kept === false ? unsavedRecords + 1 : 0;
      return kept;
    },
  };
  const done = (async (): Promise<void> => {
    let pool: Awaited<ReturnType<typeof createWorkerPool>> | undefined;
    try {
      pool = await createWorkerPool(
        rigOptions,
        options.workers,
        options.onReady ? { onReady: options.onReady } : {},
      );
      options.onNote?.(
        `  policy ${pool.shape.sizes.join(' x ')}: ${pool.shape.parameterCount} weights; ` +
          `${pool.shape.inputNames.length} senses, ${pool.shape.outputNames.length} drives`,
      );
      const result = await train({
        recipe: options.recipe,
        pool,
        store,
        generations: options.generations,
        population: options.population,
        seedsPerCandidate: options.seeds,
        seconds: options.seconds,
        workers: options.workers,
        // The search's own settings, as the terminal trainer takes them when no flag is given.
        sigma: SEARCH_DEFAULTS.sigma,
        learningRate: SEARCH_DEFAULTS.learningRate,
        hidden,
        resume: options.resume,
        now: () => performance.now(),
        stopped: () => stopping,
        onNote: options.onNote,
        onGeneration: (report) => {
          generationsDone += 1;
          options.onGeneration?.(report);
        },
        onEpisode: options.onProgress,
      });
      // The same line the terminal prints, so a run that beat nothing says so in both places
      // rather than printing its record of minus infinity as a score -- and then whether the
      // record it names was kept, because a summary that reports a best the store refused reads
      // as a checkpoint that is there.
      options.onDone?.(
        `Stopped: ${describeResult(result)}.${unsavedSentence(unsavedRecords, lastFailure)}`,
      );
    } catch (error) {
      // What a generation that finished wrote stays written, since the store keeps the centre
      // and the history every generation; a failure part-way through the next loses only that
      // one. Said only when there is something to carry on from, and not over a store that has
      // already refused a write, where it would be a promise nobody kept.
      const kept =
        generationsDone > 0 && !toldFailure
          ? ' Everything up to the last finished generation is kept; tick Resume to carry on.'
          : '';
      options.onError?.(`${String(error)}${kept}`);
    } finally {
      pool?.dispose();
    }
  })();
  return {
    stop(): void {
      stopping = true;
    },
    done,
  };
}
