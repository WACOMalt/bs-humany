/**
 * A pool of web workers, each with a rig, behind the three methods the search wants.
 *
 * The Node trainer spreads a generation's episodes over worker threads; this spreads them over
 * web workers, and the search cannot tell the difference. An episode is handed out one at a
 * time rather than in a block, because a generation is only as fast as its slowest worker and a
 * block leaves one of them alone with the tail of the work.
 */

import type { RigOptions } from '@bs-humany/train/rig';
import type { EpisodePool, EpisodeResult, EpisodeTask, RigShape } from '@bs-humany/train/trainer';

type Outgoing =
  | ({ readonly type: 'ready' } & RigShape)
  | { readonly type: 'failed'; readonly error: string }
  | {
      readonly type: 'result';
      readonly id: number;
      readonly fitness: number;
      readonly alive: number;
    };

/**
 * Build the pool and wait for every worker to have a body. Rejects if any of them cannot: a
 * generation scored by three workers out of four is a generation with a quarter of its
 * candidates unscored, which the search would read as a quarter of them being terrible.
 */
export async function createWorkerPool(options: RigOptions, workers: number): Promise<EpisodePool> {
  const pool: Worker[] = [];
  const ready: Promise<RigShape>[] = [];
  for (let i = 0; i < workers; i++) {
    const worker = new Worker(new URL('./episodeWorker.ts', import.meta.url), { type: 'module' });
    pool.push(worker);
    ready.push(
      new Promise<RigShape>((resolve, reject) => {
        const onMessage = (event: MessageEvent<Outgoing>): void => {
          const message = event.data;
          if (message.type === 'ready') {
            worker.removeEventListener('message', onMessage);
            resolve(message);
          } else if (message.type === 'failed') {
            worker.removeEventListener('message', onMessage);
            reject(new Error(message.error));
          }
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', (e) => reject(new Error(String(e.message))));
      }),
    );
    worker.postMessage({ type: 'build', options });
  }
  let shapes: RigShape[];
  try {
    shapes = await Promise.all(ready);
  } catch (error) {
    for (const w of pool) w.terminate();
    throw error;
  }
  const shape = shapes[0] as RigShape;

  return {
    shape,
    run(tasks: readonly EpisodeTask[], onResult: (result: EpisodeResult) => void): Promise<void> {
      return new Promise<void>((resolve) => {
        if (tasks.length === 0) {
          resolve();
          return;
        }
        let next = 0;
        let done = 0;
        const listeners = new Map<Worker, (event: MessageEvent<Outgoing>) => void>();
        const feed = (worker: Worker): void => {
          if (next >= tasks.length) return;
          const task = tasks[next++] as EpisodeTask;
          worker.postMessage({
            type: 'evaluate',
            id: task.id,
            weights: task.weights,
            seed: task.seed,
          });
        };
        for (const worker of pool) {
          const onMessage = (event: MessageEvent<Outgoing>): void => {
            const message = event.data;
            if (message.type !== 'result') return;
            onResult({ id: message.id, fitness: message.fitness, alive: message.alive });
            done += 1;
            if (done === tasks.length) {
              for (const [w, listener] of listeners) w.removeEventListener('message', listener);
              resolve();
            } else {
              feed(worker);
            }
          };
          listeners.set(worker, onMessage);
          worker.addEventListener('message', onMessage);
          feed(worker);
        }
      });
    },
    dispose(): void {
      for (const w of pool) w.terminate();
    },
  };
}
