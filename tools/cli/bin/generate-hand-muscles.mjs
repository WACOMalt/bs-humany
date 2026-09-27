#!/usr/bin/env node
/**
 * Generates the hand muscle parameter set from the vendored MyoSuite arm model.
 *
 *   pnpm generate:hand-muscles          # rewrite packages/muscle-data/src/hand.ts
 *   pnpm generate:hand-muscles --check  # fail if the file is not what this would write
 *
 * ## The nineteen that move a digit from the forearm
 *
 * Four slips of flexor digitorum superficialis and four of profundus, four of extensor digitorum,
 * extensor indicis and extensor digiti minimi, the four thumb muscles, and extensor carpi ulnaris
 * -- which belongs to the forearm set by its action and is here because it could not be there:
 * it ends on the base of the fifth metacarpal, which was unmarked until the digit bones were
 * measured, and the forearm set says so in its own header.
 *
 * Every one is a `<muscle>` element in the source, stating force and a length range and no
 * operating range, so the same reading applies as to the forearm's six: peak force is the
 * source's, and the fiber length is the stated length range's width over
 * `TYPICAL_NORMALISED_TRAVEL`, a stand-in good to about half. There is no marker field on the
 * unit that says so; the citation does, since every unit here cites `myoArmStandIn`, and the
 * generator refuses to run if an actuator ever turns up that states its architecture after all,
 * because that one would deserve the ordinary derivation and the ordinary citation. OQ-022 has
 * the argument.
 *
 * The stand-in is translated to this skeleton at compile, as the forearm's six are.
 * `deriveOptimalFiberLength` lengthens a fiber by how much further its muscle travels here than on
 * the source's (OQ-020), and the source's side of that ratio is `SOURCE_MUSCLE_TRAVEL`, which
 * `measure-source-travel` sweeps in the arm for these tendons as for the elbow's, the shoulder's
 * and the forearm's. It did not until 2026-09-27, and this generator refused to run the day one of
 * them was measured, because the citation then said they were not; the citation says what the
 * forearm's says now, and the measurement refuses a unit citing the source that it neither
 * measures nor excludes by name.
 *
 * ## Their paths are ours, and have to be
 *
 * `muscleViaPoints.ts` carries the reference's via points through a frame correspondence built
 * for the clavicle, scapula, humerus, ulna and radius. It stops at the wrist, so not one point of
 * a finger tendon comes through it, and a finger flexor with no path is a straight line from the
 * medial epicondyle to a fingertip -- which does not flex the finger, it pulls it off its joints.
 *
 * So the paths are attachment sites of our own, measured off the bones in `attachments.ts` and
 * named here: the compartment of the retinaculum each tendon runs in at the wrist, then the
 * flexor or extensor side of the head of every bone it crosses. This is the same answer the ankle
 * set reached for the three muscles whose carried points were worse than none.
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
  sided,
} from '../lib/myoSuite.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/muscle-data/src/hand.ts');
const { check } = cliFlags('generate-hand-muscles');

const jiti = createJiti(import.meta.url);
const { VIA_PATH_DIRECTION } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/muscleViaPoints.ts'),
);
// The site-id scheme and the wrist compartments, from the module `attachments.ts` builds the sites
// with, so an id named here is the id the body carries. It imports nothing, so loading it is cheap.
const { CARPAL_TUNNEL, FIRST_COMPARTMENT, LISTERS_TUBERCLE, ULNAR_COMPARTMENT, attachmentSiteId } =
  await jiti.import(join(ROOT, 'packages/skeleton/src/attachmentSiteId.ts'));

/** An attachment-site id with the side left as `$`, for `sided` to fill in. */
const site = (muscle, role, bone, feature) => attachmentSiteId(muscle, role, '$', bone, feature);

/** Every bone in the digit from the metacarpal to the one the tendon ends on. */
const chainTo = (digit, stop) => {
  const parts = digit === 1 ? ['proximal', 'distal'] : ['proximal', 'middle', 'distal'];
  return [
    `metacarpal_${digit}`,
    ...parts.slice(0, parts.indexOf(stop) + 1).map((part) => `phalanx_${part}_${digit}`),
  ];
};

/**
 * The whole path of a digital tendon: the wrist, then where the sheath holds it against each bone
 * -- at the base and the head of every bone it passes, which is what puts a span right across each
 * joint. See the block comment on `heldAt` in attachments.ts for why the heads alone are not
 * enough.
 */
const digitPath = (muscle, wrist, digit, stop, side) => {
  const chain = chainTo(digit, stop);
  return [
    site(muscle, 'path', wrist[0], wrist[1]),
    ...chain.flatMap((bone, i) => [
      ...(i === 0 || side === 'flexor' ? [] : [site(muscle, 'path', bone, `${side}_side_of_base`)]),
      ...(i === chain.length - 1 ? [] : [site(muscle, 'path', bone, `${side}_side_of_head`)]),
    ]),
  ];
};

const FINGER = { 2: 'index', 3: 'middle', 4: 'ring', 5: 'little' };

/** Which actuator becomes which unit, and which of our attachment sites it binds to. */
const UNITS = [
  ...[2, 3, 4, 5].flatMap((d) => {
    const fds = `flexor_digitorum_superficialis_${d}`;
    const fdp = `flexor_digitorum_profundus_${d}`;
    const edc = `extensor_digitorum_${d}`;
    return [
      {
        actuator: `FDS${d}`,
        group: 'flexor_digitorum_superficialis_$',
        groupName: 'Flexor digitorum superficialis',
        taTerm: 'Musculus flexor digitorum superficialis',
        innervation: 'Median nerve',
        id: `${fds}_$`,
        name: `Flexor digitorum superficialis, ${FINGER[d]}`,
        origin: site(fds, 'origin', null, 'medial_epicondyle_of_humerus'),
        insertion: site(fds, 'insertion', null, 'flexor_side_of_shaft'),
        via: digitPath(fds, CARPAL_TUNNEL, d, 'middle', 'flexor'),
      },
      {
        actuator: `FDP${d}`,
        group: 'flexor_digitorum_profundus_$',
        groupName: 'Flexor digitorum profundus',
        taTerm: 'Musculus flexor digitorum profundus',
        innervation: 'Median and ulnar nerves',
        id: `${fdp}_$`,
        name: `Flexor digitorum profundus, ${FINGER[d]}`,
        origin: site(fdp, 'origin', null, 'anterior_border_of_ulna'),
        insertion: site(fdp, 'insertion', null, 'flexor_side_of_shaft'),
        via: digitPath(fdp, CARPAL_TUNNEL, d, 'distal', 'flexor'),
      },
      {
        actuator: `EDC${d}`,
        group: 'extensor_digitorum_$',
        groupName: 'Extensor digitorum',
        taTerm: 'Musculus extensor digitorum',
        innervation: 'Posterior interosseous nerve',
        id: `${edc}_$`,
        name: `Extensor digitorum, ${FINGER[d]}`,
        origin: site(edc, 'origin', null, 'lateral_epicondyle_of_humerus'),
        insertion: site(edc, 'insertion', null, 'extensor_side_of_shaft'),
        via: digitPath(edc, LISTERS_TUBERCLE, d, 'distal', 'extensor'),
      },
    ];
  }),
  {
    actuator: 'EIP',
    group: 'extensor_indicis_$',
    groupName: 'Extensor indicis',
    taTerm: 'Musculus extensor indicis',
    innervation: 'Posterior interosseous nerve',
    id: 'extensor_indicis_$',
    name: 'Extensor indicis',
    origin: site('extensor_indicis', 'origin', null, 'posterior_surface_of_ulna'),
    insertion: site('extensor_indicis', 'insertion', null, 'extensor_side_of_shaft'),
    via: digitPath('extensor_indicis', LISTERS_TUBERCLE, 2, 'distal', 'extensor'),
  },
  {
    actuator: 'EDM',
    group: 'extensor_digiti_minimi_$',
    groupName: 'Extensor digiti minimi',
    taTerm: 'Musculus extensor digiti minimi',
    innervation: 'Posterior interosseous nerve',
    id: 'extensor_digiti_minimi_$',
    name: 'Extensor digiti minimi',
    origin: site('extensor_digiti_minimi', 'origin', null, 'lateral_epicondyle_of_humerus'),
    insertion: site('extensor_digiti_minimi', 'insertion', null, 'extensor_side_of_shaft'),
    via: digitPath('extensor_digiti_minimi', ULNAR_COMPARTMENT, 5, 'distal', 'extensor'),
  },
  {
    actuator: 'ECU',
    group: 'extensor_carpi_ulnaris_$',
    groupName: 'Extensor carpi ulnaris',
    taTerm: 'Musculus extensor carpi ulnaris',
    innervation: 'Posterior interosseous nerve',
    id: 'extensor_carpi_ulnaris_$',
    name: 'Extensor carpi ulnaris',
    origin: site('extensor_carpi_ulnaris', 'origin', null, 'lateral_epicondyle_of_humerus'),
    insertion: site('extensor_carpi_ulnaris', 'insertion', null, 'base_of_digit_bone'),
    via: [site('extensor_carpi_ulnaris', 'path', ULNAR_COMPARTMENT[0], ULNAR_COMPARTMENT[1])],
  },
  {
    actuator: 'FPL',
    group: 'flexor_pollicis_longus_$',
    groupName: 'Flexor pollicis longus',
    taTerm: 'Musculus flexor pollicis longus',
    innervation: 'Anterior interosseous nerve',
    id: 'flexor_pollicis_longus_$',
    name: 'Flexor pollicis longus',
    origin: site('flexor_pollicis_longus', 'origin', null, 'anterior_surface_of_radius'),
    insertion: site('flexor_pollicis_longus', 'insertion', null, 'flexor_side_of_shaft'),
    via: digitPath('flexor_pollicis_longus', CARPAL_TUNNEL, 1, 'distal', 'flexor'),
  },
  {
    actuator: 'EPL',
    group: 'extensor_pollicis_longus_$',
    groupName: 'Extensor pollicis longus',
    taTerm: 'Musculus extensor pollicis longus',
    innervation: 'Posterior interosseous nerve',
    id: 'extensor_pollicis_longus_$',
    name: 'Extensor pollicis longus',
    origin: site('extensor_pollicis_longus', 'origin', null, 'posterior_surface_of_ulna'),
    insertion: site('extensor_pollicis_longus', 'insertion', null, 'extensor_side_of_shaft'),
    via: digitPath('extensor_pollicis_longus', LISTERS_TUBERCLE, 1, 'distal', 'extensor'),
  },
  {
    actuator: 'EPB',
    group: 'extensor_pollicis_brevis_$',
    groupName: 'Extensor pollicis brevis',
    taTerm: 'Musculus extensor pollicis brevis',
    innervation: 'Posterior interosseous nerve',
    id: 'extensor_pollicis_brevis_$',
    name: 'Extensor pollicis brevis',
    origin: site('extensor_pollicis_brevis', 'origin', null, 'posterior_surface_of_radius'),
    insertion: site('extensor_pollicis_brevis', 'insertion', null, 'extensor_side_of_shaft'),
    via: digitPath('extensor_pollicis_brevis', FIRST_COMPARTMENT, 1, 'proximal', 'extensor'),
  },
  {
    actuator: 'APL',
    group: 'abductor_pollicis_longus_$',
    groupName: 'Abductor pollicis longus',
    taTerm: 'Musculus abductor pollicis longus',
    innervation: 'Posterior interosseous nerve',
    id: 'abductor_pollicis_longus_$',
    name: 'Abductor pollicis longus',
    origin: site('abductor_pollicis_longus', 'origin', null, 'posterior_surface_of_ulna'),
    insertion: site('abductor_pollicis_longus', 'insertion', null, 'base_of_digit_bone'),
    via: [site('abductor_pollicis_longus', 'path', FIRST_COMPARTMENT[0], FIRST_COMPARTMENT[1])],
  },
];

/**
 * The reference's points stop at the wrist, so these units take none of them.
 *
 * Said twice, on purpose: every unit declares it, with the reason, so `renderGroups` can tell a
 * unit that takes no carried points by decision from one the via-point table missed; and the
 * lookup it is handed finds nothing, so a unit that somehow lost the declaration still gets none.
 */
const noCarriedPoints = () => [];
const NOT_CARRIED = Object.freeze({
  carried: false,
  because: "the reference's via points stop at the wrist, and these run on to the digits",
});

function render() {
  const actuators = readActuators(ARM);
  const units = sided(UNITS).map((unit) => {
    // The reference model's arm is a right arm and names its actuators for it, so both of ours
    // read the same one.
    const parameters = actuatorFor(actuators, unit.actuator, ARM);
    // The file emits one citation, the stand-in's, and it would be false on an actuator that
    // states its operating range. None does at the vendored commit; if one ever does, it gets the
    // forearm's treatment -- `requirePhysical` and a citation of its own -- rather than this one.
    if (parameters.architecture !== 'not stated') {
      throw new Error(
        `${ARM.muscle} actuator '${unit.actuator}' states its operating range, and every hand ` +
          'unit is cited as a stand-in. Give it the ordinary derivation and citation, as ' +
          'generate-forearm-muscles.mjs does for supinator and anconeus.',
      );
    }
    return {
      ...unit,
      ...NOT_CARRIED,
      parameters,
      cite: 'myoArmStandIn',
      ...(unit.side === undefined ? {} : { preferredSide: unit.side }),
    };
  });
  const body = renderGroups(units, noCarriedPoints, VIA_PATH_DIRECTION, ARM);

  return `/**
 * The hand muscle parameter set -- the long tendons that move the digits.
 *
 * **Generated by \`pnpm generate:hand-muscles\`. Do not edit.** CI runs the generator with
 * \`--check\`.
 *
 * ## What is here
 *
 * The extrinsics: the nineteen muscles a side that lie in the forearm and move a digit. Four
 * slips each of flexor digitorum superficialis, profundus and extensor digitorum, extensor
 * indicis and extensor digiti minimi, the four thumb muscles, and extensor carpi ulnaris -- which
 * acts at the wrist and is here because it ends on the base of the fifth metacarpal, and until
 * the digit bones were measured there was no such point to end on.
 *
 * Superficialis stops at the middle phalanx and profundus goes on to the distal one. That is the
 * real difference between them and it is what gives a finger two flexions rather than one.
 *
 * The intrinsics are not here. The lumbricals and the interossei insert into the dorsal
 * expansion and the thenar and hypothenar muscles arise from the flexor retinaculum: soft
 * structures, none of which the dataset carries. \`UNMODELLED_MUSCLES\` in
 * \`@bs-humany/skeleton\` names them, and \`docs/plans/dataset-correspondence.md\` 5.2 is the
 * work that would add them.
 *
 * ## Where each half comes from
 *
 * The same split as every other set. *Where a muscle attaches* is ours -- Gray's anatomical
 * statement located on this subject, and for the digits measured off the bones themselves,
 * because beyond the wrist the export's four markers are label anchors floating clear of the
 * hand. *What a muscle can do* is MyoSuite's. Every actuator here is a \`<muscle>\` element with
 * no operating range of its own, so peak force is as stated and every fiber length is the stated
 * \`lengthrange\` width over \`TYPICAL_NORMALISED_TRAVEL\`: a stand-in good to about half, which
 * every unit's citation, \`myoArmStandIn\`, says. OQ-022 has the argument.
 *
 * Compile then lengthens a fiber where its muscle travels further on this skeleton than on the
 * source's (OQ-020), as it does every set's: \`measure:source-travel\` sweeps these tendons on the
 * source's model, and \`docs/validation/fiber-lengths.md\` says what that did to each.
 *
 * ## The paths are ours and have to be
 *
 * The carried via points stop at the wrist -- the frame correspondence behind them covers the
 * clavicle, scapula, humerus, ulna and radius -- so a finger tendon would have no path at all,
 * and a finger flexor with no path is a straight line from the medial epicondyle to a fingertip.
 * It does not flex the finger; it pulls it off its joints. Each tendon instead names the
 * compartment of the retinaculum it runs in and then the flexor or extensor side of the head of
 * every bone it crosses, which is where the fibrous sheath holds it.
 */

import { cite } from '@bs-humany/hsdl';
import type { MuscleGroup } from './schema.js';

/** Anatomy: which bony feature a muscle attaches to. The sites themselves are cited in M5.3. */
const gray = (muscle: string) => cite('gray1918', \`Part IV, Myology: The \${muscle}\`);

/** Parameters, for an actuator that states no operating range: the fiber length is a stand-in. */
const myoArmStandIn = (actuator: string) =>
  cite(
    'caggiano2022',
    \`${ARM.muscle}, actuator name="\${actuator}": peak force as stated; fiber length is the \` +
      'stated lengthrange width over TYPICAL_NORMALISED_TRAVEL (${TYPICAL_NORMALISED_TRAVEL}), a stand-in good to ' +
      'about half (OQ-022); lengthened at compile only where the muscle travels further here ' +
      'than on the source (OQ-020)',
  );

export const HAND_MUSCLES: readonly MuscleGroup[] = [
${body}
];

/** Every unit in the set, flattened, in a stable order. */
export const HAND_UNITS = HAND_MUSCLES.flatMap((group) => group.units);
`;
}

emitOrCheck({
  name: 'generate-hand-muscles',
  script: 'generate:hand-muscles',
  out: OUT,
  text: render(),
  check,
  summary: `${sided(UNITS).length} units from ${ARM.muscle}`,
});
