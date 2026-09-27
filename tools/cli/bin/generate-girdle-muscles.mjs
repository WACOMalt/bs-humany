#!/usr/bin/env node
/**
 * Generates the shoulder girdle muscle parameter set.
 *
 *   pnpm generate:girdle-muscles          # rewrite packages/muscle-data/src/girdle.ts
 *   pnpm generate:girdle-muscles --check  # fail if the file is not what this would write
 *
 * ## Where the numbers come from
 *
 * The muscles that hang the scapula from the skull and spine and pin it to the ribs: trapezius,
 * levator scapulae, the rhomboids, serratus anterior, pectoralis minor. MyoSuite's arm has no
 * actuator for any of them -- its scapula is carried by a regression, not by muscles -- so they
 * are read from Seth et al. 2019, Table 1, the thoracoscapular shoulder model, which states each
 * one's maximal isometric force, optimal fibre length, tendon slack length and pennation, as
 * aggregated from van der Helm's bundles with Klein Breteler's parameters.
 *
 * Seth carries trapezius in four parts by insertion. This set carries three by origin -- the
 * descending part from the skull, the transverse from C7, the ascending from the mid-thoracic
 * spine -- and maps them: the descending part is Seth's clavicular part, the transverse his
 * scapula-superior, and the ascending his scapula-middle and scapula-inferior together, with
 * the lengths averaged by force.
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { cliFlags } from '../lib/args.mjs';
import { emitOrCheck } from '../lib/generated.mjs';
import { bothSides, renderMuscleGroups } from '../lib/renderMuscles.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/muscle-data/src/girdle.ts');
const { check } = cliFlags('generate-girdle-muscles');

// The site-id scheme `attachments.ts` builds the sites with, so an id named here is the one the
// body carries.
const jiti = createJiti(import.meta.url);
const { attachmentSiteId } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/attachmentSiteId.ts'),
);

/** Seth 2019 Table 1, verbatim: force N, lengths m, pennation degrees. */
const SETH = {
  'Trapezius, Scapula superior': { force: 1043, fibre: 0.1127, tendon: 0.027 },
  'Trapezius, Scapula middle': { force: 470.4, fibre: 0.0832, tendon: 0.032 },
  'Trapezius, Scapula inferior': { force: 414.4, fibre: 0.1264, tendon: 0.035 },
  'Trapezius, Clavicle': { force: 201.6, fibre: 0.1116, tendon: 0.027 },
  'Serratus anterior, Superior': { force: 387.8, fibre: 0.0945, tendon: 0 },
  'Serratus anterior, Middle': { force: 508, fibre: 0.1538, tendon: 0.012 },
  'Serratus anterior, Inferior': { force: 430, fibre: 0.1587, tendon: 0 },
  'Rhomboideus, Superior': { force: 200.2, fibre: 0.0986, tendon: 0.015 },
  'Rhomboideus, Inferior': { force: 407.4, fibre: 0.1152, tendon: 0.028 },
  'Levator scapulae': { force: 280, fibre: 0.1578, tendon: 0.019 },
  'Pectoralis minor': { force: 429.8, fibre: 0.1183, tendon: 0.032 },
};

/** Two of Seth's rows as one unit: forces added, lengths averaged by force. */
function combined(...rows) {
  const force = rows.reduce((t, r) => t + SETH[r].force, 0);
  const fibre = rows.reduce((t, r) => t + SETH[r].force * SETH[r].fibre, 0) / force;
  const tendon = rows.reduce((t, r) => t + SETH[r].force * SETH[r].tendon, 0) / force;
  return { force, fibre, tendon, rows: rows.join(' + ') };
}

const UNITS = [
  {
    group: 'trapezius_$',
    groupName: 'Trapezius',
    taTerm: 'Musculus trapezius',
    innervation: 'Accessory nerve (XI); C3, C4',
    units: [
      {
        id: 'trapezius_upper_$',
        name: 'Trapezius, descending part',
        row: 'Trapezius, Clavicle',
        origin: ['trapezius_upper', 'external_occipital_protuberance'],
        insertion: ['trapezius_upper', 'acromial_end'],
      },
      {
        id: 'trapezius_middle_$',
        name: 'Trapezius, transverse part',
        row: 'Trapezius, Scapula superior',
        origin: ['trapezius_middle', 'spinous_process_tip'],
        insertion: ['trapezius_middle', 'acromion'],
      },
      {
        id: 'trapezius_lower_$',
        name: 'Trapezius, ascending part',
        rows: ['Trapezius, Scapula middle', 'Trapezius, Scapula inferior'],
        origin: ['trapezius_lower', 'spinous_process_tip'],
        insertion: ['trapezius_lower', 'spine_of_scapula'],
      },
    ],
  },
  {
    group: 'levator_scapulae_$',
    groupName: 'Levator scapulae',
    taTerm: 'Musculus levator scapulae',
    innervation: 'Dorsal scapular nerve; C3, C4',
    units: [
      {
        id: 'levator_scapulae_$',
        name: 'Levator scapulae',
        row: 'Levator scapulae',
        origin: ['levator_scapulae', 'transverse_process_tip_$'],
        insertion: ['levator_scapulae', 'superior_angle_of_scapula'],
      },
    ],
  },
  {
    group: 'rhomboids_$',
    groupName: 'Rhomboidei',
    taTerm: 'Musculi rhomboidei',
    innervation: 'Dorsal scapular nerve',
    units: [
      {
        id: 'rhomboid_minor_$',
        name: 'Rhomboideus minor',
        row: 'Rhomboideus, Superior',
        origin: ['rhomboid_minor', 'spinous_process_tip'],
        insertion: ['rhomboid_minor', 'medial_border_of_scapula'],
      },
      {
        id: 'rhomboid_major_$',
        name: 'Rhomboideus major',
        row: 'Rhomboideus, Inferior',
        origin: ['rhomboid_major', 'spinous_process_tip'],
        insertion: ['rhomboid_major', 'medial_border_of_scapula'],
      },
    ],
  },
  {
    group: 'serratus_anterior_$',
    groupName: 'Serratus anterior',
    taTerm: 'Musculus serratus anterior',
    innervation: 'Long thoracic nerve',
    units: [
      {
        id: 'serratus_anterior_superior_$',
        name: 'Serratus anterior, superior part',
        row: 'Serratus anterior, Superior',
        origin: ['serratus_anterior_superior', 'outer_surface_at_70'],
        insertion: ['serratus_anterior_superior', 'superior_angle_of_scapula'],
      },
      {
        id: 'serratus_anterior_middle_$',
        name: 'Serratus anterior, middle part',
        row: 'Serratus anterior, Middle',
        origin: ['serratus_anterior_middle', 'outer_surface_at_70'],
        insertion: ['serratus_anterior_middle', 'medial_border_of_scapula'],
      },
      {
        id: 'serratus_anterior_inferior_$',
        name: 'Serratus anterior, inferior part',
        row: 'Serratus anterior, Inferior',
        origin: ['serratus_anterior_inferior', 'outer_surface_at_70'],
        insertion: ['serratus_anterior_inferior', 'inferior_angle_of_scapula'],
      },
    ],
  },
  {
    group: 'pectoralis_minor_$',
    groupName: 'Pectoralis minor',
    taTerm: 'Musculus pectoralis minor',
    innervation: 'Medial pectoral nerve',
    units: [
      {
        id: 'pectoralis_minor_$',
        name: 'Pectoralis minor',
        row: 'Pectoralis minor',
        origin: ['pectoralis_minor', 'outer_surface_at_90'],
        insertion: ['pectoralis_minor', 'coracoid_process'],
      },
    ],
  },
];

function render() {
  const groups = bothSides(UNITS).map((group) => {
    const s = group.group.endsWith('_l') ? 'l' : 'r';
    return {
      id: group.group,
      displayName: `${group.groupName}, ${s === 'r' ? 'right' : 'left'}`,
      taTerm: group.taTerm,
      innervation: group.innervation,
      source: `gray('${group.groupName}')`,
      units: group.units.map((unit) => {
        const p = unit.rows ? combined(...unit.rows) : { ...SETH[unit.row], rows: unit.row };
        return {
          id: unit.id,
          displayName: `${unit.name}, ${s === 'r' ? 'right' : 'left'}`,
          origin: attachmentSiteId(unit.origin[0], 'origin', s, null, unit.origin[1]),
          insertion: attachmentSiteId(unit.insertion[0], 'insertion', s, null, unit.insertion[1]),
          path: [],
          parameters: {
            maxIsometricForce: p.force,
            optimalFiberLength: p.fibre,
            tendonSlackLength: p.tendon,
            pennationAngle: 0,
          },
          source: `seth('${p.rows}')`,
        };
      }),
    };
  });
  const body = renderMuscleGroups(groups);

  return `/**
 * The shoulder girdle muscle parameter set -- what hangs the scapula and pins it to the ribs.
 *
 * **Generated by \`pnpm generate:girdle-muscles\`. Do not edit.** CI runs the generator with
 * \`--check\`.
 *
 * Trapezius in three parts from the skull, C7 and the mid-thoracic spine to the clavicle and
 * the scapula; levator scapulae and the two rhomboids from the cervical and upper thoracic spine
 * to the scapula's upper and medial borders; serratus anterior in three parts from the ribs to
 * the same borders from in front; pectoralis minor from the ribs to the coracoid. MyoSuite's arm
 * carries none of them, so the parameters are Seth 2019's, Table 1, from the thoracoscapular
 * shoulder model.
 */

import { cite } from '@bs-humany/hsdl';
import type { MuscleGroup } from './schema.js';

/** Anatomy: which bony feature a muscle attaches to. The sites themselves are cited in M5.3. */
const gray = (muscle: string) => cite('gray1918', \`Part IV, Myology: The \${muscle}\`);

/** Parameters: the row of Seth 2019's Table 1 they are, force and fibre and tendon as given. */
const seth = (row: string) =>
  cite(
    'seth2019',
    \`Table 1, \${row}: max isometric force, optimal fiber length, tendon slack length, pennation\`,
  );

export const GIRDLE_MUSCLES: readonly MuscleGroup[] = [
${body}
];

/** Every unit in the set, flattened, in a stable order. */
export const GIRDLE_UNITS = GIRDLE_MUSCLES.flatMap((g) => g.units);
`;
}

const text = render();
emitOrCheck({
  name: 'generate-girdle-muscles',
  script: 'generate:girdle-muscles',
  out: OUT,
  text,
  check,
});
