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
 * the data directory -- `~/.local/share/bs-humany/policies/<name>.json` on Linux, and the
 * equivalent elsewhere -- whenever it improves, and a line a generation goes to
 * `<data>/runs/<name>-<started>.jsonl`. `pnpm train:where` prints the paths.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createJiti } from 'jiti';
import { runsDir as runsHome, seedFromRepository } from './home.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const jiti = createJiti(import.meta.url);
const { OpenAiEs } = await jiti.import(join(ROOT, 'tools/train/src/es.ts'));
const { rigOptionsFor, defaultRecipe, DEFAULT_REFLEX } = await jiti.import(
  join(ROOT, 'tools/train/src/rig.ts'),
);
const { train } = await jiti.import(join(ROOT, 'tools/train/src/trainer.ts'));

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
// The noise, overridable from the command line whichever way the recipe arrived: a run that
// wants a silent body for a comparison says `--noise 0 --sense-noise 0`.
if (flag('noise', undefined) !== undefined || flag('sense-noise', undefined) !== undefined) {
  recipe.noise = {
    motor: Number(flag('noise', recipe.noise?.motor ?? 0.05)),
    sense: Number(flag('sense-noise', recipe.noise?.sense ?? 0.01)),
    tau: Number(flag('noise-tau', recipe.noise?.tau ?? 0.25)),
  };
}
// The cord under the brain and the memory in it, overridable the same way. `--reflex 0` is the
// body every checkpoint before the spinal module was trained in: no stretch reflex at all.
if (
  flag('reflex', undefined) !== undefined ||
  flag('reflex-velocity', undefined) !== undefined ||
  flag('reflex-delay', undefined) !== undefined ||
  flag('reflex-inhibition', undefined) !== undefined ||
  flag('reflex-setpoint', undefined) !== undefined
) {
  const base = recipe.reflex ?? DEFAULT_REFLEX;
  recipe.reflex = {
    stretch: Number(flag('reflex', base.stretch)),
    velocity: Number(flag('reflex-velocity', base.velocity)),
    setPoint: Number(flag('reflex-setpoint', base.setPoint)),
    inhibition: Number(flag('reflex-inhibition', base.inhibition)),
    forceCeiling: Number(flag('reflex-ceiling', base.forceCeiling)),
    forceInhibition: Number(flag('reflex-force-inhibition', base.forceInhibition)),
    delaySeconds: Number(flag('reflex-delay', base.delaySeconds)),
  };
}
if (flag('memory', undefined) !== undefined) recipe.memory = Number(flag('memory', 0));
if (flag('authority', undefined) !== undefined) {
  recipe.authority = Number(flag('authority', recipe.authority));
}

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
// The data directory the operating system means for this, shared with the studio binary, so a
// checkpoint trained here is one the studio can hand over and the other way about. The ones
// that ship with the repository are copied in once, on a machine that has none of its own.
const POLICIES = seedFromRepository(join(ROOT, 'packages/modules-nerves/policies'));
const out = flag('out', join(POLICIES, `${name}.json`));
const runsDir = runsHome();
const started = new Date();
const log = join(runsDir, `${name}-${started.toISOString().replace(/[:.]/g, '-')}.jsonl`);
// What the dashboard draws: every generation so far, and where things stand.
const latest = join(runsDir, `${name}-latest.json`);
// The search's own centre, every generation, so a restart continues the search rather than
// starting again from the last policy that beat the best.
const centrePath = join(runsDir, `${name}-centre.json`);
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
console.log(
  `  noise: tremor ${(recipe.noise?.motor ?? 0.05).toFixed(3)} over ${(recipe.noise?.tau ?? 0.25).toFixed(2)}s, ` +
    `senses ${(recipe.noise?.sense ?? 0.01).toFixed(3)}`,
);
const cord = recipe.reflex;
console.log(
  cord && cord.stretch > 0
    ? `  cord: stretch ${cord.stretch.toFixed(3)}, damping ${cord.velocity.toFixed(2)}, ` +
        `set point ${cord.setPoint.toFixed(2)}, inhibition ${cord.inhibition.toFixed(2)}, ` +
        `${(cord.delaySeconds * 1000).toFixed(0)} ms down and back`
    : '  cord: no reflexes; the brain is the only thing holding the body up',
);
console.log(
  recipe.memory
    ? `  memory: ${recipe.memory} context units carried between control steps`
    : '  memory: none; the policy answers the instant it is shown and nothing else',
);
/**
 * The pool, in Node: one worker thread a core, each with its own rig. The search does not know
 * that -- it asks for episodes and gets scores back -- so the same search runs in a window with
 * web workers behind the same three methods.
 */
const threads = [];
const ready = [];
for (let i = 0; i < workers; i++) {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { options } });
  threads.push(worker);
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
  `  ${shape.stepsPerSecond} steps a second, the policy every ${shape.controlDivisor} of them`,
);
console.log(
  `  policy ${shape.sizes.join(' x ')}: ${shape.parameterCount} weights; ${shape.inputNames.length} senses, ${shape.outputNames.length} drives`,
);

const pool = {
  shape,
  run(tasks, onResult) {
    return new Promise((resolve) => {
      if (tasks.length === 0) {
        resolve();
        return;
      }
      let next = 0;
      let done = 0;
      const feed = (worker) => {
        if (next >= tasks.length) return;
        const task = tasks[next++];
        worker.postMessage({
          type: 'evaluate',
          id: task.id,
          weights: task.weights,
          seed: task.seed,
        });
      };
      for (const worker of threads) {
        worker.on('message', function onMessage(m) {
          if (m.type !== 'result') return;
          onResult({ id: m.id, fitness: m.fitness, alive: m.alive });
          done += 1;
          if (done === tasks.length) {
            for (const w of threads) w.removeAllListeners('message');
            resolve();
          } else {
            feed(worker);
          }
        });
        feed(worker);
      }
    });
  },
  dispose() {
    for (const w of threads) w.terminate();
  },
};

/** The store, in Node: three files beside the checkpoint, and a line a generation appended. */
const store = {
  async read(kind) {
    const path = kind === 'policy' ? out : kind === 'centre' ? centrePath : latest;
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // A half-written file is no file: the search starts that part afresh.
      return undefined;
    }
  },
  async write(kind, value) {
    const path = kind === 'policy' ? out : kind === 'centre' ? centrePath : latest;
    writeFileSync(path, `${JSON.stringify(value)}\n`);
  },
  async appendLog(line) {
    appendFileSync(log, `${JSON.stringify(line)}\n`);
  },
};

// The first interrupt asks the search to stop at the end of the generation it is in, so the
// centre and the record are written and the run is resumable. A generation is seconds, which is
// a long time to watch a button do nothing, so the second interrupt goes at once -- and the
// dashboard's own escalation is the third line, for a trainer that has wedged.
let stopping = false;
process.on('SIGINT', () => {
  if (stopping) {
    console.log('\nstopping now; the generation in progress is lost');
    pool.dispose();
    process.exit(130);
  }
  stopping = true;
  console.log('\nstopping at the end of this generation; interrupt again to stop now');
});

const result = await train({
  recipe,
  pool,
  store,
  generations,
  population,
  seedsPerCandidate,
  seconds,
  workers,
  sigma,
  learningRate,
  hidden,
  resume,
  now: () => performance.now(),
  rss: () => Math.round(process.memoryUsage().rss / 1048576),
  stopped: () => stopping,
  onNote: (text) => console.log(text),
  onGeneration: (r) => {
    console.log(
      `  gen ${String(r.generation).padStart(4)}  mean ${r.mean.toFixed(3)}  ` +
        `top ${r.top.toFixed(3)} (${r.topAlive.toFixed(2)} s up)  ` +
        `${r.seconds.toFixed(1)} s  ${r.rssMb} MB${r.note}`,
    );
  },
});
console.log(
  `\nstopping; best fitness ${result.fitness.toFixed(3)} (${result.alive.toFixed(2)} s up) ` +
    `from generation ${result.generation}, saved to ${out}`,
);
pool.dispose();
process.exit(0);
