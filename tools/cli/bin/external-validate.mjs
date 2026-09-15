#!/usr/bin/env node
/**
 * External validation against the reference models -- milestone M5.7, spec section 13.6.
 *
 *   pnpm validate:external          # write docs/validation/external.md
 *   pnpm validate:external --check  # and fail if a discrepancy is not already recorded there
 *
 * Every range and coupling in this project that comes from MyoSuite carries a citation naming
 * the file and the element it came from. That makes the claim checkable, and this checks it:
 * it reads the vendored reference models (tools/validate-external, pinned to a commit) and puts
 * each cited value next to the value in the file it cites.
 *
 * Several of our values are deliberately not identical to the source's. A region joint carries
 * half of a lumped range because two of them share it; a source that counts extension as
 * positive is flipped. Those relationships are recognised and named rather than reported as
 * errors, which is the point: the report says how each value relates to its source, so a
 * transcription slip stands out from a modelling decision.
 *
 * MyoSkeleton is non-commercial and cannot be vendored or transcribed (ADR-009, ADR-011). If a
 * developer has their own copy, `MYOSKELETON_XML` points at it and the structural comparison
 * runs; only whether a structure agrees is reported, never a number from it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import {
  angleBetween,
  bodyOffset,
  equalitiesByName,
  jointsByName,
  readMjcf,
} from '../../validate-external/src/mjcf.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const REFERENCE = join(ROOT, 'tools/validate-external/myo_sim');
const COMMIT = 'eb327acbae0fad12279495040607f5235d962328';
const check = process.argv.includes('--check');

/** Angles closer than this count as the same axis: a hundredth of a degree. */
const AXIS_TOLERANCE = 1.75e-4;
/** Ranges closer than this count as the same bound; the source states four to six figures. */
const RANGE_TOLERANCE = 5e-4;
/** Relative agreement required of a coupling coefficient. */
const COEFFICIENT_TOLERANCE = 1e-6;

const jiti = createJiti(import.meta.url);
const { buildDocument } = await jiti.import(join(ROOT, 'packages/skeleton/src/index.ts'));
const document = buildDocument();

// --- The reference ------------------------------------------------------------------------------

const models = new Map();
for (const file of [
  'myolegs_chain.xml',
  'myolegs_assets.xml',
  'myoarm_r_chain.xml',
  'myoarm_r_assets.xml',
  'myotorso_chain.xml',
  'myotorso_assets.xml',
  'myohead_rigid_chain.xml',
]) {
  const model = readMjcf(readFileSync(join(REFERENCE, file), 'utf8'));
  models.set(file, {
    model,
    joints: jointsByName(model),
    equalities: equalitiesByName(model),
  });
}

/** A citation locator names a file and an element: `<path>, joint <name>` or `, equality <name>`. */
function parseLocator(locator) {
  const match = /^([^,]+),\s*(joint|equality)\s+(.+)$/.exec(locator ?? '');
  if (!match) return null;
  // Trim the parenthetical a citation may carry, such as the note that the left mirrors the right.
  const element = match[3].replace(/\s*\(.*$/, '').trim();
  return { file: basename(match[1].trim()), kind: match[2], element };
}

/**
 * Differences that are decisions, each with where the decision is written down.
 *
 * A difference from the reference is not automatically a defect: an axis may be restated in this
 * project's frame on purpose. What would be a defect is a difference nobody noticed, so a
 * decision is listed here, next to where it is recorded, and anything not on this list is
 * reported for investigation and fails `--check`.
 */
const RECORDED = [
  {
    match: /^ankle_[rl]: dorsiflexion to inversion$/,
    where:
      "the ankle joint's own limitations: dorsiflexion is about the ISB malleolar axis, not the " +
      "source's, which is tilted about 12 degrees from it",
  },
  {
    match: /^mcp_\d_[rl]: flexion to abduction$/,
    where:
      "the header of jointsL3.ts: the hand joints are stated in the source's own hand frame, " +
      'where flexion is about x, and are restated here about the medio-lateral axis',
  },
];

const findings = [];
/** Values this project does not claim to have transcribed, counted rather than compared. */
const provisional = [];
const record = (area, subject, ours, reference, verdict, note) => {
  const recorded = verdict === 'investigate' && RECORDED.find((r) => r.match.test(subject));
  findings.push({
    area,
    subject,
    ours,
    reference,
    verdict: recorded ? 'recorded' : verdict,
    note: recorded ? `${note}; a decision, recorded in ${recorded.where}` : note,
  });
};

// --- Ranges -------------------------------------------------------------------------------------

/** How our range relates to the source's, or null when nothing simple relates them. */
function relate(ours, theirs) {
  const near = (a, b) => Math.abs(a - b) <= RANGE_TOLERANCE;
  const flipped = [-theirs[1], -theirs[0]];
  const candidates = [
    { name: 'as stated', value: theirs },
    { name: 'halved', value: [theirs[0] / 2, theirs[1] / 2] },
    { name: 'flexion-positive', value: flipped },
    { name: 'halved, flexion-positive', value: [flipped[0] / 2, flipped[1] / 2] },
  ];
  for (const candidate of candidates) {
    if (near(ours[0], candidate.value[0]) && near(ours[1], candidate.value[1]))
      return candidate.name;
  }
  return null;
}

for (const joint of document.joints) {
  for (const dof of joint.dofs) {
    const source = dof.romSource;
    if (!source || source.key !== 'caggiano2022') continue;
    // A provisional range is a recorded gap, not a transcription: it says in its own citation
    // that the reference does not state it, so there is nothing here to check it against.
    if (source.provisional) {
      provisional.push({
        subject: `${joint.id}/${dof.axis}`,
        question: source.provisional.openQuestion,
      });
      continue;
    }
    const located = parseLocator(source.locator);
    const subject = `${joint.id}/${dof.axis}`;
    if (!located || !models.has(located.file)) {
      record(
        'range',
        subject,
        fmtRange(dof.range),
        '-',
        'investigate',
        'citation names no vendored file',
      );
      continue;
    }
    const reference = models.get(located.file).joints.get(located.element);
    if (!reference) {
      record(
        'range',
        subject,
        fmtRange(dof.range),
        'absent',
        'investigate',
        `no joint '${located.element}' in ${located.file}`,
      );
      continue;
    }
    if (!reference.range) {
      record(
        'range',
        subject,
        fmtRange(dof.range),
        'unbounded',
        'investigate',
        'the source states no range',
      );
      continue;
    }
    const relation = relate(dof.range, reference.range);
    record(
      'range',
      subject,
      fmtRange(dof.range),
      fmtRange(reference.range),
      relation ? 'ok' : 'investigate',
      relation ?? 'no simple relation to the source',
    );
  }
}

// --- Axes, by the angles between them ------------------------------------------------------------

// A joint's axes live in its own frame, and ours is not the source's, so the directions cannot be
// compared side by side without building both models' kinematics. The angles *between* a joint's
// own axes do not depend on the frame at all, and they are what a mis-transcribed oblique axis
// would break, so they are what is compared.
for (const joint of document.joints) {
  if (joint.dofs.length < 2) continue;
  // A counter-rotating DoF takes its axis from another joint, carried through both joint frames
  // (see `counterRotates`). Its direction is stated in this project's frame while the reference
  // states the joint it mirrors in the reference's own, so the two are not comparable as they
  // stand and comparing them would only measure the difference between the frames.
  if (joint.dofs.some((d) => /^unrotate_/.test(d.axis))) continue;
  const located = joint.dofs.map((d) => parseLocator(d.romSource?.locator));
  if (located.some((l) => !l || !models.has(l.file))) continue;
  const references = located.map((l) => models.get(l.file).joints.get(l.element));
  if (references.some((r) => !r)) continue;
  for (let i = 0; i < joint.dofs.length; i++) {
    for (let k = i + 1; k < joint.dofs.length; k++) {
      const a = joint.dofs[i];
      const b = joint.dofs[k];
      const ours = angleBetween(
        [a.vector.x, a.vector.y, a.vector.z],
        [b.vector.x, b.vector.y, b.vector.z],
      );
      const theirs = angleBetween(references[i].axis, references[k].axis);
      const difference = Math.abs(ours - theirs);
      record(
        'axis',
        `${joint.id}: ${a.axis} to ${b.axis}`,
        `${deg(ours)}`,
        `${deg(theirs)}`,
        difference <= AXIS_TOLERANCE ? 'ok' : 'investigate',
        difference <= AXIS_TOLERANCE ? 'same angle between the axes' : `${deg(difference)} apart`,
      );
    }
  }
}

// --- Couplings ------------------------------------------------------------------------------------

for (const constraint of document.constraints) {
  if (constraint.kind.type !== 'jointCoupling') continue;
  const source = constraint.source;
  if (!source || source.key !== 'caggiano2022') continue;
  const locator = source.locator ?? '';
  const located = parseLocator(locator);
  const driver = constraint.kind.drivers[0];
  if (!located || !models.has(located.file) || !driver) {
    record(
      'coupling',
      constraint.id,
      `${driver?.coefficient ?? '-'}`,
      '-',
      'investigate',
      'citation names no vendored file',
    );
    continue;
  }
  const model = models.get(located.file);
  // A lumbar share is the ratio of two of the source's coefficients, and says so in its locator.
  const ratio = /^(\S+)\s+and\s+(\S+)$/.exec(located.element);
  if (ratio) {
    const a = model.equalities.get(ratio[1]);
    const b = model.equalities.get(ratio[2]);
    if (!a || !b) {
      record(
        'coupling',
        constraint.id,
        `${driver.coefficient}`,
        'absent',
        'investigate',
        'one of the two equalities is missing',
      );
      continue;
    }
    const expected = a.polycoef[1] / b.polycoef[1];
    const agree =
      Math.abs(expected - driver.coefficient) <= COEFFICIENT_TOLERANCE * Math.abs(expected);
    record(
      'coupling',
      constraint.id,
      driver.coefficient.toPrecision(6),
      `${a.polycoef[1]} / ${b.polycoef[1]} = ${expected.toPrecision(6)}`,
      agree ? 'ok' : 'investigate',
      agree ? 'the ratio the source states' : 'the ratio does not follow from the source',
    );
    continue;
  }
  const equality = model.equalities.get(located.element);
  if (!equality) {
    record(
      'coupling',
      constraint.id,
      `${driver.coefficient}`,
      'absent',
      'investigate',
      `no equality '${located.element}' in ${located.file}`,
    );
    continue;
  }
  const ours = [constraint.kind.offset ?? 0, driver.coefficient, ...(driver.higher ?? [0, 0, 0])];
  const worst = Math.max(
    ...ours.map((value, i) => {
      const theirs = equality.polycoef[i] ?? 0;
      const scale = Math.max(Math.abs(theirs), 1e-9);
      return Math.abs(value - theirs) / scale;
    }),
  );
  record(
    'coupling',
    constraint.id,
    ours.map((v) => v.toPrecision(6)).join(' '),
    equality.polycoef.join(' '),
    worst <= COEFFICIENT_TOLERANCE ? 'ok' : 'investigate',
    worst <= COEFFICIENT_TOLERANCE ? 'every coefficient as stated' : 'coefficients differ',
  );
}

// --- Segment lengths --------------------------------------------------------------------------

// Both models are built at their own subject's size, so the lengths are compared as fractions of
// the thigh, which cancels the overall scale and leaves the proportions to disagree if they do.
const legs = models.get('myolegs_chain.xml');
const proportions = [['shank', 'knee_r', 'ankle_r', 'talus_r']];
const jointWorld = await (async () => {
  const { resolveMorphology } = await jiti.import(
    join(ROOT, 'packages/anthropometry/src/index.ts'),
  );
  const { compileArticulation } = await jiti.import(join(ROOT, 'packages/compiler/src/index.ts'));
  const { DATASET_MANIFEST } = await jiti.import(join(ROOT, 'packages/skeleton/src/index.ts'));
  const morphology = resolveMorphology({
    sex: 0.5,
    stature: DATASET_MANIFEST.subjectStature,
    mass: 70,
  });
  const { articulation } = compileArticulation(document, 'l1_standard', morphology);
  const out = new Map();
  for (const joint of articulation.joints) {
    const parent = articulation.segments[joint.parentSegment];
    if (!parent) continue;
    const t = parent.restWorld.translation;
    const r = parent.restWorld.rotation;
    const v = joint.frameInParent.translation;
    const tx = 2 * (r.y * v.z - r.z * v.y);
    const ty = 2 * (r.z * v.x - r.x * v.z);
    const tz = 2 * (r.x * v.y - r.y * v.x);
    out.set(joint.id, [
      t.x + v.x + r.w * tx + (r.y * tz - r.z * ty),
      t.y + v.y + r.w * ty + (r.z * tx - r.x * tz),
      t.z + v.z + r.w * tz + (r.x * ty - r.y * tx),
    ]);
  }
  return out;
})();

const ourThigh = distance(jointWorld.get('hip_r'), jointWorld.get('knee_r'));
const theirThigh = bodyOffset(legs.model, 'tibia_r');
record(
  'proportion',
  'thigh length',
  `${ourThigh.toFixed(4)} m`,
  `${theirThigh.toFixed(4)} m`,
  'ok',
  "the two models are built at different subjects' sizes, so the absolute lengths differ; what " +
    'follows compares proportions, which do not depend on that',
);
for (const [name, from, to, body] of proportions) {
  const ours = distance(jointWorld.get(from), jointWorld.get(to));
  const theirs = bodyOffset(legs.model, body);
  if (ours === undefined || theirs === undefined) continue;
  const oursRatio = ours / ourThigh;
  const theirsRatio = theirs / theirThigh;
  const difference = Math.abs(oursRatio - theirsRatio);
  record(
    'proportion',
    `${name} length, as a fraction of the thigh`,
    oursRatio.toFixed(4),
    theirsRatio.toFixed(4),
    difference <= 0.05 ? 'ok' : 'investigate',
    `${(difference * 100).toFixed(1)}% apart; the two are different subjects, so a few per cent is expected`,
  );
}

// --- Passive curves -----------------------------------------------------------------------------

record(
  'passive',
  'passive moment curves',
  'Riener and Edrich double exponential, per DoF',
  'none',
  'ok',
  'the reference models state damping and armature but no passive moment, so there is nothing to compare',
);

// --- MyoSkeleton --------------------------------------------------------------------------------

const myoskeleton = process.env.MYOSKELETON_XML;
let oracle =
  'Not run: set `MYOSKELETON_XML` to a local copy. It is never vendored and no value is ever taken from it (ADR-009, ADR-011).';
if (myoskeleton) {
  try {
    const model = readMjcf(readFileSync(myoskeleton, 'utf8'));
    const theirs = jointsByName(model);
    const ours = new Set(document.joints.map((j) => j.id));
    let shared = 0;
    for (const name of theirs.keys()) if (ours.has(name)) shared += 1;
    oracle =
      `Read ${model.bodies.length} bodies and ${theirs.size} joints. ${shared} joint names are ` +
      'also ours. Structure only: no number from this model is read, compared or recorded.';
  } catch (error) {
    oracle = `Could not read \`MYOSKELETON_XML\`: ${error instanceof Error ? error.message : error}`;
  }
}

// --- Report ---------------------------------------------------------------------------------------

const investigate = findings.filter((f) => f.verdict === 'investigate');
const recorded = findings.filter((f) => f.verdict === 'recorded');
const lines = [
  '# External validation against the reference models',
  '',
  'Spec section 13.6. Generated by `pnpm validate:external`; commit the result with the change',
  'that moved it. Every value this project takes from MyoSuite carries a citation naming the file',
  'and element it came from, and this puts each of them next to the file it cites.',
  '',
  `Reference: MyoSuite \`myo_sim\` at commit \`${COMMIT.slice(0, 10)}\`, vendored under`,
  '`tools/validate-external/` with its Apache-2.0 licence. See that directory for how to verify',
  'or advance the pin.',
  '',
  `Generated ${new Date().toISOString().slice(0, 10)}. ${findings.length} comparisons, ` +
    `${investigate.length} to investigate, ${recorded.length} differing by a recorded decision, ` +
    `${provisional.length} values provisional and so not compared.`,
  '',
  '## What is compared',
  '',
  "- **Range** bounds, per degree of freedom. Ours is not always the source's number: a region",
  '  joint carries half of a lumped range because two of them share it, and a source that counts',
  '  extension as positive is flipped. The relation is named rather than flattened to a delta.',
  "- **Axis** orientation, as the angle between a joint's own axes. A joint's axes are stated in",
  "  its own frame and ours is not the source's, so the directions are not comparable side by",
  '  side; the angles between them do not depend on the frame, and an oblique axis transcribed',
  '  wrongly would change them.',
  "- **Coupling** coefficients, against the source's `polycoef`, including the lumbar shares that",
  '  are ratios of two of them.',
  '- **Proportion**: segment lengths as a fraction of the thigh, which cancels the difference in',
  '  subject size and leaves the proportions to disagree if they do.',
  '- **Passive** moment curves, which the reference does not have.',
  '',
  '## Values with nothing to compare against',
  '',
  `${provisional.length} degrees of freedom carry a provisional range: their citation records`,
  'that the reference does not state the value, so there is nothing here to check them against.',
  'They are listed in `docs/sources/open-questions.md` under the question each belongs to.',
  '',
  ...[...new Set(provisional.map((p) => p.question))]
    .sort()
    .map((q) => `- ${q}: ${provisional.filter((p) => p.question === q).length} degrees of freedom`),
  '',
  '## MyoSkeleton',
  '',
  oracle,
  '',
  '## Findings',
  '',
  '| | Subject | Ours | Reference | Note |',
  '|---|---|---|---|---|',
];
for (const verdict of ['investigate', 'recorded', 'ok']) {
  for (const f of findings.filter((x) => x.verdict === verdict)) {
    lines.push(`| ${verdict} | ${f.subject} | ${f.ours} | ${f.reference} | ${f.note} |`);
  }
}
lines.push('');

const path = join(ROOT, 'docs/validation/external.md');
const report = `${lines.join('\n')}`;
if (check) {
  const existing = readFileSync(path, 'utf8');
  if (existing.split('Generated ')[0] !== report.split('Generated ')[0]) {
    console.error(
      'External validation has changed and docs/validation/external.md is stale. ' +
        'Run `pnpm validate:external` and commit the result with the change that moved it.',
    );
    process.exit(1);
  }
  if (investigate.length > 0) {
    console.error(
      `External validation has ${investigate.length} difference(s) from the reference that are ` +
        'not recorded as decisions. Each is in docs/validation/external.md: either fix the value, ' +
        'or record the decision and add it to RECORDED in this tool.',
    );
    for (const f of investigate) console.error(`  ${f.subject}: ${f.note}`);
    process.exit(1);
  }
  console.error(
    `external validation: ${findings.length} comparisons, none unexplained, report current.`,
  );
} else {
  writeFileSync(path, report);
  console.error(
    `wrote ${path}: ${findings.length} comparisons, ${investigate.length} to investigate.`,
  );
}

function fmtRange(range) {
  return `[${range[0]}, ${range[1]}]`;
}
function deg(radians) {
  return `${((radians * 180) / Math.PI).toFixed(3)} deg`;
}
function distance(a, b) {
  if (!a || !b) return undefined;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
