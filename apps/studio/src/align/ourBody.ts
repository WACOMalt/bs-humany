/**
 * Our body at rest, as the Align tab measures it: where the joints are, and where the muscles
 * attach.
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
