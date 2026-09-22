/**
 * Every muscle in the body, in one list.
 *
 * The studio, the test runner and the training rig each build the same body, and each used to
 * assemble it by spreading the eleven region sets in a literal of its own. Three copies of one
 * list is three chances to add a region to two of them: add the hand to the studio and the trainer
 * and not to the runner, and the goldens go on passing against a body with no fingers while the
 * thing anyone looks at has them. So the list is written once, here, beside the sets it is made
 * of, and the three of them read it.
 *
 * The order is the order the regions were built in, which is the order the units are numbered in
 * and therefore the order a trained policy's outputs are in. Appending is safe; reordering is not.
 */

import { ANKLE_MUSCLES } from './ankle.js';
import { ELBOW_MUSCLES } from './elbow.js';
import { FOREARM_MUSCLES } from './forearm.js';
import { GIRDLE_MUSCLES } from './girdle.js';
import { HAND_MUSCLES } from './hand.js';
import { HIP_MUSCLES } from './hip.js';
import { KNEE_MUSCLES } from './knee.js';
import { NECK_MUSCLES } from './neck.js';
import type { MuscleGroup } from './schema.js';
import { SHOULDER_MUSCLES } from './shoulder.js';
import { THORAX_MUSCLES } from './thorax.js';
import { TORSO_MUSCLES } from './torso.js';
import { TRUNK_MUSCLES } from './trunk.js';

export const ALL_MUSCLES: readonly MuscleGroup[] = [
  ...ELBOW_MUSCLES,
  ...SHOULDER_MUSCLES,
  ...KNEE_MUSCLES,
  ...HIP_MUSCLES,
  ...ANKLE_MUSCLES,
  ...TRUNK_MUSCLES,
  ...FOREARM_MUSCLES,
  ...TORSO_MUSCLES,
  ...NECK_MUSCLES,
  ...GIRDLE_MUSCLES,
  ...THORAX_MUSCLES,
  ...HAND_MUSCLES,
];

/** Every unit in the body, flattened, in the same order. */
export const ALL_MUSCLE_UNITS = ALL_MUSCLES.flatMap((group) => group.units);
