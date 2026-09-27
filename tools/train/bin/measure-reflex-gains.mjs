#!/usr/bin/env node
/**
 * What the cord's gains are worth, measured: the tables of `docs/validation/reflex-gains.md`.
 *
 *   pnpm measure:reflex-gains                          # every table, eight seeds; about twenty minutes
 *   pnpm measure:reflex-gains --tables stretch         # one table, or several: stretch,damper
 *   pnpm measure:reflex-gains --seeds 2 --tables afferent,golgi   # a quick look
 *   pnpm measure:reflex-gains --help
 *
 * None of the spinal module's seven numbers is trained. The search is over the policy's weights,
 * and the cord is part of the body those weights are searched against, fixed for the whole run.
 * So the gains are chosen by measurement, and the page that chooses them is only as good as the
 * measurement is repeatable. It was first made with probes in the git-ignored `tools/train/runs`,
 * which nobody else had; this is the measurement, tracked, and it prints the page's tables.
 *
 * Every number is a `StandRig` -- the trainer's own body, built by `rigOptionsFor` from the
 * reference stand's recipe, so the noise, the clip under the brain and the authority are
 * training's own -- with the cord set to `DEFAULT_REFLEX` and the one number a row is about
 * changed. A rig is built per setting, because the rig settles its body with the cord it was given
 * before it takes the snapshot every episode starts from. "Trained" is the committed standing
 * policy, `packages/modules-nerves/policies/stand.json`, fitted to this body by the names of its
 * senses and drives with `MlpPolicy.fit`; "silent" is the same network with every weight zero, so
 * what stands is the body, the clip and the cord. Seconds upright and fitness are the means of
 * `episode` over seeds 1 to `--seeds`.
 *
 * It prints to stdout and writes nothing -- no file in the repository and nothing in the data
 * directory -- so the working tree is as it was after it has run. Progress goes to stderr.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { formatHelp, parse } from './flags.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The tables, in the page's order, and what each one is. */
const TABLES = {
  afferent:
    'the length afferent as the body presents it, and how many muscles are past each set point',
  setpoint: 'time upright across the set point, silent',
  stretch: 'the stretch gain, trained and silent',
  damper: 'the velocity gain, trained and silent',
  inhibition: 'reciprocal inhibition, silent',
  golgi: 'tendon force in a collapse, and the Golgi ceiling on and off',
};

const FLAGS = [
  {
    name: 'tables',
    kind: 'string',
    default: Object.keys(TABLES).join(','),
    help: `which tables, separated by commas: ${Object.keys(TABLES).join(', ')}`,
  },
  { name: 'seeds', kind: 'posint', default: 8, help: 'episodes a setting is averaged over' },
  { name: 'seconds', kind: 'positive', default: 6, help: 'the length of an episode, s' },
  { name: 'help', kind: 'bool', help: 'this' },
];

const { values: flags, errors, unknown } = parse(process.argv.slice(2), FLAGS);
if (unknown.length > 0) errors.push(`no such option: ${unknown.map((n) => `--${n}`).join(', ')}`);
const tables = String(flags.tables)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
for (const t of tables)
  if (!(t in TABLES))
    errors.push(`no table '${t}'; the tables are ${Object.keys(TABLES).join(', ')}`);
if (errors.length > 0) {
  console.error(`measure-reflex-gains: ${errors.join('\n  ')}`);
  process.exit(1);
}
if (flags.help) {
  const list = Object.entries(TABLES)
    .map(([name, what]) => `  ${name.padEnd(11)}${what}`)
    .join('\n');
  console.log(
    formatHelp(
      FLAGS,
      `measure-reflex-gains: the tables of docs/validation/reflex-gains.md\n\n${list}`,
    ),
  );
  process.exit(0);
}
const SEEDS = flags.seeds;
const SECONDS = flags.seconds;

const jiti = createJiti(import.meta.url);
const { StandRig, DEFAULT_REFLEX, DEFAULT_AUTHORITY, NO_REFLEX, defaultRecipe, rigOptionsFor } =
  await jiti.import(join(ROOT, 'tools/train/src/rig.ts'));
const { MlpPolicy } = await jiti.import(join(ROOT, 'packages/modules-nerves/src/index.ts'));
const { MUSCLE_STATE } = await jiti.import(join(ROOT, 'packages/modules-muscle/src/index.ts'));

const POLICY = JSON.parse(
  readFileSync(join(ROOT, 'packages/modules-nerves/policies/stand.json'), 'utf8'),
);
/** The reference stand the trainer runs without a recipe, on the body the policy was trained on. */
const RECIPE = defaultRecipe('stand', 'l3_anatomical', DEFAULT_AUTHORITY);

/**
 * The cord every row starts from, trained and silent: the defaults with the damper at a half.
 *
 * The page's gains were measured with the damper at 0.5, before a quarter was chosen as the
 * default from the damper's own table, and a stretch of 3 for the silent body's rows. Kept as the
 * page states them, so this reproduces the page rather than a set of rows the page does not have.
 */
const MEASURED_DAMPER = 0.5;
const SILENT_STRETCH = 3;
const trainedCord = (change = {}) => ({ ...DEFAULT_REFLEX, velocity: MEASURED_DAMPER, ...change });
const silentCord = (change = {}) => trainedCord({ stretch: SILENT_STRETCH, ...change });

const say = (text) => console.error(`  ${text}`);

/** A rig for one cord, and what to do with it; disposed however the work ends. */
async function withRig(reflex, work) {
  const rig = await StandRig.build(
    rigOptionsFor({ ...RECIPE, reflex }, { hidden: POLICY.sizes.slice(1, -1), seconds: SECONDS }),
  );
  try {
    return await work(rig);
  } finally {
    rig.dispose();
  }
}

/**
 * Mean seconds upright and fitness over the seeds, for one brain -- `trained` or `silent` -- on
 * one cord. Each is measured once, so a row two tables share, such as the trained body at stretch
 * 3 with the damper at a half, is the same number in both.
 */
const measured = new Map();
async function upright(reflex, brain) {
  const key = `${brain} ${JSON.stringify(reflex)}`;
  const known = measured.get(key);
  if (known) return known;
  const result = await withRig(reflex, (rig) => {
    const weights =
      brain === 'trained'
        ? MlpPolicy.fit(POLICY, rig.inputNames, rig.outputNames).policy.weights
        : new Float32Array(rig.parameterCount);
    let seconds = 0;
    let fitness = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const run = rig.episode(weights, seed);
      seconds += run.aliveSeconds;
      fitness += run.fitness;
    }
    return { seconds: seconds / SEEDS, fitness: fitness / SEEDS };
  });
  say(`${brain}, ${describeCord(reflex)}: ${result.seconds.toFixed(3)} s upright`);
  measured.set(key, result);
  return result;
}

/** The numbers of a cord that differ from the defaults, for the progress lines. */
function describeCord(reflex) {
  const changed = Object.entries(reflex).filter(([k, v]) => DEFAULT_REFLEX[k] !== v);
  return changed.length ? changed.map(([k, v]) => `${k} ${v}`).join(', ') : 'the default cord';
}

/** The value `p` of the way up a list, taken at the index below. */
function percentile(values, p) {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(p * (sorted.length - 1))];
}

/** The largest of a list, by a loop: a collapse's tendon forces are too many to spread. */
function largest(values) {
  let most = Number.NEGATIVE_INFINITY;
  for (const v of values) if (v > most) most = v;
  return most;
}

const table = (head, rows) =>
  [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
const s3 = (v) => v.toFixed(3);

/**
 * The silent body falling with no cord at all, read as the cord would read it: every unit's fibre
 * length less one, the strain, on the first tick and three seconds in; and every unit's tendon
 * force over its maximum isometric force, on every tick of the fall.
 *
 * No cord, so that what is read is the body and not a reflex's answer to it. The strain is read
 * straight off `muscle.state`, which the rig does not publish because nothing but a probe wants
 * it; the tendon force is the rig's own `muscleTension`.
 */
let collapse;
async function fall() {
  if (collapse) return collapse;
  collapse = await withRig(NO_REFLEX, (rig) => {
    // The rig keeps its kernel to itself; this is a measurement, not a consumer of the rig.
    const fibre = rig.kernel.channels.storage(MUSCLE_STATE).fields.fiberLength;
    const strain = () => Array.from(fibre, (v) => v - 1);
    rig.begin(new Float32Array(rig.parameterCount), 1);
    rig.tick();
    const standing = strain();
    const ticks = Math.round(SECONDS * rig.stepsPerSecond);
    const at = Math.round(3 * rig.stepsPerSecond);
    const units = standing.length;
    const tension = new Float64Array(ticks * units);
    tension.set(rig.muscleTension(), 0);
    let falling;
    for (let t = 1; t < ticks; t++) {
      rig.tick();
      tension.set(rig.muscleTension(), t * units);
      if (t === at) falling = strain();
    }
    return { standing, falling: falling ?? strain(), tension };
  });
  return collapse;
}

const out = [];

if (tables.includes('afferent')) {
  const { standing, falling } = await fall();
  const row = (label, s) => [
    label,
    ...[0.05, 0.5, 0.95].map((p) => s3(percentile(s, p))),
    s3(largest(s)),
  ];
  out.push(
    `## The length afferent, fibre length less one, over every unit (${standing.length})\n\n` +
      table(
        ['', 'p05', 'p50', 'p95', 'max'],
        [
          row('standing, the first moment', standing),
          row('three seconds into a collapse', falling),
        ],
      ),
  );
  const past = (s, point) => s.filter((v) => v - point > 0).length;
  out.push(
    `## Muscles past the set point, of ${standing.length}\n\n` +
      table(
        ['set point', 'standing still', 'falling'],
        [-0.1, -0.05, 0, 0.05].map((point) => [
          point > 0 ? `+${point.toFixed(2)}` : point.toFixed(2),
          String(past(standing, point)),
          String(past(falling, point)),
        ]),
      ),
  );
}

if (tables.includes('setpoint')) {
  const rows = [];
  for (const setPoint of [-0.06, -0.02, 0, 0.02]) {
    rows.push([String(setPoint), s3((await upright(silentCord({ setPoint }), 'silent')).seconds)]);
  }
  out.push(
    `## Time upright across the set point, silent, stretch ${SILENT_STRETCH}\n\n` +
      table(['set point', 'seconds upright'], rows),
  );
}

if (tables.includes('stretch')) {
  const rows = [];
  // Past 5 in half steps to 10: on the cord per side and per unit, time upright was still rising
  // at 5, the top of the first sweep, so the default waited for a sweep that found the peak.
  const gains = [0, 2, 2.5, 3];
  for (let g = 3.5; g <= 10; g += 0.5) gains.push(g);
  for (const stretch of gains) {
    // No cord at all is stretch and damper both off: the body every checkpoint before the spinal
    // module was trained in.
    const cord =
      stretch === 0 ? trainedCord({ stretch: 0, velocity: 0 }) : trainedCord({ stretch });
    const trained = await upright(cord, 'trained');
    const silent = await upright(cord, 'silent');
    rows.push([
      stretch === 0 ? '0 (no cord)' : String(stretch),
      s3(trained.seconds),
      s3(trained.fitness),
      s3(silent.seconds),
    ]);
  }
  out.push(
    `## The gains, ${SEEDS} seeds, ${SECONDS} s episodes, damper ${MEASURED_DAMPER}\n\n` +
      table(['stretch', 'seconds upright', 'fitness', 'silent: seconds upright'], rows),
  );
}

if (tables.includes('damper')) {
  // The trained body is compared at the page's two settings only; past them the silent body's
  // ringing is the whole story, and a trained run there would cost minutes to say the same.
  const rows = [];
  for (const velocity of [0, 0.5, 2, 4, 8]) {
    const cord = silentCord({ velocity });
    const trained = velocity <= MEASURED_DAMPER ? s3((await upright(cord, 'trained')).seconds) : '';
    rows.push([String(velocity), trained, s3((await upright(cord, 'silent')).seconds)]);
  }
  out.push(
    `## The damper, at stretch ${SILENT_STRETCH}\n\n` +
      table(['velocity gain', 'trained: seconds upright', 'silent: seconds upright'], rows),
  );
}

if (tables.includes('inhibition')) {
  const rows = [];
  for (const inhibition of [0, 0.3, 0.8, 1, 1.5, 3]) {
    const { seconds } = await upright(silentCord({ inhibition }), 'silent');
    rows.push([inhibition.toFixed(2), s3(seconds)]);
  }
  out.push(
    `## Reciprocal inhibition, silent, stretch ${SILENT_STRETCH}\n\n` +
      table(['inhibition', 'seconds upright'], rows),
  );
}

if (tables.includes('golgi')) {
  const { tension } = await fall();
  // Off is nothing taken back past the ceiling, so the Ib term cannot fire whatever the force.
  const rows = [];
  for (const [label, change] of [
    ['on', {}],
    ['off', { forceInhibition: 0 }],
  ]) {
    rows.push([
      label,
      s3((await upright(trainedCord(change), 'trained')).seconds),
      s3((await upright(silentCord(change), 'silent')).seconds),
    ]);
  }
  out.push(
    `## The Golgi ceiling, of ${DEFAULT_REFLEX.forceCeiling}\n\n` +
      'Tendon force over maximum isometric force, every unit on every tick of the collapse: ' +
      `p95 ${s3(percentile(tension, 0.95))}, max ${s3(largest(tension))}.\n\n` +
      table(
        [
          'Golgi',
          `trained, stretch ${DEFAULT_REFLEX.stretch}: seconds upright`,
          `silent, stretch ${SILENT_STRETCH}: seconds upright`,
        ],
        rows,
      ),
  );
}

console.log(out.join('\n\n'));
