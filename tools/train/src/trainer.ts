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
 * window, both satisfy it. A store reads and writes three named things, and appends a log, and
 * says nothing about where -- a directory, or a Tauri command, or a browser's own storage. A
 * reporter takes the line a generation would have printed and does what it likes with it.
 *
 * What is left is the search, and it is the same search it was: mirrored sampling, rank-shaped
 * fitness, Adam, the centre scored on fresh seeds every fifth generation, and the restart when
 * the centre has walked off a cliff and the record is sitting behind it.
 */

import {
  type BodyFingerprint,
  MlpPolicy,
  type PolicyFile,
  compareBody,
} from '@bs-humany/modules-nerves';
import { OpenAiEs } from './es.js';
import { describeDifferences, recipeDifferences } from './recipeDiff.js';
import type { TrainingRecipe } from './rig.js';

/** What a rig reports about itself once it is built: the shape of the policy it wants. */
export interface RigShape {
  readonly sizes: readonly number[];
  readonly parameterCount: number;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly stepsPerSecond: number;
  readonly controlDivisor: number;
  /**
   * The body the rig built, fingerprinted with the cord under its brain, which every checkpoint
   * the run writes carries so a body it is later handed to can say how it differs. Optional
   * because a pool that cannot say -- a test's, or a worker from before fingerprints -- still
   * trains; its checkpoints then read as trained before bodies were recorded.
   */
  readonly body?: BodyFingerprint | undefined;
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
  /**
   * Score every task, in any order, and resolve when all of them are done. Reject if any episode
   * cannot be scored -- an episode that threw, a worker that died -- rather than wait for a result
   * that is never coming: a run that hangs looks exactly like a run that is slow, and nobody
   * stops it. Whatever the last finished generation wrote is kept, so a resume carries on.
   */
  run(tasks: readonly EpisodeTask[], onResult: (result: EpisodeResult) => void): Promise<void>;
  dispose(): void;
}

/**
 * The three things a run keeps. `policy` is the record; `centre` is where the search is now;
 * `latest` is the progress a dashboard draws.
 */
export type Keep = 'policy' | 'centre' | 'latest';

export interface CheckpointStore {
  read(kind: Keep): Promise<unknown | undefined>;
  /**
   * Keep one of the three. Resolving `false` means the host could not keep it -- a disk that
   * refused, a browser store that is full or forbidden -- and chose to go on training rather than
   * end the run, because a search worth watching is still worth watching. The search then says
   * the record was not saved instead of that it was. Anything else, `undefined` included, means
   * it was kept, which is what every store that simply throws on failure already meant. A host
   * that would rather the run stopped throws, and the run ends with its message.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: a store that predates the result returns nothing, and `undefined` would not admit its `Promise<void>`.
  write(kind: Keep, value: unknown): Promise<boolean | void>;
  /**
   * The run's history, for whoever wants it; may do nothing. The first line a run appends is a
   * header, `{ kind: 'header', ... }`, saying what the run was: the recipe, the search's own
   * settings, and where it started and means to stop. Every line without a `kind` is one
   * generation's `GenerationReport`.
   */
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
  /** The generation the run means to stop at, counting the ones a resume carried over. */
  readonly target: number;
  /**
   * Wall seconds a generation, the mean of the last ten, from the end of one to the end of the
   * next -- so the centre's evaluation and the writes are in it, which `seconds` leaves out.
   */
  readonly secondsPerGeneration: number;
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
  /**
   * Told as each episode is scored, so a host can show a generation filling up rather than
   * nothing for the seconds or minutes one takes. `done` of `total` in this batch; `centre` is
   * true for the batch that scores the search's centre on fresh seeds, which follows the
   * population's on the generations that have one. Not asked by the terminal or the dashboard,
   * which print a line a generation and nothing between.
   */
  readonly onEpisode?:
    | ((progress: {
        readonly generation: number;
        readonly done: number;
        readonly total: number;
        readonly centre: boolean;
      }) => void)
    | undefined;
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

/** A saved file fitted to the body a run is training, or the reason it cannot be. */
type Fit =
  | {
      readonly weights: Float32Array;
      /**
       * Whether it was this very body's, sense for sense and layer for layer, and -- where both
       * the file and the rig record one -- fingerprint for fingerprint.
       */
      readonly sameBody: boolean;
      /** Whether its senses and layers were this body's, whatever the fingerprints say. */
      readonly sameNames: boolean;
      /** How the body it was trained in differs from this one; empty when it did not record one. */
      readonly bodyChanges: readonly string[];
      readonly carried: { readonly inputs: number; readonly outputs: number };
      /** Where it stood when it was saved: the generation and the episodes run to get there. */
      readonly generations: number;
      readonly episodes: number;
    }
  | { readonly mismatch: 'task' | 'hidden'; readonly message: string };

/** What a saved file has to be fitted to: this run's name, task, hidden widths and body. */
interface FitTarget {
  readonly name: string;
  readonly task: string;
  readonly hidden: readonly number[];
  readonly shape: RigShape;
}

/**
 * Fit a saved file to this run's body, or say why it cannot be.
 *
 * Pure, and silent: the caller decides what to say about it. It used to be a closure that wrote
 * a shared `sameBody` as it went and said "starting afresh" on the way out, which meant the
 * answer for the centre and the answer for the policy were one variable, whichever was asked
 * last -- and that a checkpoint for another task or of another width was quietly replaced by a
 * random start, the very thing a resume is asked for to avoid.
 */
function fit(file: PolicyFile, want: FitTarget): Fit {
  if (file.task !== want.task) {
    return {
      mismatch: 'task',
      message:
        `cannot resume ${want.name}: it was trained on ${file.task}, and this run scores ` +
        `${want.task}. Resume continues only the same task; choose another name to start afresh`,
    };
  }
  const saved = file.sizes.slice(1, -1).join('x');
  if (saved !== want.hidden.join('x')) {
    return {
      mismatch: 'hidden',
      message:
        `cannot resume ${want.name}: it has hidden layers ${saved || 'none'}, and this run asks ` +
        `for ${want.hidden.join('x') || 'none'}. Resume continues only the same widths; choose ` +
        'another name to start afresh',
    };
  }
  const { policy, carried } = MlpPolicy.fit(file, want.shape.inputNames, want.shape.outputNames);
  // Names alone say a sense is there, not what it means: a sense fixed since the file was written
  // keeps its name. Where both sides have a fingerprint, the body is the same only if it agrees.
  const bodyChanges =
    file.body && want.shape.body ? compareBody(file.body, want.shape.body, file.inputs) : [];
  const sameNames =
    carried.inputs === want.shape.inputNames.length &&
    file.sizes.join('x') === want.shape.sizes.join('x');
  return {
    weights: policy.weights,
    sameBody: sameNames && bodyChanges.length === 0,
    sameNames,
    bodyChanges,
    carried,
    generations: file.trained?.generations ?? 0,
    episodes: file.trained?.episodes ?? 0,
  };
}

/** How long is left, as a person says it: `3 h 10 m`, `4 m`, `< 1 m`. */
export function formatRemaining(seconds: number): string {
  if (!(seconds >= 60)) return '< 1 m';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} m`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
}

/**
 * What a run came to, in one line, for the terminal and the studio alike. A run in which nothing
 * beat the record has no best to report -- its fitness is minus infinity -- and says so, rather
 * than printing that infinity as a score.
 */
export function describeResult(r: TrainResult): string {
  if (r.generation === 0 || !Number.isFinite(r.fitness)) {
    return `nothing beat the record after ${r.episodes} episodes; nothing saved`;
  }
  return (
    `best ${r.fitness.toFixed(3)} (${r.alive.toFixed(2)} s up) from generation ${r.generation}, ` +
    `${r.episodes} episodes`
  );
}

/** How many generations the rolling estimate of a generation's wall time is taken over. */
const PACE_WINDOW = 10;

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
  const want: FitTarget = { name: recipe.name, task, hidden, shape };

  // The timescale the rig settled on, into the recipe the checkpoint carries: a run that plays
  // it at another step rate or evaluates it at another divisor is not what it was trained in.
  const carriedRecipe: TrainingRecipe = {
    ...recipe,
    stepsPerSecond: shape.stepsPerSecond,
    controlDivisor: shape.controlDivisor,
  };

  let initial: Float32Array | undefined;
  let startGeneration = 0;
  let startEpisodes = 0;
  /**
   * The saved record, when it was set on this very body in this very world: its weights from
   * the policy file (null when there is none that fits), and its score where that file says.
   */
  let record:
    | {
        readonly weights: Float32Array | null;
        readonly fitness?: number;
        readonly generation?: number;
      }
    | undefined;

  if (resume) {
    // Both, before anything is written. A resume that cannot continue what is saved refuses
    // outright: the old behaviour was to start from random weights under the same name, and the
    // first centre that scored anything at all then overwrote a checkpoint that may have taken
    // days -- which is what a person ticking Resume was asking not to happen.
    const centreFile = (await store.read('centre')) as PolicyFile | undefined;
    const policyFile = (await store.read('policy')) as PolicyFile | undefined;
    const centreFit = centreFile ? fit(centreFile, want) : undefined;
    const policyFit = policyFile ? fit(policyFile, want) : undefined;
    for (const f of [centreFit, policyFit]) {
      if (f && 'mismatch' in f) throw new Error(f.message);
    }
    const usable = (f: Fit | undefined) => (f && !('mismatch' in f) ? f : undefined);
    const centre = usable(centreFit);
    const policy = usable(policyFit);
    // The search resumes from its own centre, where it was; the policy is only the fallback,
    // because it is the best the search has been, which may be generations behind it.
    const from = centre ?? policy;
    const fromFile = centre ? centreFile : policyFile;
    if (!from || !fromFile) {
      note(`  nothing saved under ${recipe.name}; starting afresh`);
    } else {
      initial = from.weights;
      startGeneration = from.generations;
      startEpisodes = from.episodes;
      note(
        `  resuming from ${centre ? 'the saved centre' : 'the saved policy'} at generation ${startGeneration}` +
          (from.sameNames
            ? ''
            : `, fitted from ${fromFile.profile ?? 'another body'}: ${from.carried.inputs} of ${shape.inputNames.length} senses and ${from.carried.outputs} of ${shape.outputNames.length} drives carried`),
      );
      // The body, before the recipe: a sense that changed meaning under its old name is the one
      // difference the fit above cannot see, and the one a person resuming most needs to hear.
      if (from.bodyChanges.length > 0) {
        note(
          `  resuming a checkpoint trained in a different body (${from.bodyChanges.join('; ')}), ` +
            'so its record starts afresh; the checkpoint will record this body',
        );
      } else if (!fromFile.body && shape.body) {
        note(
          '  the checkpoint was trained before bodies were recorded; from here it records this one',
        );
      }
      // Said before a single episode is spent, field by field: a resume trains in what the
      // recipe says now, and the person resuming should know what that is not.
      const changes = recipeDifferences(fromFile.recipe, recipe);
      if (changes.length > 0) {
        note(
          `  resuming under a changed recipe: ${describeDifferences(changes)}; the checkpoint will record the new one`,
        );
      }
      // The record is a score, and a score means something only in the world it was earned in
      // and on the body that earned it. Its weights come from the policy file -- the record
      // itself -- and not from the centre the search resumes from: restarting "from the record"
      // to the centre is restarting from exactly where the search slumped.
      const recordChanges = recipeDifferences((policyFile ?? fromFile).recipe, recipe);
      if (recordChanges.length > 0) {
        note(
          `  the record was set in a different world (${recordChanges.map((c) => c.field).join(', ')}), so the record starts afresh`,
        );
      } else if (from.sameBody) {
        const trained = policy?.sameBody ? policyFile?.trained : undefined;
        record = {
          weights: policy?.sameBody ? policy.weights : null,
          ...(trained ? { fitness: trained.fitness, generation: trained.generations } : {}),
        };
      }
    }
  }
  if (!initial) initial = MlpPolicy.random(shape.sizes, seeded(12345)).weights;

  const search = (start: Float32Array, seed: number): OpenAiEs =>
    new OpenAiEs(
      {
        dimension: shape.parameterCount,
        population,
        sigma,
        learningRate,
        weightDecay: 0.001,
        seed,
      },
      start,
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
    // A centre's evaluation is asked for with the generation negated, which is what keeps its
    // seeds apart from the population's; the progress says which it is in plain words instead.
    const told = Math.abs(generation);
    const centre = generation < 0;
    let done = 0;
    await pool.run(tasks, (result) => {
      const at = tasks[result.id] as EpisodeTask;
      fitness[at.candidate] =
        (fitness[at.candidate] as number) + result.fitness / seedsPerCandidate;
      alive[at.candidate] = (alive[at.candidate] as number) + result.alive / seedsPerCandidate;
      done += 1;
      options.onEpisode?.({ generation: told, done, total: tasks.length, centre });
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
    // Up to where the search resumes and no further: a run stopped hard after its progress was
    // published and before its centre was written would otherwise chart its last generation
    // twice, once from each side of the resume.
    if (previous?.task === task && Array.isArray(previous.series)) {
      series.push(...previous.series.filter((row) => row[0] <= startGeneration));
    }
    // The score and the generation from the policy file where it says, so the record's weights
    // and its score come from one file; the progress file's, which says the same thing, where it
    // does not. The weights may be null -- a score that stands with nothing to restart to, which
    // every restart already checks for.
    const fitness = record?.fitness ?? previous?.best?.fitness;
    if (record && typeof fitness === 'number') {
      best = {
        fitness,
        weights: record.weights,
        generation: record.generation ?? previous?.best?.generation ?? startGeneration,
        alive: previous?.best?.alive ?? 0,
      };
    }
  }

  const fileFor = (
    weights: Float32Array,
    generation: number,
    fitness: number,
    count: number,
    scored: { readonly scoredAt: number; readonly populationMean: number },
  ) =>
    new MlpPolicy(shape.sizes, weights).toFile({
      task,
      profile: profileId,
      inputs: shape.inputNames,
      outputs: shape.outputNames,
      trained: {
        generations: generation,
        fitness,
        episodes: count,
        at: new Date().toISOString(),
        seconds,
        ...scored,
      },
      recipe: carriedRecipe,
      // The body this run trains in, from the rig that scored it, so a checkpoint handed to
      // another body -- a later build with a sense fixed, another profile -- says it is one.
      ...(shape.body ? { body: shape.body } : {}),
    });

  let episodes = startEpisodes;
  const target = startGeneration + generations;
  const startedAt = new Date().toISOString();
  /** Wall seconds of the last few generations, for the pace and what is left. */
  const laps: number[] = [];
  let secondsPerGeneration = 0;
  /** The last generation finished, so the final progress can say whether the run got there. */
  let reached = startGeneration;
  const publishLatest = async (state: 'running' | 'finished' | 'stopped'): Promise<void> => {
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
      startGeneration,
      target,
      startedAt,
      secondsPerGeneration,
      state,
    });
  };

  // What this run was, before its first generation: a history file read on its own a month
  // later should say what produced the rows under it.
  await store.appendLog({
    kind: 'header',
    recipe: carriedRecipe,
    population,
    seeds: seedsPerCandidate,
    seconds,
    sigma,
    learningRate,
    hidden,
    startGeneration,
    target,
    startedAt,
  });

  /**
   * The centre's last score, which is what the centre file says it is worth. It used to write
   * the population's mean there, which is the score of nobody: the centre is not scored by the
   * mean of its perturbations, and a dashboard that read it as the centre's was misled.
   */
  let lastCentre = { fitness: Number.NaN, alive: 0, generation: 0 };
  let lap = now();
  for (let g = startGeneration + 1; g <= target; g++) {
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
      lastCentre = { fitness: centreFitness, alive: centre.alive[0] as number, generation: g };
      // The step is Adam-normalised, so a noisy estimate still moves at full speed, and a run of
      // them can carry the centre somewhere it cannot stand at all while the record sits behind
      // it. Two checks in a row at less than half the record, and the search restarts from the
      // record with fresh momentum and fresh noise. "Half" is half the record's size below it,
      // so a negative record -- a task scored as a penalty -- slumps downwards as a positive one
      // does; `0.5 * best` put the threshold above a negative record, and every centre that
      // improved on it by less than half counted as a slump.
      slumped =
        best.weights && centreFitness < best.fitness - 0.5 * Math.abs(best.fitness)
          ? slumped + 1
          : 0;
      if (slumped >= 2 && best.weights) {
        es = search(best.weights, 42 + g);
        slumped = 0;
        noteText = `  restarted from the record (centre ${centreFitness.toFixed(3)} against ${best.fitness.toFixed(3)})`;
        // The centre is the record now, and is worth what the record is.
        lastCentre = { fitness: best.fitness, alive: best.alive, generation: best.generation };
      } else if (centreFitness > best.fitness) {
        best = {
          fitness: centreFitness,
          weights: Float32Array.from(es.theta),
          generation: g,
          alive: centre.alive[0] as number,
        };
        // The record stands in the search whether or not the host kept it -- a restart still
        // goes back to it -- but the line says which, because "saved" over a write that failed
        // is what let a run look finished while the checkpoint on disk was the old one.
        const kept =
          (await store.write(
            'policy',
            fileFor(best.weights as Float32Array, g, centreFitness, episodes, {
              scoredAt: g,
              populationMean: mean,
            }),
          )) !== false;
        const scoredText = `centre ${centreFitness.toFixed(3)}, ${(centre.alive[0] as number).toFixed(2)} s up`;
        noteText = kept ? `  saved (${scoredText})` : `  record not saved (${scoredText})`;
      }
    }
    // A lap runs from this point in one generation to this point in the next, so it holds the
    // previous generation's writes as well as this one's episodes: what a generation costs.
    const at = now();
    laps.push((at - lap) / 1000);
    lap = at;
    if (laps.length > PACE_WINDOW) laps.shift();
    secondsPerGeneration = laps.reduce((a, b) => a + b, 0) / laps.length;
    const report: GenerationReport = {
      generation: g,
      mean,
      top,
      topAlive,
      seconds: elapsed,
      rssMb: rss(),
      note: noteText,
      target,
      secondsPerGeneration,
    };
    await store.appendLog(report);
    options.onGeneration?.(report);
    await publishLatest('running');
    await store.write(
      'centre',
      fileFor(Float32Array.from(es.theta), g, lastCentre.fitness, episodes, {
        scoredAt: lastCentre.generation,
        populationMean: mean,
      }),
    );
    reached = g;
  }
  await publishLatest(reached === target ? 'finished' : 'stopped');
  return {
    fitness: best.fitness,
    alive: best.alive,
    generation: best.generation,
    episodes,
  };
}
