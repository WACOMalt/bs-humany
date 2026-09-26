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
import type { PolicyFile } from '@bs-humany/modules-nerves';
import { describe, expect, it } from 'vitest';
import { type TrainingRecipe, defaultRecipe } from './rig.js';
import {
  type CheckpointStore,
  type EpisodePool,
  type EpisodeResult,
  type EpisodeTask,
  type GenerationReport,
  type Keep,
  type RigShape,
  type TrainOptions,
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

const RECIPE: TrainingRecipe = defaultRecipe('stand', 'l3_anatomical', 0.3);

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
