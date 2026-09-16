#!/usr/bin/env node
/**
 * Moment arm validation -- ticket N1.9, muscle spec 13.2.
 *
 *   pnpm validate:moment-arms          # write docs/validation/moment-arms.md
 *   pnpm validate:moment-arms --check  # and fail if a discrepancy is not already recorded there
 *
 * "This is the most important test in the module, and it MUST run in continuous integration."
 * The reason is M-ADR-003: muscle force reaches the solver as wrenches at the points the tendon
 * pulls, never as a joint torque, so the moment arm is a *derived diagnostic* that nothing in the
 * simulation reads. That is what makes comparing it worth anything -- a quantity the simulation
 * depends on tells you the model is self-consistent, and one it does not tells you whether the
 * model is right.
 *
 * ## What it is compared against
 *
 * The vendored MyoSuite arm, loaded into MuJoCo and measured (`tools/validate-external/src/
 * referenceArm.mjs`). Not a table of numbers transcribed from a paper: the model this project
 * took its muscle parameters from, run at the same angles, so every number on both sides of the
 * comparison is computed here and can be recomputed by anyone. The reference is an oracle under
 * ADR-009 -- it may be compared against and reported on, and no value is ever copied from it into
 * the model.
 *
 * Published cadaver ranges appear in the report as context only, in the note column, and are not
 * what anything passes or fails on. The reference model is itself fitted to that literature, and
 * comparing against a number nobody here has read would be the kind of claim ADR-009 exists to
 * stop.
 *
 * ## What fails
 *
 * Two things, per muscle spec 13.2:
 *
 *   - A **sign change** where the reference shows none. Hard failure, always: an extensor that
 *     becomes a flexor part-way through the range holds a bent elbow bent.
 *   - A **deviation** past `TOLERANCE` that is not recorded in `RECORDED` below with a written
 *     explanation and the open question it belongs to.
 *
 * The recorded list is not a way to make a failure go away. Each entry names what is wrong, why
 * it is wrong, and what would fix it; the bound in each entry is the deviation as it stands, so
 * a discrepancy that grows fails again.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { ELBOW_TENDONS, loadReferenceArm } from '../../validate-external/src/referenceArm.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const COMMIT = 'eb327acbae0fad12279495040607f5235d962328';
const check = process.argv.includes('--check');

/**
 * How far our arm may sit from the reference's before it has to be explained, metres.
 *
 * Five millimetres. Moment arms at the elbow run from about 8 to 90 mm, published measurements of
 * the same muscle across subjects spread by a centimetre or more, and a model that agreed to
 * closer than five would be being fitted rather than built. It is a bound on the mean deviation
 * across the sweep, and a mean is the right statistic here: a curve that is right everywhere but
 * one end is a different fault from one that is wrong throughout, and the peak column says which.
 */
const TOLERANCE = 0.005;

/**
 * What is known about each muscle, and how far it is allowed to be wrong.
 *
 * `bound` is the mean deviation in metres as measured when the entry was written, plus a little
 * room; an entry with one excuses a difference past `TOLERANCE`, and passing means the fault is no
 * worse than it was rather than that it is acceptable. An entry without a bound excuses nothing --
 * it is context for a row that already agrees.
 */
const RECORDED = [
  {
    unit: 'biceps_brachii_long_r',
    question: 'OQ-015',
    note: 'Agrees through the middle and upper range. The disagreement is at full extension, where ours sits at the trochlea\u2019s radius and the reference passes within a millimetre of the elbow axis -- which would leave a biceps unable to begin flexing from a straight arm, so the difference is not evidence against ours.',
  },
  {
    unit: 'biceps_brachii_short_r',
    question: 'OQ-015',
    note: 'As the long head, and at the same place in the range.',
  },
  {
    unit: 'brachialis_r',
    bound: 0.013,
    question: 'OQ-015',
    note: 'Still close to twice the reference, though putting the markers back on the bone brought it in from 22 mm of mean error to 12 and moved its peak onto the reference\u2019s angle. Its line still passes outside the trochlea cylinder at every angle, so the surface it declares does nothing for it; what it needs is an attachment over the coronoid rather than a point 40 mm from the flexion axis.',
  },
  {
    unit: 'brachioradialis_r',
    bound: 0.016,
    question: 'OQ-015',
    note: 'Was a fifth of the reference and the largest error in the set, and the wrap surface was blamed for it. That was wrong: the reference\u2019s surface here is a 15 mm cylinder against our 12.4 mm trochlea, which cannot be worth 70 mm of moment arm. It was the origin. The lateral supracondylar ridge runs the lower third of the humerus and the dataset marks it once, near its bottom, 32 mm above the elbow; brachioradialis arises from its upper two-thirds, which `ridgeAttachments.ts` measures at 65 mm up. That took the peak arm from 18 mm to 64 and the mean error from 42.6 to 14.7. What is left is a path that still hugs the joint more than the reference\u2019s at full flexion, where ours peaks at 110 degrees and falls to 27 mm by 130 while the reference is still climbing.',
  },
  {
    unit: 'triceps_brachii_long_r',
    bound: 0.008,
    question: 'OQ-015',
    note: 'Flat at 15 mm where the reference runs from 24 down to 8, and both halves of that are the same cause: our extensor pulley is coaxial with the joint, which by construction gives a constant arm, and the reference\u2019s cylinder is offset behind it, which gives one that falls as the elbow closes. The size is the attachment: the triceps inserts on the olecranon, and the point the marker projects to stands 15 mm from the flexion axis where the bone\u2019s own posterior apex stands 25. A surface at the olecranon was measured (25.1 mm) and does not help, because an attachment inside a wrap surface cannot wrap it.',
  },
  {
    unit: 'triceps_brachii_lateral_r',
    bound: 0.008,
    question: 'OQ-015',
    note: 'As the long head, and from the same attachment.',
  },
  {
    unit: 'triceps_brachii_medial_r',
    bound: 0.008,
    question: 'OQ-015',
    note: 'As the long head, and from the same attachment.',
  },
];

// --- Ours ---------------------------------------------------------------------------------------

const jiti = createJiti(import.meta.url);
const { resolveMorphology } = await jiti.import(join(ROOT, 'packages/anthropometry/src/index.ts'));
const { MujocoBackend } = await jiti.import(join(ROOT, 'packages/backend-mujoco/src/index.ts'));
const { compileArticulation } = await jiti.import(join(ROOT, 'packages/compiler/src/index.ts'));
const { ELBOW_MUSCLES } = await jiti.import(join(ROOT, 'packages/muscle-data/src/index.ts'));
const { buildDocument } = await jiti.import(join(ROOT, 'packages/skeleton/src/index.ts'));
const { compileMuscleSet, degreeRange, sweepMomentArms } = await jiti.import(
  join(ROOT, 'packages/modules-muscle/src/index.ts'),
);

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l3_anatomical', morphology);
const muscles = compileMuscleSet(
  ELBOW_MUSCLES,
  document.attachmentSites,
  articulation,
  morphology.context,
  document.wrappingSurfaces ?? [],
);

/** The sweep: the elbow's own range, at ten-degree steps, forearm neutral. */
const FROM = 0;
const TO = 130;
const STEP = 10;
const angles = degreeRange(FROM, TO, STEP);

const sweep = await sweepMomentArms({
  articulation,
  muscles,
  backend: () => new MujocoBackend(),
  jointId: 'elbow_r',
  axisName: 'flexion',
  angles,
  hold: [{ jointId: 'radioulnar_r', axisName: 'pronation', value: 0 }],
});

// --- Theirs -------------------------------------------------------------------------------------

// MuJoCo resolves from the package that depends on it rather than from here, which is why this
// import goes through a jiti rooted there. The alternative is a root dependency on a backend,
// which is exactly the coupling the backend package exists to avoid.
const backendJiti = createJiti(
  new URL('../../../packages/backend-mujoco/src/index.ts', import.meta.url).href,
);
const loadMujoco = (await backendJiti.import('@mujoco/mujoco')).default;
const mujoco = await loadMujoco();
const reference = loadReferenceArm(mujoco);
const referenceArms = new Map();
for (const name of Object.keys(ELBOW_TENDONS)) referenceArms.set(name, []);
for (const angle of angles) {
  const arms = reference.momentArms(angle, 0);
  for (const [tendon, unit] of Object.entries(ELBOW_TENDONS)) {
    referenceArms.get(tendon).push(arms.get(tendon) ?? Number.NaN);
    void unit;
  }
}
reference.dispose();

// --- Comparison ---------------------------------------------------------------------------------

const unitToTendon = new Map(Object.entries(ELBOW_TENDONS).map(([t, u]) => [u, t]));
const findings = [];

for (let p = 0; p < sweep.pairs.length; p++) {
  const pair = sweep.pairs[p];
  const tendon = unitToTendon.get(pair.unitId);
  // One row per muscle, for the coordinate being swept. These units cross the radioulnar
  // coordinate too and the moment module reports that as well; it is a different comparison and
  // belongs in its own sweep rather than mixed into this table.
  if (!tendon || pair.jointId !== 'elbow_r' || pair.dofId !== 'flexion') continue;
  const ours = Array.from(sweep.arms[p]);
  const theirs = referenceArms.get(tendon);

  let sum = 0;
  let worst = 0;
  let worstAt = 0;
  for (let a = 0; a < ours.length; a++) {
    const d = Math.abs(ours[a] - theirs[a]);
    sum += d;
    if (d > worst) {
      worst = d;
      worstAt = angles[a];
    }
  }
  const mean = sum / ours.length;

  const signChange = (values) => {
    const signs = values.filter((v) => Math.abs(v) > 1e-4).map((v) => Math.sign(v));
    return signs.some((s) => s !== signs[0]);
  };
  const oursFlips = signChange(ours);
  const theirsFlips = signChange(theirs);

  const peak = (values) => {
    let at = 0;
    for (let i = 1; i < values.length; i++) {
      if (Math.abs(values[i]) > Math.abs(values[at])) at = i;
    }
    return { value: values[at], angle: angles[at] };
  };

  const recorded = RECORDED.find((r) => r.unit === pair.unitId);
  let status = 'ok';
  let note = recorded?.note ?? 'within tolerance of the reference';
  if (oursFlips && !theirsFlips) {
    status = 'HARD FAILURE';
    note = 'changes sign where the reference does not (muscle spec 13.2)';
  } else if (mean > TOLERANCE) {
    if (recorded?.bound !== undefined && mean <= recorded.bound) {
      status = `recorded (${recorded.question})`;
    } else if (recorded?.bound !== undefined) {
      status = 'investigate';
      note = `worse than recorded: ${(mean * 1000).toFixed(1)} mm against a bound of ${(recorded.bound * 1000).toFixed(1)} mm. ${recorded.note}`;
    } else {
      status = 'investigate';
      note =
        'past tolerance and not recorded: fix it, or record the difference and its open question in RECORDED';
    }
  }

  findings.push({
    unit: pair.unitId,
    tendon,
    ours,
    theirs,
    mean,
    worst,
    worstAt,
    oursPeak: peak(ours),
    theirsPeak: peak(theirs),
    oursFlips,
    theirsFlips,
    status,
    note,
  });
}

// --- The report ----------------------------------------------------------------------------------

const mm = (v) => (Number.isFinite(v) ? (v * 1000).toFixed(1) : '--');
const deg = (radians) => `${Math.round((radians * 180) / Math.PI)}`;
const hard = findings.filter((f) => f.status === 'HARD FAILURE');
const investigate = findings.filter((f) => f.status === 'investigate');

const lines = [];
lines.push('# Moment arm validation');
lines.push('');
lines.push(
  'Muscle spec 13.2, ticket N1.9. Generated by `pnpm validate:moment-arms`; commit the result',
);
lines.push('with the change that moved it.');
lines.push('');
lines.push(
  `The elbow swept from ${FROM} to ${TO} degrees of flexion in ${STEP}-degree steps, forearm neutral, ` +
    'against the vendored MyoSuite arm at commit `' +
    COMMIT.slice(0, 10) +
    '` loaded into MuJoCo and measured the same way. Both sides are computed here: nothing is ' +
    'transcribed, and no value from the reference reaches the model (ADR-009).',
);
lines.push('');
lines.push(
  `Generated ${new Date().toISOString().slice(0, 10)}. ${findings.length} muscles, ` +
    `${hard.length} hard failure(s), ${investigate.length} to investigate, ` +
    `${findings.filter((f) => f.status.startsWith('recorded')).length} recorded.`,
);
lines.push('');
lines.push('## Summary');
lines.push('');
lines.push(
  'Moment arms in millimetres, positive toward flexion. Mean and worst are |ours - theirs|.',
);
lines.push('');
lines.push('| Muscle | Our peak | Reference peak | Mean | Worst | Status |');
lines.push('|---|---|---|---|---|---|');
for (const f of findings) {
  lines.push(
    `| ${f.unit} | ${mm(f.oursPeak.value)} at ${deg(f.oursPeak.angle)}° | ` +
      `${mm(f.theirsPeak.value)} at ${deg(f.theirsPeak.angle)}° | ${mm(f.mean)} | ` +
      `${mm(f.worst)} at ${deg(f.worstAt)}° | ${f.status} |`,
  );
}
lines.push('');
lines.push('## Notes');
lines.push('');
for (const f of findings) lines.push(`- **${f.unit}** — ${f.note}`);
lines.push('');
lines.push('## Ours, millimetres');
lines.push('');
lines.push(`| Flexion | ${findings.map((f) => f.unit.replace(/_r$/, '')).join(' | ')} |`);
lines.push(`|---|${findings.map(() => '---').join('|')}|`);
for (let a = 0; a < angles.length; a++) {
  lines.push(`| ${deg(angles[a])}° | ${findings.map((f) => mm(f.ours[a])).join(' | ')} |`);
}
lines.push('');
lines.push('## The reference, millimetres');
lines.push('');
lines.push(`| Flexion | ${findings.map((f) => f.unit.replace(/_r$/, '')).join(' | ')} |`);
lines.push(`|---|${findings.map(() => '---').join('|')}|`);
for (let a = 0; a < angles.length; a++) {
  lines.push(`| ${deg(angles[a])}° | ${findings.map((f) => mm(f.theirs[a])).join(' | ')} |`);
}
lines.push('');

const report = `${lines.join('\n')}`;
const path = join(ROOT, 'docs/validation/moment-arms.md');

if (check) {
  const existing = readFileSync(path, 'utf8');
  if (existing.split('Generated ')[0] !== report.split('Generated ')[0]) {
    console.error(
      'Moment arms have changed and docs/validation/moment-arms.md is stale. ' +
        'Run `pnpm validate:moment-arms` and commit the result with the change that moved it.',
    );
    process.exit(1);
  }
  if (hard.length > 0) {
    console.error('Moment arm validation FAILED, muscle spec 13.2:');
    for (const f of hard) console.error(`  ${f.unit}: ${f.note}`);
    process.exit(1);
  }
  if (investigate.length > 0) {
    console.error(
      `${investigate.length} moment arm(s) differ from the reference by more than is recorded. ` +
        'Each is in docs/validation/moment-arms.md: either fix the path, or record the ' +
        'difference and its open question in RECORDED in this tool.',
    );
    for (const f of investigate) console.error(`  ${f.unit}: ${f.note}`);
    process.exit(1);
  }
  console.error(
    `moment arms: ok. ${findings.length} muscles swept, no sign changes, ` +
      `${findings.filter((f) => f.status.startsWith('recorded')).length} recorded difference(s), ` +
      'report current.',
  );
} else {
  writeFileSync(path, report);
  console.error(
    `wrote ${relative(ROOT, path)}: ${findings.length} muscles, ${hard.length} hard failure(s), ` +
      `${investigate.length} to investigate.`,
  );
}
