/**
 * The node pool refuses a run it cannot finish, rather than waiting for it for ever.
 *
 * An episode that threw used to leave the pool one answer short of a generation, and the trainer
 * sat there with its workers idle until somebody noticed nothing was moving. These tests use real
 * worker threads -- the pool is about threads, and a fake would test the fake -- running a
 * stand-in worker with no body, which fails in whichever way a test asks.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createNodePool } from './nodePool.js';
import type { EpisodePool, EpisodeResult, EpisodeTask } from './trainer.js';

const WORKER = new URL('./testing/throwing-worker.mjs', import.meta.url);

/** Ten episodes, ids 0 to 9, each with a seed that is not its id, so a message can be read for both. */
const TASKS: EpisodeTask[] = Array.from({ length: 10 }, (_, id) => ({
  id,
  candidate: id >> 1,
  seed: 100 + id,
  weights: new Float32Array(3),
}));

const pools: EpisodePool[] = [];
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose();
});

async function pool(workerData: Record<string, unknown>, count = 2): Promise<EpisodePool> {
  const p = await createNodePool(WORKER, workerData, count);
  pools.push(p);
  return p;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createNodePool', () => {
  it('scores every episode once and resolves', async () => {
    const p = await pool({ failOn: -1 });
    expect(p.shape.parameterCount).toBe(3);
    const results: EpisodeResult[] = [];
    await p.run(TASKS, (r) => results.push(r));
    expect(results.map((r) => r.id).sort((a, b) => a - b)).toEqual(TASKS.map((t) => t.id));
  });

  it('rejects a run whose episode throws, naming the episode and its seed', async () => {
    const p = await pool({ failOn: 3, how: 'throw' });
    let calls = 0;
    const started = Date.now();
    const run = p.run(TASKS, () => {
      calls += 1;
    });
    await expect(run).rejects.toThrow(/episode 3 \(seed 103\) failed: boom in episode 3/);
    expect(Date.now() - started).toBeLessThan(1000);
    // The other worker is still in the middle of an episode; its answer lands after the refusal
    // and must not be handed to a search that has been told the generation failed.
    const atRejection = calls;
    await wait(100);
    expect(calls).toBe(atRejection);
  });

  it('rejects a run whose worker reports a failed episode, keeping the stack as the cause', async () => {
    const p = await pool({ failOn: 3, how: 'report' });
    const error = await p.run(TASKS, () => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('episode 3 (seed 103) failed: boom');
    expect((error as Error).cause).toBe('at rig');
  });

  it('rejects a run whose worker thread exits', async () => {
    const p = await pool({ failOn: 3, how: 'exit' });
    await expect(p.run(TASKS, () => {})).rejects.toThrow(
      /episode 3 \(seed 103\) failed: its worker exited with code 3/,
    );
  });

  it('refuses the next run on a pool that has failed one, at once', async () => {
    const p = await pool({ failOn: 3, how: 'report' });
    await expect(p.run(TASKS, () => {})).rejects.toThrow(/episode 3/);
    let calls = 0;
    await expect(
      p.run(TASKS, () => {
        calls += 1;
      }),
    ).rejects.toThrow(/episode 3/);
    expect(calls).toBe(0);
  });

  it('rejects when a worker cannot build its body, with the sentence it gave', async () => {
    await expect(createNodePool(WORKER, { build: 'fail' }, 2)).rejects.toThrow(
      'No scenario called nowhere',
    );
  });
});
