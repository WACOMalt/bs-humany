import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// One rig, one thread: built once, then episodes on demand.
import { parentPort, workerData } from 'node:worker_threads';
import { createJiti } from 'jiti';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * What went wrong, as the parent needs it: one line to say, and the stack for whoever has to find
 * it. Anything can be thrown in JavaScript, so a thing that is not an Error is said as it is.
 */
const failure = (error) => ({
  error: error instanceof Error ? error.message : String(error),
  stack: error instanceof Error ? error.stack : undefined,
});

// A body that cannot be built -- a scenario that does not exist, a profile nobody has -- is said
// in a message rather than thrown. Thrown, it reaches the parent as a worker 'error' carrying a
// stack from inside this thread, and the trainer, which can only say one useful thing about it,
// would print that stack instead of the sentence the rig threw.
let rig;
try {
  const jiti = createJiti(import.meta.url);
  const { StandRig } = await jiti.import(join(ROOT, 'tools/train/src/rig.ts'));
  rig = await StandRig.build(workerData.options);
} catch (error) {
  parentPort.postMessage({ type: 'failed', ...failure(error) });
}
if (rig) {
  parentPort.postMessage({
    type: 'ready',
    sizes: rig.sizes,
    parameterCount: rig.parameterCount,
    inputNames: rig.inputNames,
    outputNames: rig.outputNames,
    stepsPerSecond: rig.stepsPerSecond,
    controlDivisor: rig.controlDivisor,
  });
  // One episode a message: the finest grain there is, so no thread sits idle at the end of a
  // generation waiting on another's last long episode.
  parentPort.on('message', (message) => {
    if (message.type !== 'evaluate') return;
    // An episode that throws is answered, not dropped. The parent counts answers to know when a
    // generation is done, so an episode that never answers leaves it waiting for ever -- which is
    // what a throw here used to do, with the trainer, the dashboard and the studio all showing a
    // run that was merely slow. It is not scored as a very bad episode either: a MuJoCo instance
    // that has thrown once is not one to trust with the next, so the run stops and says which.
    let result;
    try {
      result = rig.episode(message.weights, message.seed);
    } catch (error) {
      parentPort.postMessage({ type: 'failed', id: message.id, ...failure(error) });
      return;
    }
    parentPort.postMessage({
      type: 'result',
      id: message.id,
      fitness: result.fitness,
      alive: result.aliveSeconds,
    });
  });
}
