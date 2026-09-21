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

import { type RigOptions, type TrainingRecipe, rigOptionsFor } from '@bs-humany/train/rig';
import { type GenerationReport, train } from '@bs-humany/train/trainer';
import { createWorkerPool } from './pool.js';
import { createCheckpointStore } from './store.js';

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
}

export interface LocalRun {
  /** Ask the run to stop after the generation it is in; it keeps everything it has. */
  stop(): void;
  readonly done: Promise<void>;
}

/**
 * How many workers a window should actually make.
 *
 * Every one of them holds a whole body -- a compiled articulation, a MuJoCo model, two hundred
 * and thirty-four muscles -- and a tab's memory is the tab's, not the machine's. Bounded by the
 * cores the browser admits to and by eight, past which the tab is likelier to be killed than to
 * finish a generation faster.
 */
export function suggestedWorkers(): number {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(8, cores - 1));
}

export function startLocalTraining(options: LocalTrainingOptions): LocalRun {
  let stopping = false;
  const hidden = options.hidden ?? [32, 32];
  const rigOptions: RigOptions = rigOptionsFor(options.recipe, {
    hidden,
    seconds: options.seconds,
  });
  const done = (async (): Promise<void> => {
    let pool: Awaited<ReturnType<typeof createWorkerPool>> | undefined;
    try {
      pool = await createWorkerPool(rigOptions, options.workers);
      options.onNote?.(
        `  policy ${pool.shape.sizes.join(' x ')}: ${pool.shape.parameterCount} weights; ` +
          `${pool.shape.inputNames.length} senses, ${pool.shape.outputNames.length} drives`,
      );
      const result = await train({
        recipe: options.recipe,
        pool,
        store: createCheckpointStore(options.recipe.name),
        generations: options.generations,
        population: options.population,
        seedsPerCandidate: options.seeds,
        seconds: options.seconds,
        workers: options.workers,
        sigma: 0.03,
        learningRate: 0.005,
        hidden,
        resume: options.resume,
        now: () => performance.now(),
        stopped: () => stopping,
        onNote: options.onNote,
        onGeneration: options.onGeneration,
      });
      options.onDone?.(
        result.generation === 0
          ? `Stopped after ${result.episodes} episodes; nothing beat the record.`
          : `Stopped: best ${result.fitness.toFixed(3)} (${result.alive.toFixed(2)} s up) ` +
              `from generation ${result.generation}, ${result.episodes} episodes.`,
      );
    } catch (error) {
      options.onError?.(String(error));
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
