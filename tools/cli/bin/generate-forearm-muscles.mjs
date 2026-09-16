#!/usr/bin/env node
/**
 * Generates the forearm and wrist muscle parameter set from the vendored MyoSuite arm model.
 *
 *   pnpm generate:forearm-muscles          # rewrite packages/muscle-data/src/forearm.ts
 *   pnpm generate:forearm-muscles --check  # fail if the file is not what this would write
 *
 * ## Two kinds of actuator, and only one of them states architecture
 *
 * The arm model writes its actuators two ways and they do not say the same things. The upper arm's
 * are `<general>` elements carrying an operating range of their own, and that range with
 * `lengthrange` determines optimal fiber length and tendon slack length exactly, which is how every
 * other set in this project is extracted. The forearm's are `<muscle>` elements stating `force` and
 * `lengthrange` and no range at all, so MuJoCo's own default of 0.75 to 1.05 applies -- and that
 * default is not a statement about any muscle. Derived from it the fiber lengths come out 1.1 to
 * 5.6 times published, with pronator quadratus landing on a tendon of minus 16 mm, which is the
 * signature `requirePhysical` refuses elsewhere.
 *
 * Two of this set's eight are written the other way and prove the reading: supinator and anconeus
 * are `<general>`, and their derived fiber lengths are 36 mm and 26 mm against a published 33 and
 * 27. What the other six get instead is the one thing their elements do state, which is a length
 * range, divided by `TYPICAL_NORMALISED_TRAVEL` -- the travel a muscle typically has, measured
 * from the fifty-four actuators that do state architecture. Peak force is the source's throughout.
 *
 * Checked against published architecture that lands well: 34 mm against 36 for pronator teres,
 * 23 against 23 for pronator quadratus, 53 against 52 for flexor carpi radialis, 59 against 51 for
 * flexor carpi ulnaris, 47 against 59 for extensor carpi radialis brevis. Extensor carpi radialis
 * longus is the outlier at 42 against 81. It is a stand-in and OQ-022 says so, but it is a good
 * one, and it goes through the same travel translation every other set does rather than round it.
 *
 * Deriving from *our* travel instead was tried and is worse: our wrist flexes 45 degrees where a
 * real one does 80, and our forearm attachments sit nearer their joint axes, so the muscles travel
 * less here than they should and the fibers came out at 18, 5, 20 and 23 mm against the same
 * published figures. The source's own length range is the better statement of how long these
 * muscles are.
 *
 * ## What the dataset marks in a hand, which is almost nothing
 *
 * Four muscles here end past the wrist and the dataset marks four points beyond it: the tubercles
 * of the scaphoid and the trapezium, the hook of the hamate, and the base and styloid process of
 * the third metacarpal. Nothing on the first, second, fourth or fifth metacarpals, and nothing on
 * the pisiform.
 *
Worse, the trapezium's tubercle
 * is marked on the right hand and not on the left.
 *
 * So extensor carpi radialis brevis ends exactly where it should, on the third metacarpal's
 * styloid, and the rest end at the nearest marked point along their own anatomy: flexor carpi
 * radialis at the scaphoid's tubercle, the radial anchor of the retinaculum its tendon passes
 * under; flexor carpi ulnaris at the hook of the hamate, which Gray gives it through the
 * pisohamate ligament; extensor carpi radialis longus at the third metacarpal's base, standing in
 * for the second's.
 *
 * Two are left out for want of anywhere to put them. Extensor carpi ulnaris ends on the base of
 * the fifth metacarpal, unmarked and on the side of the hand nothing else here reaches, so no
 * nearby point would leave it an ulnar deviator rather than something else. Palmaris longus ends
 * in the middle of the palm, and the only marked points are at its two edges -- put at either it
 * would duplicate a muscle already there, and it is the weakest in the set and missing altogether
 * in about one person in seven. That leaves the wrist two flexors, one radial and one ulnar, and
 * two extensors, both radial.
 *
 * ## One ridge, two muscles
 *
 * Extensor carpi radialis longus arises from the lower third of the lateral supracondylar ridge
 * and brachioradialis from the upper two-thirds. The dataset marks that ridge once, near its
 * bottom. `ridgeAttachments.ts` measures both portions off the mesh: 14 mm above the elbow and 65.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { ARM, readActuators, renderGroups, requirePhysical, sided } from '../lib/myoSuite.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/muscle-data/src/forearm.ts');
const check = process.argv.includes('--check');

const jiti = createJiti(import.meta.url);
const { VIA_PATH_DIRECTION, viaPointsFor } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/muscleViaPoints.ts'),
);

/** Which actuator becomes which unit, and which of our attachment sites it binds to. */
const UNITS = [
  {
    actuator: 'PT',
    group: 'pronator_teres_$',
    groupName: 'Pronator teres',
    taTerm: 'Musculus pronator teres',
    innervation: 'Median nerve',
    id: 'pronator_teres_$',
    name: 'Pronator teres',
    origin: 'pronator_teres_origin_$_medial_epicondyle_of_humerus',
    insertion: 'pronator_teres_insertion_$_pronator_tuberosity',
  },
  {
    actuator: 'PQ',
    group: 'pronator_quadratus_$',
    groupName: 'Pronator quadratus',
    taTerm: 'Musculus pronator quadratus',
    innervation: 'Anterior interosseous nerve',
    id: 'pronator_quadratus_$',
    name: 'Pronator quadratus',
    origin: 'pronator_quadratus_origin_$_medial_surface_of_ulna',
    insertion: 'pronator_quadratus_insertion_$_anterior_surface_of_radius',
  },
  {
    actuator: 'SUP',
    group: 'supinator_$',
    groupName: 'Supinator',
    taTerm: 'Musculus supinator',
    innervation: 'Posterior interosseous nerve',
    id: 'supinator_$',
    name: 'Supinator',
    origin: 'supinator_origin_$_supinator_crest',
    insertion: 'supinator_insertion_$_lateral_surface_of_radius',
  },
  {
    actuator: 'ANC',
    group: 'anconeus_$',
    groupName: 'Anconeus',
    taTerm: 'Musculus anconeus',
    innervation: 'Radial nerve',
    id: 'anconeus_$',
    name: 'Anconeus',
    origin: 'anconeus_origin_$_lateral_epicondyle_of_humerus',
    insertion: 'anconeus_insertion_$_olecranon',
  },
  {
    actuator: 'FCR',
    group: 'flexor_carpi_radialis_$',
    groupName: 'Flexor carpi radialis',
    taTerm: 'Musculus flexor carpi radialis',
    innervation: 'Median nerve',
    id: 'flexor_carpi_radialis_$',
    name: 'Flexor carpi radialis',
    origin: 'flexor_carpi_radialis_origin_$_medial_epicondyle_of_humerus',
    insertion: 'flexor_carpi_radialis_insertion_$_tubercle_of_scaphoid_bone',
  },
  {
    actuator: 'FCU',
    group: 'flexor_carpi_ulnaris_$',
    groupName: 'Flexor carpi ulnaris',
    taTerm: 'Musculus flexor carpi ulnaris',
    innervation: 'Ulnar nerve',
    id: 'flexor_carpi_ulnaris_$',
    name: 'Flexor carpi ulnaris',
    origin: 'flexor_carpi_ulnaris_origin_$_footprint',
    insertion: 'flexor_carpi_ulnaris_insertion_$_hook_of_hamate_bone',
  },
  {
    actuator: 'ECRL',
    group: 'extensor_carpi_radialis_$',
    groupName: 'Extensor carpi radialis',
    taTerm: 'Musculi extensores carpi radiales',
    innervation: 'Radial nerve, and its posterior interosseous branch for brevis',
    id: 'extensor_carpi_radialis_longus_$',
    name: 'Extensor carpi radialis longus',
    origin: 'extensor_carpi_radialis_longus_origin_$_lateral_supracondylar_ridge',
    insertion: 'extensor_carpi_radialis_longus_insertion_$_metacarpal_base',
  },
  {
    actuator: 'ECRB',
    group: 'extensor_carpi_radialis_$',
    id: 'extensor_carpi_radialis_brevis_$',
    name: 'Extensor carpi radialis brevis',
    origin: 'extensor_carpi_radialis_brevis_origin_$_lateral_epicondyle_of_humerus',
    insertion:
      'extensor_carpi_radialis_brevis_insertion_$_styloid_process_of_third_metacarpal_bone',
  },
];

function render() {
  const actuators = readActuators(ARM);
  const units = sided(UNITS).map((unit) => {
    const parameters = actuators.get(unit.actuator);
    if (parameters === undefined) {
      throw new Error(
        `${ARM.muscle} has no actuator named '${unit.actuator}'. The vendored commit may have ` +
          'moved; check tools/validate-external/README.md before changing this mapping.',
      );
    }
    // Only the ones that state an operating range can have their two lengths checked against each
    // other; for the rest there is no second statement to disagree with the first.
    if (parameters.architecture === 'stated') requirePhysical(unit.actuator, parameters, ARM);
    return {
      ...unit,
      parameters,
      ...(unit.side === undefined ? {} : { preferredSide: unit.side }),
    };
  });
  const body = renderGroups(units, viaPointsFor, VIA_PATH_DIRECTION, ARM);

  return `/**
 * The forearm and wrist muscle parameter set -- ticket N2.5.
 *
 * **Generated by \`pnpm generate:forearm-muscles\`. Do not edit.** CI runs the generator with
 * \`--check\`.
 *
 * ## What is transcribed here and what is not
 *
 * Peak force is the source's for all nine. So is the fiber length of supinator and anconeus, whose
 * actuators state an operating range the fiber length can be derived from -- and which come out at
 * 36 mm and 26 mm against a published 33 and 27.
 *
 * The other seven state no such range, so MuJoCo's default applies and no fiber length can be
 * derived from it: doing so gives 1.1 to 5.6 times published and one tendon of minus 16 mm. Those
 * seven carry \`fiberLengthFromTravel\`, and the compiler works out a fiber length from how far the
 * muscle travels on *this* skeleton, over the travel a muscle typically has. It is a stand-in good
 * to about half and it is labelled as one. OQ-022 has the argument, the numbers and the licence
 * reason the better source could not be vendored.
 *
 * *Where a muscle attaches* is ours throughout, as everywhere: Gray's anatomical statement located
 * on this subject by the dataset's own markers.
 *
 * ## The hand is nearly unmarked, and one muscle is missing because of it
 *
 * Beyond the wrist the dataset marks four points: the tubercles of the scaphoid and trapezium, the
 * hook of the hamate, and the base and styloid of the third metacarpal -- and the trapezium's only
 * on the right hand. Extensor carpi radialis brevis ends exactly where it should; the others end at
 * the nearest marked point along their own anatomy. Extensor carpi ulnaris and palmaris longus are
 * left out for want of anywhere to put them that would leave them a line of their own. The wrist
 * has two flexors, one radial and one ulnar, and two extensors, both radial.
 */

import { cite } from '@bs-humany/hsdl';
import type { MuscleGroup } from './schema.js';

/** Anatomy: which bony feature a muscle attaches to. The sites themselves are cited in M5.3. */
const gray = (muscle: string) => cite('gray1918', \`Part IV, Myology: The \${muscle}\`);

/** Parameters: the actuator in the vendored arm model they were derived from. */
const myoArm = (actuator: string) =>
  cite(
    'caggiano2022',
    \`${ARM.muscle}, actuator name="\${actuator}": peak force as stated. Fiber length from the \` +
      'operating range the actuator states where it has one, and otherwise from the travel ' +
      'measured on this skeleton (OQ-022), which the unit marks with fiberLengthFromTravel',
  );

export const FOREARM_MUSCLES: readonly MuscleGroup[] = [
${body}
];

/** Every unit in the set, flattened, in a stable order. */
export const FOREARM_UNITS = FOREARM_MUSCLES.flatMap((group) => group.units);
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
      `generate-forearm-muscles: ${relative(ROOT, OUT)} is not what the generator would write.\n` +
        '  Run `pnpm generate:forearm-muscles`. If the vendored model changed, say so in the commit.',
    );
    process.exit(1);
  }
  console.log(`generate-forearm-muscles: ok. ${sided(UNITS).length} units match ${ARM.muscle}.`);
} else {
  writeFileSync(OUT, rendered);
  console.log(
    `generate-forearm-muscles: wrote ${relative(ROOT, OUT)} -- ${sided(UNITS).length} units from ${ARM.muscle}.`,
  );
}
