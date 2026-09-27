/**
 * The pool, in Node: one worker thread a core, each with its own rig, behind the three methods the
 * search wants. The search does not know it is here -- it asks for episodes and gets scores back
 * -- so the same search runs in a window with web workers behind the same three methods
 * (`apps/studio/src/training/pool.ts`), and the two keep the same rules.
 *
 * The rule this file exists for is that a run which cannot finish says so. The pool counts answers
 * to know when a generation is done, and it used to listen for nothing but answers: an episode
 * that threw, or a thread that died, left it one answer short for ever, and the trainer, the
 * dashboard drawing it and the person watching the dashboard all waited on a run that had stopped.
 * Now every way a worker can go -- an episode it reports as failed, an exception nobody caught, a
 * thread that exits -- ends the generation with an error that names the episode it was running.
 */

import { Worker } from 'node:worker_threads';
import type { EpisodePool, EpisodeResult, EpisodeTask, RigShape } from './trainer.js';

/** What a worker says back: its body is built, an episode's score, or that something failed. */
type Outgoing =
  | ({ readonly type: 'ready' } & RigShape)
  | {
      readonly type: 'failed';
      /** The episode it was running; absent when it failed building its body. */
      readonly id?: number;
      readonly error: string;
      readonly stack?: string;
    }
  | {
      readonly type: 'result';
      readonly id: number;
      readonly fitness: number;
      readonly alive: number;
    };

/** An Error whose message is one line, with the worker's own stack kept as its cause. */
function failure(message: string, stack: string | undefined): Error {
  return stack === undefined ? new Error(message) : new Error(message, { cause: stack });
}

/**
 * Wait for one worker to build its body. Every listener this adds is taken off again once it
 * has, so a worker's later life is heard only by the run that is using it.
 */
function whenReady(worker: Worker, index: number): Promise<RigShape> {
  return new Promise<RigShape>((resolve, reject) => {
    const off = (): void => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const onMessage = (message: Outgoing): void => {
      if (message.type === 'ready') {
        off();
        resolve(message);
      } else if (message.type === 'failed') {
        off();
        reject(failure(message.error, message.stack));
      }
    };
    const onError = (error: Error): void => {
      off();
      reject(error);
    };
    const onExit = (code: number): void => {
      off();
      reject(
        new Error(`training worker ${index} exited with code ${code} before its body was built`),
      );
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
}

/**
 * Start `count` worker threads from `workerUrl`, each given `workerData`, and wait for every one
 * to have a body. Rejects, with every thread let go, if any of them cannot: a generation scored by
 * three workers out of four is not a thing the search can be handed.
 *
 * The worker's side of the conversation is `tools/train/bin/worker.mjs`: `ready` with the rig's
 * shape once, then for every `evaluate` either a `result` or a `failed` carrying the episode's id.
 */
export async function createNodePool(
  workerUrl: URL,
  workerData: unknown,
  count: number,
): Promise<EpisodePool> {
  const threads: Worker[] = [];
  for (let i = 0; i < count; i++) threads.push(new Worker(workerUrl, { workerData }));
  /**
   * Why the pool can no longer be trusted, once it cannot. A thread can die between two
   * generations, when no run is listening, and the next run would hand it an episode it will never
   * answer; so every thread is watched for as long as the pool lives, and a run on a pool that has
   * lost one refuses at once. So does a run after an episode failed, because the rig that threw is
   * still the rig that thread would score its next episode on. Watched from the moment it is
   * started, too: an 'error' that nothing listens for is thrown again in this thread, and takes the
   * trainer down with a stack instead of a sentence.
   */
  let broken: Error | undefined;
  for (const [i, worker] of threads.entries()) {
    worker.on('error', (error) => {
      broken ??= new Error(`training worker ${i} stopped: ${error.message}`);
    });
    worker.on('exit', (code) => {
      broken ??= new Error(`training worker ${i} exited with code ${code}`);
    });
  }

  let shape: RigShape;
  try {
    const shapes = await Promise.all(threads.map((worker, i) => whenReady(worker, i)));
    shape = shapes[0] as RigShape;
  } catch (error) {
    for (const worker of threads) void worker.terminate();
    throw error;
  }

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
        /** The episode each worker is running, so a worker that dies can be said to have died in it. */
        const running = new Map<Worker, EpisodeTask>();
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
        const episode = (worker: Worker, id?: number): string => {
          const task = id === undefined ? running.get(worker) : tasks.find((t) => t.id === id);
          if (task) return `episode ${task.id} (seed ${task.seed})`;
          return id === undefined ? 'an episode' : `episode ${id}`;
        };
        const feed = (worker: Worker): void => {
          if (next >= tasks.length) {
            running.delete(worker);
            return;
          }
          const task = tasks[next++] as EpisodeTask;
          running.set(worker, task);
          // One episode a message, as it always was: the finest grain there is, so no thread sits
          // idle at the end of a generation waiting on another's last long episode.
          worker.postMessage({
            type: 'evaluate',
            id: task.id,
            weights: task.weights,
            seed: task.seed,
          });
        };
        for (const worker of threads) {
          const onMessage = (message: Outgoing): void => {
            if (settled) return;
            if (message.type === 'failed') {
              finish(
                failure(`${episode(worker, message.id)} failed: ${message.error}`, message.stack),
              );
              return;
            }
            if (message.type !== 'result') return;
            onResult({ id: message.id, fitness: message.fitness, alive: message.alive });
            done += 1;
            if (done === tasks.length) finish();
            else feed(worker);
          };
          // An exception the worker did not catch, and a thread that stopped. Either way the
          // episode it held will never be answered; there is no scoring it as a bad one, because
          // the body it was scored on is gone, and a rebuilt one would be another run.
          const onError = (error: Error): void => {
            finish(
              new Error(`${episode(worker)} failed: ${error.message}`, { cause: error.stack }),
            );
          };
          const onExit = (code: number): void => {
            finish(new Error(`${episode(worker)} failed: its worker exited with code ${code}`));
          };
          worker.on('message', onMessage);
          worker.on('error', onError);
          worker.on('exit', onExit);
          detach.push(() => {
            worker.off('message', onMessage);
            worker.off('error', onError);
            worker.off('exit', onExit);
          });
          feed(worker);
        }
      });
    },
    dispose(): void {
      broken ??= new Error('the training pool has been disposed');
      for (const worker of threads) void worker.terminate();
    },
  };
}
