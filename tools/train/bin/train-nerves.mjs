#!/usr/bin/env node
/**
 * Train the nerves to stand.
 *
 *   pnpm train:nerves                              # defaults below; Ctrl-C keeps the best so far
 *   pnpm train:nerves --generations 400 --population 32 --workers 16 --seconds 6
 *   pnpm train:nerves --resume                     # continue from the saved policy
 *
 * Evolution strategies over the policy's weights, every candidate scored on its own copy of the
 * simulation in a worker thread. The best policy so far is written to
 * `packages/modules-nerves/policies/<task>.json` whenever it improves, and a line a generation
 * goes to `tools/train/runs/<task>-<started>.jsonl`.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createJiti } from 'jiti';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const jiti = createJiti(import.meta.url);
const { OpenAiEs } = await jiti.import(join(ROOT, 'tools/train/src/es.ts'));
const { MlpPolicy } = await jiti.import(join(ROOT, 'packages/modules-nerves/src/index.ts'));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const task = flag('task', 'stand');
const generations = Number(flag('generations', 300));
const population = Number(flag('population', 32));
const workers = Number(flag('workers', Math.max(1, Math.min(cpus().length, 16))));
const seconds = Number(flag('seconds', 6));
const seedsPerCandidate = Number(flag('seeds', 2));
const sigma = Number(flag('sigma', 0.05));
const learningRate = Number(flag('lr', 0.02));
const hidden = flag('hidden', '32,32').split(',').map(Number);
const profileId = flag('profile', 'l1_standard');
const authority = Number(flag('authority', 0.3));
const resume = args.includes('--resume');
const out = flag('out', join(ROOT, 'packages/modules-nerves/policies', `${task}.json`));
const runsDir = join(ROOT, 'tools/train/runs');
mkdirSync(runsDir, { recursive: true });
const started = new Date();
const log = join(runsDir, `${task}-${started.toISOString().replace(/[:.]/g, '-')}.jsonl`);
// What the dashboard draws: every generation so far, and where things stand.
const latest = join(runsDir, `${task}-latest.json`);
// The search's own centre, every generation, so a restart continues the search rather than
// starting again from the last policy that beat the best.
const centrePath = join(runsDir, `${task}-centre.json`);
const series = [];
const publishLatest = (best, episodes, shape) => {
  writeFileSync(
    latest,
    JSON.stringify({
      task,
      started: started.toISOString(),
      updated: new Date().toISOString(),
      population,
      seeds: seedsPerCandidate,
      seconds,
      workers,
      sizes: shape.sizes,
      parameters: shape.parameterCount,
      episodes,
      best: { fitness: best.fitness, alive: best.alive, generation: best.generation },
      series,
    }),
  );
};

const options = {
  profileId,
  hidden,
  seconds,
  controlDivisor: 5,
  authority,
  clip: task === 'stand' ? 'quiet-standing' : task === 'walk' ? 'walk-normal' : 'quiet-standing',
};

console.log(
  `training ${task}: ${generations} generations, population ${population} x ${seedsPerCandidate} seeds, ` +
    `${seconds} s episodes on ${profileId}, ${workers} workers`,
);
const pool = [];
const ready = [];
for (let i = 0; i < workers; i++) {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { options } });
  pool.push(worker);
  ready.push(
    new Promise((resolve, reject) => {
      worker.once('message', (m) =>
        m.type === 'ready' ? resolve(m) : reject(new Error(String(m))),
      );
      worker.once('error', reject);
    }),
  );
}
const shapes = await Promise.all(ready);
const shape = shapes[0];
console.log(
  `  policy ${shape.sizes.join(' x ')}: ${shape.parameterCount} weights; ${shape.inputNames.length} senses, ${shape.outputNames.length} drives`,
);

let initial;
let startGeneration = 0;
if (resume && existsSync(centrePath)) {
  try {
    const centre = JSON.parse(readFileSync(centrePath, 'utf8'));
    if (centre.task === task && centre.sizes.join('x') === shape.sizes.join('x')) {
      initial = MlpPolicy.fromFile(centre).weights;
      startGeneration = centre.trained?.generations ?? 0;
      console.log(`  resuming the search from ${centrePath} at generation ${startGeneration}`);
    }
  } catch {
    // A half-written centre: fall back to the saved policy below.
  }
}
if (!initial && resume && existsSync(out)) {
  const file = JSON.parse(readFileSync(out, 'utf8'));
  if (file.sizes.join('x') === shape.sizes.join('x')) {
    initial = MlpPolicy.fromFile(file).weights;
    startGeneration = file.trained?.generations ?? 0;
    console.log(
      `  resuming from ${out} at generation ${startGeneration}, fitness ${file.trained?.fitness?.toFixed(3)}`,
    );
  } else {
    console.log(`  ${out} has a different shape; starting afresh`);
  }
}
if (!initial) {
  let s = 12345;
  const random = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  initial = MlpPolicy.random(shape.sizes, random).weights;
}

const es = new OpenAiEs(
  {
    dimension: shape.parameterCount,
    population,
    sigma,
    learningRate,
    weightDecay: 0.001,
    seed: 42 + startGeneration,
  },
  initial,
);

/**
 * Score every candidate, spread over the pool, one episode a task -- `candidates x seeds` of
 * them -- so the threads stay busy to the last episode of the generation; resolves with the mean
 * fitness and alive time per candidate.
 */
function evaluate(candidates, generation) {
  return new Promise((resolve) => {
    const tasks = [];
    candidates.forEach((weights, c) => {
      for (let k = 0; k < seedsPerCandidate; k++) {
        tasks.push({ candidate: c, weights, seed: 1000 * generation + 7 * c + k });
      }
    });
    const fitness = new Array(candidates.length).fill(0);
    const alive = new Array(candidates.length).fill(0);
    let next = 0;
    let done = 0;
    const feed = (worker) => {
      if (next >= tasks.length) return;
      const id = next++;
      const task = tasks[id];
      worker.postMessage({ type: 'evaluate', id, weights: task.weights, seed: task.seed });
    };
    for (const worker of pool) {
      worker.on('message', function onResult(m) {
        if (m.type !== 'result') return;
        const task = tasks[m.id];
        fitness[task.candidate] += m.fitness / seedsPerCandidate;
        alive[task.candidate] += m.alive / seedsPerCandidate;
        done += 1;
        if (done === tasks.length) {
          for (const w of pool) w.removeAllListeners('message');
          resolve({ fitness, alive });
        } else {
          feed(worker);
        }
      });
      feed(worker);
    }
  });
}

let best = { fitness: Number.NEGATIVE_INFINITY, weights: null, generation: 0, alive: 0 };
if (resume && existsSync(latest)) {
  try {
    const previous = JSON.parse(readFileSync(latest, 'utf8'));
    if (previous.task === task && Array.isArray(previous.series)) series.push(...previous.series);
    if (previous.best && initial) best = { ...previous.best, weights: Float32Array.from(initial) };
  } catch {
    // A half-written file: start the chart afresh.
  }
}
const save = (fitness, generation, alive, episodes) => {
  const policy = new MlpPolicy(shape.sizes, best.weights);
  const file = policy.toFile({
    task,
    inputs: shape.inputNames,
    outputs: shape.outputNames,
    trained: { generations: generation, fitness, episodes, at: new Date().toISOString() },
  });
  writeFileSync(out, `${JSON.stringify(file)}\n`);
};

let episodes = 0;
const stop = () => {
  console.log(
    `\nstopping; best fitness ${best.fitness.toFixed(3)} (${best.alive.toFixed(2)} s up) from generation ${best.generation}, saved to ${out}`,
  );
  for (const w of pool) w.terminate();
  process.exit(0);
};
process.on('SIGINT', stop);

for (let g = startGeneration + 1; g <= startGeneration + generations; g++) {
  const t0 = performance.now();
  const candidates = es.ask();
  const { fitness, alive } = await evaluate(candidates, g);
  episodes += candidates.length * seedsPerCandidate;
  es.tell(fitness);
  // The centre of the distribution is what gets saved; score it on fresh seeds now and then.
  const mean = fitness.reduce((a, b) => a + b, 0) / fitness.length;
  const top = Math.max(...fitness);
  const topAlive = alive[fitness.indexOf(top)];
  const seconds = (performance.now() - t0) / 1000;
  const line = { generation: g, mean, top, topAlive, seconds };
  appendFileSync(log, `${JSON.stringify(line)}\n`);
  series.push([g, Number(mean.toFixed(4)), Number(top.toFixed(4)), Number(topAlive.toFixed(3))]);
  let improved = '';
  if (g % 5 === 0 || g === startGeneration + 1) {
    const centre = await evaluate([Float32Array.from(es.theta)], -g);
    const centreFitness = centre.fitness[0];
    if (centreFitness > best.fitness) {
      best = {
        fitness: centreFitness,
        weights: Float32Array.from(es.theta),
        generation: g,
        alive: centre.alive[0],
      };
      save(centreFitness, g, centre.alive[0], episodes);
      improved = `  saved (centre ${centreFitness.toFixed(3)}, ${centre.alive[0].toFixed(2)} s up)`;
    }
  }
  console.log(
    `  gen ${String(g).padStart(4)}  mean ${mean.toFixed(3)}  top ${top.toFixed(3)} (${topAlive.toFixed(2)} s up)  ${seconds.toFixed(1)} s${improved}`,
  );
  publishLatest(best, episodes, shape);
  writeFileSync(
    centrePath,
    `${JSON.stringify(
      new MlpPolicy(shape.sizes, Float32Array.from(es.theta)).toFile({
        task,
        inputs: shape.inputNames,
        outputs: shape.outputNames,
        trained: { generations: g, fitness: mean, episodes, at: new Date().toISOString() },
      }),
    )}\n`,
  );
}
stop();
