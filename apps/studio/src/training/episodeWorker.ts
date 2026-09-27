/**
 * One rig in a web worker: the browser's answer to `tools/train/bin/worker.mjs`.
 *
 * The rig is pure workspace code -- it imports a compiler, a kernel, a MuJoCo built to
 * WebAssembly and nothing of Node -- so the same class that scores episodes in a worker thread
 * scores them here, in a window, with no second process anywhere. That is what lets training
 * live inside the one binary.
 *
 * Built once on the first message, then an episode a message, because the finest grain there is
 * keeps every worker busy to the last episode of a generation.
 */

import { type RigOptions, StandRig } from '@bs-humany/train/rig';

type Incoming =
  | { readonly type: 'build'; readonly options: RigOptions }
  | {
      readonly type: 'evaluate';
      readonly id: number;
      readonly weights: Float32Array;
      readonly seed: number;
    };

let rig: StandRig | undefined;

self.onmessage = async (event: MessageEvent<Incoming>): Promise<void> => {
  const message = event.data;
  if (message.type === 'build') {
    try {
      rig = await StandRig.build(message.options);
      self.postMessage({
        type: 'ready',
        sizes: rig.sizes,
        parameterCount: rig.parameterCount,
        inputNames: rig.inputNames,
        outputNames: rig.outputNames,
        stepsPerSecond: rig.stepsPerSecond,
        controlDivisor: rig.controlDivisor,
        // What the body is, for every checkpoint this run writes to carry: see `RigShape.body`.
        body: rig.body,
      });
    } catch (error) {
      self.postMessage({
        type: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (message.type !== 'evaluate') return;
  // Every episode is answered, with a score or with why there is none. This handler is async, so
  // a throw from it is not an 'error' on the Worker the pool holds: it is a rejected promise
  // nobody awaits, which the browser logs in the worker's console and the pool never hears of,
  // and the pool, one answer short, waits for ever. An episode sent before the body is built used
  // to be dropped the same way, without a word.
  if (!rig) {
    self.postMessage({ type: 'failed', id: message.id, error: 'its worker has no body built yet' });
    return;
  }
  let result: ReturnType<StandRig['episode']>;
  try {
    result = rig.episode(message.weights, message.seed);
  } catch (error) {
    // The stack goes to this worker's console, for whoever opens it; the pool gets the sentence.
    console.error(error);
    self.postMessage({
      type: 'failed',
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  self.postMessage({
    type: 'result',
    id: message.id,
    fitness: result.fitness,
    alive: result.aliveSeconds,
  });
};
