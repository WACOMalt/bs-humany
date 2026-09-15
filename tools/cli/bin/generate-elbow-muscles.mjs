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
 * ## What this file decides, and what it only assembles
 *
 * The derivations are in `tools/cli/lib/myoArm.mjs`, because the shoulder set comes out of the
 * same two files by the same two steps: what MuJoCo states and what has to be derived from it,
 * and where a wrap belongs in a path. What is here is the part that is about the elbow -- which
 * actuator is which muscle, which of our attachment sites it binds to, which surface it turns
 * over and which side of it it lies on.
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
import { MUSCLE_FILE, readActuators, renderGroups, sided } from '../lib/myoArm.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/muscle-data/src/elbow.ts');
const check = process.argv.includes('--check');

const jiti = createJiti(import.meta.url);
const { viaPointsFor } = await jiti.import(join(ROOT, 'packages/skeleton/src/muscleViaPoints.ts'));

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

function render() {
  const actuators = readActuators();
  const units = sided(UNITS).map((unit) => {
    const parameters = actuators.get(unit.actuator);
    if (parameters === undefined) {
      throw new Error(
        `${MUSCLE_FILE} has no actuator named '${unit.actuator}'. The vendored commit may have ` +
          'moved; check tools/validate-external/README.md before changing this mapping.',
      );
    }
    return {
      ...unit,
      parameters,
      // Every unit turns over the trochlea on its own side, and declares which side of it it lies
      // on: the three heads of triceps behind the joint axis, the four flexors in front of it.
      wrap: `elbow_trochlea_${unit.side_}`,
      preferredSide: { x: 0, y: 0, z: unit.side === 'extensor' ? 1 : -1 },
    };
  });
  const body = renderGroups(units, viaPointsFor);

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
${body}
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
  console.log(`generate-elbow-muscles: ok. ${sided(UNITS).length} units match ${MUSCLE_FILE}.`);
} else {
  writeFileSync(OUT, rendered);
  console.log(
    `generate-elbow-muscles: wrote ${relative(ROOT, OUT)} -- ${sided(UNITS).length} units from ${MUSCLE_FILE}.`,
  );
}
