/**
 * A stand-in for `tools/train/bin/worker.mjs` that has no body and fails on purpose, for the node
 * pool's tests.
 *
 * It says `ready` with a shape of a few numbers, then answers every episode after a short wait --
 * long enough that the other workers are still busy when one of them fails, which is the case a
 * test has to see: answers arriving after the run has already been refused. The episode `failOn`
 * goes wrong in the way `how` names:
 *
 * - `throw`: the handler throws, and nothing catches it, so the parent hears a worker 'error'.
 * - `report`: it answers `failed` with the episode's id, as the real worker does when a rig throws.
 * - `exit`: the thread ends, with no word at all.
 *
 * `build: 'fail'` refuses to build instead, the way the real worker does for a scenario that does
 * not exist.
 */

import { parentPort, workerData } from 'node:worker_threads';

const { failOn = 3, how = 'throw', build = 'ok', delayMs = 5 } = workerData ?? {};

if (build === 'fail') {
  parentPort.postMessage({ type: 'failed', error: 'No scenario called nowhere' });
} else {
  parentPort.postMessage({
    type: 'ready',
    sizes: [2, 1],
    parameterCount: 3,
    inputNames: ['a', 'b'],
    outputNames: ['c'],
    stepsPerSecond: 100,
    controlDivisor: 1,
  });
  parentPort.on('message', (message) => {
    if (message.type !== 'evaluate') return;
    if (message.id === failOn) {
      if (how === 'throw') throw new Error(`boom in episode ${message.id}`);
      if (how === 'report') {
        parentPort.postMessage({ type: 'failed', id: message.id, error: 'boom', stack: 'at rig' });
        return;
      }
      if (how === 'exit') process.exit(3);
    }
    setTimeout(() => {
      parentPort.postMessage({
        type: 'result',
        id: message.id,
        fitness: -message.id,
        alive: 1,
      });
    }, delayMs);
  });
}
