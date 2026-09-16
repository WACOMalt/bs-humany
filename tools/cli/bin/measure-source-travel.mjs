#!/usr/bin/env node
/**
 * How far each muscle travels on the model its parameters came from.
 *
 *   pnpm measure:source-travel          # rewrite packages/muscle-data/src/sourceTravel.ts
 *   pnpm measure:source-travel --check  # fail if the file is not what this would write
 *
 * ## What this is for
 *
 * Optimal fiber length is transcribed from MyoSuite and optimal fiber length is *architecture*:
 * how long the fibers are relative to the distance the muscle has to cover. Carried onto a
 * different skeleton the number stops meaning what it meant, because the distance changed --
 * OQ-020. A muscle whose path travels further here than it did there covers a wider stretch of
 * its own force-length curve with the same fibers, and ends up weak at one end of a range it was
 * fine over in the model it was measured on.
 *
 * So the travel is measured on both skeletons, the same way -- each crossed coordinate swept
 * through its own range with the others at neutral, nine samples, extremes taken -- and what is
 * carried across is the *ratio* the source chose between fiber length and travel, rather than the
 * fiber length itself. `deriveOptimalFiberLength` in `compile.ts` is where that is applied.
 *
 * ## Why the reference model has to be run rather than read
 *
 * A MuJoCo muscle states `lengthrange`, which looks like exactly this measurement and is not. The
 * four vasti share one joint and must travel the same distance; the vendored file gives them 290,
 * 180, 45 and 172 mm. That attribute is a carrier for the derivation of optimal fiber length and
 * tendon slack length (see `readActuators`), not a statement about range of motion, and reading it
 * as one would put a 45 mm excursion and a 290 mm excursion on two halves of the same quadriceps.
 * Measured on the running model the same four come out at 64, 65, 68 and 193 mm -- three vasti
 * that agree and a rectus femoris that crosses the hip as well, which is the answer a quadriceps
 * should give.
 *
 * The models are rebuilt from the vendored fragments by `referenceArm.mjs`, which explains what it
 * drops and why. What is measured here is `ten_length`, which is the quantity those models are
 * definitive about.
 *
 * ## Coupled coordinates, on both sides
 *
 * A shoulder does not elevate with its scapula flat, and both models say so -- ours with joint
 * couplings the compiler emits, MyoSuite's with the joint equalities in its assets file. Neither
 * says so to a sweep that writes coordinates, because an equality is satisfied by the solver
 * during a step and not projected by `mj_forward`. So both sweeps apply their own couplings the
 * same way: a coordinate that follows another is never swept on its own, and sweeping a driver
 * carries its followers. Without that, the reference's phantom girdle joints were being swept as
 * though they were free, and 180 degrees of elevation was being asked of the glenohumeral joint
 * alone on both skeletons.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import {
  ELBOW_TENDONS,
  FOREARM_TENDONS,
  LEG_TENDONS,
  MODELS,
  SHOULDER_TENDONS,
  couplings,
  referenceArmXml,
} from '../../validate-external/src/referenceArm.mjs';
import { ARM, LEGS, readActuators } from '../lib/myoSuite.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/muscle-data/src/sourceTravel.ts');
const REPORT = join(ROOT, 'docs/validation/fiber-lengths.md');
const check = process.argv.includes('--check');

/** Angles sampled across each coordinate's range, ends included. Matches `measure-muscle-ranges`. */
const SAMPLES = 9;
/**
 * How far into a coordinate's range to nudge it when asking whether a tendon crosses it.
 *
 * A twentieth. Far enough that a tendon that crosses the joint moves by much more than the
 * solver's noise, and near enough to neutral that the pose stays one the model is happy in.
 */
const PROBE = 0.05;
/** A length change below this is the solver's own noise, not a joint the tendon crosses. */
const CROSSES = 1e-9;

const mjtJNT_SLIDE = 2;
const mjtJNT_HINGE = 3;

const backendJiti = createJiti(
  new URL('../../../packages/backend-mujoco/src/index.ts', import.meta.url).href,
);
const mujoco = await (await backendJiti.import('@mujoco/mujoco')).default();

/** Every tendon's rest length and travel on one reference model, keyed by the unit it becomes. */
function travelOn(tendons, model) {
  const m = mujoco.MjModel.from_xml_string(referenceArmXml(Object.keys(tendons), model));
  const d = new mujoco.MjData(m);
  const names = [];
  for (let t = 0; t < m.ntendon; t++) {
    names.push(mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_TENDON.value, t));
  }
  const address = m.jnt_qposadr;
  const range = m.jnt_range;
  const type = m.jnt_type;
  const jointId = (name) => mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT.value, name);

  // The model's own couplings, by joint index. A coordinate that follows another is never swept
  // on its own -- it does not move on its own -- and sweeping a driver carries its followers.
  const follows = [];
  const dependent = new Set();
  for (const c of couplings(model)) {
    const to = jointId(c.dependent);
    const from = jointId(c.driver);
    if (to < 0 || from < 0) continue;
    follows.push({ to, from, polycoef: c.polycoef });
    dependent.add(to);
  }
  const follow = (joint, value) => {
    for (const f of follows) {
      if (f.from !== joint) continue;
      let total = 0;
      for (let power = f.polycoef.length - 1; power >= 0; power--) {
        total = total * value + (f.polycoef[power] ?? 0);
      }
      d.qpos[address[f.to]] = total;
    }
  };

  const neutral = Float64Array.from(d.qpos);
  const lengths = () => {
    mujoco.mj_forward(m, d);
    return Array.from(d.ten_length);
  };

  d.qpos.set(neutral);
  const rest = lengths();
  const minimum = [...rest];
  const maximum = [...rest];

  for (let j = 0; j < m.njnt; j++) {
    // Hinges and sliders only. A free or ball joint has no range to sweep, and the models state
    // an unlimited joint's range as an empty interval rather than flagging it.
    if (type[j] !== mjtJNT_HINGE && type[j] !== mjtJNT_SLIDE) continue;
    if (dependent.has(j)) continue;
    const low = range[2 * j];
    const high = range[2 * j + 1];
    if (!(high > low)) continue;

    d.qpos.set(neutral);
    d.qpos[address[j]] = low + (high - low) * PROBE;
    follow(j, low + (high - low) * PROBE);
    const probed = lengths();
    // Only the tendons this joint actually moves: another tendon's length here is its length at
    // neutral, and recording it would be recording nothing.
    const crosses = probed.map((v, t) => Math.abs(v - rest[t]) > CROSSES);
    if (!crosses.some(Boolean)) continue;

    for (let i = 0; i < SAMPLES; i++) {
      d.qpos.set(neutral);
      const value = low + ((high - low) * i) / (SAMPLES - 1);
      d.qpos[address[j]] = value;
      follow(j, value);
      const now = lengths();
      for (let t = 0; t < names.length; t++) {
        if (!crosses[t]) continue;
        if (now[t] < minimum[t]) minimum[t] = now[t];
        if (now[t] > maximum[t]) maximum[t] = now[t];
      }
    }
  }

  const found = new Map();
  for (let t = 0; t < names.length; t++) {
    const unit = tendons[names[t]];
    if (unit === undefined) continue;
    found.set(unit, { rest: rest[t], minimum: minimum[t], maximum: maximum[t] });
  }
  d.delete();
  m.delete();
  return found;
}

const measured = new Map([
  ...travelOn({ ...ELBOW_TENDONS, ...SHOULDER_TENDONS, ...FOREARM_TENDONS }, MODELS.arm),
  ...travelOn(LEG_TENDONS, MODELS.legs),
]);

/** The actuator each tendon belongs to: the reference names them `<actuator>_tendon`. */
const actuatorOf = new Map(
  [
    ...Object.entries(ELBOW_TENDONS),
    ...Object.entries(FOREARM_TENDONS),
    ...Object.entries(SHOULDER_TENDONS),
    ...Object.entries(LEG_TENDONS),
  ].map(([tendon, unit]) => [unit, tendon.replace(/_tendon$/, '')]),
);
const parameters = new Map([...readActuators(ARM), ...readActuators(LEGS)]);

const round = (v) => Number(v.toPrecision(6));
const rows = [...measured]
  .map(([unit, v]) => {
    const p = parameters.get(actuatorOf.get(unit));
    if (p === undefined) {
      throw new Error(`measure-source-travel: no actuator parameters for '${unit}'.`);
    }
    // Where on its own force-length curve the source runs this muscle. MuJoCo's muscle model has
    // no pennation, so the fiber lies along the tendon and there is no cosine to take.
    const normalised = (length) => (length - p.tendonSlackLength) / p.optimalFiberLength;
    return {
      unit,
      travel: round(v.maximum - v.minimum),
      low: round(normalised(v.minimum)),
      high: round(normalised(v.maximum)),
    };
  })
  .sort((a, b) => a.unit.localeCompare(b.unit));

// Both sides carry the same muscle, and the reference models only have a right one.
const sided = rows.flatMap((row) => [row, { ...row, unit: row.unit.replace(/_r$/, '_l') }]);

const body = sided
  .map(
    (r) => `  {
    unit: '${r.unit}',
    travel: ${r.travel},
    low: ${r.low},
    high: ${r.high},
  },`,
  )
  .join('\n');

const rendered = `/**
 * How far each muscle travels on the model its parameters came from, and where that puts it.
 *
 * **Generated by \`pnpm measure:source-travel\`. Do not edit.**
 *
 * Measured by running the vendored MyoSuite models and sweeping each coordinate a tendon crosses
 * through that model's own range, one at a time with the others at neutral -- the same method
 * \`MUSCLE_LENGTH_RANGES\` uses on this skeleton, so the two are comparable.
 *
 * What it is for is optimal fiber length, which is architecture: how long a muscle's fibers are
 * against the distance it has to cover. Transcribed onto different bones that number stops saying
 * what it said, because the distance changed. \`deriveOptimalFiberLength\` carries across the ratio
 * the source chose rather than the length itself -- see OQ-020.
 *
 * \`low\` and \`high\` are where the source runs the muscle on its own force-length curve, in units
 * of its optimal fiber length. They are not used to fit anything; they are here because they are
 * the evidence for whether a unit's parameters and its geometry agree in the model they came
 * from, and several of them plainly do not: the source works its own biceps femoris long head
 * between 0.27 and 1.78 of optimal, which no fiber does.
 *
 * Neither model has a left side. Both sides of ours carry the same muscle, so each row is
 * repeated for the left.
 *
 * Every number here is measured on the vendored MyoSuite models -- the same files, at the same
 * pinned commit, that the parameter sets are extracted from.
 */

import { cite } from '@bs-humany/hsdl';

/** Where these measurements come from: the models, run rather than read. */
export const SOURCE_TRAVEL_SOURCE = cite(
  'caggiano2022',
  '${MODELS.arm.tendon} and ${MODELS.legs.tendon}, tendon lengths swept over the joint ranges ' +
    'stated in ${MODELS.arm.chain} and ${MODELS.legs.chain}',
);

export interface SourceMuscleTravel {
  readonly unit: string;
  /** Metres, on the source's skeleton, over the source's own joint ranges. */
  readonly travel: number;
  /** Shortest the source's fibers get over that travel, in units of its optimal fiber length. */
  readonly low: number;
  /** Longest they get, likewise. */
  readonly high: number;
}

export const SOURCE_MUSCLE_TRAVEL: readonly SourceMuscleTravel[] = [
${body}
];

/** One unit's source travel, or undefined for a unit that came from somewhere else. */
export function sourceMuscleTravel(unit: string): SourceMuscleTravel | undefined {
  return SOURCE_MUSCLE_TRAVEL.find((r) => r.unit === unit);
}
`;

// The other half: what that travel does to each fiber length on this skeleton. Compiled here
// rather than read out of the committed table, so the report cannot describe a previous run.
const jiti = createJiti(import.meta.url);
const { resolveMorphology } = await jiti.import(join(ROOT, 'packages/anthropometry/src/index.ts'));
const { compileArticulation } = await jiti.import(join(ROOT, 'packages/compiler/src/index.ts'));
const { buildDocument } = await jiti.import(join(ROOT, 'packages/skeleton/src/index.ts'));
const muscleData = await jiti.import(join(ROOT, 'packages/muscle-data/src/index.ts'));
const modules = await jiti.import(join(ROOT, 'packages/modules-muscle/src/index.ts'));

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l3_anatomical', morphology);
const compiled = modules.compileMuscleSet(
  [
    ...muscleData.ELBOW_MUSCLES,
    ...muscleData.SHOULDER_MUSCLES,
    ...muscleData.KNEE_MUSCLES,
    ...muscleData.HIP_MUSCLES,
    ...muscleData.ANKLE_MUSCLES,
    ...muscleData.TRUNK_MUSCLES,
    ...muscleData.FOREARM_MUSCLES,
    ...muscleData.TRUNK_MUSCLES,
  ],
  document.attachmentSites,
  articulation,
  morphology.context,
  document.wrappingSurfaces ?? [],
);
const sourceOf = new Map(sided.map((r) => [r.unit, r]));
const translations = compiled.units
  .filter((unit) => sourceOf.has(unit.id))
  .map((unit) => {
    const source = sourceOf.get(unit.id);
    const range = muscleData.muscleLengthRange(unit.id);
    const travel = (range.longest - range.shortest) * unit.restLength;
    const ratio = travel / source.travel;
    const derived = modules.deriveOptimalFiberLength(
      unit.statedOptimalFiberLength,
      travel,
      source.travel,
      unit.restLength,
    );
    return {
      unit: unit.id,
      travel,
      source: source.travel,
      ratio,
      stated: unit.statedOptimalFiberLength,
      derived,
      // What the rule asks for before either cap. A unit that travels less here than there is not
      // capped, it is left alone: the translation only ever lengthens.
      capped: derived < unit.statedOptimalFiberLength * Math.max(1, ratio) - 1e-12,
      restLength: unit.restLength,
      low: source.low,
      high: source.high,
    };
  })
  .sort((a, b) => b.ratio - a.ratio);

const mm = (v) => (v * 1000).toFixed(0);
const capped = translations.filter((t) => t.capped);
const report = `# Fiber lengths, translated to this skeleton

**Generated by \`pnpm measure:source-travel\`. Do not edit.**

Optimal fiber length is transcribed from MyoSuite and is architecture: the length of the fibers
against the distance the muscle has to cover. The distance changed with the bones, so the number
is translated rather than carried -- \`deriveOptimalFiberLength\` scales it by how far the muscle
travels here against how far it travelled there, both measured by sweeping each crossed coordinate
through its own range with the others at neutral. OQ-020 is where this is argued; this is the
guard it asks for.

A ratio near one means the two skeletons agree about that muscle and its fiber length crosses
over unchanged. A ratio far from one is evidence about the *path*, not about the fibers: either
the route is wrong here, or the joint's range is not the range the source gave it. Ratios past
\`TRANSLATION_LIMIT\` are capped, and so is any fiber that would take more than
\`FIBER_SHARE_LIMIT\` of the whole path and leave no room for a tendon. A capped unit is one to go
and look at: both caps bite where our path is longer than the one the parameters were measured on,
which is a statement about the attachments rather than about the muscle.

**${capped.length} of ${translations.length} units are capped.**

| unit | travel here | travel there | ratio | fiber stated | translated | whole path | source's own band |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${translations
  .map(
    (t) =>
      `| ${t.unit}${t.capped ? ' **(capped)**' : ''} | ${mm(t.travel)} mm | ${mm(t.source)} mm | ` +
      `${t.ratio.toFixed(2)} | ${mm(t.stated)} mm | ${mm(t.derived)} mm | ${mm(t.restLength)} mm | ` +
      `${t.low.toFixed(2)} .. ${t.high.toFixed(2)} |`,
  )
  .join('\n')}

The last column is where the source runs each muscle on its own force-length curve over its own
range of motion, in units of optimal fiber length. It fits nothing here. It is the evidence for
whether the source's parameters and the source's geometry agree with each other, and for several
units they plainly do not -- a band from 0.27 to 1.78 is not a fiber's working range in any model,
which is why the placement of the fibers within their band is fitted here (\`fittedTendonSlack\`)
rather than copied from the source along with the width.
`;

const readIf = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

if (check) {
  const stale = [
    readIf(OUT) === rendered ? undefined : relative(ROOT, OUT),
    readIf(REPORT) === report ? undefined : relative(ROOT, REPORT),
  ].filter(Boolean);
  if (stale.length > 0) {
    console.error(
      `measure-source-travel: ${stale.join(' and ')} is not what the measurement would write.\n` +
        '  Run `pnpm measure:source-travel`. If the vendored model changed, say so in the commit.',
    );
    process.exit(1);
  }
  console.log(
    `measure-source-travel: ok. ${sided.length} units match the vendored models, ` +
      `${capped.length} capped.`,
  );
} else {
  writeFileSync(OUT, rendered);
  writeFileSync(REPORT, report);
  console.log(
    `measure-source-travel: wrote ${relative(ROOT, OUT)} and ${relative(ROOT, REPORT)} -- ` +
      `${sided.length} units, ${capped.length} capped.`,
  );
  for (const t of capped) {
    console.log(
      `  capped: ${t.unit} travels ${mm(t.travel)} mm here against ${mm(t.source)} mm there, ` +
        `fiber ${mm(t.stated)} -> ${mm(t.derived)} mm on a ${mm(t.restLength)} mm path`,
    );
  }
}
