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
 * ## One surface, and which side of it
 *
 * Every unit turns over the head of the humerus, a sphere whose radius is the articular fit that
 * located the shoulder's joint centre. That is what the reference does too, with rather more
 * surfaces: several of these paths wrap two or three geoms apiece, at the head and again at the
 * acromion or the shaft. The solver takes one per span until N1.5, so each unit gets the head --
 * the surface all nine share, and the one whose radius sets their leverage.
 *
 * Which side of it each passes on is anatomy, and unlike the elbow it is not the same on both
 * arms: the elbow's sides are anterior and posterior, which are the same direction on either
 * side of the body, while the shoulder's include lateral and medial, which are opposite. So the
 * left side's declarations are mirrored in X, and only in X.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import {
  MUSCLE_FILE,
  readActuators,
  renderGroups,
  requirePhysical,
  sided,
} from '../lib/myoArm.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/muscle-data/src/shoulder.ts');
const check = process.argv.includes('--check');

const jiti = createJiti(import.meta.url);
const { VIA_PATH_DIRECTION, viaPointsFor } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/muscleViaPoints.ts'),
);

/**
 * Which actuator becomes which unit, which of our attachment sites it binds to, and which side of
 * the humeral head it passes on.
 *
 * `side` is in the dataset's own frame for the right arm, where +X is lateral, +Y superior and
 * +Z posterior. The left arm's is this mirrored in X.
 */
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
    side: { x: 0.7, y: 0, z: -0.7 },
  },
  {
    actuator: 'DELT2',
    group: 'deltoid_$',
    id: 'deltoid_middle_$',
    name: 'Deltoid, middle part',
    origin: 'deltoid_origin_$_acromion',
    insertion: 'deltoid_insertion_$_deltoid_tuberosity',
    side: { x: 1, y: 0, z: 0 },
  },
  {
    actuator: 'DELT3',
    group: 'deltoid_$',
    id: 'deltoid_posterior_$',
    name: 'Deltoid, posterior part',
    origin: 'deltoid_origin_$_spine_of_scapula',
    insertion: 'deltoid_insertion_$_deltoid_tuberosity',
    side: { x: 0.7, y: 0, z: 0.7 },
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
    // Over the top of the head, which is what makes it the muscle that starts an abduction.
    side: { x: 0, y: 1, z: 0 },
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
    side: { x: 0, y: 0, z: 1 },
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
    // In front of the head: the one cuff muscle on the anterior side, and the internal rotator.
    side: { x: 0, y: 0, z: -1 },
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
    side: { x: 0, y: 0, z: 1 },
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
    // Round the inside of the humerus to the lesser tubercle, which is why it rotates the arm in.
    side: { x: -1, y: 0, z: 0 },
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
    requirePhysical(unit.actuator, parameters);
    return {
      ...unit,
      parameters,
      wrap: `humeral_head_${unit.side_}`,
      // Lateral on the left arm is the other way along X; anterior and superior are not.
      preferredSide:
        unit.side_ === 'r' ? unit.side : { x: -unit.side.x, y: unit.side.y, z: unit.side.z },
    };
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
 * ## The humeral head
 *
 * All nine turn over it, and it is a sphere rather than a cylinder because the head is one: its
 * radius is the articular fit that located the shoulder's joint centre, over 681 vertices with a
 * residual of about a millimetre. A sphere centred on the joint centre has the same moment arm
 * about every axis through it, which is what a ball joint means.
 *
 * Which side each unit passes on is declared rather than discovered, because a path that fell to
 * the other side of the head between one tick and the next would reverse that muscle's action.
 * The sides are mirrored in X for the left arm and not in Y or Z: lateral is opposite on the two
 * sides of a body, and superior and anterior are not.
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
  console.log(`generate-shoulder-muscles: ok. ${sided(UNITS).length} units match ${MUSCLE_FILE}.`);
} else {
  writeFileSync(OUT, rendered);
  console.log(
    `generate-shoulder-muscles: wrote ${relative(ROOT, OUT)} -- ${sided(UNITS).length} units from ${MUSCLE_FILE}.`,
  );
}
