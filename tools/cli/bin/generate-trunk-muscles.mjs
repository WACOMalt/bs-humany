#!/usr/bin/env node
/**
 * Generates the back and chest muscle parameter set from the vendored MyoSuite arm model.
 *
 *   pnpm generate:trunk-muscles          # rewrite packages/muscle-data/src/trunk.ts
 *   pnpm generate:trunk-muscles --check  # fail if the file is not what this would write
 *
 * The two muscles that hold the arm onto the trunk: latissimus dorsi behind and pectoralis major
 * in front. Between them they are most of what pulls an arm down and across, which nothing in the
 * shoulder set does -- the deltoid and the cuff lift and turn the humerus, and the trunk muscles
 * are what brings it back.
 *
 * ## Four units, and the two the source cannot describe
 *
 * The reference carries three parts of each, which is right: pectoralis major's clavicular head
 * flexes the arm, its sternocostal head adducts it and its abdominal part pulls it down and in,
 * and one line through the middle of them does none of those. Two of the six state an operating
 * range and a length range that disagree -- `LAT2` implies a 395 mm fiber on a tendon 60 mm
 * shorter than nothing and `PECM1` a 189 mm fiber on one 65 mm shorter -- and the generator
 * refuses them rather than carrying a negative slack length into a model that divides by it. It is
 * the coracobrachialis case again, and the third time in this project.
 *
 * What is lost is the middle of latissimus, off the thoracolumbar fascia, and the *clavicular*
 * head of pectoralis major, which is the part that flexes. What is kept is latissimus from the
 * thoracic spine and from the iliac crest, and pectoralis major from the sternum and the sixth
 * rib. Both muscles still adduct and extend the arm; pectoralis major no longer flexes it.
 *
 * ## No wrap surfaces, and what holds these paths instead
 *
 * The reference wraps all four over the humeral head, a thorax ellipsoid, or both. None of those
 * is carried: the ellipsoid this project refuses outright (OQ-016, no closed-form geodesic) and
 * the humeral head was measured and dropped from the shoulder set, because it engaged at some
 * poses and not others and a stiff tendon turns that into kilonewtons.
 *
 * What holds latissimus instead is its own via point on the scapula, carried from the reference,
 * which routes it around the back rather than through the chest. Pectoralis major needs no such
 * help: a line from the sternum to the humerus runs across the front of the chest, which is where
 * the muscle runs.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { ARM, readActuators, renderGroups, requirePhysical, sided } from '../lib/myoSuite.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/muscle-data/src/trunk.ts');
const check = process.argv.includes('--check');

const jiti = createJiti(import.meta.url);
const { VIA_PATH_DIRECTION, viaPointsFor } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/muscleViaPoints.ts'),
);

/** Which actuator becomes which unit, and which of our attachment sites it binds to. */
const UNITS = [
  {
    actuator: 'LAT1',
    group: 'latissimus_dorsi_$',
    groupName: 'Latissimus dorsi',
    taTerm: 'Musculus latissimus dorsi',
    innervation: 'Thoracodorsal nerve',
    id: 'latissimus_dorsi_thoracic_$',
    name: 'Latissimus dorsi, thoracic part',
    origin: 'latissimus_dorsi_origin_$_spinous_process_tip',
    insertion: 'latissimus_dorsi_insertion_$_intertubercular_sulcus',
  },
  {
    actuator: 'LAT2',
    group: 'latissimus_dorsi_$',
    id: 'latissimus_dorsi_lumbar_$',
    name: 'Latissimus dorsi, lumbar part',
    origin: 'latissimus_dorsi_origin_$_median_sacral_crest',
    insertion: 'latissimus_dorsi_insertion_$_intertubercular_sulcus',
  },
  {
    actuator: 'LAT3',
    group: 'latissimus_dorsi_$',
    id: 'latissimus_dorsi_iliac_$',
    name: 'Latissimus dorsi, iliac part',
    origin: 'latissimus_dorsi_origin_$_iliac_crest',
    insertion: 'latissimus_dorsi_insertion_$_intertubercular_sulcus',
  },
  {
    actuator: 'PECM1',
    group: 'pectoralis_major_$',
    groupName: 'Pectoralis major',
    taTerm: 'Musculus pectoralis major',
    innervation: 'Lateral and medial pectoral nerves',
    id: 'pectoralis_major_clavicular_$',
    name: 'Pectoralis major, clavicular head',
    origin: 'pectoralis_major_origin_$_sternal_end',
    insertion: 'pectoralis_major_insertion_$_crest_of_greater_tubercle',
  },
  {
    actuator: 'PECM2',
    group: 'pectoralis_major_$',
    id: 'pectoralis_major_sternal_$',
    name: 'Pectoralis major, sternocostal head',
    origin: 'pectoralis_major_origin_$_manubrium_of_sternum',
    insertion: 'pectoralis_major_insertion_$_crest_of_greater_tubercle',
  },
  {
    actuator: 'PECM3',
    group: 'pectoralis_major_$',
    id: 'pectoralis_major_abdominal_$',
    name: 'Pectoralis major, abdominal part',
    origin: 'pectoralis_major_origin_$_body_of_rib',
    insertion: 'pectoralis_major_insertion_$_crest_of_greater_tubercle',
  },
];

function render() {
  const actuators = readActuators(ARM);
  const units = sided(UNITS).map((unit) => {
    // The reference model's arm is a right arm and names its actuators for it, so both of ours
    // read the same one.
    const parameters = actuators.get(unit.actuator);
    if (parameters === undefined) {
      throw new Error(
        `${ARM.muscle} has no actuator named '${unit.actuator}'. The vendored commit may have ` +
          'moved; check tools/validate-external/README.md before changing this mapping.',
      );
    }
    requirePhysical(unit.actuator, parameters, ARM);
    return {
      ...unit,
      parameters,
      ...(unit.side === undefined ? {} : { preferredSide: unit.side }),
    };
  });
  const body = renderGroups(units, viaPointsFor, VIA_PATH_DIRECTION, ARM);

  return `/**
 * The back and chest muscle parameter set -- the two that hold the arm onto the trunk.
 *
 * **Generated by \`pnpm generate:trunk-muscles\`. Do not edit.** The numbers are extracted from the
 * vendored MyoSuite arm model rather than copied out of it, so the value here and the value in the
 * cited file cannot disagree; CI runs the generator with \`--check\`.
 *
 * ## Where each half comes from
 *
 * The same split as every other set. *Where a muscle attaches* is ours: Gray's anatomical
 * statement located on this subject by the dataset's own markers, which for these two means the
 * thoracic spine, the iliac crest, the sternum and the sixth rib. *What a muscle can do* is
 * MyoSuite's. Both lengths are derived against this skeleton at compile.
 *
 * ## Four parts of six
 *
 * The reference carries three of each and two of those six cannot be used: \`LAT2\` states an
 * operating range and a length range implying a 395 mm fiber on a tendon 60 mm shorter than
 * nothing, and \`PECM1\` a 189 mm fiber on one 65 mm shorter. The generator refuses them. What is
 * lost is the middle of latissimus, off the thoracolumbar fascia, and the clavicular head of
 * pectoralis major -- so this pectoralis adducts the arm and pulls it down but does not flex it.
 *
 * ## The trunk end of the reference's paths is not carried
 *
 * MyoArm is an arm, and it anchors these two to its own root rather than to a spine it does not
 * have: their last three path points sit on the model's world body. Ours start where Gray says
 * they start, on bones this skeleton has. What is carried is the arm end -- the point on the
 * scapula that routes latissimus around the back, and the points on the humerus.
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

export const TRUNK_MUSCLES: readonly MuscleGroup[] = [
${body}
];

/** Every unit in the set, flattened, in a stable order. */
export const TRUNK_UNITS = TRUNK_MUSCLES.flatMap((group) => group.units);
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
      `generate-trunk-muscles: ${relative(ROOT, OUT)} is not what the generator would write.\n` +
        '  Run `pnpm generate:trunk-muscles`. If the vendored model changed, say so in the commit.',
    );
    process.exit(1);
  }
  console.log(`generate-trunk-muscles: ok. ${sided(UNITS).length} units match ${ARM.muscle}.`);
} else {
  writeFileSync(OUT, rendered);
  console.log(
    `generate-trunk-muscles: wrote ${relative(ROOT, OUT)} -- ${sided(UNITS).length} units from ${ARM.muscle}.`,
  );
}
