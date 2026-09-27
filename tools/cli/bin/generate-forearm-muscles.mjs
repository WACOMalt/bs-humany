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
 * Those six cite `myoArmStandIn` rather than `myoArm`, so the stand-in is named on the unit that
 * carries it and not only here.
 *
 * Checked against published architecture that lands well: 34 mm against 36 for pronator teres,
 * 23 against 23 for pronator quadratus, 53 against 52 for flexor carpi radialis, 59 against 51 for
 * flexor carpi ulnaris, 47 against 59 for extensor carpi radialis brevis. Extensor carpi radialis
 * longus is the outlier at 42 against 81. It is a stand-in and OQ-022 says so, but it is a good
 * one.
 *
 * Deriving from *our* travel instead was tried and is worse: our wrist flexes 45 degrees where a
 * real one does 80, and our forearm attachments sit nearer their joint axes, so the muscles travel
 * less here than they should and the fibers came out at 18, 5, 20 and 23 mm against the same
 * published figures. The source's own length range is the better statement of how long these
 * muscles are.
 *
 * That same shortfall is why the number written here is the number the simulation runs. Compile
 * passes all eight through `deriveOptimalFiberLength` as it does every set, and that step only
 * ever lengthens a fiber, by how much further the muscle travels on this skeleton than on the
 * source's (OQ-020). Every one of these travels less here -- at 1.7 m from 3 per cent of the
 * source's travel for anconeus to 72 for flexor carpi radialis, and still no more than 85 at
 * 2 m -- so none is lengthened. What the step can still do is cap a fiber at four fifths of its
 * path, which only a short body's anconeus reaches.
 *
 * ## What the dataset marks in a hand, and what had to be measured
 *
 * Four muscles here end past the wrist, and the dataset itself marks four points beyond it: the
 * tubercles of the scaphoid and the trapezium, the hook of the hamate, and the base and styloid
 * process of the third metacarpal. Nothing on the first, second, fourth or fifth metacarpals, and
 * nothing on the pisiform. Worse, the trapezium's tubercle is marked on the right hand and not on
 * the left.
 *
 * So extensor carpi radialis brevis ends exactly where it should, on the third metacarpal's
 * styloid, and flexor carpi ulnaris at the hook of the hamate, which Gray gives it through the
 * pisohamate ligament and which is the next marked thing along that chain. The other two end on
 * the base of the second metacarpal, where Gray puts them, because `tools/ingest/src/derived.ts`
 * now measures the base and head of every digit bone off the mesh: flexor carpi radialis keeps
 * the scaphoid's tubercle as the point it passes over on the way, the radial anchor of the
 * retinaculum its tendon runs under, and extensor carpi radialis longus passes the radial
 * styloid.
 *
 * Two muscles of the forearm are not in this set, and only one of them is missing from the body.
 * Extensor carpi ulnaris ends on the base of the fifth metacarpal, which was unmarked when this
 * set was built; once derived.ts measured the digit bones it had somewhere to go, and it went to
 * the hand set (`generate-hand-muscles.mjs`) rather than back here. Palmaris longus alone is
 * omitted. It ends in the palmar aponeurosis, in the middle of the palm, which is soft tissue
 * the dataset does not carry, and the nearest bony point is the scaphoid's tubercle where flexor
 * carpi radialis already passes -- put there it would duplicate a muscle already here, and it is
 * the weakest in the set and missing altogether in about one person in seven. That leaves the
 * wrist two flexors, one radial and one ulnar, and three extensors, two radial here and the ulnar
 * one in the hand set.
 *
 * ## One ridge, two muscles
 *
 * Extensor carpi radialis longus arises from the lower third of the lateral supracondylar ridge
 * and brachioradialis from the upper two-thirds. The dataset marks that ridge once, near its
 * bottom. `ridgeAttachments.ts` measures both portions off the mesh: 14 mm above the elbow and 65.
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { cliFlags } from '../lib/args.mjs';
import { emitOrCheck } from '../lib/generated.mjs';
import {
  ARM,
  TYPICAL_NORMALISED_TRAVEL,
  actuatorFor,
  readActuators,
  renderGroups,
  requirePhysical,
  sided,
} from '../lib/myoSuite.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/muscle-data/src/forearm.ts');
const { check } = cliFlags('generate-forearm-muscles');

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
    insertion: 'flexor_carpi_radialis_insertion_$_base_of_digit_bone',
    via: ['flexor_carpi_radialis_path_$_scaphoid_tubercle_of_scaphoid_bone'],
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
    insertion: 'extensor_carpi_radialis_longus_insertion_$_base_of_digit_bone',
    via: ['extensor_carpi_radialis_longus_path_$_radius_radial_styloid_process'],
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
    const parameters = actuatorFor(actuators, unit.actuator, ARM);
    // Only the ones that state an operating range can have their two lengths checked against each
    // other; for the rest there is no second statement to disagree with the first.
    if (parameters.architecture === 'stated') requirePhysical(unit.actuator, parameters, ARM);
    return {
      ...unit,
      parameters,
      // The citation says which of the two derivations made the fiber length, per unit, because a
      // reader looking at one unit should not have to know which element kind its actuator was.
      ...(parameters.architecture === 'not stated' ? { cite: 'myoArmStandIn' } : {}),
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
 * Peak force is the source's for all eight. So is the fiber length of supinator and anconeus, whose
 * actuators state an operating range the fiber length can be derived from -- and which come out at
 * 36 mm and 26 mm against a published 33 and 27. Those two cite \`myoArm\`.
 *
 * The other six state no such range, so MuJoCo's default applies and no fiber length can be
 * derived from it: doing so gives 1.1 to 5.6 times published and one tendon of minus 16 mm. What
 * those six do state is a \`lengthrange\`, and their fiber length is its width over
 * \`TYPICAL_NORMALISED_TRAVEL\` -- the travel a muscle typically has, measured on the source's
 * units that do state their architecture. It is a stand-in good to about half, and each of those
 * units cites \`myoArmStandIn\`, which says so. OQ-022 has the argument, the numbers and the
 * licence reason the better source could not be vendored.
 *
 * Both kinds are the number the simulation runs. Compile's \`deriveOptimalFiberLength\` lengthens a
 * fiber only where the muscle travels further on this skeleton than on the source's (OQ-020), and
 * every one of these eight travels less here, for the reason OQ-022 gives: our wrist's range is
 * short and our forearm attachments sit near their joint axes. The step's other effect, a cap at
 * four fifths of the path, reaches only a short body's anconeus.
 *
 * *Where a muscle attaches* is ours throughout, as everywhere: Gray's anatomical statement located
 * on this subject by the dataset's own markers, and where the dataset marks nothing, measured off
 * the bone.
 *
 * ## Two muscles are missing from this set, and one from the body
 *
 * Beyond the wrist the dataset marks four points: the tubercles of the scaphoid and trapezium, the
 * hook of the hamate, and the base and styloid of the third metacarpal -- and the trapezium's only
 * on the right hand. Extensor carpi radialis brevis ends on the third metacarpal's styloid and
 * flexor carpi ulnaris at the hook of the hamate. Flexor carpi radialis and extensor carpi
 * radialis longus end on the base of the second metacarpal, which the dataset does not mark and
 * \`tools/ingest/src/derived.ts\` measures off the bone.
 *
 * Extensor carpi ulnaris is in the hand set, not here: it ends on the base of the fifth
 * metacarpal, which had nothing to locate it until derived.ts measured the digit bones. Palmaris
 * longus alone is omitted. It ends in the palmar aponeurosis, soft tissue the dataset does not
 * carry, and the nearest bony point is where flexor carpi radialis already passes. The wrist has
 * two flexors, one radial and one ulnar, and three extensors, two radial here and the ulnar one
 * in the hand set.
 */

import { cite } from '@bs-humany/hsdl';
import type { MuscleGroup } from './schema.js';

/** Anatomy: which bony feature a muscle attaches to. The sites themselves are cited in M5.3. */
const gray = (muscle: string) => cite('gray1918', \`Part IV, Myology: The \${muscle}\`);

/** Parameters, for an actuator that states its own operating range: both lengths are derived. */
const myoArm = (actuator: string) =>
  cite(
    'caggiano2022',
    \`${ARM.muscle}, actuator name="\${actuator}": peak force as stated; fiber length derived \` +
      'from the operating range the actuator states',
  );

/** Parameters, for an actuator that states no operating range: the fiber length is a stand-in. */
const myoArmStandIn = (actuator: string) =>
  cite(
    'caggiano2022',
    \`${ARM.muscle}, actuator name="\${actuator}": peak force as stated; fiber length is the \` +
      'stated lengthrange width over TYPICAL_NORMALISED_TRAVEL (${TYPICAL_NORMALISED_TRAVEL}), a stand-in good to ' +
      'about half (OQ-022); lengthened at compile only where the muscle travels further here ' +
      'than on the source (OQ-020)',
  );

export const FOREARM_MUSCLES: readonly MuscleGroup[] = [
${body}
];

/** Every unit in the set, flattened, in a stable order. */
export const FOREARM_UNITS = FOREARM_MUSCLES.flatMap((group) => group.units);
`;
}

emitOrCheck({
  name: 'generate-forearm-muscles',
  script: 'generate:forearm-muscles',
  out: OUT,
  text: render(),
  check,
  summary: `${sided(UNITS).length} units from ${ARM.muscle}`,
});
