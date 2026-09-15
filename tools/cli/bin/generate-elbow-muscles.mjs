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

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MUSCLE_FILE = 'myoarm_r_muscle.xml';
const SOURCE = join(ROOT, 'tools/validate-external/myo_sim', MUSCLE_FILE);
const OUT = join(ROOT, 'packages/muscle-data/src/elbow.ts');
const check = process.argv.includes('--check');

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
    group: 'biceps_brachii_r',
    groupName: 'Biceps brachii, right',
    taTerm: 'Musculus biceps brachii',
    innervation: 'Musculocutaneous nerve',
    id: 'biceps_brachii_long_r',
    name: 'Biceps brachii, long head, right',
    origin: 'biceps_brachii_origin_r_supraglenoid_tubercle',
    insertion: 'biceps_brachii_insertion_r_radial_tuberosity',
  },
  {
    actuator: 'BICshort',
    group: 'biceps_brachii_r',
    id: 'biceps_brachii_short_r',
    name: 'Biceps brachii, short head, right',
    origin: 'biceps_brachii_origin_r_coracoid_process',
    insertion: 'biceps_brachii_insertion_r_radial_tuberosity',
  },
  {
    actuator: 'BRA',
    group: 'brachialis_r',
    groupName: 'Brachialis, right',
    taTerm: 'Musculus brachialis',
    innervation: 'Musculocutaneous nerve',
    id: 'brachialis_r',
    name: 'Brachialis, right',
    origin: 'brachialis_origin_r_anteromedial_surface_of_humerus',
    insertion: 'brachialis_insertion_r_tuberosity_of_ulna',
  },
  {
    actuator: 'BRD',
    group: 'brachioradialis_r',
    groupName: 'Brachioradialis, right',
    taTerm: 'Musculus brachioradialis',
    innervation: 'Radial nerve',
    id: 'brachioradialis_r',
    name: 'Brachioradialis, right',
    origin: 'brachioradialis_origin_r_lateral_supracondylar_ridge',
    insertion: 'brachioradialis_insertion_r_radial_styloid_process',
  },
  {
    actuator: 'TRIlong',
    group: 'triceps_brachii_r',
    groupName: 'Triceps brachii, right',
    taTerm: 'Musculus triceps brachii',
    innervation: 'Radial nerve',
    id: 'triceps_brachii_long_r',
    name: 'Triceps brachii, long head, right',
    origin: 'triceps_brachii_origin_r_infraglenoid_tubercle',
    insertion: 'triceps_brachii_insertion_r_olecranon',
  },
  {
    actuator: 'TRIlat',
    group: 'triceps_brachii_r',
    id: 'triceps_brachii_lateral_r',
    name: 'Triceps brachii, lateral head, right',
    origin: 'triceps_brachii_origin_r_posterior_surface_of_humerus',
    insertion: 'triceps_brachii_insertion_r_olecranon',
  },
  {
    actuator: 'TRImed',
    group: 'triceps_brachii_r',
    id: 'triceps_brachii_medial_r',
    name: 'Triceps brachii, medial head, right',
    origin: 'triceps_brachii_origin_r_posterior_surface_of_humerus',
    insertion: 'triceps_brachii_insertion_r_olecranon',
  },
];

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
  for (const unit of UNITS) {
    const parameters = actuators.get(unit.actuator);
    if (parameters === undefined) {
      throw new Error(
        `${MUSCLE_FILE} has no actuator named '${unit.actuator}'. The vendored commit may have ` +
          'moved; check tools/validate-external/README.md before changing this mapping.',
      );
    }
    if (!groups.has(unit.group)) groups.set(unit.group, []);
    groups.get(unit.group).push({ ...unit, parameters });
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
        path: [],
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
 * The paths are empty. Every one of these muscles wraps in the source model -- brachialis over a
 * cylinder, both biceps heads over two ellipsoids each -- and the wrap geometry is in MyoSuite's
 * frames, so it needs the same reconciliation the via points do, and a solver that can wrap
 * (N1.4). Until then these are straight lines from origin to insertion, which is wrong about the
 * moment arm near full flexion in the direction of underestimating it. Recorded as OQ-015.
 *
 * Pennation is zero for every unit. That is not a gap: the MuJoCo muscle model has no pennation
 * angle at all, so the conversion folded it into the peak force and the force declared here is
 * already the force along the tendon. What it costs is recorded as OQ-014.
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
  console.log(`generate-elbow-muscles: ok. ${UNITS.length} units match ${MUSCLE_FILE}.`);
} else {
  writeFileSync(OUT, rendered);
  console.log(
    `generate-elbow-muscles: wrote ${relative(ROOT, OUT)} -- ${UNITS.length} units from ${MUSCLE_FILE}.`,
  );
}
