#!/usr/bin/env node
/**
 * Carries the reference model's muscle via points into this skeleton's bone frames -- OQ-015.
 *
 *   pnpm generate:via-points          # rewrite packages/skeleton/src/muscleViaPoints.ts
 *   pnpm generate:via-points --check  # fail if the file is not what this would write
 *
 * A muscle does not run straight from its origin to its insertion: it lies along the bones it
 * passes, and published models hold it there with via points. Without them the elbow flexors cut
 * through the humerus, and their moment arms are wrong in the direction of being far too large --
 * the biceps peaks at 65 mm against a published 36 to 40.
 *
 * Wrapping surfaces were tried first and are not the answer for a muscle running *along* a bone.
 * A cylinder is a poor model of a humerus: narrow through the shaft, flared at both ends, so one
 * wide enough to catch a muscle near the ends stands clear of the bone in the middle. The
 * measurements are in OQ-015. Via points are what the reference model uses, and they are what
 * this brings over.
 *
 * ## The frames problem, and how it is solved
 *
 * The reference model's points are in its own body frames, which are not ours -- a coordinate
 * lifted from one frame into another is a number that means nothing where it lands. So nothing is
 * lifted. Instead both models are asked for the same *anatomical* construction, and the transform
 * between the two answers is what carries the points across:
 *
 *   - The origin is the joint at the bone's proximal end -- the glenohumeral centre for the
 *     humerus, the elbow for the forearm. In the reference model that is a body's own offset;
 *     here it is a fitted centre or the midpoint of two landmarks.
 *   - One axis runs from the joint at the far end up to that origin: the bone's long axis.
 *   - The other is the far joint's axis. The reference model states it as a joint axis or marks
 *     both its ends; here it is the line through the two landmarks that are its ends -- the
 *     epicondyles at the elbow, the styloids at the wrist, the malleoli at the ankle.
 *
 * That is the same frame the ISB defines for the humerus (Wu 2005, 2.3.4), built twice from
 * whatever each model happens to carry. Two frames of the same bone, so the rotation between them
 * is the disagreement between two conventions and nothing else.
 *
 * Lengths are scaled by the ratio of the two bones, so a point a third of the way down one lands
 * a third of the way down the other, and then divided by this subject's stature so it scales with
 * the morphology like every other point in the skeleton.
 *
 * ## One frame a bone group, not one a limb
 *
 * Every body in the reference model is a pure translation of its parent at the neutral pose, so
 * adding the offsets down the chain puts every site in one frame. For a while that was the whole
 * method: one correspondence fitted at the limb's proximal bone, carrying the scapula and the
 * forearm and the foot as well as the humerus. It does not reach. A rotation fitted at the
 * shoulder is a rotation fitted at the shoulder, and by the wrist the points were fifty
 * millimetres off the radius -- past the bone, in mid-air -- while the foot's were ninety from
 * the heel. The scale is a limb's too: the reference's shank is a tenth longer against its femur
 * than ours is, so everything below the knee was stretched by that tenth.
 *
 * So each bone group has its own frame now, built the same way from whatever both models can
 * state about *that* bone: the upper arm from the shoulder to the elbow, the forearm from the
 * elbow to the wrist, the thigh from the hip to the knee, the shank from the knee to the ankle.
 * Each carries the sites of its own bodies and scales by its own bone's ratio.
 *
 * Two of those frames are built from landmarks both models mark -- the malleoli, which the
 * reference carries as `LMAL_r` and `MMAL_r` -- and a frame built from the same two landmarks on
 * both sides points the same way on both, so it needs no probe. The others take a joint's own
 * stated axis and settle its direction against a landmark, which is what `orientAxis` is for.
 *
 * ## The forearm turns
 *
 * The one place the two models are not in the same pose. The reference's neutral forearm is
 * thumb-up: `pro_sup_r` runs from a quarter turn of supination to a quarter turn of pronation
 * about zero. This skeleton stands in the anatomical position, fully supinated, its radial
 * styloid forty millimetres lateral of its ulnar one. So the forearm's frame is built at the
 * *wrist*, on the wrist's own flexion axis, which turns with pronation in both models as the
 * styloids do. Built on the proximal radioulnar direction instead -- which does not turn, because
 * the radial head spins where it sits -- the two forearms are carried onto each other a quarter
 * turn out, and every extensor lands in front of the bone it should run behind.
 *
 * ## The bone a point is fixed to
 *
 * A carried point rides the bone the reference model's own body carries it on, which is usually
 * right and sometimes not: the reference's bodies are its skeleton's, not ours. Its radius body
 * carries the hand, so the flexor carpi ulnaris -- a muscle that runs down the ulna and inserts
 * on the pisiform -- has its forearm points on the radius, where they would turn with pronation
 * as the real tendon does not. Its tibia body carries the fibula, so the fibularis tendons, which
 * run behind the lateral malleolus, are on the tibia.
 *
 * `rebind` moves such a unit's points to the bone they belong on, and names the bone they came
 * from as well as the one they go to: the fibularis longus runs behind the malleolus *and* across
 * the sole, so its leg points belong on the fibula and its foot points belong where they are. It
 * is a change of *frame*, not of place: the point stays where it was carried to and is written as
 * an offset from the other bone's centroid, so what changes is only which bone it moves with.
 * Where the place is wrong too, that is the frame correspondence's business and not this.
 *
 * ## Which way round a path runs
 *
 * The reference model does not agree with itself about which end of a tendon comes first: the
 * elbow muscles are listed from the girdle outward and most of the shoulder muscles from the
 * humerus inward. `order` here means "counting from *our* origin", because that is what a path
 * solver walks, so a unit whose reference path starts at the far end has its points reversed.
 *
 * Which end is ours is the one thing that cannot be read off the reference, so each unit names
 * the bone its origin is on and the reversal follows. It is not cosmetic: carried in the
 * reference's order, the anterior deltoid ran from the clavicle down to a point on the humerus,
 * back up to a point above it, and down again to its insertion -- a path half as long again as
 * the muscle, with the fiber at twice its optimal length and a force that overflowed.
 *
 * ## The other arm
 *
 * The reference model is a right arm and there is no left one to carry over, so the left side is
 * this side mirrored. That is a cheaper claim than it sounds: a point here is stored as an offset
 * from its bone's centroid in the dataset's own axis-aligned frame, and the dataset's two sides
 * are the same geometry reflected in the sagittal plane, so mirroring a point is negating one
 * coordinate. The assumption is that the dataset is symmetric, and it is checked rather than
 * assumed -- each left bone's centroid is compared against its right one's reflection, and the
 * generator refuses if any pair disagrees by more than `SYMMETRY_TOLERANCE`.
 *
 * What the mirror does not touch is which side of a surface a muscle passes: that is stated as an
 * anterior or posterior direction, and anterior is anterior on both arms.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { MODELS, MYO_SIM, upstreamPath } from '../../validate-external/src/models.mjs';
import { REFERENCE_FOREARM_AT_OUR_NEUTRAL } from '../../validate-external/src/referenceArm.mjs';
import { cliFlags } from '../lib/args.mjs';
import { emitOrCheck } from '../lib/generated.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/skeleton/src/muscleViaPoints.ts');
const { check } = cliFlags('generate-via-points');

const jiti = createJiti(import.meta.url);
const frames = await jiti.import(join(ROOT, 'packages/frames/src/index.ts'));
const skeleton = await jiti.import(join(ROOT, 'packages/skeleton/src/index.ts'));

/**
 * How far a left bone's centroid may sit from its right one's reflection, metres.
 *
 * Two millimetres. The dataset's sides are not identical -- they are a real subject's, and real
 * skeletons are asymmetric -- but a bone whose centroid is centimetres from its mirror is a bone
 * that has been packed differently on the two sides, and a point mirrored onto it would land in
 * the wrong place.
 */
const SYMMETRY_TOLERANCE = 0.002;

/** How far off the long axis a chirality probe has to be to mean anything, metres. */
const PROBE_MARGIN = 0.01;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/**
 * A limb: which reference files describe it, how its bodies nest, the frame both models can
 * state, and which of our units are in it.
 *
 * Two of them now, and the second is why this is a table rather than a script. The construction
 * that carries a point across is the same either way -- ask both models for the same anatomical
 * frame and take the rotation between the answers -- and what differs is only which bone that
 * frame belongs to and what each model calls the things it is built from.
 */
const LIMBS = [
  {
    id: 'arm',
    model: MODELS.arm,
    /**
     * Where each body sits in the root's frame, as offsets accumulated down the chain.
     *
     * Every body in the reference arm is a pure translation of its parent at the neutral pose, so
     * adding the offsets is enough; a body with a rotation would need more and there is none here.
     * Bodies that carry no sites are here too when a frame needs their origin: the lunate is the
     * wrist's child, so its accumulated offset is where the wrist is.
     */
    offsets: (bodyPos) => {
      const forearm = bodyPos('ulna_r');
      const radius = add(forearm, bodyPos('radius_r'));
      const phantom = bodyPos('clavphant_r');
      return new Map([
        ['scapula_r', [0, 0, 0]],
        ['humerus_r', [0, 0, 0]],
        // The clavicle is a body further out than the scapula, back along the phantom between.
        ['clavicle_r', [-phantom[0], -phantom[1], -phantom[2]]],
        ['ulna_r', forearm],
        ['radius_r', radius],
        ['lunate_r', add(radius, bodyPos('lunate_r'))],
      ]);
    },
    bodies: [
      { body: 'clavicle_r', bone: 'clavicle_r' },
      { body: 'scapula_r', bone: 'scapula_r' },
      { body: 'humerus_r', bone: 'humerus_r' },
      { body: 'ulna_r', bone: 'ulna_r' },
      { body: 'radius_r', bone: 'radius_r' },
    ],
    /**
     * Where the two models' neutral poses differ, and by how much.
     *
     * The reference's forearm is thumb-up: `pro_sup_r` runs a quarter turn either way about zero.
     * This skeleton stands in the anatomical position, fully supinated, its radial styloid forty
     * millimetres lateral of its ulnar one. So before the radius's sites are carried they are
     * turned about the reference's own pronation joint, through the reference's own quarter turn,
     * into the pose this skeleton is in. Pronation turns the radius about the line from its head
     * to the ulna's, which is what that joint's axis is, so a point by the head barely moves and
     * one at the wrist moves the width of the wrist -- as it should. The direction is checked
     * rather than trusted: turned the wrong way, the extensors land in front of the bone.
     */
    pose: [
      {
        body: 'radius_r',
        joint: 'pro_sup_r',
        radians: REFERENCE_FOREARM_AT_OUR_NEUTRAL,
        dorsal: 'ECRB-P3_r',
      },
    ],
    /**
     * Points placed on this skeleton's own bone rather than carried, where the carry cannot
     * reach: the reference's wrist is wider than ours across the forearm, and no rigid frame with
     * one scale can narrow it, so the two radial extensors arrived twenty millimetres past the
     * styloid's tip. In life their tendons cross the wrist in the second dorsal compartment, on
     * the dorsal radius immediately radial of Lister's tubercle -- which this skeleton marks --
     * so each is put on the surface between the tubercle and the styloid, the brevis nearer the
     * tubercle. `at` is the fraction of the way from the first landmark to the second; the point
     * is the bone's nearest vertex to that spot, so it is on the bone by construction.
     */
    measuredSites: {
      'ECRB-P3_r': {
        bone: 'radius_r',
        between: ['Dorsal_radial_tubercle', 'Radial_styloid_process'],
        at: 0.3,
      },
      'ECRL-P3_r': {
        bone: 'radius_r',
        between: ['Dorsal_radial_tubercle', 'Radial_styloid_process'],
        at: 0.6,
      },
    },
    /**
     * Carried points pulled in to their bone, for the same reason. Along the shaft the two
     * radial extensors and brachioradialis lie on the lateral radius under a few millimetres of
     * their own bellies, and the carry left them twenty out. Each is moved along the line from
     * the nearest point of the bone's surface to where it was carried, to `standoff` metres from
     * that surface: the same side of the bone, the same direction, the right distance.
     */
    /**
     * Tendons whose wrap surface's side site is carried as a via point, in the surface's place.
     *
     * A side site is the reference's statement of which way round its surface a tendon goes, and
     * it stands on that side, a millimetre or two off the surface. The supinator is the case: it
     * wraps the back of the radius from the ulna, and our wrap cylinder -- coaxial with the
     * forearm's turn, as every surface here is with its joint -- only holds a path whose straight
     * line crosses it. Its one carried point lies across the axis from its origin, so that line
     * passed within a millimetre of the axis and the muscle supinated or pronated by which side
     * it fell. With the side site behind the bone as its first point (placed by `onSurface`
     * below), the path from the ulna runs round the back of the cylinder through the whole turn.
     */
    wrapSides: ['SUP'],
    snapSites: {
      'ECRB-P2_r': { standoff: 0.005 },
      'ECRL-P2_r': { standoff: 0.005 },
      'BRD_BRD-P2_r': { standoff: 0.005 },
      // The clavicular head's point on the clavicle, which the upper arm's frame -- fitted at the
      // humerus, and carrying the whole girdle with it -- left 57 mm off the bone. The head
      // arises along the clavicle's front, so it is drawn in to that bone like the rest.
      'PECM1_PECM1-P3_r': { standoff: 0.005 },
    },
    /**
     * Side sites put on our wrap surface rather than where the carry leaves them.
     *
     * A side site stands just off its own surface: the supinator's is 1.7 mm outside the
     * reference's 8 mm cylinder. Carried, it arrived 17 mm off our radius, because the reference's
     * cylinder is not where ours is -- ours is coaxial with the forearm's turn and has the radial
     * head's radius. So it keeps the direction the carry gave it, seen down our cylinder's axis,
     * and stands the reference's own distance off our cylinder: on the same side of the same kind
     * of surface, which is all a side site says. `geom` is the reference's cylinder the standoff
     * is read from; `surface` is ours, as the axis's two ends and the radius.
     */
    onSurface: {
      SUP_cylinder_SUP_2_sidesite_r: {
        geom: 'SUP_cylinder',
        surface: (skeleton) => ({
          from: skeleton.measuredWorld('ulna_r', 'Ulnar_styloid_process'),
          to: skeleton.measuredWorld('radius_r', 'Head_of_radius__articular_centre'),
          radius: skeleton.articularFit('radius_r', 'Head_of_radius__articular_centre').radius,
        }),
      },
    },
    frames: [
      {
        id: 'upper arm',
        bodies: ['clavicle_r', 'scapula_r', 'humerus_r'],
        reference: {
          origin: (c) => c.offset('humerus_r'),
          distal: (c) => c.offset('ulna_r'),
          axis: (c) => c.jointAxis('elbow_flexion_r'),
        },
        /** Ours: the same frame, from the landmarks this skeleton carries. */
        ours: (skeleton) => {
          const gh = skeleton.refWorld(['humerus_r', 'GH']);
          const em = skeleton.refWorld(['humerus_r', 'EM']);
          const el = skeleton.refWorld(['humerus_r', 'EL']);
          return { origin: gh, distal: midpoint(em, el), axis: sub(el, em) };
        },
        // Which way round the frame is rolled: see `orientAxis`. The olecranon is firmly behind
        // the elbow in any convention, and far enough behind to settle it with margin.
        probe: {
          site: 'TRIlong_TRIlong-P5_r',
          ours: (skeleton) => skeleton.measuredWorld('ulna_r', 'Olecranon'),
        },
      },
      {
        /**
         * Elbow to wrist, on the elbow's own axis -- the one the upper arm's probe has settled.
         *
         * Not the wrist's. The two models are not at the same pronation, and pronation is a turn
         * of the radius about its own line, which no frame built on the forearm's midline can
         * carry: fit at the wrist and the biceps' point by the radial head is dragged forty
         * millimetres; fit at the elbow and the wrist arrives a quarter turn out. So the pose is
         * put right first -- see `pose` -- and one frame carries the forearm as it does the thigh.
         */
        id: 'forearm',
        bodies: ['ulna_r', 'radius_r'],
        reference: {
          origin: (c) => c.offset('ulna_r'),
          distal: (c) => c.offset('lunate_r'),
          axis: (c) => c.jointAxis('elbow_flexion_r'),
        },
        ours: (skeleton) => {
          const em = skeleton.refWorld(['humerus_r', 'EM']);
          const el = skeleton.refWorld(['humerus_r', 'EL']);
          const ulnar = skeleton.measuredWorld('ulna_r', 'Ulnar_styloid_process');
          const radial = skeleton.measuredWorld('radius_r', 'Radial_styloid_process');
          return { origin: midpoint(em, el), distal: midpoint(ulnar, radial), axis: sub(el, em) };
        },
      },
    ],
    /** Points the reference carries on one bone that belong on another of ours. */
    rebind: {
      // Down the ulna to the pisiform: the reference's radius body carries the hand, so its
      // forearm points are on the radius, where pronation would swing them.
      flexor_carpi_ulnaris_r: { radius_r: 'ulna_r' },
    },
    units: [
      { unit: 'deltoid_anterior_r', tendon: 'DELT1', from: 'clavicle_r' },
      { unit: 'deltoid_middle_r', tendon: 'DELT2', from: 'scapula_r' },
      { unit: 'deltoid_posterior_r', tendon: 'DELT3', from: 'scapula_r' },
      { unit: 'supraspinatus_r', tendon: 'SUPSP', from: 'scapula_r' },
      { unit: 'infraspinatus_r', tendon: 'INFSP', from: 'scapula_r' },
      { unit: 'subscapularis_r', tendon: 'SUBSC', from: 'scapula_r' },
      { unit: 'teres_minor_r', tendon: 'TMIN', from: 'scapula_r' },
      { unit: 'teres_major_r', tendon: 'TMAJ', from: 'scapula_r' },
      { unit: 'biceps_brachii_long_r', tendon: 'BIClong', from: 'scapula_r' },
      { unit: 'biceps_brachii_short_r', tendon: 'BICshort', from: 'scapula_r' },
      { unit: 'brachialis_r', tendon: 'BRA', from: 'humerus_r' },
      { unit: 'brachioradialis_r', tendon: 'BRD', from: 'humerus_r' },
      { unit: 'triceps_brachii_long_r', tendon: 'TRIlong', from: 'scapula_r' },
      { unit: 'triceps_brachii_lateral_r', tendon: 'TRIlat', from: 'humerus_r' },
      { unit: 'triceps_brachii_medial_r', tendon: 'TRImed', from: 'humerus_r' },
      // Re-admitted by OQ-023 on 2026-09-16 and left out of this table until now, so it ran
      // straight from the coracoid to the humerus where the reference holds it on a via point.
      { unit: 'coracobrachialis_r', tendon: 'CORB', from: 'scapula_r' },
      // The forearm and wrist. `from` is the bone our origin is on; the reference lists most of
      // these from the hand inward, which the direction test reads from whichever end it knows.
      { unit: 'pronator_teres_r', tendon: 'PT', from: 'humerus_r' },
      { unit: 'pronator_quadratus_r', tendon: 'PQ', from: 'ulna_r' },
      { unit: 'supinator_r', tendon: 'SUP', from: 'ulna_r' },
      { unit: 'anconeus_r', tendon: 'ANC', from: 'humerus_r' },
      { unit: 'flexor_carpi_radialis_r', tendon: 'FCR', from: 'humerus_r' },
      { unit: 'flexor_carpi_ulnaris_r', tendon: 'FCU', from: 'humerus_r' },
      { unit: 'extensor_carpi_radialis_longus_r', tendon: 'ECRL', from: 'humerus_r' },
      { unit: 'extensor_carpi_radialis_brevis_r', tendon: 'ECRB', from: 'humerus_r' },
      // The trunk's two. MyoArm anchors them to its own root rather than to a spine it does not
      // have, so their trunk-end points sit on the world body and are not carried; `from` names
      // the bone *our* origin is on, which no limb maps, and the direction is read from the far
      // end instead.
      { unit: 'latissimus_dorsi_thoracic_r', tendon: 'LAT1', from: 'vertebra_t8' },
      // The lumbar part and the clavicular head, like coracobrachialis re-admitted by OQ-023 and
      // left out of this table until now.
      { unit: 'latissimus_dorsi_lumbar_r', tendon: 'LAT2', from: 'sacrum' },
      { unit: 'latissimus_dorsi_iliac_r', tendon: 'LAT3', from: 'hip_r' },
      { unit: 'pectoralis_major_clavicular_r', tendon: 'PECM1', from: 'clavicle_r' },
      { unit: 'pectoralis_major_sternal_r', tendon: 'PECM2', from: 'sternum' },
      { unit: 'pectoralis_major_abdominal_r', tendon: 'PECM3', from: 'rib_6_r' },
    ],
  },
  {
    id: 'leg',
    model: MODELS.legs,
    offsets: (bodyPos) => {
      const shank = bodyPos('tibia_r');
      const ankle = add(shank, bodyPos('talus_r'));
      const heel = add(ankle, bodyPos('calcn_r'));
      return new Map([
        ['femur_r', [0, 0, 0]],
        // The patella hangs off the femur rather than the shank, which is what makes it able to
        // carry the quadriceps across the joint.
        ['patella_r', bodyPos('patella_r')],
        ['tibia_r', shank],
        ['talus_r', ankle],
        ['calcn_r', heel],
        ['toes_r', add(heel, bodyPos('toes_r'))],
      ]);
    },
    bodies: [
      { body: 'femur_r', bone: 'femur_r' },
      { body: 'patella_r', bone: 'patella_r' },
      { body: 'tibia_r', bone: 'tibia_r' },
      { body: 'calcn_r', bone: 'calcaneus_r' },
    ],
    frames: [
      {
        id: 'thigh',
        bodies: ['femur_r', 'patella_r'],
        reference: {
          origin: (c) => c.offset('femur_r'),
          distal: (c) => c.offset('tibia_r'),
          axis: (c) => c.jointAxis('knee_angle_r'),
        },
        ours: (skeleton) => {
          // The hip centre is fitted from the femoral head's own articular surface rather than
          // taken from a marker, as everywhere else this project needs a joint centre.
          const hip = skeleton.measuredWorld('femur_r', 'Head_of_femur__articular_centre');
          const em = skeleton.measuredWorld('femur_r', 'Medial_epicondyle_of_femur');
          const el = skeleton.measuredWorld('femur_r', 'Lateral_epicondyle_of_femur');
          return { origin: hip, distal: midpoint(em, el), axis: sub(el, em) };
        },
        // The tibial tuberosity: firmly in front of the knee in any convention, and where the
        // quadriceps arrive. See `orientAxis` -- this is the probe that caught the leg frames
        // rolled half a turn against each other.
        probe: {
          site: 'recfem-P5_r',
          ours: (skeleton) => skeleton.measuredWorld('tibia_r', 'Tibial_tuberosity'),
        },
      },
      {
        // Knee to ankle, on the ankle's own axis. The malleoli are that axis's ends, and the
        // reference marks both of them, so the frame is built from the same two landmarks on
        // both sides and its direction needs no probe.
        id: 'shank',
        bodies: ['tibia_r', 'calcn_r'],
        reference: {
          // The knee centre the thigh's frame ends at, so the two meet at the same place.
          origin: (c) => c.offset('tibia_r'),
          distal: (c) => midpoint(c.site('MMAL_r'), c.site('LMAL_r')),
          axis: (c) => sub(c.site('LMAL_r'), c.site('MMAL_r')),
          needs: ['MMAL_r', 'LMAL_r'],
        },
        ours: (skeleton) => {
          const em = skeleton.measuredWorld('femur_r', 'Medial_epicondyle_of_femur');
          const el = skeleton.measuredWorld('femur_r', 'Lateral_epicondyle_of_femur');
          const mm = skeleton.measuredWorld('tibia_r', 'Medial_malleolus');
          const lm = skeleton.measuredWorld('fibula_r', 'Lateral_malleolus');
          return { origin: midpoint(em, el), distal: midpoint(mm, lm), axis: sub(lm, mm) };
        },
      },
    ],
    /**
     * Points measured from our own bone rather than carried from the reference.
     *
     * The quadriceps run over the patella, and the reference's patella sites cannot be carried:
     * its patella is a reference point with three slide joints and a coupling, sitting within a
     * centimetre of the femur's long axis, and its sites are offsets from *that*. Ours is the
     * bone -- a mesh, 40 to 52 mm in front of the knee's axis, on a joint coupled to knee flexion.
     * Carrying a coordinate between those two would be carrying a number out of a frame where it
     * meant something into one where it does not, which is the thing this whole file exists to
     * avoid.
     *
     * So the two points a quadriceps needs are measured from the patella itself: the poles it
     * arrives at and leaves by, which are the most superior and most inferior vertices of the
     * bone in the femur's frame. Both come out about 40 mm in front of the knee axis, because
     * that is where a patella is, and that stand-off is the whole reason the knee has one.
     */
    measured: {
      units: [
        'rectus_femoris_r',
        'vastus_lateralis_r',
        'vastus_medialis_r',
        'vastus_intermedius_r',
      ],
      bone: 'patella_r',
      points: [
        { name: 'superior_pole', pick: 'max', axis: 'y' },
        { name: 'inferior_pole', pick: 'min', axis: 'y' },
      ],
    },
    /**
     * The reference's `calcn` body is the whole foot, so every point forward of the ankle arrives
     * on the heel: the long toe tendons end up bound to the calcaneus when they are lying on a
     * metatarsal. At L3 the midfoot and the forefoot are segments of their own and the difference
     * is a tendon that moves with the wrong bone.
     *
     * Each is named by the reference's own site and goes to the bone it is on, which is the bone
     * anatomy puts it on: the long hallux tendons to the first metatarsal, the long toe tendons
     * to the fourth, the fibularis longus to the cuboid it grooves, and the extensors' turn over
     * the midfoot to the navicular. The points still in the tarsal tunnel -- behind the malleolus
     * and under the sustentaculum -- stay on the heel, which is what they are nearest.
     */
    rebind: {
      // Behind the lateral malleolus, which is the fibula's. The reference's tibia body carries
      // the fibula, so both fibularis tendons arrive on the tibia.
      fibularis_longus_r: { tibia_r: 'fibula_r', 'perlong-P6_r': 'cuboid_r' },
      fibularis_brevis_r: { tibia_r: 'fibula_r' },
      extensor_digitorum_longus_r: { 'edl-P3_r': 'navicular_r', 'edl-P4_r': 'metatarsal_4_r' },
      extensor_hallucis_longus_r: {
        'ehl-P4_r': 'navicular_r',
        'ehl-P5_r': 'metatarsal_1_r',
        'ehl-P6_r': 'metatarsal_1_r',
      },
      flexor_digitorum_longus_r: { 'fdl-P5_r': 'metatarsal_4_r' },
      flexor_hallucis_longus_r: {
        'fhl-P4_r': 'cuneiform_medial_r',
        'fhl-P5_r': 'metatarsal_1_r',
      },
    },
    units: [
      { unit: 'rectus_femoris_r', tendon: 'recfem_r', from: 'hip_r' },
      { unit: 'vastus_lateralis_r', tendon: 'vaslat_r', from: 'femur_r' },
      { unit: 'vastus_medialis_r', tendon: 'vasmed_r', from: 'femur_r' },
      { unit: 'vastus_intermedius_r', tendon: 'vasint_r', from: 'femur_r' },
      { unit: 'biceps_femoris_long_r', tendon: 'bflh_r', from: 'hip_r' },
      { unit: 'biceps_femoris_short_r', tendon: 'bfsh_r', from: 'femur_r' },
      { unit: 'semitendinosus_r', tendon: 'semiten_r', from: 'hip_r' },
      { unit: 'semimembranosus_r', tendon: 'semimem_r', from: 'hip_r' },
      { unit: 'gastrocnemius_lateral_r', tendon: 'gaslat_r', from: 'femur_r' },
      { unit: 'gastrocnemius_medial_r', tendon: 'gasmed_r', from: 'femur_r' },
      // The hip. `from` is the bone the reference's first path point sits on, which for the
      // gluteals and the adductors is the pelvis and for the vasti-like ones is the femur.
      { unit: 'gluteus_maximus_superior_r', tendon: 'glmax1_r', from: 'hip_r' },
      { unit: 'gluteus_maximus_middle_r', tendon: 'glmax2_r', from: 'hip_r' },
      // The inferior part, re-admitted by OQ-023 and left out of this table until now: it ran as
      // a 63 mm chord from the ischial tuberosity where the reference holds it on its femur.
      { unit: 'gluteus_maximus_inferior_r', tendon: 'glmax3_r', from: 'hip_r' },
      { unit: 'gluteus_medius_anterior_r', tendon: 'glmed1_r', from: 'hip_r' },
      { unit: 'gluteus_medius_middle_r', tendon: 'glmed2_r', from: 'hip_r' },
      { unit: 'gluteus_medius_posterior_r', tendon: 'glmed3_r', from: 'hip_r' },
      { unit: 'gluteus_minimus_anterior_r', tendon: 'glmin1_r', from: 'hip_r' },
      { unit: 'gluteus_minimus_middle_r', tendon: 'glmin2_r', from: 'hip_r' },
      { unit: 'gluteus_minimus_posterior_r', tendon: 'glmin3_r', from: 'hip_r' },
      { unit: 'iliacus_r', tendon: 'iliacus_r', from: 'hip_r' },
      { unit: 'psoas_major_r', tendon: 'psoas_r', from: 'hip_r' },
      { unit: 'adductor_longus_r', tendon: 'addlong_r', from: 'hip_r' },
      { unit: 'adductor_brevis_r', tendon: 'addbrev_r', from: 'hip_r' },
      { unit: 'adductor_magnus_proximal_r', tendon: 'addmagProx_r', from: 'hip_r' },
      { unit: 'adductor_magnus_middle_r', tendon: 'addmagMid_r', from: 'hip_r' },
      { unit: 'adductor_magnus_distal_r', tendon: 'addmagDist_r', from: 'hip_r' },
      { unit: 'adductor_magnus_ischiocondylar_r', tendon: 'addmagIsch_r', from: 'hip_r' },
      { unit: 'piriformis_r', tendon: 'piri_r', from: 'hip_r' },
      { unit: 'tensor_fasciae_latae_r', tendon: 'tfl_r', from: 'hip_r' },
      { unit: 'gracilis_r', tendon: 'grac_r', from: 'hip_r' },
      { unit: 'sartorius_r', tendon: 'sart_r', from: 'hip_r' },
      // The ankle and the foot. Every one of these is held by a retinaculum in life and by via
      // points in the reference, which is why none of them wraps anything.
      { unit: 'soleus_r', tendon: 'soleus_r', from: 'tibia_r' },
      { unit: 'tibialis_anterior_r', tendon: 'tibant_r', from: 'tibia_r' },
      { unit: 'tibialis_posterior_r', tendon: 'tibpost_r', from: 'tibia_r' },
      { unit: 'fibularis_longus_r', tendon: 'perlong_r', from: 'tibia_r' },
      { unit: 'fibularis_brevis_r', tendon: 'perbrev_r', from: 'tibia_r' },
      { unit: 'extensor_digitorum_longus_r', tendon: 'edl_r', from: 'tibia_r' },
      { unit: 'extensor_hallucis_longus_r', tendon: 'ehl_r', from: 'tibia_r' },
      { unit: 'flexor_digitorum_longus_r', tendon: 'fdl_r', from: 'tibia_r' },
      { unit: 'flexor_hallucis_longus_r', tendon: 'fhl_r', from: 'tibia_r' },
    ],
  },
];

/** Everything one limb's reference files say, read once. */
function readLimb(limb) {
  const xml = readFileSync(join(MYO_SIM, limb.model.chain), 'utf8');
  const tendonXml = readFileSync(join(MYO_SIM, limb.model.tendon), 'utf8');

  const bodyBlock = (name) => {
    const start = xml.indexOf(`<body name="${name}"`);
    if (start < 0) throw new Error(`${limb.model.chain} has no body '${name}'`);
    // Up to the next nested body, which is where this body's own sites end.
    const next = xml.indexOf('<body ', start + 1);
    return xml.slice(start, next < 0 ? xml.length : next);
  };
  const tendonBlock = (name) => {
    const m = tendonXml.match(
      new RegExp(`<spatial name="${name}_tendon"[^>]*>(.*?)</spatial>`, 's'),
    );
    if (!m) throw new Error(`${limb.model.tendon} has no tendon '${name}'`);
    return m[1];
  };
  const attribute = (block, pattern) => {
    const m = block.match(pattern);
    if (!m) throw new Error(`${limb.model.chain}: no match for ${pattern}`);
    return m[1].trim().split(/\s+/).map(Number);
  };
  const bodyPos = (name) =>
    attribute(
      xml.slice(xml.indexOf(`<body name="${name}"`)),
      new RegExp(`^<body name="${name}"[^>]*pos="([^"]+)"`),
    );

  /** A joint's own axis, by name: one of the two things every frame is built from. */
  const axisOf = (joint) => attribute(xml, new RegExp(`<joint axis="([^"]+)" name="${joint}"`));

  /**
   * Every site of the limb, in the reference model's root-bone frame, with the bone it belongs to.
   *
   * Each body in the chain is a pure translation of its parent at the neutral pose, so adding the
   * offsets down the chain puts every site in one frame and a single frame correspondence carries
   * the whole limb rather than needing one per bone.
   */
  const offsets = limb.offsets(bodyPos);
  /** A body's sites turned about one of its joints, into the pose this skeleton holds. */
  const posed = new Map((limb.pose ?? []).map((p) => [p.body, p]));
  const turn = (body, p) => {
    const correction = posed.get(body);
    if (!correction) return p;
    const k = norm(axisOf(correction.joint));
    const c = Math.cos(correction.radians);
    const sn = Math.sin(correction.radians);
    // Rodrigues, about the joint's axis through the body's own origin, which is where the
    // reference puts the joint.
    const kd = dot(k, p);
    const kx = cross(k, p);
    return [
      p[0] * c + kx[0] * sn + k[0] * kd * (1 - c),
      p[1] * c + kx[1] * sn + k[1] * kd * (1 - c),
      p[2] * c + kx[2] * sn + k[2] * kd * (1 - c),
    ];
  };
  const sites = new Map();
  // Every body the limb maps, and any body a frame needs a probe from.
  // Sites a frame names for itself -- its probe, or a landmark it builds its axis from -- are
  // kept even when their body carries no muscle points of ours.
  const probed = new Set(
    limb.frames.flatMap((f) => [f.probe?.site, ...(f.reference.needs ?? [])].filter(Boolean)),
  );
  for (const body of offsets.keys()) {
    const at = offsets.get(body);
    const bone = limb.bodies.find((b) => b.body === body)?.bone;
    for (const m of bodyBlock(body).matchAll(/<site name="([^"]+)" pos="([^"]+)"/g)) {
      if (bone === undefined && !probed.has(m[1])) continue;
      const local = m[2].trim().split(/\s+/).map(Number);
      sites.set(m[1], { body, bone, at, local, point: add(at, local) });
    }
  }

  /**
   * Which of a tendon's points are via points.
   *
   * Read off the reference model's own path rather than assumed, because assuming gets it wrong.
   * The rule is the definition: a point is a via point if the path passes *through* it, so the
   * first and last are the origin and the insertion however they happen to be numbered.
   * Brachialis and brachioradialis are named P1 at the humerus and that P1 is where each one
   * starts, not somewhere it passes; the long head of triceps has a P1b between its first wrap
   * and its P2 that a numeric guess skips entirely.
   */
  const viaPoints = (tendon) => {
    const path = [
      ...tendonBlock(tendon).matchAll(
        /<(?:site|geom) (?:site|geom)="([^"]+)"(?:\s+sidesite="([^"]+)")?/g,
      ),
    ].map((m) => (m[2] !== undefined && limb.wrapSides?.includes(tendon) ? m[2] : m[1]));
    return path.filter((name, i) => i > 0 && i < path.length - 1 && sites.has(name));
  };

  /** Every site of a reference tendon, ends included: what says which way round its path runs. */
  const allSites = (tendon) =>
    [...tendonBlock(tendon).matchAll(/<site site="([^"]+)"/g)].map((m) => m[1]);

  /**
   * How far a site stands outside a cylinder wrap geom, metres: its distance from the cylinder's
   * axis less the cylinder's radius. Both are in the frame of the body that carries them.
   */
  const standoffFrom = (geom, siteName) => {
    const element = xml.match(new RegExp(`<geom\\b[^>]*name="${geom}"[^>]*/>`))?.[0];
    if (!element) throw new Error(`${limb.model.chain} has no geom '${geom}'`);
    const numbers = (key) => {
      const m = element.match(new RegExp(`\\b${key}="([^"]+)"`));
      if (!m) throw new Error(`${limb.model.chain}: geom '${geom}' states no ${key}`);
      return m[1].trim().split(/\s+/).map(Number);
    };
    if (!/type="cylinder"/.test(element)) {
      throw new Error(`${limb.model.chain}: geom '${geom}' is not a cylinder`);
    }
    const [w, x, y, z] = numbers('quat');
    // The cylinder's own Z, turned by its quaternion (MuJoCo's order, w first).
    const axis = norm([2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)]);
    const site = sites.get(siteName);
    if (!site) throw new Error(`${limb.model.chain}: no site '${siteName}'`);
    const d = sub(site.local, numbers('pos'));
    const along = dot(d, axis);
    const off = Math.hypot(d[0] - along * axis[0], d[1] - along * axis[1], d[2] - along * axis[2]);
    return off - numbers('size')[0];
  };

  return { sites, viaPoints, allSites, offsets, axisOf, turn, posed, standoffFrom };
}

// --- Frame arithmetic ------------------------------------------------------------------------

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (v) => {
  const n = Math.hypot(...v) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};

/**
 * A long bone's frame, from the two things both models can state: its long axis and the axis of
 * the joint at its far end.
 *
 * Y up the bone, Z along the joint's axis with whatever component along Y removed, X completing a
 * right-handed set. The same recipe `frames.ts` uses, so the two frames differ only by the
 * conventions they were each built under. It is the humerus for the arm and the femur for the
 * leg, and nothing in the arithmetic knows which.
 */
function boneFrame(proximal, distal, flexionAxis) {
  const y = norm(sub(proximal, distal));
  const raw = norm(flexionAxis);
  const z = norm(
    sub(
      raw,
      y.map((c) => c * dot(raw, y)),
    ),
  );
  const x = cross(y, z);
  // Columns are the frame's axes in the parent coordinates, so this maps frame -> parent.
  return [x, y, z];
}

/**
 * Which way round a joint's axis points, settled by a landmark rather than by hoping.
 *
 * The frame is built from the bone's long axis and the axis of the joint at its far end, and the
 * long axis is unambiguous -- it runs from one joint centre to the other. The joint axis is not:
 * ours runs medial to lateral by construction, and the reference model states whichever direction
 * makes its own joint's positive rotation come out as flexion. Get that sign wrong and Z flips,
 * and with it X, and the frame is rolled half a turn: anterior lands posterior and every point
 * carried across ends up behind the bone it should be in front of.
 *
 * It is not hypothetical. The leg frames were rolled exactly that way, which put the quadriceps
 * via points on the knee axis instead of in front of it and left the knee extensors with a three
 * millimetre moment arm where the patella should give them forty.
 *
 * So each limb names a place both models can point at that is firmly off to one side -- the
 * radial tuberosity, the tibial tuberosity -- and if the two frames disagree about which side it
 * is on, the reference's axis is negated. The arm needs no correction and the leg does, and the
 * check says which rather than either being assumed.
 */
function orientAxis(axis, basisOf, probeInReference, probeInOurs, name, along = 0) {
  // Relative to the frame's own origin: a frame whose origin is not the root's -- the forearm's,
  // the foot's -- would otherwise be asked which side of the *root* the probe fell on.
  const theirs = dot(probeInReference, basisOf(axis)[along]);
  // A probe close to the axis cannot settle which side of it anything is on, and a frame carried
  // on a coin toss is worse than one that refuses to build.
  if (Math.abs(theirs) < PROBE_MARGIN || Math.abs(probeInOurs) < PROBE_MARGIN) {
    throw new Error(
      `The probe '${name}' is ${(theirs * 1000).toFixed(1)} mm from the frame's own axis in the ` +
        `reference and ${(probeInOurs * 1000).toFixed(1)} mm in ours, which is too close to it ` +
        `to say which side it is on. Name a landmark further off the bone's long axis.`,
    );
  }
  const agree = theirs > 0 === probeInOurs > 0;
  return { axis: agree ? axis : axis.map((c) => -c), flipped: !agree };
}

/**
 * The extreme vertex of one of our bones along a frame axis, in world coordinates.
 *
 * Reads the packed meshes, the way `wrapRadii.ts` does, so it re-runs from the repository without
 * the source export. The rule is the whole content of the measurement and it is recorded beside
 * each point it produces.
 */
function boneExtreme(bone, axis, pick, basis) {
  const mesh = PACKED.get(bone);
  if (!mesh) throw new Error(`'${bone}' is not in the packed dataset`);
  const direction = basis[{ x: 0, y: 1, z: 2 }[axis]];
  let best = null;
  let bestValue = pick === 'max' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const at = 3 * (mesh.vertexOffset + i);
    const v = [POSITIONS[at], POSITIONS[at + 1], POSITIONS[at + 2]];
    const along = dot(v, direction);
    if (pick === 'max' ? along > bestValue : along < bestValue) {
      bestValue = along;
      best = v;
    }
  }
  if (!best) throw new Error(`'${bone}' has no vertices`);
  return best;
}

/** The vertex of one of our bones nearest a world point, from the packed meshes. */
function boneNearest(bone, point) {
  const mesh = PACKED.get(bone);
  if (!mesh) throw new Error(`'${bone}' is not in the packed dataset`);
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const at = 3 * (mesh.vertexOffset + i);
    const v = [POSITIONS[at], POSITIONS[at + 1], POSITIONS[at + 2]];
    const d = (v[0] - point[0]) ** 2 + (v[1] - point[1]) ** 2 + (v[2] - point[2]) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = v;
    }
  }
  if (!best) throw new Error(`'${bone}' has no vertices`);
  return best;
}

/** Express a point given in the parent coordinates in the frame's own. */
const intoFrame = (basis, origin, p) => {
  const d = sub(p, origin);
  return [dot(d, basis[0]), dot(d, basis[1]), dot(d, basis[2])];
};

/** Express a point given in the frame's coordinates in the parent's. */
const outOfFrame = (basis, origin, q) => [
  origin[0] + basis[0][0] * q[0] + basis[1][0] * q[1] + basis[2][0] * q[2],
  origin[1] + basis[0][1] * q[0] + basis[1][1] * q[1] + basis[2][1] * q[2],
  origin[2] + basis[0][2] * q[0] + basis[1][2] * q[1] + basis[2][2] * q[2],
];

const centroids = new Map(skeleton.DATASET_MANIFEST.bones.map((b) => [b.id, b.centroid]));
const PACKED = new Map(skeleton.DATASET_MANIFEST.bones.map((b) => [b.id, b]));
const PACK = readFileSync(join(ROOT, 'packages/assets-anatomical/data/skeleton.bin'));
const POSITIONS = new Float32Array(
  PACK.buffer.slice(PACK.byteOffset, PACK.byteOffset + PACK.byteLength),
);
const stature = skeleton.DATASET_MANIFEST.subjectStature;

// --- Carry the points across -------------------------------------------------------------------

const round = (v) => Number(v.toPrecision(6));
const rows = [];
const direction = new Map();
const measured = [];

for (const limb of LIMBS) {
  const { sites, viaPoints, allSites, offsets, axisOf, turn, posed, standoffFrom } = readLimb(limb);

  /**
   * One frame correspondence per bone group, built the same way: ask both models for the same
   * anatomical frame and take the rotation and the scale between the answers.
   */
  const carriers = new Map();
  /** What a frame may ask the reference model for. */
  const ctx = {
    offset: (body) => {
      const at = offsets.get(body);
      if (!at) throw new Error(`${limb.model.chain}: no offset for body '${body}'`);
      return at;
    },
    site: (name) => {
      const site = sites.get(name);
      if (!site) throw new Error(`${limb.model.chain}: no site '${name}'`);
      return site.point;
    },
    jointAxis: (joint) => axisOf(joint),
  };
  for (const frame of limb.frames) {
    const referenceOrigin = frame.reference.origin(ctx);
    const referenceDistal = frame.reference.distal(ctx);
    const ours = frame.ours(skeleton);
    const ourBasis = boneFrame(ours.origin, ours.distal, ours.axis);

    // A frame whose axis is built from the same two landmarks on both sides points the same way
    // on both by construction. One taken from a joint's own statement does not, and is settled
    // against a landmark both models carry before anything is carried through it.
    let orientedAxis = frame.reference.axis(ctx);
    if (frame.probe) {
      const probeSite = sites.get(frame.probe.site);
      if (!probeSite) throw new Error(`${limb.model.chain}: no probe site '${frame.probe.site}'`);
      const along = { x: 0, y: 1, z: 2 }[frame.probe.along ?? 'x'];
      const oursProbe = dot(sub(frame.probe.ours(skeleton), ours.origin), ourBasis[along]);
      const oriented = orientAxis(
        orientedAxis,
        (a) => boneFrame(referenceOrigin, referenceDistal, a),
        sub(probeSite.point, referenceOrigin),
        oursProbe,
        frame.probe.site,
        along,
      );
      orientedAxis = oriented.axis;
      if (oriented.flipped) {
        console.error(
          `  ${limb.id}/${frame.id}: the reference states its joint axis the other way round, so ` +
            `its frame is rolled half a turn against ours. Negated, checked against ${frame.probe.site}.`,
        );
      }
    }
    const referenceBasis = boneFrame(referenceOrigin, referenceDistal, orientedAxis);
    const referenceLength = Math.hypot(...sub(referenceDistal, referenceOrigin));
    const ourLength = Math.hypot(...sub(ours.origin, ours.distal));
    const scale = ourLength / referenceLength;
    const twist =
      (Math.acos(Math.min(1, Math.max(-1, dot(referenceBasis[1], ourBasis[1])))) * 180) / Math.PI;
    measured.push(
      ` *   ${frame.id.padEnd(9)} ${(referenceLength * 1000).toFixed(1)} mm against ` +
        `${(ourLength * 1000).toFixed(1)}, a scale of ${scale.toFixed(4)}`,
    );
    console.error(
      `  ${limb.id}/${frame.id}: reference ${(referenceLength * 1000).toFixed(1)} mm, ours ` +
        `${(ourLength * 1000).toFixed(1)} mm, scale ${scale.toFixed(4)}, twist ${twist.toFixed(1)} deg`,
    );
    const carrier = {
      frame: frame.id,
      referenceBasis,
      referenceOrigin,
      scale,
      ourBasis,
      ourOrigin: ours.origin,
    };
    for (const body of frame.bodies) carriers.set(body, carrier);
  }
  /** The frame the thigh is carried on, which is also the one the patella is measured in. */
  const ourBasis = carriers.get(limb.bodies[0].body).ourBasis;

  for (const spec of limb.units) {
    // A unit whose points are measured from our own bone takes them instead of the reference's.
    const measuredFor = limb.measured?.units.includes(spec.unit) ? limb.measured : undefined;
    if (measuredFor) {
      direction.set(spec.unit, 'forward');
      measuredFor.points.forEach((point, i) => {
        const world = boneExtreme(measuredFor.bone, point.axis, point.pick, ourBasis);
        const centroid = centroids.get(measuredFor.bone);
        rows.push({
          id: `${spec.unit}__via_${i + 1}`,
          unit: spec.unit,
          order: i + 1,
          bone: measuredFor.bone,
          site: `measured: ${point.pick === 'max' ? 'most' : 'least'} ${point.axis} of ${measuredFor.bone}`,
          // Taken from our own bone, so no reference model and no frame carried it.
          referenceModel: null,
          frame: null,
          method: 'measured',
          local: [
            round((world[0] - centroid[0]) / stature),
            round((world[1] - centroid[1]) / stature),
            round((world[2] - centroid[2]) / stature),
          ],
        });
      });
      console.error(
        `  ${spec.unit.padEnd(26)} ${measuredFor.points.length} point(s) measured on ` +
          `${measuredFor.bone}`,
      );
      continue;
    }
    const names = viaPoints(spec.tendon);
    // Which way round the reference lists this path, decided from whichever end can be identified.
    //
    // The obvious test -- is the first site on the bone our origin is on -- answers wrongly when
    // it is on a bone this limb does not map. The leg's chain is rooted at the pelvis and the
    // frame correspondence here is built from the femur, so pelvis sites are not carried and are
    // not in `sites`; every muscle that starts on the pelvis, which is most of the hip's, came out
    // `reversed` on the strength of a lookup that missed. Sartorius then ran from the iliac spine
    // down to the tibia, back up to the femur and down to the tibia again: an 835 mm muscle.
    //
    // So: use the first site if it is on a bone we know, otherwise the last, and refuse if neither
    // is. Reading it from the far end inverts the test, because a path that ends where our
    // insertion is runs the same way ours does.
    const ends = allSites(spec.tendon);
    const first = ends[0];
    const last = ends.at(-1);
    const firstBone = first === undefined ? undefined : sites.get(first)?.bone;
    const lastBone = last === undefined ? undefined : sites.get(last)?.bone;
    let reversed;
    if (firstBone !== undefined) reversed = firstBone !== spec.from;
    else if (lastBone !== undefined) reversed = lastBone === spec.from;
    else {
      throw new Error(
        `${spec.unit}: neither end of '${spec.tendon}' is on a bone this limb maps, so which ` +
          'way round its path runs cannot be read. Add the bone to the limb, or the points to it.',
      );
    }
    if (reversed) names.reverse();
    direction.set(spec.unit, reversed ? 'reversed' : 'forward');
    let index = 0;
    for (const name of names) {
      index++;
      const site = sites.get(name);
      if (!site) throw new Error(`${limb.model.chain}: no site '${name}' on any body of this limb`);
      // The bone it rides: the reference's, unless this unit's tendon runs on another there.
      // Named by the point when only some of a unit's points move, and by the bone they came
      // from when all of them do.
      const rebindOf = limb.rebind?.[spec.unit];
      const bone = rebindOf?.[name] ?? rebindOf?.[site.bone] ?? site.bone;
      const centroid = centroids.get(bone);
      if (!centroid) throw new Error(`'${bone}' is not in the packed dataset`);
      const carrier = carriers.get(site.body);
      if (!carrier) {
        throw new Error(
          `${spec.unit}: its point '${name}' is on body '${site.body}', which no frame of the ` +
            `${limb.id} carries. Add the body to a frame's bodies.`,
        );
      }
      // Into this skeleton's pose first, if its body is one the two models hold differently --
      // unless the point is being rebound to a bone that does not turn, in which case it was only
      // ever on the turning body because the reference's body was the whole hand.
      const turns = posed.has(site.body) && bone === site.bone;
      const point = turns ? add(site.at, turn(site.body, site.local)) : site.point;
      const inReference = intoFrame(carrier.referenceBasis, carrier.referenceOrigin, point);
      const scaled = inReference.map((c) => c * carrier.scale);
      let world = outOfFrame(carrier.ourBasis, carrier.ourOrigin, scaled);
      let provenance = name;
      // How it was obtained, which is what its site's citation has to say: carried by the frame
      // correspondence from the reference's file, or not carried at all.
      let method = 'carried';
      const measuredAt = limb.measuredSites?.[name];
      if (measuredAt) {
        const [a, b] = measuredAt.between.map((f) => skeleton.measuredWorld(measuredAt.bone, f));
        const spot = [
          a[0] + (b[0] - a[0]) * measuredAt.at,
          a[1] + (b[1] - a[1]) * measuredAt.at,
          a[2] + (b[2] - a[2]) * measuredAt.at,
        ];
        world = boneNearest(measuredAt.bone, spot);
        provenance = `measured: ${measuredAt.between[0]} to ${measuredAt.between[1]} at ${measuredAt.at}`;
        method = 'measured';
      }
      const snap = limb.snapSites?.[name];
      if (snap) {
        const surface = boneNearest(bone, world);
        const out = norm(sub(world, surface));
        world = add(
          surface,
          out.map((c) => c * snap.standoff),
        );
        provenance = `${name}, drawn in to ${(snap.standoff * 1000).toFixed(0)} mm from ${bone}`;
        method = 'drawn-in';
      }
      const onSurface = limb.onSurface?.[name];
      if (onSurface) {
        const ours = onSurface.surface(skeleton);
        const standoff = standoffFrom(onSurface.geom, name);
        const axis = norm(sub(ours.to, ours.from));
        const d = sub(world, ours.from);
        const along = dot(d, axis);
        const foot = add(
          ours.from,
          axis.map((c) => c * along),
        );
        const out = norm(sub(world, foot));
        world = add(
          foot,
          out.map((c) => c * (ours.radius + standoff)),
        );
        // Said the way every drawn-in point says it, by where it ended up from its own bone, which
        // is what its site's citation reads back (attachments.ts).
        const fromBone = Math.hypot(...sub(world, boneNearest(bone, world)));
        provenance = `${name}, drawn in to ${(fromBone * 1000).toFixed(0)} mm from ${bone}`;
        method = 'drawn-in';
      }
      rows.push({
        id: `${spec.unit}__via_${index}`,
        unit: spec.unit,
        order: index,
        bone,
        site: provenance,
        // A point measured on our bone owes the reference nothing but its name. One drawn in was
        // carried first, and the carry is where its direction from the bone came from.
        referenceModel: method === 'measured' ? null : upstreamPath(limb.model, 'chain'),
        frame: method === 'measured' ? null : carrier.frame,
        method,
        local: [
          round((world[0] - centroid[0]) / stature),
          round((world[1] - centroid[1]) / stature),
          round((world[2] - centroid[2]) / stature),
        ],
      });
    }
    const rebind = limb.rebind?.[spec.unit];
    const from = [...new Set(names.map((n) => sites.get(n).bone))];
    const to = [...new Set(from.map((b) => rebind?.[b] ?? b))];
    const where = rebind
      ? `${to.join(', ')} (from ${from.join(', ')})`
      : from.join(', ') || '(none)';
    console.error(
      `  ${spec.unit.padEnd(26)} ${String(names.length).padStart(2)} via point(s) on ${where}`,
    );
  }
}

// --- The other arm ------------------------------------------------------------------------------

/**
 * The same points on the left, by reflecting them in the sagittal plane.
 *
 * A point is stored as an offset from its bone's centroid in the dataset's own axis-aligned frame,
 * where +X is right. So the reflection is a negated X in world, taken back to an offset from the
 * *left* bone's centroid -- which is why the two centroids have to agree to a mirror for this to
 * mean anything, and why that is checked.
 */
const mirrored = [];
const asymmetry = [];
for (const r of rows) {
  const left = r.bone.replace(/_r$/, '_l');
  const rightCentroid = centroids.get(r.bone);
  const leftCentroid = centroids.get(left);
  if (!leftCentroid) throw new Error(`'${left}' is not in the packed dataset`);
  const gap = Math.hypot(
    leftCentroid[0] + rightCentroid[0],
    leftCentroid[1] - rightCentroid[1],
    leftCentroid[2] - rightCentroid[2],
  );
  if (gap > SYMMETRY_TOLERANCE)
    asymmetry.push(`${r.bone} vs ${left}: ${(gap * 1000).toFixed(1)} mm`);
  // Back to world, reflect, and down again onto the left bone.
  const world = [
    r.local[0] * stature + rightCentroid[0],
    r.local[1] * stature + rightCentroid[1],
    r.local[2] * stature + rightCentroid[2],
  ];
  mirrored.push({
    id: r.id.replace(/_r__via_/, '_l__via_'),
    unit: r.unit.replace(/_r$/, '_l'),
    order: r.order,
    bone: left,
    site: r.site,
    // The right side's file and frame: the left point is that one reflected, not a second carry.
    referenceModel: r.referenceModel,
    frame: r.frame,
    method: r.method,
    local: [
      round((-world[0] - leftCentroid[0]) / stature),
      round((world[1] - leftCentroid[1]) / stature),
      round((world[2] - leftCentroid[2]) / stature),
    ],
  });
}
if (asymmetry.length > 0) {
  throw new Error(
    `The dataset's two sides do not mirror to within ${SYMMETRY_TOLERANCE * 1000} mm, so the ` +
      `left side cannot be taken as the right reflected:\n  ${asymmetry.join('\n  ')}`,
  );
}
rows.push(...mirrored);
console.error(
  `  mirrored ${mirrored.length} point(s) onto the left side; the two sides' bone centroids ` +
    'agree to a reflection',
);

const measurements = measured.join('\n');
const directionBody = [...direction.entries()]
  .flatMap(([unit, how]) => [`  ${unit}: '${how}',`, `  ${unit.replace(/_r$/, '_l')}: '${how}',`])
  .join('\n');

const body = rows
  .map(
    (r) => `  {
    id: '${r.id}',
    unit: '${r.unit}',
    order: ${r.order},
    bone: '${r.bone}',
    referenceSite: '${r.site}',
    referenceModel: ${r.referenceModel === null ? 'null' : `'${r.referenceModel}'`},
    frame: ${r.frame === null ? 'null' : `'${r.frame}'`},
    method: '${r.method}',
    local: [${r.local.join(', ')}],
  },`,
  )
  .join('\n');

const rendered = `/**
 * Muscle via points, carried over from the reference models' frames into ours.
 *
 * **Generated by \`pnpm generate:via-points\`. Do not edit.**
 *
 * A muscle lies along the bones it passes rather than running straight between its attachments,
 * and published models hold it there with via points. Without them the elbow flexors cut through
 * the humerus and their moment arms come out far too large -- biceps peaked at 65 mm against a
 * published 36 to 40.
 *
 * ## Why these are not simply transcribed
 *
 * The reference models state them in their own body frames, and a coordinate lifted from one
 * frame into another means nothing where it lands. So both models are asked for the same
 * *anatomical* construction instead, one per bone group -- the joint at the bone's proximal end,
 * its long axis, the axis of the joint at its far end, which for the upper arm is the humerus frame
 * the ISB defines (Wu 2005, 2.3.4) -- and the rotation between the two answers is the disagreement
 * between two conventions and nothing else. Lengths are scaled by the ratio of the two bones, so a
 * point a third of the way down one lands a third of the way down the other.
 *
 * Not every point is carried. \`method\` says which: \`carried\` by the frame of the bone group
 * \`frame\` names, from the file \`referenceModel\` names; \`measured\` on this skeleton's own
 * bone where no carry can reach, with no reference file behind it; or \`drawn-in\`, carried and
 * then moved along the same line to a set distance from our bone's surface. A site built from a
 * point cites it by that, so a number taken from the reference says which file it came from and
 * one that was not says so.
 *
 * The transforms were measured, not assumed. Bone for bone, reference against ours:
${measurements}
 *
 * Positions are a fraction of the subject's stature, as every other point in this package is, so
 * they scale with the morphology.
 *
 * ## The left side
 *
 * The reference models are right-sided, so the left side is the right reflected in the sagittal
 * plane. The generator checks the assumption that makes that valid -- every left bone's centroid
 * against its right one's reflection -- and refuses rather than mirroring onto a bone that is not
 * where its mirror would be.
 */

/** One point a muscle passes through, in the order it meets them from origin to insertion. */
export interface MuscleViaPoint {
  readonly id: string;
  /** The muscle-tendon unit this point belongs to. */
  readonly unit: string;
  /** Position in the path, ascending from the origin. */
  readonly order: number;
  /** The bone it is fixed to, and moves with. */
  readonly bone: string;
  /**
   * The reference model's own name for it, so the number can be traced back -- or, for a point
   * measured on our bone, the rule that measured it.
   */
  readonly referenceSite: string;
  /**
   * The reference file it was carried from, as its path upstream; null for a point measured on our
   * own bone. A left point names the right side's file, because it is that point reflected.
   */
  readonly referenceModel: string | null;
  /** The bone group whose frame correspondence carried it; null for one measured on our bone. */
  readonly frame: 'upper arm' | 'forearm' | 'thigh' | 'shank' | null;
  /**
   * How it was obtained: carried by a frame correspondence, measured on our own bone, or carried
   * and then drawn in to a set distance from our bone's surface.
   */
  readonly method: 'carried' | 'measured' | 'drawn-in';
  /** Bone-local, as a fraction of stature. */
  readonly local: readonly [number, number, number];
}

export const MUSCLE_VIA_POINTS: readonly MuscleViaPoint[] = [
${body}
];

/** The points of one unit, in path order. */
export function viaPointsFor(unit: string): readonly MuscleViaPoint[] {
  return MUSCLE_VIA_POINTS.filter((p) => p.unit === unit).sort((a, b) => a.order - b.order);
}

/**
 * Which way round the reference model lists each unit's path, relative to ours.
 *
 * The reference does not agree with itself: the elbow tendons run from the girdle outward and
 * most of the shoulder tendons from the humerus inward. The points above are already in our
 * order, origin first. This says which way they were turned to get there, which is what tells a
 * muscle generator where in the path a wrap surface belongs -- the reference states that as a
 * position among its own elements, and a position read the wrong way round puts the obstacle on
 * the wrong span.
 */
export const VIA_PATH_DIRECTION: Readonly<Record<string, 'forward' | 'reversed'>> = {
${directionBody}
};
`;

emitOrCheck({
  name: 'generate-via-points',
  script: 'generate:via-points',
  out: OUT,
  text: rendered,
  check,
  summary: `${rows.length} points from ${LIMBS.map((l) => l.model.chain).join(' and ')}`,
});
