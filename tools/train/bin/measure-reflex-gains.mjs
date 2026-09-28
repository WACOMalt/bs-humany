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
 * clip stand's recipe (`clipStandRecipe`, the "reference stand" before 2026-09-28), so the noise,
 * the clip under the brain and the authority are training's own -- with the cord set to
 * `DEFAULT_REFLEX` and the one number a row is about changed. A rig is built per setting, because
 * the rig settles its body with the cord it was given before it takes the snapshot every episode
 * starts from. "Trained" is the shipped
 * policy, `packages/modules-nerves/policies/balance.json`, fitted to this body by the names of its
 * senses and drives with `MlpPolicy.fit`; "silent" is the same network with every weight zero, so
 * what stands is the body, the clip and the cord. Seconds upright and fitness are the means of
 * `episode` over seeds 1 to `--seeds`.
 *
 * The page's trained rows were measured under `stand.json`, the standing policy that shipped until
 * 2026-09-27, when the owner retired it with the four others for the one default behaviour,
 * balance. Until the page is measured again, once balance has been trained further, this script's
 * trained rows are balance's and the page's are stand's, and the two will not agree; the silent
 * rows do not read a policy's weights and still reproduce.
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
  regions:
    'the stretch gain by region: time upright and tremor, trained and silent, on the default scene',
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
const {
  StandRig,
  DEFAULT_BEHAVIOUR,
  DEFAULT_REFLEX,
  DEFAULT_AUTHORITY,
  NO_REFLEX,
  REFLEX_REGIONS,
  clipStandRecipe,
  rigOptionsFor,
} = await jiti.import(join(ROOT, 'tools/train/src/rig.ts'));
const { MlpPolicy } = await jiti.import(join(ROOT, 'packages/modules-nerves/src/index.ts'));
const { MUSCLE_STATE } = await jiti.import(join(ROOT, 'packages/modules-muscle/src/index.ts'));

const POLICY = JSON.parse(
  readFileSync(join(ROOT, 'packages/modules-nerves/policies/balance.json'), 'utf8'),
);
/**
 * The clip stand, on the body the policy was trained on: "Drop, standing" at 0 m with the
 * quiet-standing activation clip under the brain. It was the "reference stand", which named no
 * scenario, until 2026-09-28; the body is where that put it, so the tables still reproduce.
 */
const RECIPE = clipStandRecipe('stand', 'l3_anatomical', DEFAULT_AUTHORITY);

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
async function withRig(reflex, work, recipe = RECIPE) {
  const rig = await StandRig.build(
    rigOptionsFor({ ...recipe, reflex }, { hidden: POLICY.sizes.slice(1, -1), seconds: SECONDS }),
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
async function upright(reflex, brain, recipe = RECIPE) {
  const key = `${brain} ${recipe.name} ${recipe.scenario} ${JSON.stringify(reflex)}`;
  const known = measured.get(key);
  if (known) return known;
  const result = await withRig(
    reflex,
    (rig) => {
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
    },
    recipe,
  );
  say(`${brain}, ${describeCord(reflex)}: ${result.seconds.toFixed(3)} s upright`);
  measured.set(key, result);
  return result;
}

/** The numbers of a cord that differ from the defaults, for the progress lines. */
function describeCord(reflex) {
  const changed = Object.entries(reflex).filter(
    ([k, v]) => JSON.stringify(DEFAULT_REFLEX[k]) !== JSON.stringify(v),
  );
  return changed.length
    ? changed.map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')
    : 'the default cord';
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

/**
 * The stretch gain region by region: for each region, its gain swept with every other region held
 * at `MIDDLE`, and at each setting the time upright and the region's own tremor, under the shipped
 * policy and silent. Then the rule below picks a gain per region, and a last table sets the cord
 * so chosen beside the cord off and the old one, 8.5 everywhere.
 *
 * Both measures are taken where a person meets them. Time upright is the rig's, on the default
 * behaviour -- "Drop, standing" at 0 m, the body `balance.json` is trained on, with training's
 * tremor, grain and twitch -- over the seeds, as the other tables are. Tremor is the studio's own
 * session (`Simulation`, `packages/session`) on the same scene, with no tremor, grain or twitch in
 * it, because that is what the owner watched shake: silent is the scene as it opens, trained is
 * the same with `balance.json` handed over at the authority it was trained at. The tremor is the
 * root mean square of each joint velocity less its own 0.2 s centred moving average, from 0.5 s
 * to 3 s, over the region's joints (`TREMOR_JOINTS`): what is left once the slow motion of a body
 * settling or going down is taken out is the shaking.
 */
async function regionTables() {
  const MIDDLE = 5;
  const GAINS = [0, 1, 2, 3.5, 5, 6.5, 8.5, 10];
  const cordWith = (stretches, base = MIDDLE) => ({
    ...DEFAULT_REFLEX,
    stretch: base,
    regionStretch: Object.fromEntries(REFLEX_REGIONS.map((r) => [r, stretches[r] ?? base])),
  });
  const uniform = (g) => cordWith({}, g);
  const behaviour = DEFAULT_BEHAVIOUR;
  const rows = [];
  const results = {};
  for (const region of REFLEX_REGIONS) {
    results[region] = [];
    for (const gain of GAINS) {
      const cord = cordWith({ [region]: gain });
      const trained = await upright(cord, 'trained', behaviour);
      const silent = await upright(cord, 'silent', behaviour);
      const shake = await tremor(cord);
      results[region].push({ gain, trained, silent, shake });
      rows.push([
        region,
        String(gain),
        s3(trained.seconds),
        s3(silent.seconds),
        s3(shake.trained[region]),
        s3(shake.silent[region]),
      ]);
    }
  }
  const chosen = {};
  const why = [];
  for (const region of REFLEX_REGIONS) {
    const { gain, reason } = chooseGain(region, results[region]);
    chosen[region] = gain;
    why.push(`- **${region} ${gain}**: ${reason}`);
  }
  const sweep =
    `## The stretch gain by region, ${SEEDS} seeds, others at ${MIDDLE}\n\n` +
    table(
      [
        'region',
        'stretch',
        'trained: seconds upright',
        'silent: seconds upright',
        'trained: tremor rad/s',
        'silent: tremor rad/s',
      ],
      rows,
    );
  const verdict = `## The gains the rule chooses\n\n${why.join('\n')}`;

  const compare = [];
  for (const [label, cord] of [
    ['no cord', { ...NO_REFLEX }],
    ['8.5 everywhere', uniform(8.5)],
    ['by region, as chosen', cordWith(chosen, chosen.Leg)],
  ]) {
    const trained = await upright(cord, 'trained', behaviour);
    const silent = await upright(cord, 'silent', behaviour);
    const shake = await tremor(cord);
    compare.push([
      label,
      s3(trained.seconds),
      s3(silent.seconds),
      ...REFLEX_REGIONS.map((r) => `${s3(shake.trained[r])} / ${s3(shake.silent[r])}`),
    ]);
  }
  const whole =
    '## The cord so chosen, beside none and the old one\n\n' +
    'Tremor in rad/s, trained / silent.\n\n' +
    table(
      ['cord', 'trained: seconds upright', 'silent: seconds upright', ...REFLEX_REGIONS],
      compare,
    );
  return [sweep, verdict, whole];
}

/**
 * The rule: of the gains whose tremor, trained and silent, stays within `TREMOR_ROOM` of the
 * region's tremor with its own cord off, and whose time upright, trained and silent, is within
 * `UPRIGHT_ROOM` of the region's best, take the smallest -- the least cord that holds the body up
 * as well as any does, without shaking it. The smallest for the reason the page gave the stretch
 * before regions, the smallest gain within 1% of the best: where the measure cannot tell gains
 * apart, a stiffer cord is drive nothing asked for. When no gain meets both, tremor wins: of the
 * gains inside the tremor bound, the one that keeps the trained body up longest, the smaller of
 * two that tie.
 */
const TREMOR_ROOM = 0.2;
const UPRIGHT_ROOM = 0.02;
function chooseGain(region, rows) {
  const off = rows.find((r) => r.gain === 0);
  const best = {
    trained: Math.max(...rows.map((r) => r.trained.seconds)),
    silent: Math.max(...rows.map((r) => r.silent.seconds)),
  };
  const calm = rows.filter(
    (r) =>
      r.shake.trained[region] <= (1 + TREMOR_ROOM) * off.shake.trained[region] &&
      r.shake.silent[region] <= (1 + TREMOR_ROOM) * off.shake.silent[region],
  );
  const up = calm.filter(
    (r) =>
      r.trained.seconds >= (1 - UPRIGHT_ROOM) * best.trained &&
      r.silent.seconds >= (1 - UPRIGHT_ROOM) * best.silent,
  );
  const bounds =
    `its tremor with no cord of its own is ${s3(off.shake.trained[region])} trained and ` +
    `${s3(off.shake.silent[region])} silent, and its best time upright ${s3(best.trained)} s ` +
    `trained and ${s3(best.silent)} silent`;
  if (up.length > 0) {
    const pick = up[0];
    return {
      gain: pick.gain,
      reason:
        `the smallest gain within ${TREMOR_ROOM * 100}% of that tremor and ` +
        `${UPRIGHT_ROOM * 100}% of that time upright (${s3(pick.trained.seconds)} s trained, ` +
        `${s3(pick.silent.seconds)} silent); ${bounds}.`,
    };
  }
  const pick = calm.reduce((a, b) => (b.trained.seconds > a.trained.seconds ? b : a), off);
  return {
    gain: pick.gain,
    reason:
      `no gain keeps both. Of those within ${TREMOR_ROOM * 100}% of the tremor with no cord, this ` +
      `one keeps the trained body up longest (${s3(pick.trained.seconds)} s trained, ` +
      `${s3(pick.silent.seconds)} silent); ${bounds}.`,
  };
}

/** Joints whose velocities are a region's tremor, by id, at the reference profile. */
const TREMOR_JOINTS = {
  Arm: /^(sternoclavicular|acromioclavicular|glenohumeral|elbow|radioulnar|wrist)_/,
  Hand: /^(cmc|mcp|ip|pip|dip)_\d/,
  Leg: /^(hip|knee|patellofemoral|talocrural|subtalar|mtp|ip_pedis|pip_pedis|dip_pedis)_/,
  Trunk: /^(l\d_(l\d|s1)|t\d+_(t\d+|l1))$/,
  Neck: /^c\d_(c\d|t1)$/,
};

/** Seconds the tremor is read over, from settling to well into the scene. */
const TREMOR_FROM = 0.5;
const TREMOR_TO = 3;

const session = await jiti.import(join(ROOT, 'packages/session/src/index.ts'));
const { resolveMorphology } = await jiti.import(join(ROOT, 'packages/anthropometry/src/index.ts'));
const { buildDocument } = await jiti.import(join(ROOT, 'packages/skeleton/src/index.ts'));
let skeleton;

/**
 * Each region's tremor on the studio's session, silent and with the policy handed over, for one
 * cord. Measured once per cord, like `upright`.
 */
const shaken = new Map();
async function tremor(reflex) {
  const key = JSON.stringify(reflex);
  const known = shaken.get(key);
  if (known) return known;
  const result = { silent: await tremorRun(reflex, false), trained: await tremorRun(reflex, true) };
  say(
    `tremor, ${describeCord(reflex)}: ${REFLEX_REGIONS.map((r) => `${r} ${s3(result.trained[r])}/${s3(result.silent[r])}`).join(', ')}`,
  );
  shaken.set(key, result);
  return result;
}

async function tremorRun(reflex, trained) {
  skeleton ??= buildDocument();
  const behaviour = DEFAULT_BEHAVIOUR;
  const chosen = session.scenarioDefinition(behaviour.scenario).build({ ...behaviour.parameters });
  const morphology = resolveMorphology(
    session.publisherMorphology({ profile: behaviour.profile }, chosen),
  );
  const sim = new session.Simulation(skeleton, morphology, {
    profileId: behaviour.profile,
    backend: 'mujoco',
    passiveJoints: chosen.passiveJoints,
    redistribute: behaviour.redistribute,
    scenario: chosen,
    dropHeight: chosen.clearance,
    groundHeight: chosen.ground.height,
    muscles: true,
    recordEveryTicks: 0,
    captureBudgetBytes: 0,
    restorePoints: 0,
    reflex,
    ...(trained ? { nerves: { policy: POLICY, authority: behaviour.authority, goal: 0 } } : {}),
  });
  try {
    await sim.start();
    const model = sim.articulation;
    const dofs = {};
    for (const [region, re] of Object.entries(TREMOR_JOINTS)) {
      // Past the six of the free root: `qdot` holds the root's first.
      dofs[region] = model.dofs
        .filter((d) => re.test(model.joints[d.joint].id))
        .map((d) => 6 + d.index);
    }
    const rate = sim.stepsPerSecond;
    const from = Math.round(TREMOR_FROM * rate);
    const to = Math.round(TREMOR_TO * rate);
    const series = [];
    for (let t = 0; t < to; t++) {
      sim.tick();
      if (t >= from) series.push(sim.jointState().qdot);
    }
    const half = Math.round(0.1 * rate);
    const out = {};
    for (const [region, list] of Object.entries(dofs)) {
      let sum = 0;
      let count = 0;
      for (const i of list) {
        // A running sum over the centred window, so each joint is one pass and not one per tick.
        let window = 0;
        for (let k = 0; k <= 2 * half && k < series.length; k++) window += series[k][i];
        for (let t = half; t < series.length - half; t++) {
          if (t > half) window += series[t + half][i] - series[t - half - 1][i];
          const shake = series[t][i] - window / (2 * half + 1);
          sum += shake * shake;
          count += 1;
        }
      }
      out[region] = count ? Math.sqrt(sum / count) : 0;
    }
    return out;
  } finally {
    sim.dispose();
  }
}

// Last, because the region tables' constants and the session it loads are declared above.
if (tables.includes('regions')) {
  out.push(...(await regionTables()));
}

console.log(out.join('\n\n'));
