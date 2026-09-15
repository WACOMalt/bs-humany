#!/usr/bin/env node
/**
 * Generates the shoulder muscle parameter set from the vendored MyoSuite arm model.
 *
 *   pnpm generate:shoulder-muscles          # rewrite packages/muscle-data/src/shoulder.ts
 *   pnpm generate:shoulder-muscles --check  # fail if the file is not what this would write
 *
 * The same two files and the same two derivations as the elbow set -- both live in
 * `tools/cli/lib/myoArm.mjs` -- so what is here is the part that is about the shoulder.
 *
 * ## Which muscles, and which are missing
 *
 * The eight that run from the shoulder girdle to the humerus and have parameters worth carrying:
 * the three heads of deltoid, the four of the rotator cuff (supraspinatus, infraspinatus,
 * subscapularis, teres minor) and teres major. Each is a separate line of action, per M-ADR-005,
 * and the deltoid's three heads matter more than most: they pull in three different directions
 * and a single line through the middle of them abducts the arm where the real muscle would
 * rotate it.
 *
 * Coracobrachialis is the ninth and it is left out, because the source's two statements about it
 * do not agree: its operating range and its length range imply a 312 mm fiber on a tendon 45 mm
 * shorter than nothing. `requirePhysical` refuses such an actuator rather than letting a negative
 * slack length into a model that divides by it, and this is the one in this file that trips it.
 *
 * Pectoralis major and latissimus dorsi are not here, and the reason is a frame rather than an
 * omission. Both originate on the trunk, and the via points that hold their paths are stated in
 * the reference model's *torso* chain -- a different file with its own body frames. Carrying a
 * point across means asking both models for the same anatomical construction and taking the
 * rotation between the answers, which is done for the arm and has not been done for the torso.
 * Until it is, those two would be straight lines from the sternum to the humerus, which is worse
 * than not having them.
 *
 * ## No wrap surface, and why not
 *
 * These units ran over the head of the humerus at first -- a sphere, measured by the articular fit
 * that located the shoulder's joint centre -- and every one of them was taken off it again. Not
 * because the surface is wrong, but because none of them uses it steadily.
 *
 * Swept through twenty-four shoulder poses, four of the units never touched it and the other four
 * touched it between a fifth and two fifths of the time. A wrap that engages on one tick and not
 * the next changes a path by centimetres, and a tendon that stiff turns centimetres into
 * kilonewtons: what it looks like is the arm twitching and its rotation flipping, which is what it
 * did. The same lesson as the humeral shaft cylinder in OQ-015 -- a muscle that only grazes a
 * surface is worse off with it than without it.
 *
 * The anatomy agrees. The four cuff muscles insert *on* the head, at the tubercles, ten to fifteen
 * millimetres outside a sphere of twenty-four: they lie against it and attach rather than turning
 * over it, and their leverage comes from where the tubercle stands, not from a radius. The deltoid
 * drapes over the head laterally and is held there by the via points carried from the reference.
 *
 * The surface itself stays in the skeleton. It is correct geometry, measured, and the muscle that
 * genuinely rides it -- the long head of biceps in its groove -- is a path this set does not yet
 * carry.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { ARM, readActuators, renderGroups, requirePhysical, sided } from '../lib/myoSuite.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/muscle-data/src/shoulder.ts');
const check = process.argv.includes('--check');

const jiti = createJiti(import.meta.url);
const { VIA_PATH_DIRECTION, viaPointsFor } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/muscleViaPoints.ts'),
);

/** Which actuator becomes which unit, and which of our attachment sites it binds to. */
const UNITS = [
  {
    actuator: 'DELT1',
    group: 'deltoid_$',
    groupName: 'Deltoid',
    taTerm: 'Musculus deltoideus',
    innervation: 'Axillary nerve',
    id: 'deltoid_anterior_$',
    name: 'Deltoid, anterior part',
    origin: 'deltoid_origin_$_acromial_end',
    insertion: 'deltoid_insertion_$_deltoid_tuberosity',
  },
  {
    actuator: 'DELT2',
    group: 'deltoid_$',
    id: 'deltoid_middle_$',
    name: 'Deltoid, middle part',
    origin: 'deltoid_origin_$_acromion',
    insertion: 'deltoid_insertion_$_deltoid_tuberosity',
  },
  {
    actuator: 'DELT3',
    group: 'deltoid_$',
    id: 'deltoid_posterior_$',
    name: 'Deltoid, posterior part',
    origin: 'deltoid_origin_$_spine_of_scapula',
    insertion: 'deltoid_insertion_$_deltoid_tuberosity',
  },
  {
    actuator: 'SUPSP',
    group: 'supraspinatus_$',
    groupName: 'Supraspinatus',
    taTerm: 'Musculus supraspinatus',
    innervation: 'Suprascapular nerve',
    id: 'supraspinatus_$',
    name: 'Supraspinatus',
    origin: 'supraspinatus_origin_$_supraspinous_fossa',
    insertion: 'supraspinatus_insertion_$_greater_tubercle',
  },
  {
    actuator: 'INFSP',
    group: 'infraspinatus_$',
    groupName: 'Infraspinatus',
    taTerm: 'Musculus infraspinatus',
    innervation: 'Suprascapular nerve',
    id: 'infraspinatus_$',
    name: 'Infraspinatus',
    origin: 'infraspinatus_origin_$_infraspinous_fossa',
    insertion: 'infraspinatus_insertion_$_greater_tubercle',
  },
  {
    actuator: 'SUBSC',
    group: 'subscapularis_$',
    groupName: 'Subscapularis',
    taTerm: 'Musculus subscapularis',
    innervation: 'Subscapular nerves',
    id: 'subscapularis_$',
    name: 'Subscapularis',
    origin: 'subscapularis_origin_$_subscapular_fossa',
    insertion: 'subscapularis_insertion_$_lesser_tubercle',
  },
  {
    actuator: 'TMIN',
    group: 'teres_minor_$',
    groupName: 'Teres minor',
    taTerm: 'Musculus teres minor',
    innervation: 'Axillary nerve',
    id: 'teres_minor_$',
    name: 'Teres minor',
    origin: 'teres_minor_origin_$_lateral_border_of_scapula',
    insertion: 'teres_minor_insertion_$_greater_tubercle',
  },
  {
    actuator: 'TMAJ',
    group: 'teres_major_$',
    groupName: 'Teres major',
    taTerm: 'Musculus teres major',
    innervation: 'Lower subscapular nerve',
    id: 'teres_major_$',
    name: 'Teres major',
    origin: 'teres_major_origin_$_inferior_angle_of_scapula',
    insertion: 'teres_major_insertion_$_crest_of_lesser_tubercle',
  },
];

function render() {
  const actuators = readActuators();
  const units = sided(UNITS).map((unit) => {
    const parameters = actuators.get(unit.actuator);
    if (parameters === undefined) {
      throw new Error(
        `${ARM.muscle} has no actuator named '${unit.actuator}'. The vendored commit may have ` +
          'moved; check tools/validate-external/README.md before changing this mapping.',
      );
    }
    requirePhysical(unit.actuator, parameters);
    // No wrap: the via points hold each path where it belongs, and the head is a surface these
    // muscles graze rather than ride. See the note at the top of this file.
    return { ...unit, parameters };
  });
  const body = renderGroups(units, viaPointsFor, VIA_PATH_DIRECTION);

  return `/**
 * The shoulder muscle parameter set -- ticket N2.5, the region after the elbow.
 *
 * **Generated by \`pnpm generate:shoulder-muscles\`. Do not edit.** The numbers are extracted from
 * the vendored MyoSuite arm model rather than copied out of it, so the value here and the value
 * in the cited file cannot disagree; CI runs the generator with \`--check\`.
 *
 * ## Where each half comes from
 *
 * The same split as the elbow set, and for the same reason. *Where a muscle attaches* is ours:
 * Gray's anatomical statement located on this subject by the dataset's own markers, in this
 * project's bone frames. *What a muscle can do* is MyoSuite's: peak force, optimal fiber length
 * and tendon slack length are scalars, so they cross frames without reinterpretation.
 *
 * ## Nine units, and the two that are missing
 *
 * The three heads of deltoid, the four of the rotator cuff, teres major and coracobrachialis --
 * every muscle running from the shoulder girdle to the humerus. Pectoralis major and latissimus
 * dorsi run from the trunk, and their via points live in the reference model's torso chain, whose
 * frames have not been reconciled with ours the way the arm's have. A straight line from the
 * sternum to the humerus would be worse than nothing, so they wait for that work.
 *
 * ## No wrap surface
 *
 * These paths are held by via points alone. The head of the humerus is in the skeleton as a
 * measured sphere and was tried here first, and every unit came off it again: swept through
 * twenty-four shoulder poses, half never touched it and half touched it between a fifth and two
 * fifths of the time. A wrap that comes and goes changes a path by centimetres from one tick to
 * the next, and a tendon that stiff turns that into kilonewtons -- the arm twitches and its
 * rotation flips.
 *
 * The anatomy agrees with the measurement. The cuff inserts *on* the head, at the tubercles,
 * barely outside it: those muscles lie against the head and attach rather than turning over it,
 * and their leverage is where the tubercle stands rather than a radius.
 */

import { cite } from '@bs-humany/hsdl';
import type { MuscleGroup } from './schema.js';

/** Anatomy: which bony feature a muscle attaches to. The sites themselves are cited in M5.3. */
const gray = (muscle: string) => cite('gray1918', \`Part IV, Myology: The \${muscle}\`);

/** Parameters: the actuator in the vendored arm model they were derived from. */
const myoArm = (actuator: string) =>
  cite(
    'caggiano2022',
    \`${ARM.muscle}, actuator general name="\${actuator}": gainprm force, and optimal fiber \` +
      'length and tendon slack length derived from gainprm range with lengthrange',
  );

export const SHOULDER_MUSCLES: readonly MuscleGroup[] = [
${body}
];

/** Every unit in the set, flattened, in a stable order. */
export const SHOULDER_UNITS = SHOULDER_MUSCLES.flatMap((group) => group.units);
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
      `generate-shoulder-muscles: ${relative(ROOT, OUT)} is not what the generator would write.\n` +
        '  Run `pnpm generate:shoulder-muscles`. If the vendored model changed, say so in the ' +
        'commit.',
    );
    process.exit(1);
  }
  console.log(`generate-shoulder-muscles: ok. ${sided(UNITS).length} units match ${ARM.muscle}.`);
} else {
  writeFileSync(OUT, rendered);
  console.log(
    `generate-shoulder-muscles: wrote ${relative(ROOT, OUT)} -- ${sided(UNITS).length} units from ${ARM.muscle}.`,
  );
}
