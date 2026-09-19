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
parentPort.on('message', (message) => {
  if (message.type !== 'evaluate') return;
  const results = message.seeds.map((seed) => rig.episode(message.weights, seed));
  parentPort.postMessage({
    type: 'result',
    id: message.id,
    fitness: results.reduce((a, r) => a + r.fitness, 0) / results.length,
    alive: results.reduce((a, r) => a + r.aliveSeconds, 0) / results.length,
  });
});
