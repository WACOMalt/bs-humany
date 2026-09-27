/**
 * The window's worker pool ends a run it cannot finish, instead of waiting on it for ever.
 *
 * An episode that threw in a web worker used to leave the pool one answer short of a generation:
 * the Brain tab said the run was going, Start stayed greyed out, and nothing moved until the window
 * was reloaded. The workers here are fakes, handed in through the pool's `spawn` -- there is no
 * Worker under vitest in Node, and a real one would need a real body -- that answer in a few
 * milliseconds and fail in whichever way a test asks.
 */

import type { RigOptions } from '@bs-humany/train/rig';
import type { EpisodeResult, EpisodeTask } from '@bs-humany/train/trainer';
import { describe, expect, it } from 'vitest';
import { type EpisodeWorker, createWorkerPool } from './pool.js';

/** How a fake worker behaves: which episode goes wrong, and how. */
interface Script {
  /** Answer `failed` for this episode, as the real worker does when its rig throws. */
  readonly failOn?: number;
  /** Stop on this episode with a worker 'error', as a worker does on an exception nobody caught. */
  readonly dieOn?: number;
  /** Refuse to build the body. */
  readonly buildFails?: boolean;
}

class FakeWorker extends EventTarget implements EpisodeWorker {
  terminated = false;
  constructor(private readonly script: Script) {
    super();
  }
  postMessage(message: unknown): void {
    const m = message as { type: string; id: number };
    // Answered later, as a real worker's are, so a test sees answers arrive after a refusal.
    setTimeout(() => {
      if (this.terminated) return;
      if (m.type === 'build') {
        this.reply(
          this.script.buildFails
            ? { type: 'failed', error: 'No scenario called nowhere' }
            : {
                type: 'ready',
                sizes: [2, 1],
                parameterCount: 3,
                inputNames: ['a', 'b'],
                outputNames: ['c'],
                stepsPerSecond: 100,
                controlDivisor: 1,
              },
        );
      } else if (m.id === this.script.failOn) {
        this.reply({ type: 'failed', id: m.id, error: 'boom' });
      } else if (m.id === this.script.dieOn) {
        this.dispatchEvent(Object.assign(new Event('error'), { message: 'gone' }));
      } else {
        this.reply({ type: 'result', id: m.id, fitness: -m.id, alive: 1 });
      }
    }, 2);
  }
  terminate(): void {
    this.terminated = true;
  }
  private reply(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

const OPTIONS = {} as RigOptions;
const TASKS: EpisodeTask[] = Array.from({ length: 10 }, (_, id) => ({
  id,
  candidate: id >> 1,
  seed: 100 + id,
  weights: new Float32Array(3),
}));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A pool of `count` fakes following `script`, and the fakes, for a test to look at. */
async function pool(script: Script, count = 2) {
  const workers: FakeWorker[] = [];
  const p = await createWorkerPool(OPTIONS, count, {
    spawn: () => {
      const w = new FakeWorker(script);
      workers.push(w);
      return w;
    },
  });
  return { pool: p, workers };
}

describe('createWorkerPool', () => {
  it('counts the workers that have their body, from none to all of them', async () => {
    const told: [number, number][] = [];
    await createWorkerPool(OPTIONS, 3, {
      spawn: () => new FakeWorker({}),
      onReady: (ready, total) => told.push([ready, total]),
    });
    expect(told).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('scores every episode once and resolves', async () => {
    const { pool: p } = await pool({});
    const results: EpisodeResult[] = [];
    await p.run(TASKS, (r) => results.push(r));
    expect(results.map((r) => r.id).sort((a, b) => a - b)).toEqual(TASKS.map((t) => t.id));
    // A second generation on the same pool, as the search runs them.
    results.length = 0;
    await p.run(TASKS, (r) => results.push(r));
    expect(results).toHaveLength(TASKS.length);
  });

  it('rejects a run whose worker reports a failed episode, naming it and its seed', async () => {
    const { pool: p } = await pool({ failOn: 3 });
    await expect(p.run(TASKS, () => {})).rejects.toThrow('episode 3 (seed 103) failed: boom');
  });

  it('rejects a run whose worker stops, naming the episode it was on', async () => {
    const { pool: p } = await pool({ dieOn: 4 });
    await expect(p.run(TASKS, () => {})).rejects.toThrow(
      'episode 4 (seed 104) failed: a training worker stopped: gone',
    );
  });

  it('hands no answer to the search after the run has been refused', async () => {
    const { pool: p } = await pool({ failOn: 3 });
    let calls = 0;
    await expect(
      p.run(TASKS, () => {
        calls += 1;
      }),
    ).rejects.toThrow('episode 3');
    // The other worker was in the middle of an episode, and its answer lands now.
    const atRejection = calls;
    await wait(20);
    expect(calls).toBe(atRejection);
  });

  it('refuses the next run on a pool that has failed one, at once', async () => {
    const { pool: p } = await pool({ failOn: 3 });
    await expect(p.run(TASKS, () => {})).rejects.toThrow('episode 3');
    await expect(p.run(TASKS, () => {})).rejects.toThrow('episode 3');
  });

  it('refuses a run on a pool whose worker stopped between generations', async () => {
    const { pool: p, workers } = await pool({});
    workers[1]?.dispatchEvent(Object.assign(new Event('error'), { message: 'out of memory' }));
    await expect(p.run(TASKS, () => {})).rejects.toThrow(
      'a training worker stopped: out of memory',
    );
  });

  it('rejects when a worker cannot build its body, and lets every worker go', async () => {
    const workers: FakeWorker[] = [];
    await expect(
      createWorkerPool(OPTIONS, 3, {
        spawn: () => {
          const w = new FakeWorker({ buildFails: true });
          workers.push(w);
          return w;
        },
      }),
    ).rejects.toThrow('No scenario called nowhere');
    expect(workers.every((w) => w.terminated)).toBe(true);
  });
});
