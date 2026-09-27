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
 *
 * A run that cannot go on stops and says why, with a non-zero exit, rather than waiting: a body
 * that cannot be built is named in a line, and an episode that throws or a worker that dies ends
 * the run with the episode and its seed, and the worker's stack under them. Everything up to the
 * last finished generation is kept, so `--resume` carries on from there once it is fixed.
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { REFLEX_FLAGS, formatHelp, parse, trainFlags } from './flags.mjs';
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

// The recipe module: every default, limit and rule a recipe is held to, in one place the
// dashboard and the studio read too. It loads nothing that runs -- no MuJoCo, no kernel -- so it
// is here before the flags are read, and a refused run is still refused at once.
const jiti = createJiti(import.meta.url);
const RECIPE = await jiti.import(join(ROOT, 'tools/train/src/recipe.ts'));
const { rigOptionsFor, defaultRecipe, checkRecipe, reflexWithFlags, DEFAULT_NOISE, NO_REFLEX } =
  RECIPE;
const TRAIN_FLAGS = trainFlags(RECIPE);

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
 * or the reference stand the flags describe. The task and the body the flags name have already
 * been held to the recipe module's lists by the table, so the reference stand is never asked for
 * a task it does not have.
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
  // The same rules the dashboard's recipes and the studio's are read by, all of them said at once.
  const wrong = checkRecipe(recipe);
  if (wrong.length) refuse(`${flags.recipe} is not a recipe:\n  ${wrong.join('\n  ')}`);
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
    recipe = defaultRecipe(flags.task, flags.profile, flags.authority);
    if (fromPolicy.found || fromCentre.found) {
      say('  the saved checkpoint records no recipe; resuming under the reference stand');
    }
    cordSource = 'default';
  }
} else {
  recipe = defaultRecipe(flags.task, flags.profile, flags.authority);
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
 * changes that one number of the recipe's cord, and a recipe without a cord has none -- the rule
 * is `reflexWithFlags` in the recipe module, the same one the rig reads a recipe by, rather than a
 * copy of it here that could come to disagree.
 */
if (given.has('reflex') || Object.keys(REFLEX_FLAGS).some((f) => given.has(f))) {
  const fields = {};
  if (typeof flags.reflex === 'number') fields.stretch = flags.reflex;
  for (const [flag, field] of Object.entries(REFLEX_FLAGS)) {
    if (given.has(flag)) fields[field] = flags[flag];
  }
  const preset = typeof flags.reflex === 'string' ? flags.reflex : undefined;
  const cord = reflexWithFlags(recipe.reflex, { ...fields, ...(preset ? { preset } : {}) });
  recipe.reflex = cord.levels;
  cordSource = cord.source;
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
// The search and the pool, loaded only for a run that is going to happen: the search brings the
// policy's maths with it, and nothing refused above needs it.
const { train, describeResult, formatRemaining } = await jiti.import(
  join(ROOT, 'tools/train/src/trainer.ts'),
);
const { createNodePool } = await jiti.import(join(ROOT, 'tools/train/src/nodePool.ts'));

/** An error in one line, as everything this script says about one is. */
const said = (error) => (error instanceof Error ? error.message : String(error));

// One worker thread a core, each with its own rig. A body that cannot be built -- a scenario that
// is not there, a clip nobody has -- is said in a line and the run ends, rather than a stack from
// the top of this script: it is the recipe's to fix, not the trainer's, and nothing of the run has
// been written yet.
let pool;
try {
  pool = await createNodePool(new URL('./worker.mjs', import.meta.url), { options }, workers);
} catch (error) {
  refuse(`could not build the body to train: ${said(error)}`);
}
const shape = pool.shape;
console.log(
  `  ${shape.stepsPerSecond} steps a second, the policy every ${shape.controlDivisor} of them`,
);
console.log(
  `  policy ${shape.sizes.join(' x ')}: ${shape.parameterCount} weights; ${shape.inputNames.length} senses, ${shape.outputNames.length} drives`,
);

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
  // anything else the search cannot go on from, and so does an episode that failed in a worker --
  // the pool names it and its seed, so it can be run again on its own. Either way the workers are
  // let go, and what was kept is what the last finished generation wrote. An episode's failure
  // carries the worker's stack, which is where somebody has to look next, so it is printed under
  // the line; nothing else here has one worth reading.
  console.error(`train-nerves: training failed: ${said(error)}`);
  if (error instanceof Error && typeof error.cause === 'string') {
    console.error(error.cause.replace(/^/gm, '    '));
  }
  pool.dispose();
  process.exit(1);
}
console.log(
  `\nstopping; ${describeResult(result)}${result.generation > 0 ? `, saved to ${out}` : ''}`,
);
pool.dispose();
process.exit(0);
