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
      });
    } catch (error) {
      self.postMessage({ type: 'failed', error: String(error) });
    }
    return;
  }
  if (message.type === 'evaluate' && rig) {
    const result = rig.episode(message.weights, message.seed);
    self.postMessage({
      type: 'result',
      id: message.id,
      fitness: result.fitness,
      alive: result.aliveSeconds,
    });
  }
};
