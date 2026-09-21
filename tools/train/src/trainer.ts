/**
 * The search itself, with nothing of Node in it.
 *
 * `train-nerves.mjs` was the trainer: it owned the evolution strategy, the worker pool, the
 * files it read and wrote, and the lines it printed. That made the search a thing only a
 * terminal could run, and the studio had to ask a server on localhost to run it -- which is why
 * training needed a second process, and why a single binary was not possible.
 *
 * So the loop moved here and everything that touches a machine became an interface. A pool
 * scores candidates and says nothing about how -- worker threads in Node, web workers in a
 * window, both satisfy it. A store reads and writes four named things and says nothing about
 * where -- a directory, or a Tauri command, or a browser's own storage. A reporter takes the
 * line a generation would have printed and does what it likes with it.
 *
 * What is left is the search, and it is the same search it was: mirrored sampling, rank-shaped
 * fitness, Adam, the centre scored on fresh seeds every fifth generation, and the restart when
 * the centre has walked off a cliff and the record is sitting behind it.
 */

import { MlpPolicy, type PolicyFile } from '@bs-humany/modules-nerves';
import { OpenAiEs } from './es.js';
import type { TrainingRecipe } from './rig.js';

/** What a rig reports about itself once it is built: the shape of the policy it wants. */
export interface RigShape {
  readonly sizes: readonly number[];
  readonly parameterCount: number;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly stepsPerSecond: number;
  readonly controlDivisor: number;
}

/** One episode to score: a weight vector, and the seed that draws its disturbances. */
export interface EpisodeTask {
  readonly id: number;
  readonly candidate: number;
  readonly weights: Float32Array;
  readonly seed: number;
}

export interface EpisodeResult {
  readonly id: number;
  readonly fitness: number;
  readonly alive: number;
}

/**
 * Somewhere to run episodes. The only thing the search needs from a machine.
 */
export interface EpisodePool {
  readonly shape: RigShape;
  /** Score every task, in any order, and resolve when all of them are done. */
  run(tasks: readonly EpisodeTask[], onResult: (result: EpisodeResult) => void): Promise<void>;
  dispose(): void;
}

/** The four things a run keeps. `policy` is the record; `centre` is where the search is now. */
export type Keep = 'policy' | 'centre' | 'latest';

export interface CheckpointStore {
  read(kind: Keep): Promise<unknown | undefined>;
  write(kind: Keep, value: unknown): Promise<void>;
  /** One line a generation, for whoever wants the history; may do nothing. */
  appendLog(line: unknown): Promise<void>;
}

/** A generation's news, for a console line or a chart. */
export interface GenerationReport {
  readonly generation: number;
  readonly mean: number;
  readonly top: number;
  readonly topAlive: number;
  readonly seconds: number;
  /** Resident megabytes, where the host can say; 0 where it cannot. */
  readonly rssMb: number;
  /** What happened to the record this generation, in words; empty when nothing did. */
  readonly note: string;
}

export interface TrainOptions {
  readonly recipe: TrainingRecipe;
  readonly pool: EpisodePool;
  readonly store: CheckpointStore;
  readonly generations: number;
  readonly population: number;
  readonly seedsPerCandidate: number;
  readonly seconds: number;
  readonly workers: number;
  readonly sigma: number;
  readonly learningRate: number;
  readonly hidden: readonly number[];
  readonly resume: boolean;
  /** Milliseconds now, however the host tells the time. */
  readonly now?: (() => number) | undefined;
  /** Megabytes resident, where the host knows. */
  readonly rss?: (() => number) | undefined;
  readonly onGeneration?: ((report: GenerationReport) => void) | undefined;
  /** Said once, before the first generation, about what was resumed and how it fitted. */
  readonly onNote?: ((text: string) => void) | undefined;
  /** Asked between generations; true stops the run and keeps what it has. */
  readonly stopped?: (() => boolean) | undefined;
}

export interface TrainResult {
  readonly fitness: number;
  readonly alive: number;
  readonly generation: number;
  readonly episodes: number;
}

/** A seeded uniform, so a fresh policy is the same fresh policy every time. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export async function train(options: TrainOptions): Promise<TrainResult> {
  const {
    recipe,
    pool,
    store,
    generations,
    population,
    seedsPerCandidate,
    seconds,
    workers,
    sigma,
    learningRate,
    hidden,
    resume,
  } = options;
  const now = options.now ?? (() => Date.now());
  const rss = options.rss ?? (() => 0);
  const note = options.onNote ?? (() => {});
  const shape = pool.shape;
  const task = recipe.task;
  const profileId = recipe.profile;
  const names = { inputs: shape.inputNames, outputs: shape.outputNames };

  // The timescale the rig settled on, into the recipe the checkpoint carries: a run that plays
  // it at another step rate or evaluates it at another divisor is not what it was trained in.
  const carriedRecipe: TrainingRecipe = {
    ...recipe,
    stepsPerSecond: shape.stepsPerSecond,
    controlDivisor: shape.controlDivisor,
  };

  let initial: Float32Array | undefined;
  let startGeneration = 0;
  /** Whether the resumed file was this very body's, so its record still stands. */
  let sameBody = false;
  const fitted = (file: PolicyFile, from: string): Float32Array | undefined => {
    if (file.task !== task) return undefined;
    if (file.sizes.slice(1, -1).join('x') !== hidden.join('x')) {
      note(
        `  ${from} has hidden layers ${file.sizes.slice(1, -1).join('x')}, not ${hidden.join('x')}; starting afresh`,
      );
      return undefined;
    }
    const { policy, carried } = MlpPolicy.fit(file, names.inputs, names.outputs);
    sameBody =
      carried.inputs === names.inputs.length && file.sizes.join('x') === shape.sizes.join('x');
    note(
      `  resuming from ${from} at generation ${file.trained?.generations ?? 0}` +
        (sameBody
          ? ''
          : `, fitted from ${file.profile ?? 'another body'}: ${carried.inputs} of ${names.inputs.length} senses and ${carried.outputs} of ${names.outputs.length} drives carried`),
    );
    return policy.weights;
  };

  if (resume) {
    const centre = (await store.read('centre')) as PolicyFile | undefined;
    if (centre) {
      initial = fitted(centre, 'the saved centre');
      if (initial) startGeneration = centre.trained?.generations ?? 0;
    }
    if (!initial) {
      const saved = (await store.read('policy')) as PolicyFile | undefined;
      if (saved) {
        initial = fitted(saved, 'the saved policy');
        if (initial) startGeneration = saved.trained?.generations ?? 0;
      }
    }
  }
  if (!initial) initial = MlpPolicy.random(shape.sizes, seeded(12345)).weights;

  const search = (from: Float32Array, seed: number): OpenAiEs =>
    new OpenAiEs(
      {
        dimension: shape.parameterCount,
        population,
        sigma,
        learningRate,
        weightDecay: 0.001,
        seed,
      },
      from,
    );
  let es = search(initial, 42 + startGeneration);
  /** Centre scores in a row below half the record: a search that has walked off a cliff. */
  let slumped = 0;

  /**
   * Score every candidate, one episode a task -- `candidates x seeds` of them -- and average
   * each candidate's seeds back together.
   */
  async function evaluate(
    candidates: readonly Float32Array[],
    generation: number,
  ): Promise<{ fitness: number[]; alive: number[] }> {
    const tasks: EpisodeTask[] = [];
    candidates.forEach((weights, c) => {
      for (let k = 0; k < seedsPerCandidate; k++) {
        // A mirrored pair shares its twitches: the search asks which of +epsilon and -epsilon
        // stands better through the same nudge, and a pair nudged differently answers with the
        // difference between the nudges instead, which is noise the step then walks along.
        const pair = generation < 0 ? c : Math.floor(c / 2);
        tasks.push({
          id: tasks.length,
          candidate: c,
          weights,
          seed: 1000 * generation + 7 * pair + k,
        });
      }
    });
    const fitness = new Array<number>(candidates.length).fill(0);
    const alive = new Array<number>(candidates.length).fill(0);
    await pool.run(tasks, (result) => {
      const at = tasks[result.id] as EpisodeTask;
      fitness[at.candidate] =
        (fitness[at.candidate] as number) + result.fitness / seedsPerCandidate;
      alive[at.candidate] = (alive[at.candidate] as number) + result.alive / seedsPerCandidate;
    });
    return { fitness, alive };
  }

  const series: [number, number, number, number][] = [];
  let best: { fitness: number; weights: Float32Array | null; generation: number; alive: number } = {
    fitness: Number.NEGATIVE_INFINITY,
    weights: null,
    generation: 0,
    alive: 0,
  };
  if (resume) {
    const previous = (await store.read('latest')) as
      | { task?: string; series?: [number, number, number, number][]; best?: typeof best }
      | undefined;
    if (previous?.task === task && Array.isArray(previous.series)) series.push(...previous.series);
    // The record carries over only on the same body; a fitted policy starts a new one.
    if (previous?.best && initial && sameBody) {
      best = { ...previous.best, weights: Float32Array.from(initial) };
    }
  }

  const fileFor = (weights: Float32Array, generation: number, fitness: number, episodes: number) =>
    new MlpPolicy(shape.sizes, weights).toFile({
      task,
      profile: profileId,
      inputs: shape.inputNames,
      outputs: shape.outputNames,
      trained: { generations: generation, fitness, episodes, at: new Date().toISOString() },
      recipe: carriedRecipe,
    });

  let episodes = 0;
  const publishLatest = async (): Promise<void> => {
    await store.write('latest', {
      task,
      name: recipe.name,
      recipe: carriedRecipe,
      updated: new Date().toISOString(),
      population,
      seeds: seedsPerCandidate,
      seconds,
      workers,
      profile: profileId,
      sizes: shape.sizes,
      parameters: shape.parameterCount,
      episodes,
      best: { fitness: best.fitness, alive: best.alive, generation: best.generation },
      series,
    });
  };

  for (let g = startGeneration + 1; g <= startGeneration + generations; g++) {
    if (options.stopped?.()) break;
    const t0 = now();
    const candidates = es.ask();
    const scored = await evaluate(candidates, g);
    episodes += candidates.length * seedsPerCandidate;
    es.tell(scored.fitness);
    const mean = scored.fitness.reduce((a, b) => a + b, 0) / scored.fitness.length;
    const top = Math.max(...scored.fitness);
    const topAlive = scored.alive[scored.fitness.indexOf(top)] as number;
    const elapsed = (now() - t0) / 1000;
    series.push([g, Number(mean.toFixed(4)), Number(top.toFixed(4)), Number(topAlive.toFixed(3))]);
    let noteText = '';
    // The centre of the distribution is what gets saved; score it on fresh seeds now and then.
    if (g % 5 === 0 || g === startGeneration + 1) {
      const centre = await evaluate([Float32Array.from(es.theta)], -g);
      const centreFitness = centre.fitness[0] as number;
      // The step is Adam-normalised, so a noisy estimate still moves at full speed, and a run of
      // them can carry the centre somewhere it cannot stand at all while the record sits behind
      // it. Two checks in a row at less than half the record, and the search restarts from the
      // record with fresh momentum and fresh noise.
      slumped = best.weights && centreFitness < 0.5 * best.fitness ? slumped + 1 : 0;
      if (slumped >= 2 && best.weights) {
        es = search(best.weights, 42 + g);
        slumped = 0;
        noteText = `  restarted from the record (centre ${centreFitness.toFixed(3)} against ${best.fitness.toFixed(3)})`;
      } else if (centreFitness > best.fitness) {
        best = {
          fitness: centreFitness,
          weights: Float32Array.from(es.theta),
          generation: g,
          alive: centre.alive[0] as number,
        };
        await store.write(
          'policy',
          fileFor(best.weights as Float32Array, g, centreFitness, episodes),
        );
        noteText = `  saved (centre ${centreFitness.toFixed(3)}, ${(centre.alive[0] as number).toFixed(2)} s up)`;
      }
    }
    const report: GenerationReport = {
      generation: g,
      mean,
      top,
      topAlive,
      seconds: elapsed,
      rssMb: rss(),
      note: noteText,
    };
    await store.appendLog(report);
    options.onGeneration?.(report);
    await publishLatest();
    await store.write('centre', fileFor(Float32Array.from(es.theta), g, mean, episodes));
  }
  return {
    fitness: best.fitness,
    alive: best.alive,
    generation: best.generation,
    episodes,
  };
}
