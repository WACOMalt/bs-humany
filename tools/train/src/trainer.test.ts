/**
 * The search, run against a pool that scores weights by arithmetic and a store that is a map.
 *
 * The trainer had no tests at all, and every one of the ways it went wrong -- a resume that
 * restarted from the wrong weights, an episode count that began again at nought, a checkpoint
 * silently replaced by a random start -- was invisible from outside a run of many minutes on a
 * real body. None of that needs a body. A candidate's score here is minus its squared distance
 * from a fixed target, so the search has a hill to climb and every number it writes can be
 * predicted, and a test can script the score of any one evaluation by its seed to put the
 * search wherever it wants.
 */

import { createHash } from 'node:crypto';
import { MlpPolicy, type PolicyFile } from '@bs-humany/modules-nerves';
import { describe, expect, it } from 'vitest';
import { describeDifferences, recipeDifferences } from './recipeDiff.js';
import {
  DEFAULT_NOISE,
  DEFAULT_REFLEX,
  NO_REFLEX,
  type TrainingRecipe,
  referenceStandRecipe,
} from './rig.js';
import {
  type CheckpointStore,
  type EpisodePool,
  type EpisodeResult,
  type EpisodeTask,
  type GenerationReport,
  type Keep,
  type RigShape,
  type TrainOptions,
  describeResult,
  formatRemaining,
  train,
} from './trainer.js';

const SHAPE: RigShape = {
  sizes: [3, 4, 2],
  parameterCount: 26,
  inputNames: ['a', 'b', 'c'],
  outputNames: ['x', 'y'],
  stepsPerSecond: 500,
  controlDivisor: 1,
};
const TARGET = Float32Array.from({ length: SHAPE.parameterCount }, (_, i) => Math.sin(i) * 0.5);

/** Which generation an evaluation belongs to, and whether it scored the centre. */
function generationOf(seed: number): { generation: number; centre: boolean } {
  // A candidate's seed is 1000 g + 7 pair + k, a centre's is -1000 g + k, with k below the
  // number of seeds -- so the thousands are the generation either way.
  return seed < 0
    ? { generation: Math.ceil(-seed / 1000), centre: true }
    : { generation: Math.floor(seed / 1000), centre: false };
}

class FakePool implements EpisodePool {
  readonly shape = SHAPE;
  /** Every task it was asked for, generation by generation, in the order it was asked. */
  readonly tasks: EpisodeTask[][] = [];
  /** A score for an evaluation by its seed, in place of the arithmetic; undefined for the hill. */
  constructor(private readonly script: (seed: number) => number | undefined = () => undefined) {}

  async run(
    tasks: readonly EpisodeTask[],
    onResult: (result: EpisodeResult) => void,
  ): Promise<void> {
    this.tasks.push([...tasks]);
    // Backwards, because a real pool answers in whatever order its workers finish.
    for (let i = tasks.length - 1; i >= 0; i--) {
      const task = tasks[i] as EpisodeTask;
      const scripted = this.script(task.seed);
      let d = 0;
      for (let w = 0; w < task.weights.length; w++) {
        d += ((task.weights[w] as number) - (TARGET[w] as number)) ** 2;
      }
      onResult({ id: task.id, fitness: scripted ?? -d, alive: 1 });
    }
  }

  dispose(): void {}

  /** The candidate batches only, without the centre evaluations. */
  candidateBatches(): EpisodeTask[][] {
    return this.tasks.filter((batch) => (batch[0]?.seed ?? 0) >= 0);
  }
}

class MemoryStore implements CheckpointStore {
  readonly kept = new Map<Keep, unknown>();
  readonly writes: Keep[] = [];
  readonly log: unknown[] = [];

  async read(kind: Keep): Promise<unknown | undefined> {
    return this.kept.get(kind);
  }
  async write(kind: Keep, value: unknown): Promise<void> {
    this.writes.push(kind);
    this.kept.set(kind, JSON.parse(JSON.stringify(value)));
  }
  async appendLog(line: unknown): Promise<void> {
    this.log.push(JSON.parse(JSON.stringify(line)));
  }

  policy(): PolicyFile | undefined {
    return this.kept.get('policy') as PolicyFile | undefined;
  }
  centre(): PolicyFile | undefined {
    return this.kept.get('centre') as PolicyFile | undefined;
  }
  latest(): Record<string, unknown> {
    return this.kept.get('latest') as Record<string, unknown>;
  }
  /** The log's generation rows: every line that is not a header. */
  rows(): GenerationReport[] {
    return this.log.filter(
      (line) => !(line as { kind?: string }).kind,
    ) as unknown as GenerationReport[];
  }
}

const RECIPE: TrainingRecipe = referenceStandRecipe('stand', 'l3_anatomical', 0.3);

function options(
  pool: EpisodePool,
  store: CheckpointStore,
  more: Partial<TrainOptions> = {},
): TrainOptions {
  return {
    recipe: RECIPE,
    pool,
    store,
    generations: 6,
    population: 4,
    seedsPerCandidate: 1,
    seconds: 1,
    workers: 1,
    sigma: 0.05,
    learningRate: 0.02,
    hidden: [4],
    resume: false,
    now: () => 0,
    ...more,
  };
}

function hash(weights: string): string {
  return createHash('sha256').update(weights).digest('hex').slice(0, 16);
}

/** A policy file for this shape, with weights that are all one value. */
function fileOf(
  value: number,
  meta: { task?: string; generations: number; fitness: number; episodes?: number },
  recipe: TrainingRecipe = RECIPE,
  sizes: readonly number[] = SHAPE.sizes,
): PolicyFile {
  const weights = new Float32Array(MlpPolicy.parameterCount(sizes)).fill(value);
  return new MlpPolicy(sizes, weights).toFile({
    task: meta.task ?? 'stand',
    profile: 'l3_anatomical',
    inputs: SHAPE.inputNames,
    outputs: SHAPE.outputNames,
    trained: {
      generations: meta.generations,
      fitness: meta.fitness,
      episodes: meta.episodes ?? 0,
      at: '2026-01-01T00:00:00.000Z',
    },
    recipe,
  });
}

describe('train', () => {
  it('writes the record once it is set, and the centre and progress every generation', async () => {
    const pool = new FakePool();
    const store = new MemoryStore();
    let recordAfterFirst: number | undefined;
    await train(
      options(pool, store, {
        onGeneration: (r) => {
          if (r.generation === 1) recordAfterFirst = store.policy()?.trained?.generations;
        },
      }),
    );
    // The first centre score beats a record of minus infinity, so the record is written then.
    expect(recordAfterFirst).toBe(1);
    expect(store.writes.filter((k) => k === 'centre')).toHaveLength(6);
    expect(store.writes.filter((k) => k === 'latest').length).toBeGreaterThanOrEqual(6);
    expect(store.rows().map((r) => r.generation)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(store.centre()?.trained?.generations).toBe(6);
  });

  it('keeps its trajectory: the same run gives the same centre and series', async () => {
    const store = new MemoryStore();
    await train(options(new FakePool(), store));
    // Pinned, so that every change below which is not about a resume leaves a fresh run's
    // search exactly where it was.
    expect(hash(store.centre()?.weights as string)).toMatchInlineSnapshot(`"a47acdc8c49bc7b3"`);
    expect(store.latest().series).toMatchInlineSnapshot(`
      [
        [
          1,
          -3.2152,
          -3.1234,
          1,
        ],
        [
          2,
          -3.2149,
          -2.9713,
          1,
        ],
        [
          3,
          -3.1521,
          -2.9692,
          1,
        ],
        [
          4,
          -3.0598,
          -2.8485,
          1,
        ],
        [
          5,
          -3.0177,
          -2.8162,
          1,
        ],
        [
          6,
          -2.8987,
          -2.8366,
          1,
        ],
      ]
    `);
  });

  it('is bit-identical run to run', async () => {
    const a = new MemoryStore();
    const b = new MemoryStore();
    await train(options(new FakePool(), a));
    await train(options(new FakePool(), b));
    expect(a.centre()?.weights).toBe(b.centre()?.weights);
    expect(a.policy()?.weights).toBe(b.policy()?.weights);
  });

  it('gives a mirrored pair the same seeds', async () => {
    const pool = new FakePool();
    await train(options(pool, new MemoryStore(), { seedsPerCandidate: 2, population: 6 }));
    for (const batch of pool.candidateBatches()) {
      const seeds = (c: number) => batch.filter((t) => t.candidate === c).map((t) => t.seed);
      for (let p = 0; p < 3; p++) {
        expect(seeds(2 * p)).toEqual(seeds(2 * p + 1));
        expect(seeds(2 * p)).toHaveLength(2);
      }
      expect(seeds(0)).not.toEqual(seeds(2));
    }
  });

  it('stops between generations and leaves a centre at the last one finished', async () => {
    const store = new MemoryStore();
    let finished = 0;
    await train(
      options(new FakePool(), store, {
        generations: 10,
        onGeneration: () => {
          finished += 1;
        },
        stopped: () => finished >= 3,
      }),
    );
    expect(store.centre()?.trained?.generations).toBe(3);
    expect(store.rows()).toHaveLength(3);
  });

  it('continues the numbering and the series on a resume', async () => {
    const store = new MemoryStore();
    await train(options(new FakePool(), store, { generations: 3 }));
    await train(options(new FakePool(), store, { generations: 2, resume: true }));
    const series = store.latest().series as number[][];
    expect(series.map((row) => row[0])).toEqual([1, 2, 3, 4, 5]);
    expect(store.centre()?.trained?.generations).toBe(5);
  });

  it('restarts from the record when the centre slumps twice in a row', async () => {
    // A positive record of 10 at the first check, then two checks at 1, below half of it.
    const script = (seed: number) => {
      const { generation, centre } = generationOf(seed);
      if (!centre) return undefined;
      return generation === 1 ? 10 : 1;
    };
    const reports: GenerationReport[] = [];
    await train(
      options(new FakePool(script), new MemoryStore(), {
        generations: 10,
        onGeneration: (r) => reports.push(r),
      }),
    );
    const restarted = reports.find((r) => r.note.includes('restarted from the record'));
    expect(restarted?.generation).toBe(10);
  });
});

/** A store holding a run of `stand` that got to generation 7, its record set at generation 5. */
function savedRun(more: { policy?: PolicyFile; centre?: PolicyFile; record?: number } = {}) {
  const store = new MemoryStore();
  const record = more.record ?? 10;
  store.kept.set(
    'policy',
    more.policy ?? fileOf(0.3, { generations: 5, fitness: record, episodes: 20 }),
  );
  store.kept.set(
    'centre',
    more.centre ?? fileOf(-0.3, { generations: 7, fitness: 1, episodes: 28 }),
  );
  store.kept.set('latest', {
    task: 'stand',
    // One row past the centre, as a run stopped hard between its progress and its centre leaves.
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((g) => [g, -1, -1, 1]),
    best: { fitness: record, alive: 1, generation: 5 },
  });
  return store;
}

describe('train, resumed', () => {
  it('restarts to the record the policy file holds, not to the centre it resumed from', async () => {
    // Every centre check scores 1 against a record of 10: the checks at 8 and 10 both slump.
    const script = (seed: number) => (generationOf(seed).centre ? 1 : undefined);
    const pool = new FakePool(script);
    const reports: GenerationReport[] = [];
    await train(
      options(pool, savedRun(), {
        generations: 4,
        resume: true,
        onGeneration: (r) => reports.push(r),
      }),
    );
    expect(reports.find((r) => r.note.includes('restarted'))?.generation).toBe(10);
    // Generation 11 is asked around the restart point, and a mirrored pair averages to it: the
    // policy's 0.3 everywhere, not the centre's -0.3.
    const after = pool
      .candidateBatches()
      .find((b) => generationOf(b[0]?.seed ?? 0).generation === 11);
    const plus = after?.find((t) => t.candidate === 0)?.weights as Float32Array;
    const minus = after?.find((t) => t.candidate === 1)?.weights as Float32Array;
    expect(plus).toBeDefined();
    for (let i = 0; i < plus.length; i++) {
      expect(((plus[i] as number) + (minus[i] as number)) / 2).toBeCloseTo(0.3, 5);
    }
  });

  it('continues the episode count and the generation from the same file', async () => {
    const store = new MemoryStore();
    const first = await train(options(new FakePool(), store, { generations: 2 }));
    expect(first.episodes).toBe(8);
    const second = await train(options(new FakePool(), store, { generations: 1, resume: true }));
    expect(second.episodes).toBe(12);
    expect(store.centre()?.trained?.episodes).toBe(12);
    expect(store.centre()?.trained?.generations).toBe(3);
  });

  it('refuses a checkpoint trained on another task, and writes nothing', async () => {
    const store = savedRun({
      policy: fileOf(0.3, { task: 'balance', generations: 5, fitness: 10 }),
    });
    await expect(train(options(new FakePool(), store, { resume: true }))).rejects.toThrow(
      /trained on balance, and this run scores stand/,
    );
    expect(store.writes).toEqual([]);
    expect(store.log).toEqual([]);
  });

  it('refuses a recipe for another task over a saved stand, naming both, and writes nothing', async () => {
    const store = savedRun();
    const balance: TrainingRecipe = { ...RECIPE, task: 'balance', name: 'stand' };
    const refused = train(options(new FakePool(), store, { recipe: balance, resume: true }));
    await expect(refused).rejects.toThrow(/stand.*balance/);
    expect(store.writes).toEqual([]);
  });

  it('refuses a checkpoint of other hidden widths, naming both, and writes nothing', async () => {
    const wide = fileOf(0.3, { generations: 5, fitness: 10 }, RECIPE, [3, 4, 4, 2]);
    const store = savedRun({ policy: wide, centre: wide });
    await expect(
      train(options(new FakePool(), store, { hidden: [8], resume: true })),
    ).rejects.toThrow(/4x4.*8/);
    expect(store.writes).toEqual([]);
  });

  it('keeps a record it cannot beat, continuing from the generation after the saved one', async () => {
    const store = savedRun({ record: 100 });
    const reports: GenerationReport[] = [];
    await train(
      options(new FakePool(), store, {
        generations: 3,
        resume: true,
        onGeneration: (r) => reports.push(r),
      }),
    );
    expect(reports[0]?.generation).toBe(8);
    expect(store.writes).not.toContain('policy');
    // The chart carries on from where the centre was, and does not chart generation 8 twice.
    const series = store.latest().series as number[][];
    expect(series.map((row) => row[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('starts afresh, and says so, when nothing is saved', async () => {
    const notes: string[] = [];
    const store = new MemoryStore();
    await train(options(new FakePool(), store, { resume: true, onNote: (t) => notes.push(t) }));
    expect(notes.join('\n')).toContain('nothing saved');
    expect(store.writes).toContain('policy');
  });

  it('names every changed field of the recipe before it starts', async () => {
    const quiet: TrainingRecipe = { ...RECIPE, reflex: { ...DEFAULT_REFLEX, stretch: 0 } };
    const store = savedRun({
      policy: fileOf(0.3, { generations: 5, fitness: 10 }, quiet),
      centre: fileOf(-0.3, { generations: 7, fitness: 1 }, quiet),
    });
    const notes: string[] = [];
    let notesBeforeFirstGeneration = -1;
    await train(
      options(new FakePool(), store, {
        generations: 1,
        resume: true,
        onNote: (t) => notes.push(t),
        onGeneration: () => {
          if (notesBeforeFirstGeneration < 0) notesBeforeFirstGeneration = notes.length;
        },
      }),
    );
    const changed = notes.find((n) => n.includes('changed recipe'));
    expect(changed).toContain('reflex.stretch');
    expect(notes.indexOf(changed as string)).toBeLessThan(notesBeforeFirstGeneration);
  });

  it('starts the record afresh when it was set in another world', async () => {
    const strong: TrainingRecipe = { ...RECIPE, authority: 1 };
    const store = savedRun({
      policy: fileOf(0.3, { generations: 5, fitness: 10 }, strong),
      centre: fileOf(-0.3, { generations: 7, fitness: 1 }, strong),
    });
    const notes: string[] = [];
    await train(
      options(new FakePool(), store, {
        generations: 1,
        resume: true,
        onNote: (t) => notes.push(t),
      }),
    );
    expect(notes.join('\n')).toContain('the record starts afresh');
    expect(notes.join('\n')).toContain('authority 0.30 (was 1.00)');
    // A record of minus infinity, so the first centre scored is the new one.
    expect(store.writes).toContain('policy');
    expect(store.policy()?.recipe?.authority).toBe(0.3);
  });
});

describe('train, what it writes', () => {
  it('does not restart on a negative record that the centre is improving on', async () => {
    const script = (seed: number) => {
      const { generation, centre } = generationOf(seed);
      if (!centre) return undefined;
      return generation === 1 ? -2 : generation === 5 ? -1.5 : -1.2;
    };
    const reports: GenerationReport[] = [];
    const store = new MemoryStore();
    const result = await train(
      options(new FakePool(script), store, {
        generations: 10,
        onGeneration: (r) => reports.push(r),
      }),
    );
    expect(reports.some((r) => r.note.includes('restarted'))).toBe(false);
    expect(result.fitness).toBe(-1.2);
    expect(store.policy()?.trained?.fitness).toBe(-1.2);
  });

  it("gives the centre file the centre's own score, and the population's mean beside it", async () => {
    const script = (seed: number) => (generationOf(seed).centre ? 0.25 : undefined);
    const store = new MemoryStore();
    const reports: GenerationReport[] = [];
    await train(
      options(new FakePool(script), store, {
        generations: 3,
        onGeneration: (r) => reports.push(r),
      }),
    );
    const trained = store.centre()?.trained;
    expect(trained?.fitness).toBe(0.25);
    expect(trained?.scoredAt).toBe(1);
    expect(trained?.populationMean).toBe(reports[2]?.mean);
    expect(trained?.seconds).toBe(1);
  });

  it('publishes the target, when it started, and how it ended', async () => {
    const finished = new MemoryStore();
    await train(options(new FakePool(), finished, { generations: 3 }));
    expect(finished.latest()).toMatchObject({ target: 3, startGeneration: 0, state: 'finished' });
    expect(typeof finished.latest().startedAt).toBe('string');

    const stopped = new MemoryStore();
    let done = 0;
    await train(
      options(new FakePool(), stopped, {
        generations: 5,
        onGeneration: () => {
          done += 1;
        },
        stopped: () => done >= 2,
      }),
    );
    expect(stopped.latest()).toMatchObject({ target: 5, state: 'stopped' });
  });

  it('reports the pace, and heads the log with what the run was', async () => {
    let clock = 0;
    const store = new MemoryStore();
    const reports: GenerationReport[] = [];
    await train(
      options(new FakePool(), store, {
        generations: 3,
        now: () => {
          clock += 500;
          return clock;
        },
        onGeneration: (r) => reports.push(r),
      }),
    );
    expect(reports.map((r) => r.target)).toEqual([3, 3, 3]);
    expect(reports.every((r) => r.secondsPerGeneration > 0)).toBe(true);
    expect(store.log[0]).toMatchObject({ kind: 'header', startGeneration: 0, target: 3 });
    expect(store.rows()).toHaveLength(3);
  });

  it('never says a record was saved when the store could not keep it', async () => {
    // A store that answers false for the record: a host that could not write it and chose to go
    // on training rather than stop the run. The studio's store does this when the disk or the
    // browser refuses; a line saying "saved" over that is the lie this guards against.
    const inner = new MemoryStore();
    const refusing: CheckpointStore = {
      read: (kind) => inner.read(kind),
      write: async (kind, value) => {
        if (kind === 'policy') return false;
        await inner.write(kind, value);
      },
      appendLog: (line) => inner.appendLog(line),
    };
    const reports: GenerationReport[] = [];
    await train(
      options(new FakePool(), refusing, {
        generations: 10,
        onGeneration: (r) => reports.push(r),
      }),
    );
    const notes = reports.map((r) => r.note).filter((n) => n !== '');
    expect(notes.some((n) => n.startsWith('  saved'))).toBe(false);
    expect(notes.some((n) => n.includes('not saved'))).toBe(true);
    // The search still holds its record in memory, and goes on from it.
    expect(inner.centre()?.trained?.generations).toBe(10);
  });

  it('still says saved when the store answers nothing, as every store did before', async () => {
    const reports: GenerationReport[] = [];
    await train(
      options(new FakePool(), new MemoryStore(), {
        generations: 1,
        onGeneration: (r) => reports.push(r),
      }),
    );
    expect(reports[0]?.note.startsWith('  saved (')).toBe(true);
  });

  it('reports each episode as it lands, the candidates and then the centre', async () => {
    const seen: { generation: number; done: number; total: number; centre: boolean }[] = [];
    await train(
      options(new FakePool(), new MemoryStore(), {
        generations: 1,
        population: 4,
        seedsPerCandidate: 2,
        onEpisode: (p) => seen.push({ ...p }),
      }),
    );
    const candidates = seen.filter((p) => !p.centre);
    const centre = seen.filter((p) => p.centre);
    expect(candidates.map((p) => p.done)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(candidates.every((p) => p.total === 8 && p.generation === 1)).toBe(true);
    expect(centre.map((p) => p.done)).toEqual([1, 2]);
    expect(centre.every((p) => p.total === 2 && p.generation === 1)).toBe(true);
    // In that order: the whole population, then the centre on its fresh seeds.
    expect(seen.map((p) => p.centre)).toEqual([...Array(8).fill(false), true, true]);
  });
});

describe('describeResult and formatRemaining', () => {
  it('says nothing was saved rather than printing minus infinity', () => {
    const text = describeResult({
      fitness: Number.NEGATIVE_INFINITY,
      alive: 0,
      generation: 0,
      episodes: 40,
    });
    expect(text).toContain('nothing saved');
    expect(text).not.toContain('Infinity');
    expect(describeResult({ fitness: 1.5, alive: 2, generation: 5, episodes: 40 })).toBe(
      'best 1.500 (2.00 s up) from generation 5, 40 episodes',
    );
  });

  it('says what is left as a person would', () => {
    expect(formatRemaining(11400)).toBe('3 h 10 m');
    expect(formatRemaining(240)).toBe('4 m');
    expect(formatRemaining(20)).toBe('< 1 m');
    expect(formatRemaining(Number.NaN)).toBe('< 1 m');
  });
});

describe('recipeDifferences', () => {
  it('finds nothing between a recipe and itself, or a JSON round trip of it', () => {
    expect(recipeDifferences(RECIPE, RECIPE)).toEqual([]);
    const tripped = JSON.parse(JSON.stringify({ ...RECIPE, authority: 0.1 + 0.2 }));
    expect(recipeDifferences(tripped, { ...RECIPE, authority: 0.3 })).toEqual([]);
  });

  it('cannot compare a checkpoint that records no recipe, and says nothing differs', () => {
    expect(recipeDifferences(undefined, RECIPE)).toEqual([]);
  });

  it('reads an omitted noise, cord and memory as the ones the rig gives it', () => {
    const { noise: _noise, reflex: _reflex, memory: _memory, ...old } = RECIPE;
    expect(
      recipeDifferences(old, { ...RECIPE, noise: DEFAULT_NOISE, reflex: NO_REFLEX, memory: 0 }),
    ).toEqual([]);
    expect(recipeDifferences(old, RECIPE).map((d) => d.field)).toEqual([
      'reflex.stretch',
      'reflex.velocity',
    ]);
  });

  it('names each field that changed, nested ones by their path', () => {
    const was: TrainingRecipe = {
      ...RECIPE,
      scenario: 'drop',
      parameters: { height: 1 },
      authority: 1,
    };
    const list = recipeDifferences(was, RECIPE);
    expect(list.map((d) => d.field)).toEqual(['scenario', 'parameters.height', 'authority']);
    const titles: Record<string, string> = { drop: 'Drop and collapse' };
    const text = describeDifferences(list, (id) => titles[id] ?? id);
    expect(text).toContain('in the reference stand (was Drop and collapse)');
    expect(text).toContain('parameters.height unset (was 1.00)');
    expect(text).toContain('authority 0.30 (was 1.00)');
  });

  it('words a changed profile as the fitting a resume does', () => {
    const list = recipeDifferences({ ...RECIPE, profile: 'l1_standard' }, RECIPE);
    expect(describeDifferences(list)).toBe('fitted from L1');
  });
});
