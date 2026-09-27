#!/usr/bin/env node
/**
 * Train the nerves to stand.
 *
 *   pnpm train:nerves                              # defaults below; Ctrl-C keeps the best so far
 *   pnpm train:nerves --generations 400 --population 32 --workers 16 --seconds 6
 *   pnpm train:nerves --resume                     # continue the saved checkpoint of this name
 *   pnpm train:nerves --force                      # start a checkpoint that exists afresh
 *   pnpm train:nerves --profile l1_standard        # a coarser body; L3, the reference, is the default
 *   pnpm train:nerves --reflex none                # no cord; `--reflex default` the measured one
 *   pnpm train:nerves --recipe <data>/runs/<name>-recipe.json  # the studio's way
 *   pnpm train:nerves --help                       # every flag, and its default
 *
 * A recipe names the checkpoint and says what it is trained in: the scenario and its parameter
 * values, the body, whether the joints resist, and what plays under the brain -- nothing, the
 * scenario's own muscle script, or an activation clip. The dashboard writes one from the
 * studio's Brain tab, as `<data>/runs/<name>-recipe.json`; without one, the flags describe the
 * reference body standing on the ground with the quiet-standing clip under it, saved as
 * `<task>.json`. To make a run of your own, `--print-recipe > mine.json`, change its "name", and
 * train it with `--recipe mine.json`. The recipe is written into the policy file, so a
 * checkpoint says how to set the studio up before it is handed the body.
 *
 * A plain run refuses to start under the name of a checkpoint that exists: `--resume` continues
 * it, `--force` starts it afresh. A resume without a recipe carries on under the recipe the
 * checkpoint was saved with, so it continues what it was; with one, under that recipe, and the
 * trainer lists every field that differs before it starts. A resumed policy is fitted to the body
 * by the names of its senses and drives, so a search begun on a coarser profile carries on at a
 * finer one (`--resume --profile l3_anatomical`): what it learned stays, the senses the finer
 * body adds start from nothing.
 *
 * Evolution strategies over the policy's weights, every candidate scored on its own copy of the
 * simulation in a worker thread. The best policy so far is written to
 * the data directory -- `~/.local/share/bs-humany/policies/<name>.json` on Linux, and the
 * equivalent elsewhere -- whenever it improves, and a line a generation goes to
 * `<data>/runs/<name>-<started>.jsonl`. `pnpm train:where` prints the paths and the recipes.
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createJiti } from 'jiti';
import { TRAIN_FLAGS, formatHelp, parse } from './flags.mjs';
import { dataHome, runsDir as runsHome, seedFromRepository } from './home.mjs';

// When the dashboard pipes this process and exits first, a write to the closed pipe raises
// EPIPE on the stream, and an unhandled stream error kills the trainer -- before it writes the
// centre of the generation it is in, which is the one thing a stop is supposed to keep. What
// cannot be printed any more is simply not printed.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** Refuse the run with a sentence, before anything has been written or started. */
const refuse = (text) => {
  console.error(`train-nerves: ${text}`);
  process.exit(1);
};

/**
 * Every flag, read once, before anything else happens.
 *
 * A flag nobody reads used to pass silently, and the run went ahead on the default recipe -- which
 * is named `stand` and writes `stand.json`. `--name something-else` therefore looked like it was
 * naming the run and was in fact overwriting the policy of that name with three generations of a
 * fresh one. Recipes are named in their files; the flags cannot rename a run, and say so.
 */
const { values: flags, given, errors, unknown } = parse(process.argv.slice(2), TRAIN_FLAGS);

/** The recipes the dashboard has written, by name; read without making the directory. */
function recipesHere() {
  const dir = join(dataHome(), 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('-recipe.json'))
    .map((f) => f.slice(0, -'-recipe.json'.length))
    .sort();
}

if (unknown.length > 0) {
  const hints = unknown.map((name) =>
    name === 'out'
      ? '  --out is gone: name the run in its recipe (--recipe), or set BS_HUMANY_HOME for a separate data directory'
      : undefined,
  );
  const recipes = recipesHere();
  console.error(
    [
      `train-nerves: no such option${unknown.length > 1 ? 's' : ''}: ${unknown.map((a) => `--${a}`).join(', ')}`,
      ...hints.filter(Boolean),
      `  known options: ${TRAIN_FLAGS.map((f) => `--${f.name}`).join(' ')}`,
      '  a run is named by its recipe, not by a flag; `--recipe <file>` chooses one.',
      recipes.length
        ? `  recipes in ${join(dataHome(), 'runs')}: ${recipes.join(', ')}`
        : '  no recipes written yet; the studio writes them, or make one:',
      '  to name a run of your own: `--print-recipe > mine.json`, change "name" in it, then `--recipe mine.json`',
    ].join('\n'),
  );
  process.exit(1);
}
if (errors.length > 0) refuse(errors.join('\n  '));
if (flags.help) {
  console.log(
    formatHelp(
      TRAIN_FLAGS,
      'train-nerves: evolve a policy for the body, in the recipe given or the reference stand.\n' +
        'A run is named by its recipe; a plain run will not replace a checkpoint that exists.',
    ),
  );
  process.exit(0);
}
if (flags.recipe !== undefined) {
  // A recipe says these; a flag beside it would be one or the other, silently.
  for (const name of ['profile', 'task']) {
    if (given.has(name)) refuse(`--${name} is set by the recipe (${flags.recipe}); edit it there`);
  }
}

const jiti = createJiti(import.meta.url);
const { rigOptionsFor, defaultRecipe, DEFAULT_NOISE, DEFAULT_REFLEX, NO_REFLEX } =
  await jiti.import(join(ROOT, 'tools/train/src/rig.ts'));
const { train, describeResult, formatRemaining } = await jiti.import(
  join(ROOT, 'tools/train/src/trainer.ts'),
);

/** The fields this script reads from a recipe, which a hand-edited one may have lost. */
function recipeProblems(r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return ['it is not an object'];
  const wrong = [];
  if (typeof r.name !== 'string' || !/^[\w.-]+$/.test(r.name)) wrong.push('name');
  if (typeof r.task !== 'string' || r.task === '') wrong.push('task');
  if (typeof r.profile !== 'string' || r.profile === '') wrong.push('profile');
  if (typeof r.feedforward?.kind !== 'string') wrong.push('feedforward');
  if (typeof r.authority !== 'number') wrong.push('authority');
  return wrong.length ? [`${wrong.join(', ')} missing or not what a recipe holds`] : [];
}

/** The reference stand the flags describe, refused in a sentence if the task is not one. */
function reference(task, profile, authority) {
  try {
    return defaultRecipe(task, profile, authority);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
}

/** A policy or centre file's own recipe, when it has one, without the timescale it was run at. */
function savedRecipe(path) {
  if (!existsSync(path)) return { found: false };
  try {
    const { recipe } = JSON.parse(readFileSync(path, 'utf8'));
    if (!recipe) return { found: true };
    const { stepsPerSecond: _s, controlDivisor: _c, ...rest } = recipe;
    return { found: true, recipe: rest };
  } catch {
    return { found: false };
  }
}

/** Notes said while the recipe is settled, kept off stdout when stdout is the recipe. */
const say = (text) => (flags['print-recipe'] ? console.error(text) : console.log(text));

/**
 * What is trained, in what: the recipe file; or, resuming without one, the recipe the checkpoint
 * was saved with, so a resume continues what it was rather than whatever the flags default to;
 * or the reference stand the flags describe.
 */
let recipe;
let cordSource;
if (flags.recipe !== undefined) {
  let text;
  try {
    text = readFileSync(flags.recipe, 'utf8');
  } catch {
    refuse(`no recipe at ${flags.recipe}`);
  }
  try {
    recipe = JSON.parse(text);
  } catch (error) {
    refuse(`${flags.recipe} is not JSON: ${error instanceof Error ? error.message : error}`);
  }
  const wrong = recipeProblems(recipe);
  if (wrong.length) refuse(`${flags.recipe} is not a recipe: ${wrong.join('; ')}`);
  cordSource = 'recipe';
} else if (flags.resume) {
  const name = flags.task;
  const fromPolicy = savedRecipe(join(dataHome(), 'policies', `${name}.json`));
  const fromCentre = fromPolicy.recipe
    ? fromPolicy
    : savedRecipe(join(dataHome(), 'runs', `${name}-centre.json`));
  const saved = fromPolicy.recipe ?? fromCentre.recipe;
  if (saved) {
    recipe = { ...saved };
    // The documented carry-on: a checkpoint begun on a coarser body, continued on a finer one.
    if (given.has('profile')) recipe.profile = flags.profile;
    cordSource = 'checkpoint';
  } else {
    recipe = reference(flags.task, flags.profile, flags.authority);
    if (fromPolicy.found || fromCentre.found) {
      say('  the saved checkpoint records no recipe; resuming under the reference stand');
    }
    cordSource = 'default';
  }
} else {
  recipe = reference(flags.task, flags.profile, flags.authority);
  cordSource = 'default';
}

// The noise, overridable from the command line whichever way the recipe arrived: a run that
// wants a silent body for a comparison says `--noise 0 --sense-noise 0`. Any one of the three
// opens the block, and the other two keep the recipe's.
if (given.has('noise') || given.has('sense-noise') || given.has('noise-tau')) {
  const base = recipe.noise ?? DEFAULT_NOISE;
  recipe.noise = {
    motor: given.has('noise') ? flags.noise : base.motor,
    sense: given.has('sense-noise') ? flags['sense-noise'] : base.sense,
    tau: given.has('noise-tau') ? flags['noise-tau'] : base.tau,
  };
}

/**
 * The cord under the brain, overridable the same way, one flag to one number of it.
 *
 * `--reflex` sets the stretch gain, or names a whole cord: `default` is the measured one, `none`
 * is the body every checkpoint before the spinal module was trained in. Any other cord flag
 * changes that one number of the recipe's cord -- and a recipe without a cord has none, so
 * `--reflex-delay 0.04` on its own used to switch on the measured cord at full gain, which is not
 * what anybody changing a delay asked for.
 */
const REFLEX_FLAGS = {
  'reflex-velocity': 'velocity',
  'reflex-delay': 'delaySeconds',
  'reflex-inhibition': 'inhibition',
  'reflex-setpoint': 'setPoint',
  'reflex-ceiling': 'forceCeiling',
  'reflex-force-inhibition': 'forceInhibition',
};
if (given.has('reflex') || Object.keys(REFLEX_FLAGS).some((f) => given.has(f))) {
  const named =
    flags.reflex === 'default' ? DEFAULT_REFLEX : flags.reflex === 'none' ? NO_REFLEX : undefined;
  const cord = { ...(named ?? recipe.reflex ?? NO_REFLEX) };
  if (typeof flags.reflex === 'number') cord.stretch = flags.reflex;
  for (const [flag, field] of Object.entries(REFLEX_FLAGS)) {
    if (given.has(flag)) cord[field] = flags[flag];
  }
  recipe.reflex = cord;
  cordSource = named ? `${flags.reflex}, with flags` : `${cordSource}, with flags`;
}
if (given.has('memory')) recipe.memory = flags.memory;
if (given.has('authority')) recipe.authority = flags.authority;

if (flags['print-recipe']) {
  // Nothing else goes to stdout on this path, so it can be redirected into a file and edited.
  const { stepsPerSecond: _s, controlDivisor: _c, ...printable } = recipe;
  process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
  process.exit(0);
}

const task = recipe.task;
const name = recipe.name;
const generations = flags.generations;
const population = flags.population;
const workers = given.has('workers') ? flags.workers : Math.max(1, Math.min(cpus().length, 16));
const seconds = flags.seconds;
const seedsPerCandidate = flags.seeds;
const sigma = flags.sigma;
const learningRate = flags.lr;
const hidden = flags.hidden;
const profileId = recipe.profile;
const resume = flags.resume === true;
const force = flags.force === true;
// The data directory the operating system means for this, shared with the studio binary, so a
// checkpoint trained here is one the studio can hand over and the other way about. The ones
// that ship with the repository are copied in once, on a machine that has none of its own --
// and only now, after every refusal, so a run that was refused has touched no files.
const POLICIES = seedFromRepository(join(ROOT, 'packages/modules-nerves/policies'));
const out = join(POLICIES, `${name}.json`);
// A name is a checkpoint, and a plain run under one that exists would begin from random weights
// and overwrite it with the first centre that scored anything. The same rule the dashboard keeps.
if (existsSync(out) && !resume && !force) {
  refuse(
    `a checkpoint named ${name} exists at ${out}; pass --resume to continue it, --force to start it afresh, or give a recipe with another name (--recipe <file>).`,
  );
}
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
    `${seconds} s episodes on ${profileId}, ${workers} workers${resume ? ', resuming' : force && existsSync(out) ? ', replacing the checkpoint' : ''}`,
);
console.log(
  `  in ${recipe.scenario || 'the reference stand'}${
    Object.keys(recipe.parameters ?? {}).length ? ` ${JSON.stringify(recipe.parameters)}` : ''
  }, ${under} under the brain, authority ${recipe.authority}`,
);
console.log(
  `  noise: tremor ${(recipe.noise?.motor ?? DEFAULT_NOISE.motor).toFixed(3)} over ${(recipe.noise?.tau ?? DEFAULT_NOISE.tau).toFixed(2)}s, ` +
    `senses ${(recipe.noise?.sense ?? DEFAULT_NOISE.sense).toFixed(3)}`,
);
const cord = recipe.reflex ?? NO_REFLEX;
console.log(
  cord.stretch > 0 || cord.velocity > 0
    ? `  cord (${cordSource}): stretch ${cord.stretch.toFixed(3)}, damping ${cord.velocity.toFixed(2)}, ` +
        `set point ${cord.setPoint.toFixed(2)}, inhibition ${cord.inhibition.toFixed(2)}, ` +
        `${(cord.delaySeconds * 1000).toFixed(0)} ms down and back`
    : `  cord (${cordSource}): no reflexes; the brain is the only thing holding the body up`,
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

let result;
try {
  result = await train({
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
          `${r.seconds.toFixed(1)} s  ${r.rssMb} MB${r.note}` +
          `  ${r.generation}/${r.target}, ~${formatRemaining((r.target - r.generation) * r.secondsPerGeneration)} left`,
      );
    },
  });
} catch (error) {
  // A resume that cannot continue what is saved throws before it writes anything; so does
  // anything else the search cannot go on from. Either way the workers are let go.
  console.error(`train-nerves: training failed: ${error instanceof Error ? error.message : error}`);
  pool.dispose();
  process.exit(1);
}
console.log(
  `\nstopping; ${describeResult(result)}${result.generation > 0 ? `, saved to ${out}` : ''}`,
);
pool.dispose();
process.exit(0);
