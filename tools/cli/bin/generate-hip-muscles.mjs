#!/usr/bin/env node
/**
 * Generates the hip muscle parameter set from the vendored MyoSuite leg model.
 *
 *   pnpm generate:hip-muscles          # rewrite packages/muscle-data/src/hip.ts
 *   pnpm generate:hip-muscles --check  # fail if the file is not what this would write
 *
 * The same two derivations as the other sets -- both in `tools/cli/lib/myoSuite.mjs` -- over the
 * actuators that cross the hip. What is here is the part that is about the hip.
 *
 * ## Twenty-one units, and why so many
 *
 * The hip is the joint with the most muscle on it and the one where a single line of action is
 * least defensible. Gluteus medius is the plain case: its front fibres flex and internally rotate
 * the femur and its back fibres extend and externally rotate it, so a line down the middle of the
 * muscle does neither and a model with one has no abductor that works through the stride. M-ADR-005
 * says what to do about that, and the source model agrees -- it carries three units for each
 * gluteal and four for adductor magnus.
 *
 * So each part gets the stretch of bone it actually arises from. Gluteus medius takes the iliac
 * crest, the anterior gluteal line and the posterior gluteal line; gluteus minimus lies under it
 * between the anterior and inferior lines; gluteus maximus runs from the ilium, the sacrum and the
 * sacrotuberous ligament's attachment at the ischial tuberosity. Every one of those is a feature
 * Gray names and the dataset marks.
 *
 * ## What reaches the femur and what does not
 *
 * Three of these do not attach to the femur at all. Tensor fasciae latae ends in the iliotibial
 * tract, and the tract reaches the tibia; gracilis and sartorius run past the knee to the pes
 * anserinus on the medial tibia. They are hip muscles that a knee feels, which is the whole
 * reason the moment module reports a muscle against every coordinate it crosses rather than
 * against the joint someone filed it under.
 *
 * ## No wrap surfaces
 *
 * The reference wraps eleven of these -- the gluteals over the pelvis, the iliopsoas over the
 * pelvic brim, the adductors over the femoral shaft. None of those surfaces is carried here, for
 * the reason the knee set records: a wrap that engages at some poses and not others moves a path
 * by centimetres between ticks, and a stiff tendon turns that into kilonewtons. What holds these
 * paths is the via points, which come from the reference's own geometry. Whether that is enough
 * is a question for the moment-arm sweep rather than for this comment.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { LEGS, readActuators, renderGroups, requirePhysical, sided } from '../lib/myoSuite.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/muscle-data/src/hip.ts');
const check = process.argv.includes('--check');

const jiti = createJiti(import.meta.url);
const { VIA_PATH_DIRECTION, viaPointsFor } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/muscleViaPoints.ts'),
);

/** Which actuator becomes which unit, and which of our attachment sites it binds to. */
const UNITS = [
  {
    actuator: 'glmax1_r',
    group: 'gluteus_maximus_$',
    groupName: 'Gluteus maximus',
    taTerm: 'Musculus gluteus maximus',
    innervation: 'Inferior gluteal nerve',
    id: 'gluteus_maximus_superior_$',
    name: 'Gluteus maximus, superior part',
    origin: 'gluteus_maximus_origin_$_gluteal_surface_of_ilium',
    insertion: 'gluteus_maximus_insertion_$_gluteal_tuberosity',
  },
  {
    actuator: 'glmax2_r',
    group: 'gluteus_maximus_$',
    id: 'gluteus_maximus_middle_$',
    name: 'Gluteus maximus, middle part',
    origin: 'gluteus_maximus_origin_$_dorsal_surface_of_sacrum',
    insertion: 'gluteus_maximus_insertion_$_gluteal_tuberosity',
  },
  {
    actuator: 'glmax3_r',
    group: 'gluteus_maximus_$',
    id: 'gluteus_maximus_inferior_$',
    name: 'Gluteus maximus, inferior part',
    origin: 'gluteus_maximus_origin_$_ischial_tuberosity',
    insertion: 'gluteus_maximus_insertion_$_gluteal_tuberosity',
  },
  {
    actuator: 'glmed1_r',
    group: 'gluteus_medius_$',
    groupName: 'Gluteus medius',
    taTerm: 'Musculus gluteus medius',
    innervation: 'Superior gluteal nerve',
    id: 'gluteus_medius_anterior_$',
    name: 'Gluteus medius, anterior part',
    origin: 'gluteus_medius_origin_$_anterior_gluteal_line',
    insertion: 'gluteus_medius_insertion_$_greater_trochanter',
  },
  {
    actuator: 'glmed2_r',
    group: 'gluteus_medius_$',
    id: 'gluteus_medius_middle_$',
    name: 'Gluteus medius, middle part',
    origin: 'gluteus_medius_origin_$_outer_lip_of_iliac_crest',
    insertion: 'gluteus_medius_insertion_$_greater_trochanter',
  },
  {
    actuator: 'glmed3_r',
    group: 'gluteus_medius_$',
    id: 'gluteus_medius_posterior_$',
    name: 'Gluteus medius, posterior part',
    origin: 'gluteus_medius_origin_$_posterior_gluteal_line',
    insertion: 'gluteus_medius_insertion_$_greater_trochanter',
  },
  {
    actuator: 'glmin1_r',
    group: 'gluteus_minimus_$',
    groupName: 'Gluteus minimus',
    taTerm: 'Musculus gluteus minimus',
    innervation: 'Superior gluteal nerve',
    id: 'gluteus_minimus_anterior_$',
    name: 'Gluteus minimus, anterior part',
    origin: 'gluteus_minimus_origin_$_anterior_gluteal_line',
    insertion: 'gluteus_minimus_insertion_$_greater_trochanter',
  },
  {
    actuator: 'glmin2_r',
    group: 'gluteus_minimus_$',
    id: 'gluteus_minimus_middle_$',
    name: 'Gluteus minimus, middle part',
    origin: 'gluteus_minimus_origin_$_footprint',
    insertion: 'gluteus_minimus_insertion_$_greater_trochanter',
  },
  {
    actuator: 'glmin3_r',
    group: 'gluteus_minimus_$',
    id: 'gluteus_minimus_posterior_$',
    name: 'Gluteus minimus, posterior part',
    origin: 'gluteus_minimus_origin_$_inferior_gluteal_line',
    insertion: 'gluteus_minimus_insertion_$_greater_trochanter',
  },
  {
    actuator: 'iliacus_r',
    group: 'iliopsoas_$',
    groupName: 'Iliopsoas',
    taTerm: 'Musculus iliopsoas',
    innervation: 'Femoral nerve, and the lumbar plexus directly for psoas',
    id: 'iliacus_$',
    name: 'Iliacus',
    origin: 'iliacus_origin_$_iliac_fossa',
    // Over the brim before it turns back to the trochanter. The reference holds this bend with a
    // point in its pelvis frame, and this package has no pelvis correspondence to carry it
    // through, so the bend is stated from our own anatomy instead -- see `path` in
    // `attachments.ts`. Without it the path is a chord that passes behind the hip centre in
    // extension and the flexor reads as an extensor.
    via: ['iliacus_path_$_iliopubic_eminence'],
    insertion: 'iliacus_insertion_$_lesser_trochanter',
  },
  {
    actuator: 'psoas_r',
    group: 'iliopsoas_$',
    id: 'psoas_major_$',
    name: 'Psoas major',
    origin: 'psoas_major_origin_$_vertebral_body',
    // The same brim as iliacus, and for the same reason.
    via: ['psoas_major_path_$_iliopubic_eminence'],
    insertion: 'psoas_major_insertion_$_lesser_trochanter',
  },
  {
    actuator: 'addlong_r',
    group: 'adductor_longus_$',
    groupName: 'Adductor longus',
    taTerm: 'Musculus adductor longus',
    innervation: 'Obturator nerve',
    id: 'adductor_longus_$',
    name: 'Adductor longus',
    origin: 'adductor_longus_origin_$_pubic_crest',
    insertion: 'adductor_longus_insertion_$_linea_aspera',
  },
  {
    actuator: 'addbrev_r',
    group: 'adductor_brevis_$',
    groupName: 'Adductor brevis',
    taTerm: 'Musculus adductor brevis',
    innervation: 'Obturator nerve',
    id: 'adductor_brevis_$',
    name: 'Adductor brevis',
    origin: 'adductor_brevis_origin_$_inferior_pubic_ramus',
    insertion: 'adductor_brevis_insertion_$_pectineal_line_of_femur',
  },
  {
    actuator: 'addmagProx_r',
    group: 'adductor_magnus_$',
    groupName: 'Adductor magnus',
    taTerm: 'Musculus adductor magnus',
    innervation: 'Obturator nerve, and the tibial division of the sciatic for the ischial part',
    id: 'adductor_magnus_proximal_$',
    name: 'Adductor magnus, proximal part',
    origin: 'adductor_magnus_origin_$_inferior_pubic_ramus',
    insertion: 'adductor_magnus_insertion_$_gluteal_tuberosity',
  },
  {
    actuator: 'addmagMid_r',
    group: 'adductor_magnus_$',
    id: 'adductor_magnus_middle_$',
    name: 'Adductor magnus, middle part',
    origin: 'adductor_magnus_origin_$_ramus_of_ischium',
    insertion: 'adductor_magnus_insertion_$_linea_aspera',
  },
  {
    actuator: 'addmagDist_r',
    group: 'adductor_magnus_$',
    id: 'adductor_magnus_distal_$',
    name: 'Adductor magnus, distal part',
    origin: 'adductor_magnus_origin_$_ischial_tuberosity',
    insertion: 'adductor_magnus_insertion_$_medial_supracondylar_line',
  },
  {
    actuator: 'addmagIsch_r',
    group: 'adductor_magnus_$',
    id: 'adductor_magnus_ischiocondylar_$',
    name: 'Adductor magnus, ischiocondylar part',
    // The hamstring part: from the tuberosity to the adductor tubercle, extending the hip rather
    // than adducting it, and the only part of the muscle the sciatic nerve supplies.
    origin: 'adductor_magnus_origin_$_ischial_tuberosity',
    insertion: 'adductor_magnus_insertion_$_adductor_tubercle',
  },
  {
    actuator: 'piri_r',
    group: 'piriformis_$',
    groupName: 'Piriformis',
    taTerm: 'Musculus piriformis',
    innervation: 'Nerve to piriformis, from the sacral plexus',
    id: 'piriformis_$',
    name: 'Piriformis',
    origin: 'piriformis_origin_$_pelvic_surface_of_sacrum',
    insertion: 'piriformis_insertion_$_greater_trochanter',
  },
  {
    actuator: 'tfl_r',
    group: 'tensor_fasciae_latae_$',
    groupName: 'Tensor fasciae latae',
    taTerm: 'Musculus tensor fasciae latae',
    innervation: 'Superior gluteal nerve',
    id: 'tensor_fasciae_latae_$',
    name: 'Tensor fasciae latae',
    origin: 'tensor_fasciae_latae_origin_$_footprint',
    insertion: 'tensor_fasciae_latae_insertion_$_tubercle_of_iliotibial_tract',
  },
  {
    actuator: 'grac_r',
    group: 'gracilis_$',
    groupName: 'Gracilis',
    taTerm: 'Musculus gracilis',
    innervation: 'Obturator nerve',
    id: 'gracilis_$',
    name: 'Gracilis',
    origin: 'gracilis_origin_$_footprint',
    insertion: 'gracilis_insertion_$_medial_surface_of_tibia',
  },
  {
    actuator: 'sart_r',
    group: 'sartorius_$',
    groupName: 'Sartorius',
    taTerm: 'Musculus sartorius',
    innervation: 'Femoral nerve',
    id: 'sartorius_$',
    name: 'Sartorius',
    origin: 'sartorius_origin_$_anterior_superior_iliac_spine',
    insertion: 'sartorius_insertion_$_medial_surface_of_tibia',
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
 * The hip muscle parameter set -- ticket N2.4, the rest of the lower limb.
 *
 * **Generated by \`pnpm generate:hip-muscles\`. Do not edit.** The numbers are extracted from the
 * vendored MyoSuite leg model rather than copied out of it, so the value here and the value in the
 * cited file cannot disagree; CI runs the generator with \`--check\`.
 *
 * ## Where each half comes from
 *
 * The same split as every other set. *Where a muscle attaches* is ours: Gray's anatomical
 * statement located on this subject by the dataset's own markers. *What a muscle can do* is
 * MyoSuite's: peak force is a scalar and crosses frames without reinterpretation. The two lengths
 * are neither -- both are measured against a skeleton -- so both are derived at compile against
 * this one, which is where \`fittedTendonSlack\` and \`deriveOptimalFiberLength\` explain themselves.
 *
 * ## Twenty-one lines of action
 *
 * Three apiece for the gluteals and four for adductor magnus, because these are the muscles
 * M-ADR-005 was written for. Gluteus medius is the plain case: its front fibres flex and rotate
 * the femur inwards and its back fibres extend and rotate it out, so one line down the middle
 * does neither. Each part arises from the stretch of bone Gray gives it.
 *
 * ## Three of them are not only hip muscles
 *
 * Tensor fasciae latae ends in the iliotibial tract and the tract reaches the tibia; gracilis and
 * sartorius run to the pes anserinus below the knee. They cross two joints, and the moment module
 * reports a muscle against every coordinate it crosses rather than the one it is filed under.
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

export const HIP_MUSCLES: readonly MuscleGroup[] = [
${body}
];

/** Every unit in the set, flattened, in a stable order. */
export const HIP_UNITS = HIP_MUSCLES.flatMap((group) => group.units);
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
      `generate-hip-muscles: ${relative(ROOT, OUT)} is not what the generator would write.\n` +
        '  Run `pnpm generate:hip-muscles`. If the vendored model changed, say so in the commit.',
    );
    process.exit(1);
  }
  console.log(`generate-hip-muscles: ok. ${sided(UNITS).length} units match ${LEGS.muscle}.`);
} else {
  writeFileSync(OUT, rendered);
  console.log(
    `generate-hip-muscles: wrote ${relative(ROOT, OUT)} -- ${sided(UNITS).length} units from ${LEGS.muscle}.`,
  );
}
