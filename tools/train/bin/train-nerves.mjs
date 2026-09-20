#!/usr/bin/env node
/**
 * Train the nerves to stand.
 *
 *   pnpm train:nerves                              # defaults below; Ctrl-C keeps the best so far
 *   pnpm train:nerves --generations 400 --population 32 --workers 16 --seconds 6
 *   pnpm train:nerves --resume                     # continue from the saved policy
 *   pnpm train:nerves --profile l1_standard        # a coarser body; L3, the reference, is the default
 *   pnpm train:nerves --recipe tools/train/runs/my-stand-recipe.json   # the studio's way
 *
 * A recipe names the checkpoint and says what it is trained in: the scenario and its parameter
 * values, the body, whether the joints resist, and what plays under the brain -- nothing, the
 * scenario's own muscle script, or an activation clip. The dashboard writes one from the
 * studio's Brain tab; without one, the flags describe the reference body standing on the ground
 * with the quiet-standing clip under it, saved as `<task>.json`. The recipe is written into the
 * policy file, so a checkpoint says how to set the studio up before it is handed the body.
 *
 * A resumed policy is fitted to the body by the names of its senses and drives, so a search
 * begun on a coarser profile carries on at a finer one: what it learned stays, the senses the
 * finer body adds start from nothing.
 *
 * Evolution strategies over the policy's weights, every candidate scored on its own copy of the
 * simulation in a worker thread. The best policy so far is written to
 * `packages/modules-nerves/policies/<name>.json` whenever it improves, and a line a generation
 * goes to `tools/train/runs/<name>-<started>.jsonl`.
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
const { rigOptionsFor, defaultRecipe } = await jiti.import(join(ROOT, 'tools/train/src/rig.ts'));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const recipePath = flag('recipe', undefined);
/** What is trained, in what: from the recipe file, or the reference stand the flags describe. */
const recipe = recipePath
  ? JSON.parse(readFileSync(recipePath, 'utf8'))
  : defaultRecipe(
      flag('task', 'stand'),
      flag('profile', 'l3_anatomical'),
      Number(flag('authority', 0.3)),
    );
const task = recipe.task;
const name = recipe.name;
const generations = Number(flag('generations', 300));
const population = Number(flag('population', 32));
const workers = Number(flag('workers', Math.max(1, Math.min(cpus().length, 16))));
const seconds = Number(flag('seconds', 6));
const seedsPerCandidate = Number(flag('seeds', 2));
const sigma = Number(flag('sigma', 0.03));
const learningRate = Number(flag('lr', 0.005));
const hidden = flag('hidden', '32,32').split(',').map(Number);
const profileId = recipe.profile;
const resume = args.includes('--resume');
const out = flag('out', join(ROOT, 'packages/modules-nerves/policies', `${name}.json`));
const runsDir = join(ROOT, 'tools/train/runs');
mkdirSync(runsDir, { recursive: true });
const started = new Date();
const log = join(runsDir, `${name}-${started.toISOString().replace(/[:.]/g, '-')}.jsonl`);
// What the dashboard draws: every generation so far, and where things stand.
const latest = join(runsDir, `${name}-latest.json`);
// The search's own centre, every generation, so a restart continues the search rather than
// starting again from the last policy that beat the best.
const centrePath = join(runsDir, `${name}-centre.json`);
const series = [];
const publishLatest = (best, episodes, shape) => {
  writeFileSync(
    latest,
    JSON.stringify({
      task,
      name,
      recipe,
      started: started.toISOString(),
      updated: new Date().toISOString(),
      population,
      seeds: seedsPerCandidate,
      seconds,
      workers,
      profile: profileId,
      sizes: shape.sizes,
      parameters: shape.parameterCount,
      episodes,
      best: { fitness: best.fitness, alive: best.alive, generation: best.generation },
      series,
    }),
  );
};

const options = rigOptionsFor(recipe, { hidden, seconds });

const under =
  recipe.feedforward.kind === 'clip'
    ? `the ${recipe.feedforward.clip} clip`
    : recipe.feedforward.kind === 'script'
      ? "the scenario's script"
      : 'nothing';
console.log(
  `training ${name} (${task}): ${generations} generations, population ${population} x ${seedsPerCandidate} seeds, ` +
    `${seconds} s episodes on ${profileId}, ${workers} workers`,
);
console.log(
  `  in ${recipe.scenario || 'the reference stand'}${
    Object.keys(recipe.parameters ?? {}).length ? ` ${JSON.stringify(recipe.parameters)}` : ''
  }, ${under} under the brain, authority ${recipe.authority}`,
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
// The timescale the rig settled on, into the recipe the checkpoint carries: a run that plays it
// at another step rate or evaluates it at another divisor is not what it was trained in.
recipe.stepsPerSecond = shape.stepsPerSecond;
recipe.controlDivisor = shape.controlDivisor;
console.log(
  `  ${shape.stepsPerSecond} steps a second, the policy every ${shape.controlDivisor} of them`,
);
console.log(
  `  policy ${shape.sizes.join(' x ')}: ${shape.parameterCount} weights; ${shape.inputNames.length} senses, ${shape.outputNames.length} drives`,
);

let initial;
let startGeneration = 0;
/** Whether the resumed file was this very body's, so its record still stands. */
let sameBody = false;
const names = { inputs: shape.inputNames, outputs: shape.outputNames };
/** The file's weights fitted to this body by name, or undefined when its hidden layers differ. */
const fitted = (file, from) => {
  if (file.task !== task) return undefined;
  if (file.sizes.slice(1, -1).join('x') !== hidden.join('x')) {
    console.log(
      `  ${from} has hidden layers ${file.sizes.slice(1, -1).join('x')}, not ${hidden.join('x')}; starting afresh`,
    );
    return undefined;
  }
  const { policy, carried } = MlpPolicy.fit(file, names.inputs, names.outputs);
  sameBody =
    carried.inputs === names.inputs.length && file.sizes.join('x') === shape.sizes.join('x');
  console.log(
    `  resuming from ${from} at generation ${file.trained?.generations ?? 0}` +
      (sameBody
        ? ''
        : `, fitted from ${file.profile ?? 'another body'}: ${carried.inputs} of ${names.inputs.length} senses and ${carried.outputs} of ${names.outputs.length} drives carried`),
  );
  return policy.weights;
};
if (resume && existsSync(centrePath)) {
  try {
    initial = fitted(JSON.parse(readFileSync(centrePath, 'utf8')), centrePath);
    if (initial)
      startGeneration = JSON.parse(readFileSync(centrePath, 'utf8')).trained?.generations ?? 0;
  } catch {
    // A half-written centre: fall back to the saved policy below.
  }
}
if (!initial && resume && existsSync(out)) {
  const file = JSON.parse(readFileSync(out, 'utf8'));
  initial = fitted(file, out);
  if (initial) startGeneration = file.trained?.generations ?? 0;
}
if (!initial) {
  let s = 12345;
  const random = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  initial = MlpPolicy.random(shape.sizes, random).weights;
}

const search = (from, seed) =>
  new OpenAiEs(
    { dimension: shape.parameterCount, population, sigma, learningRate, weightDecay: 0.001, seed },
    from,
  );
let es = search(initial, 42 + startGeneration);
/** Centre scores in a row below half the record: a search that has walked off a cliff. */
let slumped = 0;

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
        // A mirrored pair shares its twitches: the search asks which of +epsilon and -epsilon
        // stands better through the same nudge, and a pair nudged differently answers with the
        // difference between the nudges instead, which is noise the step then walks along.
        const pair = generation < 0 ? c : Math.floor(c / 2);
        tasks.push({ candidate: c, weights, seed: 1000 * generation + 7 * pair + k });
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
    // The record carries over only on the same body; a fitted policy starts a new one.
    if (previous.best && initial && sameBody)
      best = { ...previous.best, weights: Float32Array.from(initial) };
  } catch {
    // A half-written file: start the chart afresh.
  }
}
const save = (fitness, generation, alive, episodes) => {
  const policy = new MlpPolicy(shape.sizes, best.weights);
  const file = policy.toFile({
    task,
    profile: profileId,
    inputs: shape.inputNames,
    outputs: shape.outputNames,
    trained: { generations: generation, fitness, episodes, at: new Date().toISOString() },
    recipe,
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
  // Resident memory, in the log and on the line: sixteen rigs in one process is the first thing
  // the out-of-memory killer reaches for, and it leaves no note.
  const rssMb = Math.round(process.memoryUsage().rss / 1048576);
  const line = { generation: g, mean, top, topAlive, seconds, rssMb };
  appendFileSync(log, `${JSON.stringify(line)}\n`);
  series.push([g, Number(mean.toFixed(4)), Number(top.toFixed(4)), Number(topAlive.toFixed(3))]);
  let improved = '';
  if (g % 5 === 0 || g === startGeneration + 1) {
    const centre = await evaluate([Float32Array.from(es.theta)], -g);
    const centreFitness = centre.fitness[0];
    // The step is Adam-normalised, so a noisy estimate still moves at full speed, and a run of
    // them can carry the centre somewhere it cannot stand at all while the record sits behind
    // it. Three checks in a row at less than half the record, and the search restarts from the
    // record with fresh momentum and fresh noise.
    slumped = best.weights && centreFitness < 0.5 * best.fitness ? slumped + 1 : 0;
    if (slumped >= 2) {
      es = search(best.weights, 42 + g);
      slumped = 0;
      improved = `  restarted from the record (centre ${centreFitness.toFixed(3)} against ${best.fitness.toFixed(3)})`;
    } else if (centreFitness > best.fitness) {
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
    `  gen ${String(g).padStart(4)}  mean ${mean.toFixed(3)}  top ${top.toFixed(3)} (${topAlive.toFixed(2)} s up)  ${seconds.toFixed(1)} s  ${rssMb} MB${improved}`,
  );
  publishLatest(best, episodes, shape);
  writeFileSync(
    centrePath,
    `${JSON.stringify(
      new MlpPolicy(shape.sizes, Float32Array.from(es.theta)).toFile({
        task,
        profile: profileId,
        inputs: shape.inputNames,
        outputs: shape.outputNames,
        trained: { generations: g, fitness: mean, episodes, at: new Date().toISOString() },
        recipe,
      }),
    )}\n`,
  );
}
stop();
