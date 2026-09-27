/**
 * A pool of web workers, each with a rig, behind the three methods the search wants.
 *
 * The Node trainer spreads a generation's episodes over worker threads; this spreads them over
 * web workers, and the search cannot tell the difference. An episode is handed out one at a
 * time rather than in a block, because a generation is only as fast as its slowest worker and a
 * block leaves one of them alone with the tail of the work.
 *
 * A run that cannot finish says so. The pool counts answers to know when a generation is done, and
 * it used to listen for nothing but answers: an episode that threw left it one short for ever, and
 * the Brain tab showed a run that was merely slow, with Start greyed out, until the window was
 * reloaded. Now an episode the worker reports as failed, and a worker that stops, both end the
 * generation with an error naming the episode -- the same rules as the Node pool in
 * `tools/train/src/nodePool.ts`, in the same words.
 */

import type { RigOptions } from '@bs-humany/train/rig';
import type { EpisodePool, EpisodeResult, EpisodeTask, RigShape } from '@bs-humany/train/trainer';

type Outgoing =
  | ({ readonly type: 'ready' } & RigShape)
  | {
      readonly type: 'failed';
      /** The episode it was running; absent when it failed building its body. */
      readonly id?: number;
      readonly error: string;
    }
  | {
      readonly type: 'result';
      readonly id: number;
      readonly fitness: number;
      readonly alive: number;
    };

/** The events of a worker this pool listens to. */
type WorkerEvent = 'message' | 'error' | 'messageerror';

/**
 * As much of a web worker as the pool uses, so a test can hand it workers that are not ones --
 * there is no Worker under vitest in Node, and a real one would need a real body.
 */
export interface EpisodeWorker {
  postMessage(message: unknown): void;
  addEventListener(type: WorkerEvent, listener: (event: Event) => void): void;
  removeEventListener(type: WorkerEvent, listener: (event: Event) => void): void;
  terminate(): void;
}

/** A module worker running `episodeWorker.ts`, which is what the pool uses outside a test. */
function spawnEpisodeWorker(): EpisodeWorker {
  return new Worker(new URL('./episodeWorker.ts', import.meta.url), { type: 'module' });
}

/** What a worker's 'error' or 'messageerror' event says, whatever it carries. */
function eventMessage(event: Event): string {
  if (event.type === 'messageerror') return 'a message from it could not be read';
  const message = (event as ErrorEvent).message;
  return typeof message === 'string' && message !== '' ? message : 'it stopped without saying why';
}

/** Listen to `types` on `worker` with `listener`, and return what takes every one of them off. */
function listen(
  worker: EpisodeWorker,
  types: readonly WorkerEvent[],
  listener: (event: Event) => void,
): () => void {
  for (const type of types) worker.addEventListener(type, listener);
  return () => {
    for (const type of types) worker.removeEventListener(type, listener);
  };
}

/** What a caller may hand the pool beside the rig and the count, all of it optional. */
export interface WorkerPoolHooks {
  /**
   * Told how many workers have their body, of how many, once before any has and again as each
   * one gets it. Building a body takes seconds a worker -- compiling the articulation, loading
   * MuJoCo, fitting every muscle -- and a window building eight of them used to say "Building 8
   * bodies" and nothing else until the first generation, which is long enough to look stuck.
   */
  readonly onReady?: (ready: number, total: number) => void;
  /** Makes one worker; a test passes one that makes a fake. */
  readonly spawn?: () => EpisodeWorker;
}

/**
 * Build the pool and wait for every worker to have a body. Rejects if any of them cannot: a
 * generation scored by three workers out of four is a generation with a quarter of its
 * candidates unscored, which the search would read as a quarter of them being terrible.
 */
export async function createWorkerPool(
  options: RigOptions,
  workers: number,
  hooks: WorkerPoolHooks = {},
): Promise<EpisodePool> {
  const spawn = hooks.spawn ?? spawnEpisodeWorker;
  const pool: EpisodeWorker[] = [];
  let readyCount = 0;
  hooks.onReady?.(0, workers);

  /**
   * Why the pool can no longer be trusted, once it cannot: a worker that stopped, even between two
   * generations when no run was listening, or an episode that failed, whose rig is the one that
   * worker would score its next episode on. A run on such a pool refuses at once rather than
   * handing an episode to a worker that will never answer it.
   */
  let broken: Error | undefined;

  const ready: Promise<RigShape>[] = [];
  for (let i = 0; i < workers; i++) {
    const worker = spawn();
    pool.push(worker);
    listen(worker, ['error', 'messageerror'], (event) => {
      broken ??= new Error(`a training worker stopped: ${eventMessage(event)}`);
    });
    ready.push(
      new Promise<RigShape>((resolve, reject) => {
        // Every listener this adds is taken off once the worker has a body or has failed to get
        // one, so a worker's later life is heard only by the run that is using it.
        const off = (): void => {
          offMessage();
          offError();
        };
        const offMessage = listen(worker, ['message'], (event) => {
          const message = (event as MessageEvent<Outgoing>).data;
          if (message.type === 'ready') {
            off();
            readyCount += 1;
            hooks.onReady?.(readyCount, workers);
            resolve(message);
          } else if (message.type === 'failed') {
            off();
            reject(new Error(message.error));
          }
        });
        const offError = listen(worker, ['error', 'messageerror'], (event) => {
          off();
          reject(new Error(`a training worker could not build its body: ${eventMessage(event)}`));
        });
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
      return new Promise<void>((resolve, reject) => {
        if (broken) {
          reject(broken);
          return;
        }
        if (tasks.length === 0) {
          resolve();
          return;
        }
        let next = 0;
        let done = 0;
        let settled = false;
        /** The episode each worker is running, so a worker that stops can be said to have stopped in it. */
        const running = new Map<EpisodeWorker, EpisodeTask>();
        /** This run's listeners, and only these, so settling never takes off anyone else's. */
        const detach: (() => void)[] = [];
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          for (const off of detach) off();
          if (error) {
            broken ??= error;
            reject(error);
          } else {
            resolve();
          }
        };
        /** The episode a worker was on, in the words every failure uses. */
        const episode = (worker: EpisodeWorker, id?: number): string => {
          const task = id === undefined ? running.get(worker) : tasks.find((t) => t.id === id);
          if (task) return `episode ${task.id} (seed ${task.seed})`;
          return id === undefined ? 'an episode' : `episode ${id}`;
        };
        const feed = (worker: EpisodeWorker): void => {
          if (next >= tasks.length) {
            running.delete(worker);
            return;
          }
          const task = tasks[next++] as EpisodeTask;
          running.set(worker, task);
          worker.postMessage({
            type: 'evaluate',
            id: task.id,
            weights: task.weights,
            seed: task.seed,
          });
        };
        for (const worker of pool) {
          detach.push(
            listen(worker, ['message'], (event) => {
              if (settled) return;
              const message = (event as MessageEvent<Outgoing>).data;
              if (message.type === 'failed') {
                finish(new Error(`${episode(worker, message.id)} failed: ${message.error}`));
                return;
              }
              if (message.type !== 'result') return;
              onResult({ id: message.id, fitness: message.fitness, alive: message.alive });
              done += 1;
              if (done === tasks.length) finish();
              else feed(worker);
            }),
          );
          // A worker that stopped, or whose answer could not be read: the episode it held will
          // never be answered, and there is no scoring it as a bad one, because the body it was
          // being scored on is gone.
          detach.push(
            listen(worker, ['error', 'messageerror'], (event) => {
              finish(
                new Error(
                  `${episode(worker)} failed: a training worker stopped: ${eventMessage(event)}`,
                ),
              );
            }),
          );
          feed(worker);
        }
      });
    },
    dispose(): void {
      broken ??= new Error('the training pool has been disposed');
      for (const w of pool) w.terminate();
    },
  };
}
