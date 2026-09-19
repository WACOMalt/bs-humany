import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// One rig, one thread: built once, then episodes on demand.
import { parentPort, workerData } from 'node:worker_threads';
import { createJiti } from 'jiti';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const jiti = createJiti(import.meta.url);
const { StandRig } = await jiti.import(join(ROOT, 'tools/train/src/rig.ts'));

const rig = await StandRig.build(workerData.options);
parentPort.postMessage({
  type: 'ready',
  sizes: rig.sizes,
  parameterCount: rig.parameterCount,
  inputNames: rig.inputNames,
  outputNames: rig.outputNames,
});
// One episode a message: the finest grain there is, so no thread sits idle at the end of a
// generation waiting on another's last long episode.
parentPort.on('message', (message) => {
  if (message.type !== 'evaluate') return;
  const result = rig.episode(message.weights, message.seed);
  parentPort.postMessage({
    type: 'result',
    id: message.id,
    fitness: result.fitness,
    alive: result.aliveSeconds,
  });
});
