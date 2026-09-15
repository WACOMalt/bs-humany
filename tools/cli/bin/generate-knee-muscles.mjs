#!/usr/bin/env node
/**
 * Generates the knee muscle parameter set from the vendored MyoSuite leg model.
 *
 *   pnpm generate:knee-muscles          # rewrite packages/muscle-data/src/knee.ts
 *   pnpm generate:knee-muscles --check  # fail if the file is not what this would write
 *
 * The same two derivations as the arm sets -- both live in `tools/cli/lib/myoSuite.mjs` -- read
 * from the leg model instead. What is here is the part that is about the knee.
 *
 * ## Ten units, and the patella
 *
 * The four of the quadriceps and six flexors: both heads of biceps femoris, semitendinosus,
 * semimembranosus, and both heads of gastrocnemius. Each is a separate line of action per
 * M-ADR-005, and the quadriceps are the clearest case for it -- vastus medialis and lateralis pull
 * the patella in opposite directions across the knee, and a single line down the middle of the
 * thigh has neither effect.
 *
 * The quadriceps do not insert on the tibia directly. They converge on the patella and reach the
 * tibia through its ligament, which is why their attachment here is the *ligament* site at the
 * tibial tuberosity rather than an insertion, and why their paths run through via points on the
 * patella itself. This skeleton has a patella as its own body, coupled to knee flexion by the
 * constraint the compiler builds from the reference model's own polynomial, so those points move
 * the way a patella moves rather than riding along with the femur.
 *
 * ## No wrap surface, measured rather than assumed
 *
 * The hamstrings were given the femoral condyles first -- a cylinder coaxial with the knee's
 * flexion axis, measured at 25 mm -- on the reasoning that a path from the ischium to the tibia
 * cuts the corner as the knee closes. Swept from 0 to 120 degrees, it turned out not to: six of
 * the ten units never touched the surface and two touched it at two poses out of seven, which is
 * the flicker that made the shoulder twitch.
 *
 * So nothing here wraps, and the moment arms say the geometry does not need it: the hamstrings
 * come out between 25 and 63 mm across the range, all of one sign, which is where published
 * curves put them. What holds these paths is what holds them in the body -- the quadriceps over
 * the patella, the hamstrings running behind a joint whose bones are already behind them.
 *
 * The surface stays in the skeleton, measured and correct, for the set that needs it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { LEGS, readActuators, renderGroups, requirePhysical, sided } from '../lib/myoSuite.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/muscle-data/src/knee.ts');
const check = process.argv.includes('--check');

const jiti = createJiti(import.meta.url);
const { VIA_PATH_DIRECTION, viaPointsFor } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/muscleViaPoints.ts'),
);

/**
 * Which actuator becomes which unit, which of our attachment sites it binds to, and what it turns
 * over at the knee.
 *
 * `side` is in the dataset's own frame, where +Y is superior and +Z posterior. The knee's sides
 * are anterior and posterior, which point the same way on both legs, so nothing here is mirrored.
 */
const UNITS = [
  {
    actuator: 'recfem_r',
    group: 'quadriceps_femoris_$',
    groupName: 'Quadriceps femoris',
    taTerm: 'Musculus quadriceps femoris',
    innervation: 'Femoral nerve',
    id: 'rectus_femoris_$',
    name: 'Rectus femoris',
    origin: 'rectus_femoris_origin_$_anterior_inferior_iliac_spine',
    insertion: 'rectus_femoris_insertion_$_tibial_tuberosity',
  },
  {
    actuator: 'vaslat_r',
    group: 'quadriceps_femoris_$',
    id: 'vastus_lateralis_$',
    name: 'Vastus lateralis',
    origin: 'vastus_lateralis_origin_$_linea_aspera',
    insertion: 'vastus_lateralis_insertion_$_tibial_tuberosity',
  },
  {
    actuator: 'vasmed_r',
    group: 'quadriceps_femoris_$',
    id: 'vastus_medialis_$',
    name: 'Vastus medialis',
    origin: 'vastus_medialis_origin_$_medial_supracondylar_line',
    insertion: 'vastus_medialis_insertion_$_tibial_tuberosity',
  },
  {
    actuator: 'vasint_r',
    group: 'quadriceps_femoris_$',
    id: 'vastus_intermedius_$',
    name: 'Vastus intermedius',
    origin: 'vastus_intermedius_origin_$_body_of_femur',
    insertion: 'vastus_intermedius_insertion_$_tibial_tuberosity',
  },
  {
    actuator: 'bflh_r',
    group: 'biceps_femoris_$',
    groupName: 'Biceps femoris',
    taTerm: 'Musculus biceps femoris',
    innervation: 'Sciatic nerve: tibial and common fibular divisions',
    id: 'biceps_femoris_long_$',
    name: 'Biceps femoris, long head',
    origin: 'biceps_femoris_origin_$_ischial_tuberosity',
    insertion: 'biceps_femoris_insertion_$_head_of_fibula',
  },
  {
    actuator: 'bfsh_r',
    group: 'biceps_femoris_$',
    id: 'biceps_femoris_short_$',
    name: 'Biceps femoris, short head',
    origin: 'biceps_femoris_origin_$_linea_aspera',
    insertion: 'biceps_femoris_insertion_$_head_of_fibula',
  },
  {
    actuator: 'semiten_r',
    group: 'semitendinosus_$',
    groupName: 'Semitendinosus',
    taTerm: 'Musculus semitendinosus',
    innervation: 'Sciatic nerve: tibial division',
    id: 'semitendinosus_$',
    name: 'Semitendinosus',
    origin: 'semitendinosus_origin_$_ischial_tuberosity',
    insertion: 'semitendinosus_insertion_$_medial_surface_of_tibia',
  },
  {
    actuator: 'semimem_r',
    group: 'semimembranosus_$',
    groupName: 'Semimembranosus',
    taTerm: 'Musculus semimembranosus',
    innervation: 'Sciatic nerve: tibial division',
    id: 'semimembranosus_$',
    name: 'Semimembranosus',
    origin: 'semimembranosus_origin_$_ischial_tuberosity',
    insertion: 'semimembranosus_insertion_$_medial_condyle_of_tibia',
  },
  {
    actuator: 'gaslat_r',
    group: 'gastrocnemius_$',
    groupName: 'Gastrocnemius',
    taTerm: 'Musculus gastrocnemius',
    innervation: 'Tibial nerve',
    id: 'gastrocnemius_lateral_$',
    name: 'Gastrocnemius, lateral head',
    origin: 'gastrocnemius_origin_$_lateral_supracondylar_line',
    insertion: 'gastrocnemius_insertion_$_calcaneal_tuberosity',
  },
  {
    actuator: 'gasmed_r',
    group: 'gastrocnemius_$',
    id: 'gastrocnemius_medial_$',
    name: 'Gastrocnemius, medial head',
    origin: 'gastrocnemius_origin_$_medial_supracondylar_line',
    insertion: 'gastrocnemius_insertion_$_calcaneal_tuberosity',
  },
];

function render() {
  const actuators = readActuators(LEGS);
  const units = sided(UNITS).map((unit) => {
    // The reference model's leg is a right leg and names its actuators for it, so both of ours
    // read the same one.
    const parameters = actuators.get(unit.actuator);
    if (parameters === undefined) {
      throw new Error(
        `${LEGS.muscle} has no actuator named '${unit.actuator}'. The vendored commit may have ` +
          'moved; check tools/validate-external/README.md before changing this mapping.',
      );
    }
    requirePhysical(unit.actuator, parameters, LEGS);
    return {
      ...unit,
      parameters,
      ...(unit.side === undefined ? {} : { preferredSide: unit.side }),
    };
  });
  const body = renderGroups(units, viaPointsFor, VIA_PATH_DIRECTION, LEGS);

  return `/**
 * The knee muscle parameter set -- ticket N2.5, the region after the shoulder.
 *
 * **Generated by \`pnpm generate:knee-muscles\`. Do not edit.** The numbers are extracted from the
 * vendored MyoSuite leg model rather than copied out of it, so the value here and the value in the
 * cited file cannot disagree; CI runs the generator with \`--check\`.
 *
 * ## Where each half comes from
 *
 * The same split as the arm sets. *Where a muscle attaches* is ours: Gray's anatomical statement
 * located on this subject by the dataset's own markers. *What a muscle can do* is MyoSuite's: peak
 * force and optimal fiber length are scalars and cross frames without reinterpretation. Tendon
 * slack length is neither -- it is a length measured on the source's skeleton -- so it is fitted
 * to this one at compile, which is where \`fittedTendonSlack\` explains itself.
 *
 * ## The patella
 *
 * The quadriceps do not reach the tibia directly. They converge on the patella and pull through
 * its ligament, so what each one names as its insertion is the *ligament* site at the tibial
 * tuberosity, and their paths run through via points on the patella itself. This skeleton carries
 * a patella as its own body, coupled to knee flexion by the constraint the compiler builds from
 * the reference model's polynomial, so those points travel the way a patella travels. That is
 * what gives a knee extensor the moment arm it has: the patella holds the tendon out in front of
 * the joint, which is the whole purpose of the largest sesamoid bone in the body.
 *
 * ## One surface, for the flexors
 *
 * The hamstrings turn over the back of the femoral condyles, a cylinder coaxial with the knee's
 * flexion axis at a measured 25 mm. The quadriceps are not given it -- the patella is what carries
 * them across -- and neither are the heads of gastrocnemius, which originate on the condyles
 * themselves: a muscle attached to a surface cannot also wrap it.
 */

import { cite } from '@bs-humany/hsdl';
import type { MuscleGroup } from './schema.js';

/** Anatomy: which bony feature a muscle attaches to. The sites themselves are cited in M5.3. */
const gray = (muscle: string) => cite('gray1918', \`Part IV, Myology: The \${muscle}\`);

/** Parameters: the actuator in the vendored leg model they were derived from. */
const myoLegs = (actuator: string) =>
  cite(
    'caggiano2022',
    \`${LEGS.muscle}, actuator general name="\${actuator}": gainprm force, and optimal fiber \` +
      'length and tendon slack length derived from gainprm range with lengthrange',
  );

export const KNEE_MUSCLES: readonly MuscleGroup[] = [
${body}
];

/** Every unit in the set, flattened, in a stable order. */
export const KNEE_UNITS = KNEE_MUSCLES.flatMap((group) => group.units);
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
      `generate-knee-muscles: ${relative(ROOT, OUT)} is not what the generator would write.\n` +
        '  Run `pnpm generate:knee-muscles`. If the vendored model changed, say so in the commit.',
    );
    process.exit(1);
  }
  console.log(`generate-knee-muscles: ok. ${sided(UNITS).length} units match ${LEGS.muscle}.`);
} else {
  writeFileSync(OUT, rendered);
  console.log(
    `generate-knee-muscles: wrote ${relative(ROOT, OUT)} -- ${sided(UNITS).length} units from ${LEGS.muscle}.`,
  );
}
