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
 *   - The origin is the glenohumeral centre. In the reference model that is the humerus body's
 *     own frame origin; here it is the fitted centre of the humeral head.
 *   - One axis runs from the elbow up to that origin: the bone's long axis. The reference model
 *     gives the elbow as the forearm body's offset; here it is the midpoint of the epicondyles.
 *   - The other is the elbow's flexion axis. The reference model states it as a joint axis; here
 *     it is the line through the epicondyles.
 *
 * That is the same frame the ISB defines for the humerus (Wu 2005, 2.3.4), built twice from
 * whatever each model happens to carry. Two frames of the same bone, so the rotation between them
 * is the disagreement between two conventions and nothing else.
 *
 * Lengths are scaled by the ratio of the two humeri, so a point a third of the way down one bone
 * lands a third of the way down the other, and then divided by this subject's stature so it
 * scales with the morphology like every other point in the skeleton.
 *
 * ## One frame, the whole arm
 *
 * Every body in the reference model's arm is a pure translation of its parent at the neutral pose,
 * so adding the offsets down the chain puts every site in the humerus frame and the single
 * correspondence above carries points on the scapula and the forearm too. Both models put the
 * elbow at zero when extended and the forearm at zero in neutral rotation, so the two neutral
 * poses are the same pose.
 *
 * Lengths are scaled by the humerus ratio throughout, forearm points included. That assumes the
 * two skeletons have similar proportions; where they do not, a forearm point is out by the
 * difference between the two ratios, which is a few per cent of a bone.
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

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MYO_SIM = join(ROOT, 'tools/validate-external/myo_sim');
const OUT = join(ROOT, 'packages/skeleton/src/muscleViaPoints.ts');
const check = process.argv.includes('--check');

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
    chain: 'myoarm_r_chain.xml',
    tendon: 'myoarm_r_tendon.xml',
    /** The bone whose frame carries the whole limb, and the joint at its far end. */
    reference: { root: 'humerus_r', distal: 'ulna_r', axisJoint: 'elbow_flexion_r' },
    /**
     * Where each body sits in the root's frame, as offsets accumulated down the chain.
     *
     * Every body in the reference arm is a pure translation of its parent at the neutral pose, so
     * adding the offsets is enough; a body with a rotation would need more and there is none here.
     */
    offsets: (bodyPos) => {
      const forearm = bodyPos('ulna_r');
      const radius = bodyPos('radius_r');
      const phantom = bodyPos('clavphant_r');
      return new Map([
        ['scapula_r', [0, 0, 0]],
        ['humerus_r', [0, 0, 0]],
        // The clavicle is a body further out than the scapula, back along the phantom between.
        ['clavicle_r', [-phantom[0], -phantom[1], -phantom[2]]],
        ['ulna_r', forearm],
        ['radius_r', [forearm[0] + radius[0], forearm[1] + radius[1], forearm[2] + radius[2]]],
      ]);
    },
    bodies: [
      { body: 'clavicle_r', bone: 'clavicle_r' },
      { body: 'scapula_r', bone: 'scapula_r' },
      { body: 'humerus_r', bone: 'humerus_r' },
      { body: 'ulna_r', bone: 'ulna_r' },
      { body: 'radius_r', bone: 'radius_r' },
    ],
    /** Ours: the same frame, from the landmarks this skeleton carries. */
    ourFrame: (skeleton) => {
      const gh = skeleton.refWorld(['humerus_r', 'GH']);
      const em = skeleton.refWorld(['humerus_r', 'EM']);
      const el = skeleton.refWorld(['humerus_r', 'EL']);
      return { origin: gh, distal: midpoint(em, el), axis: sub(el, em) };
    },
    // Which way round the frame is rolled: see `orientAxis`. The olecranon is firmly behind the
    // elbow in any convention, and far enough behind to settle the question with margin.
    probe: {
      site: 'TRIlong_TRIlong-P5_r',
      ours: (skeleton) => skeleton.measuredWorld('ulna_r', 'Olecranon'),
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
    ],
  },
  {
    id: 'leg',
    chain: 'myolegs_chain.xml',
    tendon: 'myolegs_tendon.xml',
    reference: { root: 'femur_r', distal: 'tibia_r', axisJoint: 'knee_angle_r' },
    offsets: (bodyPos) => {
      const shank = bodyPos('tibia_r');
      const talus = bodyPos('talus_r');
      const heel = bodyPos('calcn_r');
      return new Map([
        ['femur_r', [0, 0, 0]],
        // The patella hangs off the femur rather than the shank, which is what makes it able to
        // carry the quadriceps across the joint.
        ['patella_r', bodyPos('patella_r')],
        ['tibia_r', shank],
        [
          'calcn_r',
          [
            shank[0] + talus[0] + heel[0],
            shank[1] + talus[1] + heel[1],
            shank[2] + talus[2] + heel[2],
          ],
        ],
      ]);
    },
    bodies: [
      { body: 'femur_r', bone: 'femur_r' },
      { body: 'patella_r', bone: 'patella_r' },
      { body: 'tibia_r', bone: 'tibia_r' },
      { body: 'calcn_r', bone: 'calcaneus_r' },
    ],
    ourFrame: (skeleton) => {
      // The hip centre is fitted from the femoral head's own articular surface rather than taken
      // from a marker, the same as everywhere else this project needs a joint centre.
      const hip = skeleton.measuredWorld('femur_r', 'Head_of_femur__articular_centre');
      const em = skeleton.measuredWorld('femur_r', 'Medial_epicondyle_of_femur');
      const el = skeleton.measuredWorld('femur_r', 'Lateral_epicondyle_of_femur');
      return { origin: hip, distal: midpoint(em, el), axis: sub(el, em) };
    },
    // The tibial tuberosity: firmly in front of the knee in any convention, and the place the
    // quadriceps arrive. See `orientAxis` -- this is the probe that caught the leg frames rolled
    // half a turn against each other.
    probe: {
      site: 'recfem-P5_r',
      ours: (skeleton) => skeleton.measuredWorld('tibia_r', 'Tibial_tuberosity'),
    },
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
    ],
  },
];

/** Everything one limb's reference files say, read once. */
function readLimb(limb) {
  const xml = readFileSync(join(MYO_SIM, limb.chain), 'utf8');
  const tendonXml = readFileSync(join(MYO_SIM, limb.tendon), 'utf8');

  const bodyBlock = (name) => {
    const start = xml.indexOf(`<body name="${name}"`);
    if (start < 0) throw new Error(`${limb.chain} has no body '${name}'`);
    // Up to the next nested body, which is where this body's own sites end.
    const next = xml.indexOf('<body ', start + 1);
    return xml.slice(start, next < 0 ? xml.length : next);
  };
  const tendonBlock = (name) => {
    const m = tendonXml.match(
      new RegExp(`<spatial name="${name}_tendon"[^>]*>(.*?)</spatial>`, 's'),
    );
    if (!m) throw new Error(`${limb.tendon} has no tendon '${name}'`);
    return m[1];
  };
  const attribute = (block, pattern) => {
    const m = block.match(pattern);
    if (!m) throw new Error(`${limb.chain}: no match for ${pattern}`);
    return m[1].trim().split(/\s+/).map(Number);
  };
  const bodyPos = (name) =>
    attribute(
      xml.slice(xml.indexOf(`<body name="${name}"`)),
      new RegExp(`^<body name="${name}"[^>]*pos="([^"]+)"`),
    );

  // The distal body's offset is the far joint's centre in the root body's frame, and the joint's
  // own axis is stated on it: the two things the frame is built from.
  const distalCentre = bodyPos(limb.reference.distal);
  const axis = attribute(
    xml,
    new RegExp(`<joint axis="([^"]+)" name="${limb.reference.axisJoint}"`),
  );

  /**
   * Every site of the limb, in the reference model's root-bone frame, with the bone it belongs to.
   *
   * Each body in the chain is a pure translation of its parent at the neutral pose, so adding the
   * offsets down the chain puts every site in one frame and a single frame correspondence carries
   * the whole limb rather than needing one per bone.
   */
  const offsets = limb.offsets(bodyPos);
  const sites = new Map();
  for (const { body, bone } of limb.bodies) {
    const at = offsets.get(body);
    if (!at) throw new Error(`${limb.chain}: no offset for body '${body}'`);
    for (const m of bodyBlock(body).matchAll(/<site name="([^"]+)" pos="([^"]+)"/g)) {
      const p = m[2].trim().split(/\s+/).map(Number);
      sites.set(m[1], { bone, point: [at[0] + p[0], at[1] + p[1], at[2] + p[2]] });
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
    const path = [...tendonBlock(tendon).matchAll(/<(?:site|geom) (?:site|geom)="([^"]+)"/g)].map(
      (m) => m[1],
    );
    return path.filter((name, i) => i > 0 && i < path.length - 1 && sites.has(name));
  };

  /** Every site of a reference tendon, ends included: what says which way round its path runs. */
  const allSites = (tendon) =>
    [...tendonBlock(tendon).matchAll(/<site site="([^"]+)"/g)].map((m) => m[1]);

  return { sites, viaPoints, allSites, distalCentre, axis };
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
function orientAxis(axis, basisOf, probeInReference, probeInOurs, name) {
  const theirs = dot(probeInReference, basisOf(axis)[0]);
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
  const { sites, viaPoints, allSites, distalCentre, axis } = readLimb(limb);

  // The reference model's frame: the root body's own origin is the proximal joint's centre.
  const referenceOrigin = [0, 0, 0];

  // Ours, built from the landmarks the same way.
  const ours = limb.ourFrame(skeleton);
  const ourBasis = boneFrame(ours.origin, ours.distal, ours.axis);

  // Settle the joint axis's direction against a landmark both models carry, before anything is
  // carried through a frame that might be rolled half a turn.
  const probeSite = sites.get(limb.probe.site);
  if (!probeSite) throw new Error(`${limb.chain}: no probe site '${limb.probe.site}'`);
  const oursProbe = dot(sub(limb.probe.ours(skeleton), ours.origin), ourBasis[0]);
  const { axis: orientedAxis, flipped } = orientAxis(
    axis,
    (a) => boneFrame(referenceOrigin, distalCentre, a),
    probeSite.point,
    oursProbe,
    limb.probe.site,
  );
  if (flipped) {
    console.error(
      `  ${limb.id}: the reference states its joint axis the other way round, so its frame is ` +
        'rolled half a turn against ours. Negated, checked against ' +
        `${limb.probe.site}.`,
    );
  }
  const referenceBasis = boneFrame(referenceOrigin, distalCentre, orientedAxis);
  const referenceLength = Math.hypot(...distalCentre);
  const ourLength = Math.hypot(...sub(ours.origin, ours.distal));
  const scale = ourLength / referenceLength;
  const twist =
    (Math.acos(Math.min(1, Math.max(-1, dot(referenceBasis[1], ourBasis[1])))) * 180) / Math.PI;
  measured.push(
    ` *   ${limb.id.padEnd(4)} ${(referenceLength * 1000).toFixed(1)} mm against ` +
      `${(ourLength * 1000).toFixed(1)}, a scale of ${scale.toFixed(4)}`,
  );
  console.error(
    `  ${limb.id}: reference bone ${(referenceLength * 1000).toFixed(1)} mm, ours ` +
      `${(ourLength * 1000).toFixed(1)} mm, scale ${scale.toFixed(4)}, twist ` +
      `${twist.toFixed(1)} deg`,
  );

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
    // Reversed when the reference's first site is not on the bone our origin is on.
    const first = allSites(spec.tendon)[0];
    const reversed = first !== undefined && sites.get(first)?.bone !== spec.from;
    if (reversed) names.reverse();
    direction.set(spec.unit, reversed ? 'reversed' : 'forward');
    let index = 0;
    for (const name of names) {
      index++;
      const site = sites.get(name);
      if (!site) throw new Error(`${limb.chain}: no site '${name}' on any body of this limb`);
      const centroid = centroids.get(site.bone);
      if (!centroid) throw new Error(`'${site.bone}' is not in the packed dataset`);
      const inReference = intoFrame(referenceBasis, referenceOrigin, site.point);
      const scaled = inReference.map((c) => c * scale);
      const world = outOfFrame(ourBasis, ours.origin, scaled);
      rows.push({
        id: `${spec.unit}__via_${index}`,
        unit: spec.unit,
        order: index,
        bone: site.bone,
        site: name,
        local: [
          round((world[0] - centroid[0]) / stature),
          round((world[1] - centroid[1]) / stature),
          round((world[2] - centroid[2]) / stature),
        ],
      });
    }
    console.error(
      `  ${spec.unit.padEnd(26)} ${String(names.length).padStart(2)} via point(s) on ` +
        `${[...new Set(names.map((n) => sites.get(n).bone))].join(', ') || '(none)'}`,
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
      `left arm cannot be taken as this one reflected:\n  ${asymmetry.join('\n  ')}`,
  );
}
rows.push(...mirrored);
console.error(
  `  mirrored ${mirrored.length} point(s) onto the left arm; the two sides' bone centroids ` +
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
    local: [${r.local.join(', ')}],
  },`,
  )
  .join('\n');

const rendered = `/**
 * Muscle via points, carried over from the reference model's frames into ours.
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
 * The reference model states them in its own body frames, and a coordinate lifted from one frame
 * into another means nothing where it lands. So both models are asked for the same *anatomical*
 * construction instead -- the glenohumeral centre, the bone's long axis, the elbow's flexion axis,
 * which is the humerus frame the ISB defines (Wu 2005, 2.3.4) -- and the rotation between the two
 * answers is the disagreement between two conventions and nothing else. Lengths are scaled by the
 * ratio of the two humeri, so a point a third of the way down one lands a third of the way down
 * the other.
 *
 * The transforms were measured, not assumed. Bone for bone, reference against ours:
${measurements}
 *
 * Positions are a fraction of the subject's stature, as every other point in this package is, so
 * they scale with the morphology.
 *
 * ## The left arm
 *
 * The reference model is a right arm, so the left side is this side reflected in the sagittal
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
  /** The reference model's own name for it, so the number can be traced back. */
  readonly referenceSite: string;
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
      `generate-via-points: ${relative(ROOT, OUT)} is not what the generator would write.\n` +
        '  Run `pnpm generate:via-points`.',
    );
    process.exit(1);
  }
  console.log(
    `generate-via-points: ok. ${rows.length} points match ${LIMBS.map((l) => l.chain).join(' and ')}.`,
  );
} else {
  writeFileSync(OUT, rendered);
  console.log(
    `generate-via-points: wrote ${relative(ROOT, OUT)} -- ${rows.length} points from ${LIMBS.map((l) => l.chain).join(' and ')}.`,
  );
}
