#!/usr/bin/env node
/**
 * Generates the ankle and foot muscle parameter set from the vendored MyoSuite leg model.
 *
 *   pnpm generate:ankle-muscles          # rewrite packages/muscle-data/src/ankle.ts
 *   pnpm generate:ankle-muscles --check  # fail if the file is not what this would write
 *
 * The same two derivations as every other set, over the nine actuators that cross the ankle. What
 * is here is the part that is about the ankle.
 *
 * ## Retinacula, and why nothing wraps
 *
 * A muscle at the ankle is not held off the joint by bone. It is held by a retinaculum -- a band
 * of fascia strapping the tendon into a groove -- and the grooves are what give these muscles
 * their leverage. Fibularis longus turns under the cuboid to reach the sole; flexor hallucis
 * longus runs behind the talus and under the sustentaculum tali; tibialis posterior passes behind
 * the medial malleolus. Without those turns every one of them runs straight from the leg to the
 * foot, which puts the evertors and invertors on the wrong side of the subtalar axis.
 *
 * None of that is a wrap surface, and the reference does not model it as one: all nine of these
 * tendons are pure via-point paths in the source, and the points are carried here the way every
 * other region's are. That is the right tool -- a retinaculum holds a tendon at a place, which is
 * what a via point is, rather than turning it over a radius.
 *
 * The dataset marks the grooves themselves, which is a nice confirmation that the anatomy is
 * being described rather than approximated: the cuboid carries a groove for fibularis longus and
 * the calcaneus one for flexor hallucis longus, both named.
 *
 * ## The four long toe muscles are ankle muscles here
 *
 * Extensor and flexor digitorum longus and their hallucis counterparts insert on the phalanges,
 * and the dataset marks no phalangeal feature at all -- no tuberosity, no base, nothing on any of
 * the fourteen bones. So each tendon is carried to the head of the metatarsal it runs over and
 * stops there, which keeps its line through the ankle and gives it no action at the toes.
 *
 * That is a real loss and it is stated rather than hidden: these four are about a tenth of the
 * plantarflexion and dorsiflexion at the ankle between them, which they still do, and all of the
 * toe-off in a stride, which they no longer do. Recorded in OQ-021. Extensor and flexor digitorum
 * longus fan to four toes apiece and are carried to the third metatarsal, the middle of the four.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { LEGS, readActuators, renderGroups, requirePhysical, sided } from '../lib/myoSuite.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/muscle-data/src/ankle.ts');
const check = process.argv.includes('--check');

const jiti = createJiti(import.meta.url);
const { VIA_PATH_DIRECTION, viaPointsFor } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/muscleViaPoints.ts'),
);

/** Which actuator becomes which unit, and which of our attachment sites it binds to. */
const UNITS = [
  {
    actuator: 'soleus_r',
    group: 'triceps_surae_$',
    groupName: 'Triceps surae, soleus',
    taTerm: 'Musculus soleus',
    innervation: 'Tibial nerve',
    id: 'soleus_$',
    name: 'Soleus',
    origin: 'soleus_origin_$_soleal_line',
    insertion: 'soleus_insertion_$_calcaneal_tuberosity',
  },
  {
    actuator: 'tibant_r',
    group: 'tibialis_anterior_$',
    groupName: 'Tibialis anterior',
    taTerm: 'Musculus tibialis anterior',
    innervation: 'Deep fibular nerve',
    id: 'tibialis_anterior_$',
    name: 'Tibialis anterior',
    origin: 'tibialis_anterior_origin_$_lateral_surface_of_tibia',
    insertion: 'tibialis_anterior_insertion_$_first_metatarsal_bone',
  },
  {
    actuator: 'tibpost_r',
    group: 'tibialis_posterior_$',
    groupName: 'Tibialis posterior',
    taTerm: 'Musculus tibialis posterior',
    innervation: 'Tibial nerve',
    id: 'tibialis_posterior_$',
    name: 'Tibialis posterior',
    origin: 'tibialis_posterior_origin_$_posterior_surface_of_tibia',
    insertion: 'tibialis_posterior_insertion_$_tuberosity_of_navicular_bone',
  },
  {
    actuator: 'perlong_r',
    group: 'fibularis_longus_$',
    groupName: 'Fibularis longus',
    taTerm: 'Musculus fibularis longus',
    innervation: 'Superficial fibular nerve',
    id: 'fibularis_longus_$',
    name: 'Fibularis longus',
    origin: 'fibularis_longus_origin_$_footprint',
    insertion: 'fibularis_longus_insertion_$_first_metatarsal_bone',
  },
  {
    actuator: 'perbrev_r',
    group: 'fibularis_brevis_$',
    groupName: 'Fibularis brevis',
    taTerm: 'Musculus fibularis brevis',
    innervation: 'Superficial fibular nerve',
    id: 'fibularis_brevis_$',
    name: 'Fibularis brevis',
    origin: 'fibularis_brevis_origin_$_lateral_surface_of_fibula',
    insertion: 'fibularis_brevis_insertion_$_fifth_metatarsal_bone',
  },
  {
    actuator: 'edl_r',
    group: 'extensor_digitorum_longus_$',
    groupName: 'Extensor digitorum longus',
    taTerm: 'Musculus extensor digitorum longus',
    innervation: 'Deep fibular nerve',
    id: 'extensor_digitorum_longus_$',
    name: 'Extensor digitorum longus',
    origin: 'extensor_digitorum_longus_origin_$_footprint',
    insertion: 'extensor_digitorum_longus_insertion_$_head_of_metatarsal_bone',
  },
  {
    actuator: 'ehl_r',
    group: 'extensor_hallucis_longus_$',
    groupName: 'Extensor hallucis longus',
    taTerm: 'Musculus extensor hallucis longus',
    innervation: 'Deep fibular nerve',
    id: 'extensor_hallucis_longus_$',
    name: 'Extensor hallucis longus',
    origin: 'extensor_hallucis_longus_origin_$_anteromedial_surface_of_fibula',
    insertion: 'extensor_hallucis_longus_insertion_$_head_of_metatarsal_bone',
  },
  {
    actuator: 'fdl_r',
    group: 'flexor_digitorum_longus_$',
    groupName: 'Flexor digitorum longus',
    taTerm: 'Musculus flexor digitorum longus',
    innervation: 'Tibial nerve',
    id: 'flexor_digitorum_longus_$',
    name: 'Flexor digitorum longus',
    origin: 'flexor_digitorum_longus_origin_$_posterior_surface_of_tibia',
    insertion: 'flexor_digitorum_longus_insertion_$_head_of_metatarsal_bone',
  },
  {
    actuator: 'fhl_r',
    group: 'flexor_hallucis_longus_$',
    groupName: 'Flexor hallucis longus',
    taTerm: 'Musculus flexor hallucis longus',
    innervation: 'Tibial nerve',
    id: 'flexor_hallucis_longus_$',
    name: 'Flexor hallucis longus',
    origin: 'flexor_hallucis_longus_origin_$_posterior_surface_of_fibula',
    insertion: 'flexor_hallucis_longus_insertion_$_head_of_metatarsal_bone',
  },
];

/**
 * Which muscles keep the via points carried from the reference, and which are better without.
 *
 * The carried points are placed by a frame correspondence fitted at the *femur* -- one rotation
 * and one scale for the whole leg -- and by the ankle they are out by about twenty millimetres.
 * For a tendon running fifty millimetres behind the joint that is a rounding error, and the five
 * posterior and lateral muscles come out with moment arms in the published range. For a tendon
 * running forty in front of it, twenty millimetres is the difference between a dorsiflexor and
 * nothing: carried, tibialis anterior has a 4 mm flexion arm where it should have forty, and
 * extensor digitorum longus and extensor hallucis longus sit within a few millimetres of the axis
 * and change sign across the range.
 *
 * Measured, at the neutral ankle:
 *
 *     with the carried points      without them        published
 *     tibialis anterior     4 mm          51 mm          about 40
 *     ext. digitorum longus -2            93             about 30
 *     ext. hallucis longus  -4            64             about 25
 *
 * So those three run straight from our own attachments, which is wrong in the other direction --
 * without the extensor retinaculum holding them down against the front of the ankle they bow away
 * from it, and the two extensors come out two to three times what they should be. Both answers
 * are wrong and this is the less wrong one: the sign is right, the muscle works, and the error is
 * in a quantity rather than in whether the muscle is a dorsiflexor at all.
 *
 * What fixes it properly is a frame correspondence of the foot's own, fitted at the ankle instead
 * of at the hip, which is OQ-021.
 */
const STRAIGHT = /^(tibialis_anterior|extensor_digitorum_longus|extensor_hallucis_longus)_/;

const viaPointsWeTrust = (unitId) => (STRAIGHT.test(unitId) ? [] : viaPointsFor(unitId));

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
  const body = renderGroups(units, viaPointsWeTrust, VIA_PATH_DIRECTION, LEGS);

  return `/**
 * The ankle and foot muscle parameter set -- ticket N2.4, the last of the lower limb.
 *
 * **Generated by \`pnpm generate:ankle-muscles\`. Do not edit.** The numbers are extracted from
 * the vendored MyoSuite leg model rather than copied out of it, so the value here and the value in
 * the cited file cannot disagree; CI runs the generator with \`--check\`.
 *
 * ## Where each half comes from
 *
 * The same split as every other set. *Where a muscle attaches* is ours: Gray's anatomical
 * statement located on this subject by the dataset's own markers. *What a muscle can do* is
 * MyoSuite's. The two lengths are neither -- both are measured against a skeleton -- so both are
 * derived at compile against this one.
 *
 * ## Three of them run straight, because the carried points are worse than none
 *
 * The via points come from a frame correspondence fitted at the femur, and by the ankle they are
 * out by about twenty millimetres -- nothing to a tendon fifty behind the joint, everything to one
 * forty in front of it. Carried, tibialis anterior has a 4 mm dorsiflexion arm where it should
 * have forty. Without them it has 51, against a published forty; the two long extensors come out
 * two to three times what they should, because nothing holds them down against the front of the
 * ankle. The sign is right and the muscle works, which the other answer cannot say. OQ-021.
 *
 * ## What holds these tendons is via points, not surfaces
 *
 * A muscle at the ankle is held off the joint by a retinaculum rather than by bone, and the
 * grooves those bands strap the tendons into are what give these muscles their leverage:
 * fibularis longus turns under the cuboid to reach the sole, flexor hallucis longus runs under
 * the sustentaculum tali, tibialis posterior passes behind the medial malleolus. All nine are
 * pure via-point paths in the source and are carried that way here, which is the right tool --
 * a retinaculum holds a tendon at a place rather than turning it over a radius.
 *
 * ## The four long toe muscles stop at the metatarsals
 *
 * The dataset marks no phalangeal feature on any of the fourteen toe bones, so extensor and
 * flexor digitorum longus and their hallucis counterparts are carried to the head of the
 * metatarsal each runs over. They keep their line through the ankle and have no action at the
 * toes. That is stated rather than hidden, and recorded in OQ-021.
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

export const ANKLE_MUSCLES: readonly MuscleGroup[] = [
${body}
];

/** Every unit in the set, flattened, in a stable order. */
export const ANKLE_UNITS = ANKLE_MUSCLES.flatMap((group) => group.units);
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
      `generate-ankle-muscles: ${relative(ROOT, OUT)} is not what the generator would write.\n` +
        '  Run `pnpm generate:ankle-muscles`. If the vendored model changed, say so in the commit.',
    );
    process.exit(1);
  }
  console.log(`generate-ankle-muscles: ok. ${sided(UNITS).length} units match ${LEGS.muscle}.`);
} else {
  writeFileSync(OUT, rendered);
  console.log(
    `generate-ankle-muscles: wrote ${relative(ROOT, OUT)} -- ${sided(UNITS).length} units from ${LEGS.muscle}.`,
  );
}
