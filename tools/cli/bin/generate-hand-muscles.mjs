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
 * operating range, so the same reading applies as to the forearm's seven: peak force is the
 * source's, and the fiber length comes from the travel measured on this skeleton, marked with
 * `fiberLengthFromTravel`. OQ-022 has the argument.
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

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { ARM, readActuators, renderGroups, requirePhysical, sided } from '../lib/myoSuite.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/muscle-data/src/hand.ts');
const check = process.argv.includes('--check');

const jiti = createJiti(import.meta.url);
const { VIA_PATH_DIRECTION } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/muscleViaPoints.ts'),
);

/**
 * The attachment-site ids `attachments.ts` builds, written the way it writes them.
 *
 * A path site carries the bone it is on and an attachment does not, because a tendon crosses the
 * same named feature on several bones and an attachment does not.
 */
const site = (muscle, role, bone, feature) =>
  role === 'path' ? `${muscle}_path_$_${bone}_${feature}` : `${muscle}_${role}_$_${feature}`;

/** Where each tendon crosses the wrist, by the compartment it runs in. */
const CARPAL_TUNNEL = ['hamate', 'hook_of_hamate_bone'];
const FIRST_COMPARTMENT = ['radius', 'radial_styloid_process'];
const LISTERS_TUBERCLE = ['radius', 'dorsal_radial_tubercle'];
const ULNAR_COMPARTMENT = ['ulna', 'head_of_ulna'];

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

/** The reference's points stop at the wrist, so these units take none of them. */
const noCarriedPoints = () => [];

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
    if (parameters.architecture === 'stated') requirePhysical(unit.actuator, parameters, ARM);
    return {
      ...unit,
      parameters,
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
 * structures, none of which the dataset carries. \`attachmentGaps\` lists them.
 *
 * ## Where each half comes from
 *
 * The same split as every other set. *Where a muscle attaches* is ours -- Gray's anatomical
 * statement located on this subject, and for the digits measured off the bones themselves,
 * because beyond the wrist the export's four markers are label anchors floating clear of the
 * hand. *What a muscle can do* is MyoSuite's. Every actuator here is a \`<muscle>\` element with
 * no operating range of its own, so every fiber length comes from the travel measured on this
 * skeleton and is marked \`fiberLengthFromTravel\`; OQ-022 has the argument.
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

/** Parameters: the actuator in the vendored arm model they were derived from. */
const myoArm = (actuator: string) =>
  cite(
    'caggiano2022',
    \`${ARM.muscle}, actuator name="\${actuator}": peak force as stated. Fiber length from the \` +
      'travel measured on this skeleton (OQ-022), which the unit marks with fiberLengthFromTravel',
  );

export const HAND_MUSCLES: readonly MuscleGroup[] = [
${body}
];

/** Every unit in the set, flattened, in a stable order. */
export const HAND_UNITS = HAND_MUSCLES.flatMap((group) => group.units);
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
      `generate-hand-muscles: ${relative(ROOT, OUT)} is not what the generator would write.\n` +
        '  Run `pnpm generate:hand-muscles`. If the vendored model changed, say so in the commit.',
    );
    process.exit(1);
  }
  console.log(`generate-hand-muscles: ok. ${sided(UNITS).length} units match ${ARM.muscle}.`);
} else {
  writeFileSync(OUT, rendered);
  console.log(
    `generate-hand-muscles: wrote ${relative(ROOT, OUT)} -- ${sided(UNITS).length} units from ${ARM.muscle}.`,
  );
}
