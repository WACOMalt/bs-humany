#!/usr/bin/env node
/**
 * Generates the neck muscle parameter set.
 *
 *   pnpm generate:neck-muscles          # rewrite packages/muscle-data/src/neck.ts
 *   pnpm generate:neck-muscles --check  # fail if the file is not what this would write
 *
 * ## Where the numbers come from
 *
 * MyoSuite has no neck: its head is a rigid chain. So this set cannot be read from a vendored
 * actuator the way every other region's is, and it is derived instead, every step cited:
 *
 * - **Volume.** Zheng et al. 2013 measured the neck's muscles by MRI in living subjects and give
 *   each muscle's share of the total neck muscle volume, and the total: 813.9 cm³ in men and
 *   510.4 in women. This project's reference body is halfway between the sexes, so it takes the
 *   mean of the two totals, 662.2 cm³, and each muscle's share of it, halved for a side.
 * - **Fibre length.** Measured on this project's own bones: the straight distance between the
 *   muscle's attachments at the dataset's stature, of which the fibres are taken to be seven
 *   tenths and the tendon three -- OQ-027 records that fraction as the assumption it is. Bruno
 *   2015 sizes the intercostals from their attachments the same way.
 * - **Cross-section and force.** PCSA is volume over fibre length, and force is PCSA times the
 *   35 N/cm² Vasavada 1998 used for these muscles, as Mortensen 2018 reports it.
 *
 * Trapezius and levator scapulae are neck muscles by Zheng's count but shoulder-girdle muscles by
 * Seth 2019's table, which states their forces directly; they are in `girdle.ts`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { bothSides, distance, renderMuscleGroups } from '../lib/renderMuscles.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/muscle-data/src/neck.ts');
const DATA = join(ROOT, 'packages/assets-anatomical/data');
const check = process.argv.includes('--check');

// The export's marker table, which CONTRIBUTING rule 5 says names a feature and never positions
// it. The lengths below are still measured between those markers; measuring them through the
// skeleton's `measuredWorld` changes this set's numbers, so it waits for its own commit with the
// other anatomy-data fixes that move the goldens.
const landmarks = JSON.parse(readFileSync(join(DATA, 'landmarks.json'), 'utf8'));
// The site-id scheme `attachments.ts` builds the sites with, so an id named here is the one the
// body carries.
const jiti = createJiti(import.meta.url);
const { attachmentSiteId } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/attachmentSiteId.ts'),
);

/** Zheng 2013: total neck muscle volume, cm³, men and women; the reference body takes the mean. */
const TOTAL_VOLUME_MEN = 813.9;
const TOTAL_VOLUME_WOMEN = 510.4;
const TOTAL_VOLUME = (TOTAL_VOLUME_MEN + TOTAL_VOLUME_WOMEN) / 2;
/** Vasavada 1998's specific tension for the neck, N/cm² (Mortensen 2018 reports it). */
const SPECIFIC_TENSION = 35;
/** The fibres' share of the attachment-to-attachment length; the rest is tendon (OQ-027). */
const FIBRE_FRACTION = 0.7;

/**
 * Each muscle's share of the total neck volume (both sides together), from Zheng 2013 as
 * reproduced in Roos 2019 Table 2, "Average" column; where Zheng gives one share for a muscle
 * this set carries in parts, the split between the parts is stated with it.
 */
const UNITS = [
  {
    group: 'sternocleidomastoid_$',
    groupName: 'Sternocleidomastoideus',
    taTerm: 'Musculus sternocleidomastoideus',
    innervation: 'Accessory nerve (XI); C2, C3',
    id: 'sternocleidomastoid_$',
    name: 'Sternocleidomastoid',
    share: 0.15,
    shareNote: 'Sternocleidomastoid 15.0%',
    origin: ['sternum', 'Manubrium_of_sternum'],
    insertion: ['temporal_$', 'Mastoid_process'],
  },
  {
    group: 'splenius_capitis_$',
    groupName: 'Splenius capitis',
    taTerm: 'Musculus splenius capitis',
    innervation: 'Dorsal rami of the middle cervical nerves',
    id: 'splenius_capitis_$',
    name: 'Splenius capitis',
    share: (0.097 * 2) / 3,
    shareNote: 'Splenius (capitis and cervicis) 9.7%, two thirds to capitis',
    origin: ['vertebra_t3', 'Spinous_process_tip'],
    insertion: ['temporal_$', 'Mastoid_process'],
  },
  {
    group: 'splenius_cervicis_$',
    groupName: 'Splenius cervicis',
    taTerm: 'Musculus splenius cervicis',
    innervation: 'Dorsal rami of the lower cervical nerves',
    id: 'splenius_cervicis_$',
    name: 'Splenius cervicis',
    share: 0.097 / 3,
    shareNote: 'Splenius (capitis and cervicis) 9.7%, one third to cervicis',
    origin: ['vertebra_t5', 'Spinous_process_tip'],
    insertion: ['vertebra_c2', 'Transverse_process_tip_$'],
  },
  {
    group: 'semispinalis_capitis_$',
    groupName: 'Semispinalis capitis',
    taTerm: 'Musculus semispinalis capitis',
    innervation: 'Dorsal rami of the cervical nerves',
    id: 'semispinalis_capitis_$',
    name: 'Semispinalis capitis',
    share: 0.107,
    shareNote: 'Semispinalis capitis 10.7%',
    origin: ['vertebra_t4', 'Transverse_process_tip_$'],
    insertion: ['occipital', 'Inferior_nuchal_line_$'],
  },
  {
    group: 'longissimus_capitis_$',
    groupName: 'Longissimus capitis',
    taTerm: 'Musculus longissimus capitis',
    innervation: 'Dorsal rami of the cervical and thoracic nerves',
    id: 'longissimus_capitis_$',
    name: 'Longissimus capitis',
    share: 0.017,
    shareNote: 'Longissimus capitis 1.7%',
    origin: ['vertebra_t3', 'Transverse_process_tip_$'],
    insertion: ['temporal_$', 'Mastoid_process'],
  },
  {
    group: 'longissimus_cervicis_$',
    groupName: 'Longissimus cervicis',
    taTerm: 'Musculus longissimus cervicis',
    innervation: 'Dorsal rami of the cervical and thoracic nerves',
    id: 'longissimus_cervicis_$',
    name: 'Longissimus cervicis',
    share: 0.012,
    shareNote: 'Longissimus cervicis 1.2%',
    origin: ['vertebra_t4', 'Transverse_process_tip_$'],
    insertion: ['vertebra_c4', 'Transverse_process_tip_$'],
  },
  {
    group: 'scalenus_anterior_$',
    groupName: 'Scalenus anterior',
    taTerm: 'Musculus scalenus anterior',
    innervation: 'Ventral rami of C4 to C6',
    id: 'scalenus_anterior_$',
    name: 'Scalenus anterior',
    share: 0.063 * 0.35,
    shareNote: 'Scalenus 6.3%, of which anterior 35%',
    origin: ['vertebra_c4', 'Transverse_process_tip_$'],
    insertion: ['rib_1_$', 'Upper_border_at_50'],
  },
  {
    group: 'scalenus_medius_$',
    groupName: 'Scalenus medius',
    taTerm: 'Musculus scalenus medius',
    innervation: 'Ventral rami of C3 to C8',
    id: 'scalenus_medius_$',
    name: 'Scalenus medius',
    share: 0.063 * 0.45,
    shareNote: 'Scalenus 6.3%, of which medius 45%',
    origin: ['vertebra_c5', 'Transverse_process_tip_$'],
    insertion: ['rib_1_$', 'Upper_border_at_60'],
  },
  {
    group: 'scalenus_posterior_$',
    groupName: 'Scalenus posterior',
    taTerm: 'Musculus scalenus posterior',
    innervation: 'Ventral rami of C6 to C8',
    id: 'scalenus_posterior_$',
    name: 'Scalenus posterior',
    share: 0.063 * 0.2,
    shareNote: 'Scalenus 6.3%, of which posterior 20%',
    origin: ['vertebra_c6', 'Transverse_process_tip_$'],
    insertion: ['rib_2_$', 'Upper_border_at_50'],
  },
  {
    group: 'longus_colli_$',
    groupName: 'Longus colli',
    taTerm: 'Musculus longus colli',
    innervation: 'Ventral rami of C2 to C6',
    id: 'longus_colli_$',
    name: 'Longus colli',
    share: 0.017,
    shareNote: 'Longus colli 1.7%',
    origin: ['vertebra_t2', 'Anterior_surface_of_body'],
    insertion: ['vertebra_c1', 'Anterior_tubercle_of_atlas'],
  },
  {
    group: 'longus_capitis_$',
    groupName: 'Longus capitis',
    taTerm: 'Musculus longus capitis',
    innervation: 'Ventral rami of C1 to C3',
    id: 'longus_capitis_$',
    name: 'Longus capitis',
    share: 0.018,
    shareNote: 'Longus capitis 1.8%',
    origin: ['vertebra_c4', 'Transverse_process_tip_$'],
    insertion: ['occipital', 'Basilar_part_of_occipital_bone'],
  },
];

function render() {
  const groups = bothSides(UNITS).map((unit) => {
    const s = unit.id.endsWith('_l') ? 'l' : 'r';
    const muscle = unit.id.slice(0, -2);
    const [originBone, originFeature] = unit.origin;
    const [insertionBone, insertionFeature] = unit.insertion;
    const from = landmarks[originBone]?.[originFeature];
    const to = landmarks[insertionBone]?.[insertionFeature];
    if (!from || !to) {
      throw new Error(
        `${unit.id}: no landmark for ${originBone}/${originFeature} or ${insertionBone}/${insertionFeature}`,
      );
    }
    const length = distance(from, to);
    const fibre = FIBRE_FRACTION * length;
    // Zheng's share is of both sides; a side has half.
    const volume = (unit.share / 2) * TOTAL_VOLUME;
    const pcsa = volume / (fibre * 100);
    const force = SPECIFIC_TENSION * pcsa;
    return {
      id: unit.group,
      displayName: `${unit.groupName}, ${s === 'r' ? 'right' : 'left'}`,
      taTerm: unit.taTerm,
      innervation: unit.innervation,
      source: `gray('${unit.groupName}')`,
      units: [
        {
          id: unit.id,
          displayName: `${unit.name}, ${s === 'r' ? 'right' : 'left'}`,
          origin: attachmentSiteId(muscle, 'origin', s, originBone, originFeature),
          insertion: attachmentSiteId(muscle, 'insertion', s, insertionBone, insertionFeature),
          path: [],
          parameters: {
            maxIsometricForce: force,
            optimalFiberLength: fibre,
            tendonSlackLength: length - fibre,
            pennationAngle: 0,
          },
          source: {
            call: 'derived',
            args: [
              `'${unit.shareNote}'`,
              String(Number(volume.toPrecision(4))),
              String(Number((length * 1000).toFixed(1))),
            ],
          },
        },
      ],
    };
  });
  const body = renderMuscleGroups(groups);

  return `/**
 * The neck muscle parameter set -- what holds the head up and turns it.
 *
 * **Generated by \`pnpm generate:neck-muscles\`. Do not edit.** CI runs the generator with
 * \`--check\`.
 *
 * Sternocleidomastoid in front, splenius and semispinalis and longissimus behind, the scalenes
 * to the side and the longus muscles along the front of the spine. MyoSuite has no neck, so
 * these are derived rather than read: each muscle's volume is its share of the neck's total by
 * MRI (Zheng 2013), its fibre length is seven tenths of the distance between its attachments on
 * this project's bones, its cross-section is the one over the other, and its force is that
 * cross-section at the 35 N/cm² of Vasavada 1998. OQ-027 records the fibre fraction as the
 * assumption it is.
 */

import { cite } from '@bs-humany/hsdl';
import type { MuscleGroup } from './schema.js';

/** Anatomy: which bony feature a muscle attaches to. The sites themselves are cited in M5.3. */
const gray = (muscle: string) => cite('gray1918', \`Part IV, Myology: The \${muscle}\`);

/**
 * Parameters: the volume share and the measured attachment distance the numbers follow from.
 * Volume is Zheng 2013's share of a ${TOTAL_VOLUME.toFixed(1)} cm³ neck (the mean of men's
 * and women's totals), halved for a side; the distance is millimetres at the dataset's stature.
 */
const derived = (share: string, volumeCm3: number, distanceMm: number) =>
  cite(
    'zheng2013',
    \`\${share} of the total neck muscle volume (Roos 2019 Table 2), \${volumeCm3} cm³ a side; \` +
      \`fibres ${FIBRE_FRACTION} of the \${distanceMm} mm between attachments (OQ-027); \` +
      'force at 35 N/cm² (Vasavada 1998, per Mortensen 2018)',
  );

export const NECK_MUSCLES: readonly MuscleGroup[] = [
${body}
];

/** Every unit in the set, flattened, in a stable order. */
export const NECK_UNITS = NECK_MUSCLES.flatMap((g) => g.units);
`;
}

const text = render();
if (check) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== text) {
    console.error(`${relative(ROOT, OUT)} is stale; run pnpm generate:neck-muscles`);
    process.exit(1);
  }
  console.log(`${relative(ROOT, OUT)} is up to date`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${relative(ROOT, OUT)}`);
}
