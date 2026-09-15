#!/usr/bin/env node
/**
 * Generates the elbow muscle parameter set from the vendored MyoSuite arm model -- ticket N2.5.
 *
 *   pnpm generate:elbow-muscles          # rewrite packages/muscle-data/src/elbow.ts
 *   pnpm generate:elbow-muscles --check  # fail if the file is not what this would write
 *
 * Generated rather than transcribed. Seven muscles times four parameters is twenty-eight numbers
 * that would otherwise be copied by hand out of an XML attribute, and a single transposed digit
 * in a tendon slack length moves a muscle onto the descending limb of its force-length curve
 * where it behaves plausibly and wrongly. Running the extraction instead means the value in the
 * repository and the value in the cited file cannot disagree, and `--check` in CI keeps it that
 * way.
 *
 * ## What MuJoCo states and what has to be derived
 *
 * A MuJoCo muscle actuator does not carry an optimal fiber length or a tendon slack length. It
 * carries `gainprm`, whose third entry is the peak active force, and an operating range in units
 * of optimal fiber length; and `lengthrange`, the musculotendon length at the two ends of that
 * range, in metres. Those four numbers determine the two lengths exactly, because the range and
 * the length range are the same interval measured in different units:
 *
 *     L0 = (LRmax - LRmin) / (rmax - rmin)
 *     LT = LRmin - L0 * rmin
 *
 * The derivation is MuJoCo's own, from its muscle actuator documentation, and it is the inverse
 * of the step its compiler takes when it fills `lengthrange` in. It is done here, once, in the
 * open, rather than left as a comment beside a hand-copied number.
 *
 * ## Where the wrap goes in the path
 *
 * A path is an ordered thing, and a surface placed at the wrong point in it constrains the wrong
 * span. Brachioradialis is the case that showed it: the reference wraps between its origin and
 * the point on the radius, and writing the wrap after every via point instead put the obstacle
 * between that radial point and the styloid -- a span that runs down the forearm and comes
 * nowhere near the elbow. Its moment arm went negative at full extension as a result, which
 * muscle spec 13.2 calls a hard failure, and N1.9's sweep is what caught it.
 *
 * So the position is read from the reference path rather than assumed: the last wrap geom in a
 * reference tendon is its elbow surface (the earlier ones, where there are any, are at the
 * humeral head), and our wrap goes where that one sits among the via points we carry.
 *
 * ## Pennation
 *
 * The MuJoCo muscle model has no pennation angle: the conversion folds it into the peak force, so
 * the force these actuators declare is already the force along the tendon. A unit taken from this
 * source therefore has a pennation of zero, and that is a faithful transcription rather than a
 * missing value. What it costs is recorded as OQ-014.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MUSCLE_FILE = 'myoarm_r_muscle.xml';
const TENDON_FILE = 'myoarm_r_tendon.xml';
const SOURCE = join(ROOT, 'tools/validate-external/myo_sim', MUSCLE_FILE);
const TENDON_SOURCE = join(ROOT, 'tools/validate-external/myo_sim', TENDON_FILE);
const OUT = join(ROOT, 'packages/muscle-data/src/elbow.ts');
const check = process.argv.includes('--check');

const jiti = createJiti(import.meta.url);
const { viaPointsFor } = await jiti.import(join(ROOT, 'packages/skeleton/src/muscleViaPoints.ts'));

const TENDON_XML = readFileSync(TENDON_SOURCE, 'utf8');

/**
 * Where the elbow surface sits in a reference tendon's path, as an index among its elements.
 *
 * Elements in order: `<site site="...">` and `<geom geom="...">`. The elbow surface is the last
 * geom -- every unit here that has two wraps has the humeral head first and the elbow second.
 */
function referencePath(actuator) {
  const block = TENDON_XML.match(
    new RegExp(`<spatial[^>]*name="${actuator}_tendon"[\\s\\S]*?</spatial>`),
  );
  if (!block) {
    throw new Error(
      `${TENDON_FILE} has no tendon named '${actuator}_tendon'. The vendored commit may have ` +
        'moved; check tools/validate-external/README.md before changing this mapping.',
    );
  }
  const elements = [...block[0].matchAll(/<(site|geom)\s+(?:site|geom)="([^"]+)"/g)].map((m) => ({
    kind: m[1],
    name: m[2],
  }));
  let lastGeom = -1;
  elements.forEach((e, i) => {
    if (e.kind === 'geom') lastGeom = i;
  });
  return { elements, lastGeom };
}

/**
 * The path elements for one unit: our via points, with the wrap where the reference puts it.
 *
 * A via point we carry knows which reference site it came from, so its place in the reference
 * path is a lookup rather than a guess, and the wrap goes before the first via point that comes
 * after the reference's elbow geom.
 */
function pathElements(unit) {
  const { elements, lastGeom } = referencePath(unit.actuator);
  const indexOf = (site) => elements.findIndex((e) => e.kind === 'site' && e.name === site);
  const via = viaPointsFor(unit.id).map((p) => ({
    kind: 'site',
    id: p.id,
    at: indexOf(p.referenceSite),
  }));
  const out = [];
  let placed = false;
  for (const point of via) {
    if (!placed && lastGeom >= 0 && point.at > lastGeom) {
      out.push({ kind: 'wrap' });
      placed = true;
    }
    out.push(point);
  }
  if (!placed) out.push({ kind: 'wrap' });
  return out;
}

/**
 * Which actuator becomes which unit, and which of our attachment sites it binds to.
 *
 * The sites are ours, from M5.3: Gray's anatomical statement located on this subject's markers.
 * They are not the source model's sites, and they must not be -- its body frames are its own, and
 * a coordinate lifted across would be a number measured in one frame written down in another.
 * Only the scalar parameters cross, and those are frame-independent.
 */
const UNITS = [
  {
    actuator: 'BIClong',
    side: 'flexor',
    group: 'biceps_brachii_$',
    groupName: 'Biceps brachii',
    taTerm: 'Musculus biceps brachii',
    innervation: 'Musculocutaneous nerve',
    id: 'biceps_brachii_long_$',
    name: 'Biceps brachii, long head',
    origin: 'biceps_brachii_origin_$_supraglenoid_tubercle',
    insertion: 'biceps_brachii_insertion_$_radial_tuberosity',
  },
  {
    actuator: 'BICshort',
    side: 'flexor',
    group: 'biceps_brachii_$',
    id: 'biceps_brachii_short_$',
    name: 'Biceps brachii, short head',
    origin: 'biceps_brachii_origin_$_coracoid_process',
    insertion: 'biceps_brachii_insertion_$_radial_tuberosity',
  },
  {
    actuator: 'BRA',
    side: 'flexor',
    group: 'brachialis_$',
    groupName: 'Brachialis',
    taTerm: 'Musculus brachialis',
    innervation: 'Musculocutaneous nerve',
    id: 'brachialis_$',
    name: 'Brachialis',
    origin: 'brachialis_origin_$_anteromedial_surface_of_humerus',
    insertion: 'brachialis_insertion_$_tuberosity_of_ulna',
  },
  {
    actuator: 'BRD',
    side: 'flexor',
    group: 'brachioradialis_$',
    groupName: 'Brachioradialis',
    taTerm: 'Musculus brachioradialis',
    innervation: 'Radial nerve',
    id: 'brachioradialis_$',
    name: 'Brachioradialis',
    origin: 'brachioradialis_origin_$_lateral_supracondylar_ridge',
    insertion: 'brachioradialis_insertion_$_radial_styloid_process',
  },
  {
    actuator: 'TRIlong',
    side: 'extensor',
    group: 'triceps_brachii_$',
    groupName: 'Triceps brachii',
    taTerm: 'Musculus triceps brachii',
    innervation: 'Radial nerve',
    id: 'triceps_brachii_long_$',
    name: 'Triceps brachii, long head',
    origin: 'triceps_brachii_origin_$_infraglenoid_tubercle',
    insertion: 'triceps_brachii_insertion_$_olecranon',
  },
  {
    actuator: 'TRIlat',
    side: 'extensor',
    group: 'triceps_brachii_$',
    id: 'triceps_brachii_lateral_$',
    name: 'Triceps brachii, lateral head',
    origin: 'triceps_brachii_origin_$_posterior_surface_of_humerus',
    insertion: 'triceps_brachii_insertion_$_olecranon',
  },
  {
    actuator: 'TRImed',
    side: 'extensor',
    group: 'triceps_brachii_$',
    id: 'triceps_brachii_medial_$',
    name: 'Triceps brachii, medial head',
    origin: 'triceps_brachii_origin_$_posterior_surface_of_humerus',
    insertion: 'triceps_brachii_insertion_$_olecranon',
  },
];

/**
 * Every unit on both arms.
 *
 * The reference model is a right arm and there is no left one to take parameters from, so the
 * left side is the right side's parameters on the left side's geometry -- which is the ordinary
 * assumption of bilateral symmetry, and the only claim in it is that a person's two biceps are
 * the same muscle. Everything that is *geometry* is already bilateral and measured: the
 * attachment sites come from each side's own markers, the wrap surfaces from each side's own
 * mesh, and the via points are mirrored with the dataset's symmetry checked.
 *
 * Which side of a surface a muscle passes is not mirrored, because it is stated as an anterior or
 * posterior direction and anterior is anterior on both arms.
 */
function sided() {
  const out = [];
  for (const s of ['r', 'l']) {
    const word = s === 'r' ? 'right' : 'left';
    for (const unit of UNITS) {
      const put = (value) => (value === undefined ? undefined : value.replaceAll('$', s));
      out.push({
        ...unit,
        group: put(unit.group),
        id: put(unit.id),
        origin: put(unit.origin),
        insertion: put(unit.insertion),
        name: `${unit.name}, ${word}`,
        ...(unit.groupName === undefined ? {} : { groupName: `${unit.groupName}, ${word}` }),
        side_: s,
      });
    }
  }
  return out;
}

function readActuators() {
  const xml = readFileSync(SOURCE, 'utf8');
  const found = new Map();
  const pattern =
    /<general\s+name="([A-Za-z0-9]+)"[^>]*?gainprm="([^"]+)"[^>]*?lengthrange="([^"]+)"/g;
  for (const match of xml.matchAll(pattern)) {
    const gain = match[2].trim().split(/\s+/).map(Number);
    const range = match[3].trim().split(/\s+/).map(Number);
    const [rmin, rmax, force, , , , vmax] = gain;
    const [lrmin, lrmax] = range;
    if (!(rmax > rmin)) {
      throw new Error(`${match[1]}: operating range is empty, so the lengths cannot be derived`);
    }
    const optimalFiberLength = (lrmax - lrmin) / (rmax - rmin);
    found.set(match[1], {
      maxIsometricForce: force,
      optimalFiberLength,
      tendonSlackLength: lrmin - optimalFiberLength * rmin,
      maxContractionVelocity: vmax,
    });
  }
  return found;
}

/** Six significant figures: more than the source states, and enough to round-trip it. */
const num = (v) => Number(v.toPrecision(6)).toString();

function render() {
  const actuators = readActuators();
  const groups = new Map();
  for (const unit of sided()) {
    const parameters = actuators.get(unit.actuator);
    if (parameters === undefined) {
      throw new Error(
        `${MUSCLE_FILE} has no actuator named '${unit.actuator}'. The vendored commit may have ` +
          'moved; check tools/validate-external/README.md before changing this mapping.',
      );
    }
    if (!groups.has(unit.group)) groups.set(unit.group, []);
    // Which surface each unit lies against. The extensors turn over the trochlea, where the
    // elbow's axis runs, and that is what gives them a moment arm. The flexors never touch it --
    // their paths pass in front of it -- so what they need is the shaft, which they lie along
    // rather than pass through. One surface each, which is what the solver takes per span until
    // N1.5; the flexors' elbow leverage is still the straight-line answer and is OQ-015's.
    // The trochlea for everyone now. Via points hold each muscle along the shaft, so what is
    // left for a wrap surface is the elbow itself -- and the shaft cylinder, which never suited a
    // muscle running along it, is no longer asked to do that job.
    const wrap = `elbow_trochlea_${unit.side_}`;
    groups.get(unit.group).push({ ...unit, parameters, wrap });
  }

  const body = [];
  for (const [groupId, units] of groups) {
    const head = units[0];
    body.push(`  {
    id: '${groupId}',
    displayName: '${head.groupName}',
    taTerm: '${head.taTerm}',
    innervation: '${head.innervation}',
    source: gray('${head.groupName.split(',')[0]}'),
    units: [`);
    for (const unit of units) {
      const p = unit.parameters;
      body.push(`      {
        id: '${unit.id}',
        displayName: '${unit.name}',
        origin: '${unit.origin}',
        insertion: '${unit.insertion}',
        path: [
${pathElements(unit)
  .map((e) =>
    e.kind === 'site'
      ? `          { kind: 'site', site: '${e.id}' },\n`
      : `          {
            kind: 'wrap',
            surface: '${unit.wrap}',
            preferredSide: { x: 0, y: 0, z: ${unit.side === 'extensor' ? 1 : -1} },
            source: gray('${unit.name.split(',')[0]}'),
          },\n`,
  )
  .join('')}        ],
        parameters: {
          maxIsometricForce: ${num(p.maxIsometricForce)},
          optimalFiberLength: ${num(p.optimalFiberLength)},
          tendonSlackLength: ${num(p.tendonSlackLength)},
          pennationAngle: 0,
          maxContractionVelocity: ${num(p.maxContractionVelocity)},
          source: myoArm('${unit.actuator}'),
        },
      },`);
    }
    body.push('    ],\n  },');
  }

  return `/**
 * The elbow muscle parameter set -- ticket N2.5, and the data the N3.7 demo runs on.
 *
 * **Generated by \`pnpm generate:elbow-muscles\`. Do not edit.** The numbers are extracted from
 * the vendored MyoSuite arm model rather than copied out of it, so the value here and the value
 * in the cited file cannot disagree; CI runs the generator with \`--check\`.
 *
 * ## Where each half comes from, and why they come from different places
 *
 * The two halves of a muscle definition have different provenance, and mixing them up would be
 * the easiest mistake to make here.
 *
 * *Where the muscle attaches* is ours. The origin and insertion name attachment sites built in
 * M5.3: Gray's anatomical statement about where a muscle attaches, located on this subject by the
 * dataset's own markers, in this project's bone frames. The source model has its own sites, and
 * they are deliberately not used -- its body frames are its own, and a coordinate lifted from one
 * frame into another is a number that means nothing in the frame it lands in.
 *
 * *What the muscle can do* is MyoSuite's. Peak force, optimal fiber length and tendon slack
 * length are scalars: they do not live in a frame, so they cross without reinterpretation. They
 * are cited to \`caggiano2022\` naming the file and the actuator, which is the pattern the
 * external validation harness already checks for every range in the skeleton.
 *
 * ## What is not here yet
 *
 * The via points on the scapula and the forearm are. Each unit is held along the humerus by the
 * points \`muscleViaPoints.ts\` carries over, and turns over the trochlea at the elbow; the source
 * model routes some units through a few further points on the bones either side of that, which
 * would need the same frame construction repeated for those bones.
 *
 * Pennation is zero for every unit. That is not a gap: the MuJoCo muscle model has no pennation
 * angle at all, so the conversion folded it into the peak force and the force declared here is
 * already the force along the tendon. What it costs is recorded as OQ-014.
 *
 * ## Which side of the bone each muscle lies on
 *
 * Every unit turns over the humeral trochlea, and each declares which side it lies on: the three
 * heads of triceps behind the joint axis, the four flexors in front of it. That is an anatomical
 * fact rather than something to work out per tick, and declaring it is what stops a path falling
 * to the other side of the bone as the joint moves -- which would reverse the muscle's moment arm
 * for a tick and turn a flexor into an extensor (muscle spec 4.3).
 *
 * The sides are in the bone's own frame, where +Z is posterior for this dataset: the olecranon
 * fossa sits at z = 0.055 and the coronoid fossa, in front of it, at z = 0.020.
 *
 * They lie against different surfaces, too. The extensors turn over the trochlea, coaxial with
 * the elbow, which is what holds their moment arm at its radius through the range. The flexors
 * never reach it -- measured, their paths pass in front of it and clear it at every angle -- so
 * what they need is the humeral shaft, which they lie along rather than pass through. One surface
 * each: the solver takes one per span until N1.5 adds the multi-surface solve, and a muscle that
 * wants both wants a via point between them, which is the other half of OQ-015.
 */

import { cite } from '@bs-humany/hsdl';
import type { MuscleGroup } from './schema.js';

/** Anatomy: which bony feature a muscle attaches to. The sites themselves are cited in M5.3. */
const gray = (muscle: string) => cite('gray1918', \`Part IV, Myology: The \${muscle}\`);

/** Parameters: the actuator in the vendored arm model they were derived from. */
const myoArm = (actuator: string) =>
  cite(
    'caggiano2022',
    \`${MUSCLE_FILE}, actuator general name="\${actuator}": gainprm force, and optimal fiber \` +
      'length and tendon slack length derived from gainprm range with lengthrange',
  );

/**
 * The seven units that cross the elbow, as five anatomical muscles.
 *
 * Both biceps heads and all three triceps heads are separate lines of action, per M-ADR-005: one
 * line through a triceps is not a simplification of a triceps, it is a different muscle with a
 * moment arm the real one does not have.
 */
export const ELBOW_MUSCLES: readonly MuscleGroup[] = [
${body.join('\n')}
];

/** Every unit in the set, flattened, in a stable order. */
export const ELBOW_UNITS = ELBOW_MUSCLES.flatMap((group) => group.units);
`;
}

const rendered = render();
const existing = (() => {
  try {
    return readFileSync(OUT, 'utf8');
  } catch {
    return undefined;
  }
})();

if (check) {
  if (existing !== rendered) {
    console.error(
      `generate-elbow-muscles: ${relative(ROOT, OUT)} is not what the generator would write.\n` +
        '  Run `pnpm generate:elbow-muscles`. If the vendored model changed, say so in the commit.',
    );
    process.exit(1);
  }
  console.log(`generate-elbow-muscles: ok. ${sided().length} units match ${MUSCLE_FILE}.`);
} else {
  writeFileSync(OUT, rendered);
  console.log(
    `generate-elbow-muscles: wrote ${relative(ROOT, OUT)} -- ${sided().length} units from ${MUSCLE_FILE}.`,
  );
}
