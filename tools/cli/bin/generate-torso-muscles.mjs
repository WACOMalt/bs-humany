#!/usr/bin/env node
/**
 * Generates the torso muscle parameter set from the vendored MyoSuite torso model.
 *
 *   pnpm generate:torso-muscles          # rewrite packages/muscle-data/src/torso.ts
 *   pnpm generate:torso-muscles --check  # fail if the file is not what this would write
 *
 * ## Four muscles, and what it took to get the extensor
 *
 * The reference splits the trunk in two. The abdomen model lumps erector spinae and the two
 * obliques into one line a side, which is the level of detail this project wants for a trunk. The
 * full model carries 210 fascicles of multifidus, longissimus, iliocostalis, quadratus lumborum
 * and psoas attached to individual lumbar vertebrae, which is much finer than anything here, and
 * is read for exactly one actuator: rectus abdominis, which the abdomen model does not carry.
 *
 * Erector spinae and rectus abdominis were both refused when this set was first written, because
 * each states an operating range and a length range implying a tendon shorter than nothing -- 12
 * mm for erector spinae and 70 for rectus abdominis. They are back, and OQ-023 is why: the fiber
 * length comes from the *width* of the two ranges and the tendon from the *offset*, they fail
 * independently, and the tendon is refitted to this skeleton at compile regardless. A negative
 * offset is evidence that the source's two statements disagree; it is not a number this model
 * divides by, because this model never uses it.
 *
 * What still is not here is anything from the detailed model beyond rectus abdominis. 64 of its
 * 210 fascicles have a usable width and the failures are not spread evenly -- multifidus 6 of 50,
 * psoas 2 of 22 -- so there is no subset of it that is a muscle rather than an arbitrary handful.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import {
  TORSO,
  TORSO_LUMBAR,
  readActuators,
  renderGroups,
  requirePhysical,
  sided,
} from '../lib/myoSuite.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/muscle-data/src/torso.ts');
const check = process.argv.includes('--check');

const jiti = createJiti(import.meta.url);
const { VIA_PATH_DIRECTION, viaPointsFor } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/muscleViaPoints.ts'),
);

/** Which actuator becomes which unit, and which of our attachment sites it binds to. */
const UNITS = [
  {
    actuator: 'ercspn_$',
    group: 'erector_spinae_$',
    groupName: 'Sacrospinalis (erector spinae)',
    taTerm: 'Musculus erector spinae',
    innervation: 'Dorsal rami of the spinal nerves',
    id: 'erector_spinae_$',
    name: 'Erector spinae',
    origin: 'erector_spinae_origin_$_dorsal_surface_of_sacrum',
    // Up the back, through two of its own attachments. Without them the path is a chord from the
    // sacrum to the sixth rib and runs inside the ribcage.
    via: [
      'erector_spinae_insertion_$_spinous_process',
      'erector_spinae_insertion_$_spinous_process_tip',
    ],
    insertion: 'erector_spinae_insertion_$_angle_of_rib',
  },
  {
    actuator: 'rect_abd_$',
    from: 'lumbar',
    group: 'rectus_abdominis_$',
    groupName: 'Rectus abdominis',
    taTerm: 'Musculus rectus abdominis',
    innervation: 'Intercostal nerves T7 to T11 and the subcostal',
    id: 'rectus_abdominis_$',
    name: 'Rectus abdominis',
    origin: 'rectus_abdominis_origin_$_pubic_crest',
    insertion: 'rectus_abdominis_insertion_$_xiphoid_tip',
  },
  {
    actuator: 'extobl_$',
    group: 'external_oblique_$',
    groupName: 'Obliquus externus abdominis',
    taTerm: 'Musculus obliquus externus abdominis',
    innervation: 'Intercostal nerves T7 to T11, subcostal, iliohypogastric and ilioinguinal',
    id: 'external_oblique_$',
    name: 'External oblique',
    origin: 'external_oblique_origin_$_body_of_rib',
    insertion: 'external_oblique_insertion_$_pubic_tubercle',
  },
  {
    actuator: 'intobl_$',
    group: 'internal_oblique_$',
    groupName: 'Obliquus internus abdominis',
    taTerm: 'Musculus obliquus internus abdominis',
    innervation: 'Intercostal nerves T7 to T11, subcostal, iliohypogastric and ilioinguinal',
    id: 'internal_oblique_$',
    name: 'Internal oblique',
    origin: 'internal_oblique_origin_$_anterior_superior_iliac_spine',
    insertion: 'internal_oblique_insertion_$_body_of_rib',
  },
];

function render() {
  // Rectus abdominis is in the detailed model rather than the abdomen one, which is the only
  // reason both are read.
  const abdomen = readActuators(TORSO);
  const lumbar = readActuators(TORSO_LUMBAR);
  // The torso model states both sides, unlike the arm's and the leg's, so the actuator name takes
  // the side too.
  const units = sided(UNITS).map((unit) => {
    const actuator = unit.actuator.replace('$', unit.id.endsWith('_l') ? 'l' : 'r');
    const model = unit.from === 'lumbar' ? TORSO_LUMBAR : TORSO;
    const parameters = (unit.from === 'lumbar' ? lumbar : abdomen).get(actuator);
    if (parameters === undefined) {
      throw new Error(
        `${model.muscle} has no actuator named '${actuator}'. The vendored commit may have ` +
          'moved; check tools/validate-external/README.md before changing this mapping.',
      );
    }
    requirePhysical(actuator, parameters, model);
    return {
      ...unit,
      actuator,
      parameters,
      model,
      cite: unit.from === 'lumbar' ? 'myoTorsoLumbar' : 'myoTorso',
    };
  });
  const body = renderGroups(units, viaPointsFor, VIA_PATH_DIRECTION, TORSO);

  return `/**
 * The torso muscle parameter set -- the abdominal wall, and a trunk with no extensor.
 *
 * **Generated by \`pnpm generate:torso-muscles\`. Do not edit.** CI runs the generator with
 * \`--check\`.
 *
 * Erector spinae behind, rectus abdominis in front, and the two obliques crossing between them --
 * the external running downward and forward from the ribs to the pubis and the internal upward
 * and forward from the iliac spine to the ribs. The trunk flexes, extends and rotates.
 *
 * Erector spinae and rectus abdominis both state a tendon shorter than nothing, which refused them
 * until OQ-023: the fiber length comes from the width of the two ranges and the tendon from the
 * offset, and only the offset is contradictory. The tendon is refitted here regardless.
 */

import { cite } from '@bs-humany/hsdl';
import type { MuscleGroup } from './schema.js';

/** Anatomy: which bony feature a muscle attaches to. The sites themselves are cited in M5.3. */
const gray = (muscle: string) => cite('gray1918', \`Part IV, Myology: The \${muscle}\`);

/** Parameters: the actuator in the vendored torso model they were derived from. */
const myoTorso = (actuator: string) =>
  cite(
    'caggiano2022',
    \`${TORSO.muscle}, actuator general name="\${actuator}": gainprm force, and optimal fiber \` +
      'length and tendon slack length derived from gainprm range with lengthrange',
  );

/** The two the abdomen model does not carry come from the detailed one instead. */
const myoTorsoLumbar = (actuator: string) =>
  cite(
    'caggiano2022',
    \`${TORSO_LUMBAR.muscle}, actuator general name="\${actuator}": gainprm force, and optimal \` +
      'fiber length and tendon slack length derived from gainprm range with lengthrange',
  );

export const TORSO_MUSCLES: readonly MuscleGroup[] = [
${body}
];

/** Every unit in the set, flattened, in a stable order. */
export const TORSO_UNITS = TORSO_MUSCLES.flatMap((group) => group.units);
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
      `generate-torso-muscles: ${relative(ROOT, OUT)} is not what the generator would write.\n` +
        '  Run `pnpm generate:torso-muscles`. If the vendored model changed, say so in the commit.',
    );
    process.exit(1);
  }
  console.log(`generate-torso-muscles: ok. ${sided(UNITS).length} units match ${TORSO.muscle}.`);
} else {
  writeFileSync(OUT, rendered);
  console.log(
    `generate-torso-muscles: wrote ${relative(ROOT, OUT)} -- ${sided(UNITS).length} units from ${TORSO.muscle}.`,
  );
}
