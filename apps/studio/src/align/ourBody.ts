/**
 * Our body at rest, as the Align tab measures it: where the joints are, where the muscles attach
 * and pass, and where a reference model sits down on it.
 *
 * These are pure functions of the compiled articulation and the compiled muscle set. They lived
 * in the studio's entry file, as closures over the running simulation, where nothing could test
 * them and the fit that rests on them could only be checked by eye. Here a test can build the body
 * and ask.
 */

import type { CompiledArticulation, CompiledJoint } from '@bs-humany/compiler';
import { type Vec3, transformPoint } from '@bs-humany/frames';
import type { CompiledMuscleSet } from '@bs-humany/modules-muscle';
import { Vector3 } from 'three';
import { fittedFromPlacement } from './retarget.js';
import { type Placement, type SourceModel, changeOfAxes } from './sourceOverlay.js';

/**
 * Where a joint's centre sits in the world at rest, through the segment on one side of it.
 *
 * The joint frame is stated twice, once in each segment it connects, and at the neutral pose the
 * two statements are the same point: that is what connecting them means. Either side will do,
 * then, and the choice is offered because each caller has a natural one -- a point handle belongs
 * to the parent, a segment's own joints are read from whichever side the segment is on.
 */
export function restJointCentre(
  articulation: CompiledArticulation,
  joint: CompiledJoint,
  side: 'parent' | 'child',
): Vector3 {
  const segment =
    articulation.segments[side === 'parent' ? joint.parentSegment : joint.childSegment];
  if (!segment) return new Vector3(Number.NaN, Number.NaN, Number.NaN);
  const frame = side === 'parent' ? joint.frameInParent : joint.frameInChild;
  const p = transformPoint(segment.restWorld, frame.translation);
  return new Vector3(p.x, p.y, p.z);
}

/** One of our joints on a segment: where it sits at rest, and the segment on its other side. */
export interface JointOnSegment {
  readonly at: Vector3;
  /** The segment on the other side of the joint, by id. */
  readonly other: string;
}

/**
 * Our joints touching a segment: where each sits at rest, and the segment on the other side.
 *
 * The other side is what lets a joint of theirs be matched to one of ours -- both models agree a
 * hip is a hip, so the joint between two paired bones is the same joint in both, and matched
 * joints are what a rotation is fitted from. A joint is counted whether the segment is its parent
 * or its child, because a femur is bounded by the hip above it and the knee below. An id that is
 * not one of our segments has no joints.
 */
export function jointsOnSegment(
  articulation: CompiledArticulation,
  segmentId: string,
): JointOnSegment[] {
  const index = articulation.segments.findIndex((s) => s.id === segmentId);
  if (index < 0) return [];
  const out: JointOnSegment[] = [];
  for (const joint of articulation.joints) {
    const onParent = joint.parentSegment === index;
    if (!onParent && joint.childSegment !== index) continue;
    const other = articulation.segments[onParent ? joint.childSegment : joint.parentSegment];
    if (!other) continue;
    out.push({
      at: restJointCentre(articulation, joint, onParent ? 'parent' : 'child'),
      other: other.id,
    });
  }
  return out;
}

/** A muscle's origin or insertion, placed in the world at rest. */
export interface SiteAtRest {
  /** `<unit>:origin` or `<unit>:insertion`. */
  readonly id: string;
  /** The document's bone the site is stated on, which is what an override of it would name. */
  readonly bone: string;
  /** Our segment that carries that bone. */
  readonly segment: string;
  readonly world: Vec3;
}

/**
 * Every muscle's origin and insertion, in the world at rest.
 *
 * A site is stated on a *bone*, in that bone's own frame, and a segment is several bones: the
 * femur is the anchor of `thigh_r`, but the tibia and the fibula are both on `shank_r`, and the
 * fibula's frame is not the segment's. So a site goes through the muscle set's own resolver --
 * the one the path solver uses -- to its segment and into that segment's frame, then out through
 * the segment's rest pose. Looking the bone up as if it were a segment id, which is what this did
 * when it lived in the studio's entry file, dropped every site on a bone whose name is not also a
 * segment's -- 288 of the 544 in the full set, the femur's and the humerus's among them -- and
 * would have put a follower bone's sites in the wrong frame had it found them.
 */
export function attachmentSites(
  articulation: CompiledArticulation,
  muscles: CompiledMuscleSet | undefined,
): SiteAtRest[] {
  if (!muscles) return [];
  const out: SiteAtRest[] = [];
  for (const path of muscles.paths) {
    for (const [end, site] of [
      ['origin', path.origin],
      ['insertion', path.insertion],
    ] as const) {
      const segment = articulation.segments[muscles.resolver.bodyOf(site.bone)];
      if (!segment) continue;
      out.push({
        id: `${path.id}:${end}`,
        bone: site.bone,
        segment: segment.id,
        world: transformPoint(
          segment.restWorld,
          muscles.resolver.toBodyLocal(site.bone, site.point),
        ),
      });
    }
  }
  return out;
}

/** A via point of one of our muscle paths, placed in the world at rest. */
export interface ViaAtRest {
  /** `<unit>:via<k>`, numbered from 1 along the path, wrapping surfaces not counted. */
  readonly id: string;
  /** The bone the via site is stated on. */
  readonly bone: string;
  /** Our segment that carries that bone. */
  readonly segment: string;
  readonly world: Vec3;
  /** True for a via point that only holds the path over part of a joint's range. */
  readonly conditional: boolean;
}

/**
 * Every via point of every muscle path, in the world at rest.
 *
 * The points a path is held through between its origin and its insertion. They are placed through
 * the muscle set's own resolver, as the ends are in `attachmentSites`, so a via point on a
 * follower bone -- the fibula on the shank -- goes through that bone's frame and not the
 * segment's. A wrapping surface is not a point and is skipped, so the numbering counts only the
 * points: `biceps_brachii_long_r:via8` is the eighth via site of that head, whatever wraps in
 * between.
 */
export function viaPoints(
  articulation: CompiledArticulation,
  muscles: CompiledMuscleSet | undefined,
): ViaAtRest[] {
  if (!muscles) return [];
  const out: ViaAtRest[] = [];
  for (const path of muscles.paths) {
    let k = 0;
    for (const element of path.elements) {
      if (element.kind === 'wrap') continue;
      k += 1;
      const segment = articulation.segments[muscles.resolver.bodyOf(element.site.bone)];
      if (!segment) continue;
      out.push({
        id: `${path.id}:via${k}`,
        bone: element.site.bone,
        segment: segment.id,
        world: transformPoint(
          segment.restWorld,
          muscles.resolver.toBodyLocal(element.site.bone, element.site.point),
        ),
        conditional: element.kind === 'conditionalViaPoint',
      });
    }
  }
  return out;
}

// ---- seating a reference model on our body ------------------------------------------------

/** One place both bodies have: their bodies' positions, and ours from a joint centre or two. */
interface Landmark {
  /** Their bodies whose positions are averaged, by name. A body's position is its joint's. */
  readonly theirs: readonly string[];
  /** Our joints whose centres are averaged, each as (parent segment, test on the child's id). */
  readonly ours: readonly (readonly [string, (child: string) => boolean])[];
}

/** How a reference model is seated: the landmark put on ours, and a length both have. */
interface SeatRule {
  /** What the anchor is, for the note: "its hip centres on ours". */
  readonly anchorLabel: string;
  readonly anchor: Landmark;
  /** What the length is, for the note, and its two ends. */
  readonly lengthLabel: string;
  readonly from: Landmark;
  readonly to: Landmark;
}

const is = (id: string) => (child: string) => child === id;
const HIPS: Landmark = {
  theirs: ['femur_r', 'femur_l'],
  ours: [
    ['pelvis', is('thigh_r')],
    ['pelvis', is('thigh_l')],
  ],
};
const LUMBOSACRAL: Landmark = {
  theirs: ['lumbar5'],
  ours: [['pelvis', (child) => !child.startsWith('thigh')]],
};
const RIGHT_SHOULDER: Landmark = {
  theirs: ['humerus_r'],
  ours: [['scapula_r', is('upperarm_r')]],
};

/**
 * Which landmark of each reference model sits on which of ours, and which length sets its size.
 *
 * Joint centres on both sides, never markers: ours are the fitted centres `restJointCentre` gives,
 * and theirs are their bodies' positions in `sourceSites.json`, which in a MuJoCo model are where
 * the body's joint turns. Ours are found by the segments a joint connects rather than by its id,
 * because the ids change with the profile -- the lumbosacral joint is `l5_s1` at L3 and
 * `lumbar_region_lower` at L0 -- and the segments at either end of it do not.
 *
 * - The legs sit by the middle of the two hip centres, which is the pelvis without either model
 *   having to agree where a pelvis's origin is, and are sized by hip-to-knee on both sides.
 * - The torso roots at the sacrum. Its first joint, L5/S1, sits on our lumbosacral joint, and it
 *   is sized by the four lumbar levels up to L1/L2. Below L3 we have no L1/L2, and it keeps its
 *   own size.
 * - The arm is a right arm. Its humeral head sits on our right shoulder centre, and it is sized by
 *   shoulder-to-elbow.
 */
const SEAT_RULES: Readonly<Record<string, SeatRule>> = {
  legs: {
    anchorLabel: 'its hip centres on ours',
    anchor: HIPS,
    lengthLabel: 'hip-to-knee',
    from: HIPS,
    to: {
      theirs: ['tibia_r', 'tibia_l'],
      ours: [
        ['thigh_r', is('shank_r')],
        ['thigh_l', is('shank_l')],
      ],
    },
  },
  torso: {
    anchorLabel: 'its L5/S1 joint on our lumbosacral joint',
    anchor: LUMBOSACRAL,
    lengthLabel: 'L5/S1 to L1/L2',
    from: LUMBOSACRAL,
    to: { theirs: ['lumbar1'], ours: [['l2', is('l1')]] },
  },
  arm: {
    anchorLabel: 'its humeral head on our right shoulder centre',
    anchor: RIGHT_SHOULDER,
    lengthLabel: 'shoulder-to-elbow',
    from: RIGHT_SHOULDER,
    to: { theirs: ['ulna_r'], ours: [['upperarm_r', () => true]] },
  },
};

/**
 * The shortest length, in metres on either body, a seat is sized by.
 *
 * Shorter than `RELIABLE_SPAN`, which guards a single bone's fit, because the torso's measure --
 * the four lumbar levels, some 13 cm -- is below that and is still the one span both models state
 * joint by joint. A seat is a starting position a person corrects, not a fit anything is measured
 * from, so a ten-centimetre span is worth more than no scale at all.
 */
const SEAT_SPAN = 0.1;

/** Where a reference model starts, and how that was worked out, for the note. */
export interface Seat {
  readonly placement: Placement;
  /** True when it was put on our body; false when it has only its change of axes. */
  readonly seated: boolean;
  /** One sentence saying what was done, or why not. */
  readonly how: string;
}

/** The mean of their named bodies' positions, or undefined when one of them is missing. */
function theirPoint(model: SourceModel, names: readonly string[]): Vector3 | undefined {
  if (names.length === 0) return undefined;
  const sum = new Vector3();
  for (const name of names) {
    const body = model.bodies.find((b) => b.name === name);
    if (!body) return undefined;
    sum.add(new Vector3(body.pos[0] ?? 0, body.pos[1] ?? 0, body.pos[2] ?? 0));
  }
  return sum.divideScalar(names.length);
}

/** The mean of our joint centres, found by the segments they join, or undefined if one is not. */
function ourPoint(
  articulation: CompiledArticulation,
  joints: Landmark['ours'],
): Vector3 | undefined {
  if (joints.length === 0) return undefined;
  const sum = new Vector3();
  for (const [parent, child] of joints) {
    const joint = articulation.joints.find(
      (j) =>
        articulation.segments[j.parentSegment]?.id === parent &&
        child(articulation.segments[j.childSegment]?.id ?? ''),
    );
    if (!joint) return undefined;
    sum.add(restJointCentre(articulation, joint, 'parent'));
  }
  return sum.divideScalar(joints.length);
}

/**
 * Where a reference model starts when it is first picked: stood up in our axes, sized to us and
 * sat on our body.
 *
 * The change of axes is `changeOfAxes`, a fact about each model. The scale is the ratio of one
 * length both bodies state, when it is long enough to measure on both, and 1 otherwise, which is
 * where the scale slider starts. The translation then puts their anchor exactly on ours: a point
 * of theirs lands at `t + R(s p)`, so `t = ours - R(s theirs)`.
 *
 * Without a body there is nothing to sit on, and the model keeps its change of axes alone, at our
 * origin; so does a model this table does not know, or one whose anchor is missing on either
 * side. Neither is guessed at: the sentence returned says which happened.
 */
export function seatReferenceModel(
  name: string,
  model: SourceModel | undefined,
  articulation: CompiledArticulation | undefined,
): Seat {
  const axes = changeOfAxes(name);
  const rule = SEAT_RULES[name];
  const unseated = (why: string): Seat => ({
    placement: axes,
    seated: false,
    how: `Stood up in our axes at our origin; ${why}`,
  });
  if (!rule || !model) return unseated('there is no rule for seating this model on ours.');
  if (!articulation) {
    return unseated(
      'it is seated on our body once a run has started: press ▶ Start sim in the top bar.',
    );
  }
  const theirAnchor = theirPoint(model, rule.anchor.theirs);
  const ourAnchor = ourPoint(articulation, rule.anchor.ours);
  if (!theirAnchor || !ourAnchor) {
    return unseated(`this body has nothing to seat ${rule.anchorLabel} by.`);
  }
  const theirFrom = theirPoint(model, rule.from.theirs);
  const theirTo = theirPoint(model, rule.to.theirs);
  const ourFrom = ourPoint(articulation, rule.from.ours);
  const ourTo = ourPoint(articulation, rule.to.ours);
  const theirLength = theirFrom && theirTo ? theirFrom.distanceTo(theirTo) : 0;
  const ourLength = ourFrom && ourTo ? ourFrom.distanceTo(ourTo) : 0;
  const measured = theirLength >= SEAT_SPAN && ourLength >= SEAT_SPAN;
  const scale = measured ? ourLength / theirLength : 1;
  const rotation = fittedFromPlacement(axes).rotation;
  const at = ourAnchor.sub(theirAnchor.multiplyScalar(scale).applyQuaternion(rotation));
  const mm = (metres: number): string => `${Math.round(1000 * metres)} mm`;
  return {
    placement: { ...axes, x: at.x, y: at.y, z: at.z, scale },
    seated: true,
    how:
      `Seated automatically: ${rule.anchorLabel}, ` +
      (measured
        ? `scaled ${Number(scale.toFixed(2))}x by ${rule.lengthLabel} ` +
          `(${mm(theirLength)} theirs, ${mm(ourLength)} ours).`
        : `at its own size, since ${rule.lengthLabel} cannot be measured on this body.`),
  };
}
