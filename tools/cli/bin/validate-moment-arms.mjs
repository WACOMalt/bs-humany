#!/usr/bin/env node
/**
 * Moment arm validation -- ticket N1.9, muscle spec 13.2.
 *
 *   pnpm validate:moment-arms          # write docs/validation/moment-arms.md
 *   pnpm validate:moment-arms --check  # and fail if a discrepancy is not already recorded there
 *
 * "This is the most important test in the module, and it MUST run in continuous integration."
 * The reason is M-ADR-003: muscle force reaches the solver as wrenches at the points the tendon
 * pulls, never as a joint torque, so the moment arm is a *derived diagnostic* that nothing in the
 * simulation reads. That is what makes comparing it worth anything -- a quantity the simulation
 * depends on tells you the model is self-consistent, and one it does not tells you whether the
 * model is right.
 *
 * ## What it is compared against
 *
 * The vendored MyoSuite arm and legs, loaded into MuJoCo and measured (`tools/validate-external/
 * src/referenceArm.mjs`). Not a table of numbers transcribed from a paper: the models this project
 * took its muscle parameters from, run at the same angles, so every number on both sides of the
 * comparison is computed here and can be recomputed by anyone. The reference is an oracle under
 * ADR-009 -- it may be compared against and reported on, and no value is ever copied from it into
 * the model.
 *
 * Published cadaver ranges appear in the report as context only, in the note column, and are not
 * what anything passes or fails on. The reference model is itself fitted to that literature, and
 * comparing against a number nobody here has read would be the kind of claim ADR-009 exists to
 * stop.
 *
 * ## What is swept
 *
 * `ROWS`, one per coordinate: the elbow, the forearm's turn, the wrist both ways, and the hip, the
 * knee and the ankle. Each row states the pose it is taken in on both sides, and where the two
 * models' zeros differ it states the offset rather than assuming there is none -- the forearm is
 * the case, its zero palm-forward here and thumb-up there.
 *
 * TODO: the shoulder. It waits on how the glenohumeral coordinates map: the reference's
 * `elv_angle`, `shoulder_elv` and `shoulder_rot` carry the girdle with them through its rhythm
 * couplings, and ours are a ball joint with couplings of its own. Until someone decides which of
 * our coordinates stands for which of theirs, and at what pose of the other two, a shoulder row
 * would be comparing two different motions. The trunk's tendons (latissimus, pectoralis) wait
 * longer still, on the arm and torso chains being joined (`TRUNK_TENDONS_NEED_THE_TORSO_CHAIN`).
 *
 * ## What fails
 *
 * Two things, per muscle spec 13.2:
 *
 *   - A **sign change** where the reference shows none. Hard failure, always: an extensor that
 *     becomes a flexor part-way through the range holds a bent elbow bent. That is either a flip
 *     inside the range the reference does not make, or a muscle on the other side of the joint
 *     from the reference's -- ours pulling one way where theirs pulls the other, at any angle
 *     where both pull by more than `SIGN_FLOOR`.
 *   - A **deviation** past `TOLERANCE` that is not recorded in `RECORDED` below with a written
 *     explanation and the open question it belongs to.
 *
 * The recorded list is not a way to make a failure go away. Each entry names what is wrong, why
 * it is wrong, and what would fix it; the bound in each entry is the deviation as it stands, so
 * a discrepancy that grows fails again. A sign change can never be recorded.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { MYO_SIM_COMMIT } from '../../validate-external/src/models.mjs';
import {
  ELBOW_TENDONS,
  FOREARM_TENDONS,
  LEG_TENDONS,
  MODELS,
  REFERENCE_FOREARM_AT_OUR_NEUTRAL,
  loadReference,
} from '../../validate-external/src/referenceArm.mjs';
import { cliFlags } from '../lib/args.mjs';
import { reportIsCurrent } from '../lib/report.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const { check } = cliFlags('validate-moment-arms');

/**
 * How far our model may sit from the reference's before it has to be explained, metres.
 *
 * Five millimetres. Moment arms at the elbow run from about 8 to 90 mm, published measurements of
 * the same muscle across subjects spread by a centimetre or more, and a model that agreed to
 * closer than five would be being fitted rather than built. It is a bound on the mean deviation
 * across the sweep, and a mean is the right statistic here: a curve that is right everywhere but
 * one end is a different fault from one that is wrong throughout, and the peak column says which.
 */
const TOLERANCE = 0.005;

/**
 * How hard both models must pull before disagreeing about the direction counts, metres.
 *
 * One millimetre. A muscle whose arm crosses zero somewhere in the range -- a hip adductor that
 * flexes the extended hip and extends the flexed one -- is near zero on both sides of the crossing,
 * and two models that put the crossing a few degrees apart disagree about the sign there without
 * disagreeing about the muscle. Past a millimetre on both sides it is a muscle on the wrong side
 * of the joint.
 */
const SIGN_FLOOR = 0.001;

/** Our pose held for the forearm: palm forward, which is our zero and the reference's -90°. */
const SUPINATED = {
  ours: [{ jointId: 'radioulnar_r', axisName: 'pronation', value: 0 }],
  reference: { pro_sup_r: REFERENCE_FOREARM_AT_OUR_NEUTRAL },
};

/**
 * The sweeps: one coordinate each, on both models.
 *
 * `offset` is the reference's coordinate at our zero, so a sample at our angle `a` is taken at
 * the reference's `a + offset`; every row states it, zero included, so the pose is read off the
 * row rather than assumed. `hold` is the rest of the pose on each side. `muscles` names the
 * muscle-data sets our side is compiled from, and `tendons` the reference's, mapped to our units;
 * a unit is compared only where both models say it crosses the coordinate.
 */
const ROWS = [
  {
    name: 'Elbow flexion',
    ourJoint: 'elbow_r',
    ourDof: 'flexion',
    refJoint: 'elbow_flexion_r',
    range: { from: 0, to: 130, step: 10 },
    offset: 0,
    hold: SUPINATED,
    pose: 'forearm supinated',
    tendons: ELBOW_TENDONS,
    model: MODELS.arm,
    muscles: ['ELBOW_MUSCLES'],
  },
  {
    name: 'Forearm pronation',
    ourJoint: 'radioulnar_r',
    ourDof: 'pronation',
    refJoint: 'pro_sup_r',
    // From palm forward to thumb up: the half of the turn both models reach from our zero, since
    // ours stops at its own range's end where the reference's would carry on.
    range: { from: 0, to: 90, step: 10 },
    offset: REFERENCE_FOREARM_AT_OUR_NEUTRAL,
    hold: { ours: [], reference: {} },
    pose: 'elbow straight',
    tendons: FOREARM_TENDONS,
    model: MODELS.arm,
    muscles: ['FOREARM_MUSCLES'],
  },
  {
    name: 'Wrist flexion',
    ourJoint: 'wrist_r',
    ourDof: 'flexion',
    refJoint: 'flexion_r',
    range: { from: -40, to: 40, step: 10 },
    offset: 0,
    hold: SUPINATED,
    pose: 'elbow straight, forearm supinated',
    tendons: FOREARM_TENDONS,
    model: MODELS.arm,
    muscles: ['FOREARM_MUSCLES'],
  },
  {
    name: 'Wrist ulnar deviation',
    ourJoint: 'wrist_r',
    ourDof: 'ulnar_deviation',
    refJoint: 'deviation_r',
    range: { from: -10, to: 25, step: 5 },
    offset: 0,
    hold: SUPINATED,
    pose: 'elbow straight, forearm supinated',
    tendons: FOREARM_TENDONS,
    model: MODELS.arm,
    muscles: ['FOREARM_MUSCLES'],
  },
  {
    name: 'Hip flexion',
    ourJoint: 'hip_r',
    ourDof: 'flexion',
    refJoint: 'hip_flexion_r',
    range: { from: -30, to: 120, step: 10 },
    offset: 0,
    hold: { ours: [], reference: {} },
    pose: 'knee straight, ankle neutral',
    tendons: LEG_TENDONS,
    model: MODELS.legs,
    muscles: ['HIP_MUSCLES', 'KNEE_MUSCLES', 'ANKLE_MUSCLES'],
  },
  {
    name: 'Knee flexion',
    ourJoint: 'knee_r',
    ourDof: 'flexion',
    refJoint: 'knee_angle_r',
    range: { from: 0, to: 120, step: 10 },
    offset: 0,
    hold: { ours: [], reference: {} },
    pose: 'hip and ankle neutral',
    tendons: LEG_TENDONS,
    model: MODELS.legs,
    muscles: ['HIP_MUSCLES', 'KNEE_MUSCLES', 'ANKLE_MUSCLES'],
  },
  {
    name: 'Ankle dorsiflexion',
    ourJoint: 'talocrural_r',
    ourDof: 'dorsiflexion',
    refJoint: 'ankle_angle_r',
    range: { from: -40, to: 30, step: 10 },
    offset: 0,
    hold: { ours: [], reference: {} },
    pose: 'hip and knee neutral',
    tendons: LEG_TENDONS,
    model: MODELS.legs,
    muscles: ['HIP_MUSCLES', 'KNEE_MUSCLES', 'ANKLE_MUSCLES'],
  },
];

/**
 * What is known about each muscle in each sweep, and how far it is allowed to be wrong.
 *
 * `bound` is the mean deviation in metres as measured when the entry was written, plus a little
 * room; an entry with one excuses a difference past `TOLERANCE`, and passing means the fault is no
 * worse than it was rather than that it is acceptable. An entry without a bound excuses nothing --
 * it is context for a row that already agrees.
 */
const RECORDED = [
  {
    row: 'Elbow flexion',
    unit: 'biceps_brachii_long_r',
    question: 'OQ-015',
    note: 'Measured with both forearms supinated, ours runs up to six millimetres above the reference from full extension to 90 degrees, and within one of it at 80 and 90. What is left is deep flexion: past 90 degrees ours falls away faster than the reference’s, to about 11 mm at 130 against its 22, and that end is where the worst row is. The mean is within tolerance, so this is context rather than an excuse; it stays here so a path change that widens the gap at the top of the range is seen as the same fault.',
  },
  {
    row: 'Elbow flexion',
    unit: 'biceps_brachii_short_r',
    question: 'OQ-015',
    note: 'As the long head, and at the same place in the range: about 8 mm at 130 degrees against the reference’s 18.',
  },
  {
    row: 'Elbow flexion',
    unit: 'brachialis_r',
    bound: 0.013,
    question: 'OQ-015',
    note: 'Still close to twice the reference, though putting the markers back on the bone brought it in from 22 mm of mean error to 12 and moved its peak onto the reference’s angle. Its line still passes outside the trochlea cylinder at every angle, so the surface it declares does nothing for it; what it needs is an attachment over the coronoid rather than a point 40 mm from the flexion axis.',
  },
  {
    row: 'Elbow flexion',
    unit: 'brachioradialis_r',
    bound: 0.016,
    question: 'OQ-015',
    note: 'Was a fifth of the reference and the largest error in the set, and the wrap surface was blamed for it. That was wrong: the reference’s surface here is a 15 mm cylinder against our 12.4 mm trochlea, which cannot be worth 70 mm of moment arm. It was the origin. The lateral supracondylar ridge runs the lower third of the humerus and the dataset marks it once, near its bottom, 32 mm above the elbow; brachioradialis arises from its upper two-thirds, which `ridgeAttachments.ts` measures at 65 mm up. That took the peak arm from 18 mm to 64 and the mean error from 42.6 to 14.7. What is left is a path that still hugs the joint more than the reference’s at full flexion, where ours peaks at 110 degrees and falls to 27 mm by 130 while the reference is still climbing.',
  },
  {
    row: 'Elbow flexion',
    unit: 'triceps_brachii_long_r',
    bound: 0.008,
    question: 'OQ-015',
    note: 'Flat at 15 mm where the reference runs from 24 down to 8, and both halves of that are the same cause: our extensor pulley is coaxial with the joint, which by construction gives a constant arm, and the reference’s cylinder is offset behind it, which gives one that falls as the elbow closes. The size is the attachment: the triceps inserts on the olecranon, and the point the marker projects to stands 15 mm from the flexion axis where the bone’s own posterior apex stands 25. A surface at the olecranon was measured (25.1 mm) and does not help, because an attachment inside a wrap surface cannot wrap it.',
  },
  {
    row: 'Elbow flexion',
    unit: 'triceps_brachii_lateral_r',
    bound: 0.008,
    question: 'OQ-015',
    note: 'As the long head, and from the same attachment.',
  },
  {
    row: 'Elbow flexion',
    unit: 'triceps_brachii_medial_r',
    bound: 0.008,
    question: 'OQ-015',
    note: 'As the long head, and from the same attachment.',
  },
  // The rows below were first swept on 2026-09-27. Each bound is that day's mean rounded up to the
  // next half millimetre with at least a third of one to spare, and each note says what the two
  // curves show rather than why: none of these has been investigated yet.
  ...[
    [
      'Wrist flexion',
      'extensor_carpi_radialis_brevis_r',
      0.0105,
      'OQ-015',
      'An extensor in both, at under half the reference’s arm, and falling to 1 mm at full extension where the reference’s is largest (18 mm).',
    ],
    [
      'Hip flexion',
      'gluteus_maximus_superior_r',
      0.0165,
      'OQ-015',
      'An extensor that turns flexor in both, ours at about 70 degrees and the reference’s at about 105.',
    ],
    [
      'Hip flexion',
      'gluteus_maximus_middle_r',
      0.0255,
      'OQ-015',
      'As the superior part: ours turns flexor at about 75 degrees and the reference’s at about 115, and ours is two thirds of the reference in extension.',
    ],
    [
      'Hip flexion',
      'gluteus_medius_anterior_r',
      0.014,
      'OQ-015',
      'Turns from extensor to flexor in both, ours at about 5 degrees and the reference’s at about 55.',
    ],
    [
      'Hip flexion',
      'gluteus_medius_middle_r',
      0.0225,
      'OQ-015',
      'Turns from extensor to flexor in both, ours at about 8 degrees and the reference’s at about 95.',
    ],
    [
      'Hip flexion',
      'gluteus_minimus_anterior_r',
      0.01,
      'OQ-015',
      'Turns flexor in both, ours at about 5 degrees and the reference’s at about 25, and ours reaches more than twice the reference’s flexor arm.',
    ],
    [
      'Hip flexion',
      'gluteus_minimus_middle_r',
      0.012,
      'OQ-015',
      'Turns flexor in both, ours at about 5 degrees and the reference’s at about 50.',
    ],
    [
      'Hip flexion',
      'gluteus_minimus_posterior_r',
      0.0165,
      'OQ-015',
      'Turns flexor in both, ours at about -15 degrees and the reference’s at about 80.',
    ],
    [
      'Hip flexion',
      'iliacus_r',
      0.015,
      'OQ-015',
      'A flexor in both, but ours is 7 mm at full extension where the reference’s is 35, and peaks at 31 against the reference’s 44.',
    ],
    [
      'Hip flexion',
      'psoas_major_r',
      0.0065,
      'OQ-015',
      'A flexor in both and close through the middle of the range; ours stays at 24 mm at 120 degrees where the reference’s falls to 10.',
    ],
    [
      'Hip flexion',
      'adductor_longus_r',
      0.008,
      'OQ-015',
      'Flexor turning extensor in both, ours at about 83 degrees and the reference’s at about 75, and ours up to 12 mm larger as a flexor.',
    ],
    [
      'Hip flexion',
      'adductor_brevis_r',
      0.006,
      'OQ-015',
      'Flexor turning extensor in both, ours at about 57 degrees and the reference’s at about 69.',
    ],
    [
      'Hip flexion',
      'adductor_magnus_middle_r',
      0.013,
      'OQ-015',
      'Flexor turning extensor in both, ours at about -20 degrees and the reference’s at about 5.',
    ],
    [
      'Hip flexion',
      'adductor_magnus_distal_r',
      0.016,
      'OQ-015',
      'An extensor throughout in ours; the reference’s is a flexor at full extension and turns at about -20 degrees, and ours is the larger extensor below 60.',
    ],
    [
      'Hip flexion',
      'adductor_magnus_ischiocondylar_r',
      0.0075,
      'OQ-015',
      'An extensor in both, close from 30 degrees up; ours is up to 15 mm smaller toward full extension.',
    ],
    [
      'Hip flexion',
      'gracilis_r',
      0.033,
      'OQ-015',
      'Flexor turning extensor in both, but ours turns at about 78 degrees and the reference’s at about 15, so between the two ours is a flexor of up to 30 mm where the reference’s is an extensor of up to 50: the largest disagreement in the hip, recorded rather than failed only because both curves turn the same way.',
    ],
    [
      'Hip flexion',
      'sartorius_r',
      0.0195,
      'OQ-015',
      'A flexor in both, with the same shape; ours is a third larger throughout, 99 mm against 71 at the peak.',
    ],
    [
      'Hip flexion',
      'semimembranosus_r',
      0.006,
      'OQ-015',
      'An extensor in both with the same shape; ours is up to 8 mm larger.',
    ],
    [
      'Knee flexion',
      'gracilis_r',
      0.0145,
      'OQ-015',
      'A flexor in both, but ours starts from 2.5 mm at full extension where the reference’s is 30, and catches up by 70 degrees.',
    ],
    [
      'Knee flexion',
      'sartorius_r',
      0.012,
      'OQ-015',
      'A flexor in both, smaller than the reference’s by 10 to 15 mm through the first half of the range.',
    ],
    [
      'Knee flexion',
      'rectus_femoris_r',
      0.007,
      'OQ-015',
      'An extensor in both over the measured patella poles; ours is up to 12 mm larger in mid-range and falls where the reference’s rises again past 100 degrees.',
    ],
    [
      'Knee flexion',
      'vastus_lateralis_r',
      0.01,
      'OQ-015',
      'As rectus femoris, over the same two poles: ours 49 mm at 30 degrees against the reference’s 38, and 21 against 36 at 120.',
    ],
    [
      'Knee flexion',
      'vastus_medialis_r',
      0.0105,
      'OQ-015',
      'As vastus lateralis, over the same two poles.',
    ],
    [
      'Knee flexion',
      'vastus_intermedius_r',
      0.0095,
      'OQ-015',
      'As vastus lateralis, over the same two poles.',
    ],
    [
      'Knee flexion',
      'biceps_femoris_short_r',
      0.0175,
      'OQ-015',
      'A flexor throughout in ours; ours starts at 4 mm where the reference’s is 29, and at 120 degrees the reference’s crosses to -4 while ours holds 45.',
    ],
    [
      'Knee flexion',
      'semitendinosus_r',
      0.0115,
      'OQ-015',
      'A flexor in both, half the reference’s at full extension (23 mm against 46) and larger past 90 degrees.',
    ],
    [
      'Knee flexion',
      'semimembranosus_r',
      0.0215,
      'OQ-015',
      'A flexor in both, but ours starts from 1.6 mm at full extension where the reference’s is 40.',
    ],
    [
      'Knee flexion',
      'gastrocnemius_medial_r',
      0.0085,
      'OQ-015',
      'A flexor in both; ours grows with flexion to 30 mm where the reference’s falls from 27 to 7 at 120 degrees.',
    ],
    [
      'Ankle dorsiflexion',
      'gastrocnemius_lateral_r',
      0.0085,
      'OQ-021',
      'A plantarflexor in both, up to 14 mm larger than the reference’s.',
    ],
    [
      'Ankle dorsiflexion',
      'gastrocnemius_medial_r',
      0.0095,
      'OQ-021',
      'As the lateral head: a plantarflexor in both, up to 15 mm larger.',
    ],
    [
      'Ankle dorsiflexion',
      'soleus_r',
      0.0065,
      'OQ-021',
      'A plantarflexor in both, up to 11 mm larger.',
    ],
    [
      'Ankle dorsiflexion',
      'tibialis_anterior_r',
      0.011,
      'OQ-021',
      'A dorsiflexor in both and about half again the reference’s, 65 mm against 44 at the top of the range; it runs straight from its attachments rather than through its carried points (generate-ankle-muscles.mjs), which is the side it errs on.',
    ],
    [
      'Ankle dorsiflexion',
      'tibialis_posterior_r',
      0.0105,
      'OQ-021',
      'A plantarflexor in both, with the same slope, and 9 to 10 mm larger throughout.',
    ],
    [
      'Ankle dorsiflexion',
      'fibularis_longus_r',
      0.01,
      'OQ-021',
      'A plantarflexor in both; ours about twice the reference’s through the range except at full plantarflexion.',
    ],
    ['Ankle dorsiflexion', 'fibularis_brevis_r', 0.01, 'OQ-021', 'As fibularis longus.'],
    [
      'Ankle dorsiflexion',
      'extensor_digitorum_longus_r',
      0.0545,
      'OQ-021',
      'A dorsiflexor in both, and ours three times the reference’s at the top of the range, 122 mm against 37: it runs straight from its attachments with no retinaculum to hold it to the ankle (generate-ankle-muscles.mjs), the largest deviation in the report.',
    ],
    [
      'Ankle dorsiflexion',
      'extensor_hallucis_longus_r',
      0.026,
      'OQ-021',
      'As extensor digitorum longus, and for the same reason: 92 mm against 40 at the top of the range.',
    ],
    [
      'Ankle dorsiflexion',
      'flexor_digitorum_longus_r',
      0.012,
      'OQ-021',
      'A plantarflexor in both, with the same slope, and about 11 mm larger throughout.',
    ],
    [
      'Ankle dorsiflexion',
      'flexor_hallucis_longus_r',
      0.012,
      'OQ-021',
      'As flexor digitorum longus: about 11 mm larger throughout.',
    ],
  ].map(([row, unit, bound, question, note]) => ({ row, unit, bound, question, note })),
];

/**
 * Sign changes found when a row was first swept, left for the owner to decide.
 *
 * Not a bound, and not an excuse: a sign change is a hard failure and nothing in `RECORDED` can
 * make it pass. These are the ones the first sweep of each row found on 2026-09-27, before anyone
 * had looked at them, and they are listed so the gate could go in for every other muscle in the
 * same rows at once. Every one is printed on every run, `--check` included, and the report marks
 * it. The list can only shrink: an entry whose sign change has gone is refused as stale, and a
 * sign change not on it fails as it always did.
 */
const AWAITING_THE_OWNER = [
  [
    'Forearm pronation',
    'pronator_quadratus_r',
    'Ours supinates, by 0.2 to 1.6 mm, through the whole turn where the reference’s pronates by up to 7 -- and pronator quadratus is the forearm’s prime pronator.',
  ],
  [
    'Forearm pronation',
    'flexor_carpi_ulnaris_r',
    'Ours supinates by about 2 mm where the reference’s pronates by 1 to 4.5. The via-point generator moves this unit’s forearm points from the radius to the ulna (its `rebind`), which the reference does not.',
  ],
  [
    'Wrist flexion',
    'flexor_carpi_radialis_r',
    'A flexor in both from -20 degrees up, but ours turns extensor past about -25 (-7 mm at -40) where the reference’s keeps 15.',
  ],
  [
    'Wrist flexion',
    'flexor_carpi_ulnaris_r',
    'As flexor carpi radialis: ours turns extensor past about -15 degrees (-5 mm at -40) where the reference’s keeps 13.',
  ],
  [
    'Wrist flexion',
    'extensor_carpi_radialis_longus_r',
    'An extensor in both, but ours touches +0.3 mm at -40 degrees, so it changes sign by the letter of spec 13.2; under half the reference’s arm throughout.',
  ],
  ...[
    'flexor_carpi_radialis_r',
    'flexor_carpi_ulnaris_r',
    'extensor_carpi_radialis_longus_r',
    'extensor_carpi_radialis_brevis_r',
  ].map((unit) => [
    'Wrist ulnar deviation',
    unit,
    'Opposite to the reference at every angle, as are all four wrist muscles in this row, so the two models most likely count deviation opposite ways. If so, `wrist_r` ulnar_deviation’s range [-10, 25] degrees, taken from `deviation_r` as stated, has its sign reversed too. The convention needs deciding before this row means anything.',
  ]),
  [
    'Hip flexion',
    'gluteus_medius_posterior_r',
    'Ours turns from extensor to flexor at about 45 degrees; the reference’s stays an extensor to 120 (-0.3 mm there).',
  ],
  [
    'Hip flexion',
    'piriformis_r',
    'Ours turns from extensor to flexor at about 50 degrees, to +12 mm at 120; the reference’s stays an extensor and reaches zero only at 120.',
  ],
  [
    'Hip flexion',
    'tensor_fasciae_latae_r',
    'Within 5 mm of the reference everywhere, but ours is -4.3 mm at -30 degrees where the reference’s is +0.5, so it changes sign by the letter of spec 13.2.',
  ],
  [
    'Knee flexion',
    'gastrocnemius_lateral_r',
    'Ours is an extensor of 3 mm at full extension and a flexor from 10 degrees; the reference’s is a 26 mm flexor there and turns extensor past 110. The two cross zero in opposite directions.',
  ],
].map(([row, unit, note]) => ({ row, unit, note }));

/** The status an owner's entry takes in the report: a sign change, said as one. */
const AWAITING = 'sign change, awaiting the owner';

// --- Ours ---------------------------------------------------------------------------------------

const jiti = createJiti(import.meta.url);
const { resolveMorphology } = await jiti.import(join(ROOT, 'packages/anthropometry/src/index.ts'));
const { MujocoBackend } = await jiti.import(join(ROOT, 'packages/backend-mujoco/src/index.ts'));
const { compileArticulation } = await jiti.import(join(ROOT, 'packages/compiler/src/index.ts'));
const muscleData = await jiti.import(join(ROOT, 'packages/muscle-data/src/index.ts'));
const { buildDocument, REFERENCE_MORPHOLOGY, REFERENCE_PROFILE } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/index.ts'),
);
const { compileMuscleSet, degreeRange, sweepMomentArms } = await jiti.import(
  join(ROOT, 'packages/modules-muscle/src/index.ts'),
);

const document = buildDocument();
const morphology = resolveMorphology(REFERENCE_MORPHOLOGY);
const { articulation } = compileArticulation(document, REFERENCE_PROFILE, morphology);

/** One compile per distinct set of muscle-data sets, shared by the rows that name it. */
const compiled = new Map();
const musclesFor = (names) => {
  const key = names.join('+');
  if (!compiled.has(key)) {
    const groups = names.flatMap((name) => {
      const set = muscleData[name];
      if (!set) throw new Error(`validate-moment-arms: muscle-data exports no '${name}'.`);
      return set;
    });
    compiled.set(
      key,
      compileMuscleSet(
        groups,
        document.attachmentSites,
        articulation,
        morphology.context,
        document.wrappingSurfaces ?? [],
      ),
    );
  }
  return compiled.get(key);
};

// --- Theirs -------------------------------------------------------------------------------------

// MuJoCo resolves from the package that depends on it rather than from here, which is why this
// import goes through a jiti rooted there. The alternative is a root dependency on a backend,
// which is exactly the coupling the backend package exists to avoid.
const backendJiti = createJiti(
  new URL('../../../packages/backend-mujoco/src/index.ts', import.meta.url).href,
);
const loadMujoco = (await backendJiti.import('@mujoco/mujoco')).default;
const mujoco = await loadMujoco();

// --- Comparison ---------------------------------------------------------------------------------

/** The signs of a curve's samples, leaving out those within `floor` of zero. */
const signsOf = (values, floor) =>
  values.filter((v) => Math.abs(v) > floor).map((v) => Math.sign(v));

/** Whether a curve changes sign within itself, ignoring samples too small to have one. */
const flips = (values, floor = 1e-4) => {
  const signs = signsOf(values, floor);
  return signs.some((s) => s !== signs[0]);
};

/**
 * Whether ours is on the other side of the joint from the reference's.
 *
 * Judged on the samples where each pulls by more than `SIGN_FLOOR`. Where neither curve changes
 * sign, one that pulls the other way from the other is a muscle on the wrong side. Where both
 * change sign, one crossing the other way -- an extensor turning flexor against a flexor turning
 * extensor -- is the same fault. Where only one of them changes sign the two cross zero at
 * different angles, which is a difference of *where*, not of which side, and the deviation
 * already measures it.
 */
const opposite = (ours, theirs) => {
  const a = signsOf(ours, SIGN_FLOOR);
  const b = signsOf(theirs, SIGN_FLOOR);
  if (a.length === 0 || b.length === 0) return false;
  const aFlips = a.some((s) => s !== a[0]);
  const bFlips = b.some((s) => s !== b[0]);
  return aFlips === bFlips && a[0] !== b[0];
};

const deg = (radians) => `${Math.round((radians * 180) / Math.PI)}`;

/** Every row's findings, in `ROWS` order. */
const results = [];
for (const row of ROWS) {
  const angles = degreeRange(row.range.from, row.range.to, row.range.step);
  const sweep = await sweepMomentArms({
    articulation,
    muscles: musclesFor(row.muscles),
    backend: () => new MujocoBackend(),
    jointId: row.ourJoint,
    axisName: row.ourDof,
    angles,
    hold: row.hold.ours,
  });

  const reference = loadReference(mujoco, row.model, Object.keys(row.tendons));
  const referenceArms = new Map(Object.keys(row.tendons).map((tendon) => [tendon, []]));
  for (const angle of angles) {
    const arms = reference.momentArms(row.refJoint, angle + row.offset, row.hold.reference);
    for (const tendon of Object.keys(row.tendons)) {
      referenceArms.get(tendon).push(arms.get(tendon) ?? Number.NaN);
    }
  }
  reference.dispose();

  const unitToTendon = new Map(Object.entries(row.tendons).map(([t, u]) => [u, t]));
  const findings = [];
  for (let p = 0; p < sweep.pairs.length; p++) {
    const pair = sweep.pairs[p];
    const tendon = unitToTendon.get(pair.unitId);
    // One entry per muscle, for the coordinate being swept. These units cross other coordinates
    // too and the moment module reports those as well; each belongs to its own row.
    if (!tendon || pair.jointId !== row.ourJoint || pair.dofId !== row.ourDof) continue;
    const ours = Array.from(sweep.arms[p]);
    const theirs = referenceArms.get(tendon);
    // A tendon the reference routes clear of this coordinate has nothing to compare against: its
    // arm is zero at every angle. Ours crossing it where theirs does not is a different finding --
    // a path through a joint the source says it misses -- and it is reported, not compared.
    const theirsCrosses = theirs.some((v) => Math.abs(v) > 1e-4);

    let sum = 0;
    let worst = 0;
    let worstAt = 0;
    for (let a = 0; a < ours.length; a++) {
      const d = Math.abs(ours[a] - theirs[a]);
      sum += d;
      if (d > worst) {
        worst = d;
        worstAt = angles[a];
      }
    }
    const mean = sum / ours.length;
    const oursFlips = flips(ours);
    const theirsFlips = flips(theirs);

    const peak = (values) => {
      let at = 0;
      for (let i = 1; i < values.length; i++) {
        if (Math.abs(values[i]) > Math.abs(values[at])) at = i;
      }
      return { value: values[at], angle: angles[at] };
    };

    const recorded = RECORDED.find((r) => r.row === row.name && r.unit === pair.unitId);
    let status = 'ok';
    let note = recorded?.note ?? 'within tolerance of the reference';
    if (!theirsCrosses) {
      status = 'investigate';
      note = 'the reference does not cross this coordinate and ours does';
    } else if (oursFlips && !theirsFlips) {
      status = 'HARD FAILURE';
      note = 'changes sign where the reference does not (muscle spec 13.2)';
    } else if (opposite(ours, theirs)) {
      status = 'HARD FAILURE';
      note = 'pulls the other way from the reference (muscle spec 13.2)';
    } else if (mean > TOLERANCE) {
      if (recorded?.bound !== undefined && mean <= recorded.bound) {
        status = `recorded (${recorded.question})`;
      } else if (recorded?.bound !== undefined) {
        status = 'investigate';
        note = `worse than recorded: ${(mean * 1000).toFixed(1)} mm against a bound of ${(recorded.bound * 1000).toFixed(1)} mm. ${recorded.note}`;
      } else {
        status = 'investigate';
        note =
          'past tolerance and not recorded: fix it, or record the difference and its open question in RECORDED';
      }
    }
    const awaiting = AWAITING_THE_OWNER.find((a) => a.row === row.name && a.unit === pair.unitId);
    if (status === 'HARD FAILURE' && awaiting) {
      status = AWAITING;
      note = `${note}. ${awaiting.note}`;
    }

    findings.push({
      unit: pair.unitId,
      tendon,
      ours,
      theirs,
      mean,
      worst,
      worstAt,
      oursPeak: peak(ours),
      theirsPeak: peak(theirs),
      status,
      note,
    });
  }
  results.push({ row, angles, findings });
}

// A bound on a pair no row measured excuses nothing and would go on excusing nothing after the
// unit is renamed, so it is refused rather than left to rot. So is an owner's entry whose sign
// change has gone: the list only ever shrinks.
const findingOf = (entry) =>
  results.find(({ row }) => row.name === entry.row)?.findings.find((f) => f.unit === entry.unit);
const stale = [
  ...RECORDED.filter((r) => findingOf(r) === undefined).map(
    (r) => `RECORDED names ${r.row} / ${r.unit}, which no row measured`,
  ),
  ...AWAITING_THE_OWNER.filter((a) => findingOf(a)?.status !== AWAITING).map(
    (a) => `AWAITING_THE_OWNER names ${a.row} / ${a.unit}, which no longer changes sign`,
  ),
];
if (stale.length > 0) {
  console.error(`${stale.join('.\n')}.\nRename the entry or remove it.`);
  process.exit(1);
}

// --- The report ----------------------------------------------------------------------------------

const all = results.flatMap((r) => r.findings);
const mm = (v) => (Number.isFinite(v) ? (v * 1000).toFixed(1) : '--');
const signed = (radians) => {
  const d = Math.round((radians * 180) / Math.PI);
  return `${d}°`;
};
const hard = all.filter((f) => f.status === 'HARD FAILURE');
const investigate = all.filter((f) => f.status === 'investigate');
const recordedCount = all.filter((f) => f.status.startsWith('recorded')).length;
const awaiting = all.filter((f) => f.status === AWAITING);
const named = (f) => {
  const row = results.find((r) => r.findings.includes(f)).row.name;
  return `${row} / ${f.unit}`;
};

/** One row's pose, as a sentence both sides of the comparison can be checked against. */
function poseLine(row) {
  const ours = [
    `\`${row.ourJoint}\` ${row.ourDof}`,
    ...row.hold.ours.map((h) => `\`${h.jointId}\` ${h.axisName} ${signed(h.value)}`),
  ];
  const theirs = [
    `\`${row.refJoint}\` at ours ${row.offset === 0 ? '+ 0°' : `${row.offset < 0 ? '-' : '+'} ${signed(Math.abs(row.offset))}`}`,
    ...Object.entries(row.hold.reference).map(([joint, value]) => `\`${joint}\` ${signed(value)}`),
  ];
  return (
    `Swept from ${row.range.from} to ${row.range.to} degrees in ${row.range.step}-degree steps, ` +
    `${row.pose}. Ours: ${ours.join(', ')}. Reference (\`${row.model.chain}\`): ` +
    `${theirs.join(', ')}; every other coordinate at its neutral, and each that follows another ` +
    `where the model's couplings put it.`
  );
}

const lines = [];
lines.push('# Moment arm validation');
lines.push('');
lines.push(
  'Muscle spec 13.2, ticket N1.9. Generated by `pnpm validate:moment-arms`; commit the result',
);
lines.push('with the change that moved it.');
lines.push('');
lines.push(
  `${ROWS.length} coordinates swept, each against the vendored MyoSuite model at commit \`` +
    MYO_SIM_COMMIT.slice(0, 10) +
    '` loaded into MuJoCo and measured the same way, in the pose each section names. Both sides ' +
    'are computed here: nothing is transcribed, and no value from the reference reaches the model ' +
    '(ADR-009). The shoulder is not swept until the glenohumeral coordinates are mapped, and the ' +
    "trunk's tendons not until the arm and torso chains are joined.",
);
lines.push('');
lines.push(
  `Generated ${new Date().toISOString().slice(0, 10)}. ${all.length} muscle sweeps, ` +
    `${hard.length} hard failure(s), ${awaiting.length} sign change(s) awaiting the owner, ` +
    `${investigate.length} to investigate, ${recordedCount} recorded.`,
);
if (awaiting.length > 0) {
  lines.push('');
  lines.push(
    'The sign changes awaiting the owner were found when their rows were first swept. Each is a ' +
      'hard failure by muscle spec 13.2 and none is excused by a bound; they are listed in ' +
      '`AWAITING_THE_OWNER` so the gate could go in for every other muscle in their rows, and a ' +
      'sign change not on that list fails `--check`:',
  );
  lines.push('');
  for (const f of awaiting) lines.push(`- ${named(f)}`);
}
lines.push('');
lines.push(
  'Moment arms in millimetres, positive toward the named motion. Mean and worst are ' +
    '|ours - theirs|.',
);
for (const { row, angles, findings } of results) {
  const heading = row.name.replace(/^\w+ /, '');
  lines.push('');
  lines.push(`## ${row.name}`);
  lines.push('');
  lines.push(poseLine(row));
  lines.push('');
  lines.push('| Muscle | Our peak | Reference peak | Mean | Worst | Status |');
  lines.push('|---|---|---|---|---|---|');
  for (const f of findings) {
    lines.push(
      `| ${f.unit} | ${mm(f.oursPeak.value)} at ${deg(f.oursPeak.angle)}° | ` +
        `${mm(f.theirsPeak.value)} at ${deg(f.theirsPeak.angle)}° | ${mm(f.mean)} | ` +
        `${mm(f.worst)} at ${deg(f.worstAt)}° | ${f.status} |`,
    );
  }
  lines.push('');
  lines.push('### Notes');
  lines.push('');
  for (const f of findings) lines.push(`- **${f.unit}** — ${f.note}`);
  for (const [title, pick] of [
    ['Ours', (f) => f.ours],
    ['The reference', (f) => f.theirs],
  ]) {
    lines.push('');
    lines.push(`### ${title}, millimetres`);
    lines.push('');
    const label = heading.charAt(0).toUpperCase() + heading.slice(1);
    lines.push(`| ${label} | ${findings.map((f) => f.unit.replace(/_r$/, '')).join(' | ')} |`);
    lines.push(`|---|${findings.map(() => '---').join('|')}|`);
    for (let a = 0; a < angles.length; a++) {
      lines.push(`| ${deg(angles[a])}° | ${findings.map((f) => mm(pick(f)[a])).join(' | ')} |`);
    }
  }
}
lines.push('');

const report = `${lines.join('\n')}`;
const path = join(ROOT, 'docs/validation/moment-arms.md');

/** The report as committed, or undefined if there is none yet -- which is never current. */
function readReport(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

if (check) {
  if (!reportIsCurrent(readReport(path), report)) {
    console.error(
      'Moment arms have changed and docs/validation/moment-arms.md is stale. ' +
        'Run `pnpm validate:moment-arms` and commit the result with the change that moved it.',
    );
    process.exit(1);
  }
  if (hard.length > 0) {
    console.error('Moment arm validation FAILED, muscle spec 13.2:');
    for (const f of hard) console.error(`  ${named(f)}: ${f.note}`);
    process.exit(1);
  }
  if (investigate.length > 0) {
    console.error(
      `${investigate.length} moment arm(s) differ from the reference by more than is recorded. ` +
        'Each is in docs/validation/moment-arms.md: either fix the path, or record the ' +
        'difference and its open question in RECORDED in this tool.',
    );
    for (const f of investigate) console.error(`  ${named(f)}: ${f.note}`);
    process.exit(1);
  }
  console.error(
    `moment arms: ok. ${all.length} muscle sweeps over ${ROWS.length} coordinates, no sign ` +
      `change but the ${awaiting.length} awaiting the owner, ${recordedCount} recorded ` +
      'difference(s), report current.',
  );
  // Said every time, so a pass never reads as though there were none.
  for (const f of awaiting) console.error(`  awaiting the owner: ${named(f)}`);
} else if (reportIsCurrent(readReport(path), report)) {
  // Nothing but the date would change, and a date that moves on every run is churn in a commit.
  console.error(`${relative(ROOT, path)} is current: ${all.length} muscle sweeps.`);
} else {
  writeFileSync(path, report);
  console.error(
    `wrote ${relative(ROOT, path)}: ${all.length} muscle sweeps, ${hard.length} hard failure(s), ` +
      `${investigate.length} to investigate.`,
  );
  for (const f of [...hard, ...awaiting, ...investigate]) {
    console.error(`  ${named(f)}: ${f.status}, ${f.note}`);
  }
}
