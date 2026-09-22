/**
 * Per-body retargeting: their muscle paths, moved onto our bones.
 *
 * One rigid transform over a whole model cannot put their shoulder and their hip on ours at the
 * same time, because the proportions differ -- and that difference is the very thing being
 * measured. So the registration is per body: each of their bodies is paired with one of our
 * segments, and every point of a muscle path is carried by the body it sits on.
 *
 * ## What a pairing determines
 *
 * A body pair gives an orientation and an origin straight away: their body has a world pose in
 * their model and our segment has one at rest, so a point expressed in their body's frame can be
 * re-expressed in ours. What it does not give is *scale*, and scale is most of the disagreement:
 * a femur that is longer here than there moves every attachment along it.
 *
 * Scale comes from the joints. A body with two joints on it -- the hip and the knee on a femur --
 * has a length in each model, and the ratio is that body's scale. A body with fewer takes the
 * scale of its parent, and failing that the model's overall one. That is stated rather than
 * fitted because it is the honest amount of information two points carry.
 *
 * ## What this is not
 *
 * It is not a way to move our attachments onto theirs. Ours are measured from the Z-Anatomy
 * meshes and stay ours (ADR-011). Retargeting their paths onto our bones is what makes the two
 * comparable *on screen*, so a person can see which muscle is which and how far apart the two
 * models really are. The numbers it produces are a measurement, never a replacement.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import { Quaternion, Vector3 } from 'three';
import { type FitKind, type Fitted, fitOne } from './fit.js';
import type { SourceBody, SourceModel } from './sourceOverlay.js';

export interface BodyPair {
  /** Their body, by the name their model gives it. */
  readonly theirs: string;
  /** Our segment id. */
  readonly ours: string;
}

/** What a paired body resolves to: a frame in our world, and how much bigger ours is. */
export interface BodyFit {
  readonly theirs: string;
  readonly ours: string;
  readonly position: Vector3;
  readonly rotation: Quaternion;
  readonly scale: number;
  /** What the fit rested on, because a fit from two points is not the claim a fit from five is. */
  readonly kind: FitKind;
  /** How many joints both models had in the same place. */
  readonly matched: number;
  /** What is left over after the best fit, in millimetres; null when nothing was fitted. */
  readonly residual: number | null;
}

const vec = (a: readonly number[]) => new Vector3(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
/** MuJoCo writes quaternions w-first; three wants them w-last. */
const quat = (a: readonly number[]) => new Quaternion(a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[0] ?? 1);

/**
 * Suggest body pairings by name, which for the legs is nearly complete already: their `femur_r`
 * is our `femur_r`, their `calcn_r` is our `calcaneus_r`. Suggestions are a starting point for
 * the eye, never a decision -- a wrong pair is worse than an absent one, so only unambiguous
 * matches are offered.
 */
export function suggestBodyPairs(
  model: SourceModel,
  segments: readonly string[],
): readonly BodyPair[] {
  const ours = new Set(segments);
  /**
   * The same bone under two names.
   *
   * Their models are converted from OpenSim and keep its bone names; ours are named for the
   * region a person points at, so their `femur` is our `thigh` and their `tibia` our `shank`.
   * Ours is one segment where theirs may be two -- we carry no separate fibula -- which is why
   * this maps toward ours rather than the other way.
   */
  const SYNONYM: Readonly<Record<string, string>> = {
    femur: 'thigh',
    tibia: 'shank',
    fibula: 'shank',
    calcn: 'calcaneus',
    humerus: 'upperarm',
    radius: 'forearm',
    ulna: 'forearm',
  };
  const normalise = (s: string) => {
    const lower = s.toLowerCase();
    const side = /_(l|r)$/.exec(lower)?.[1] ?? '';
    const stem = lower.replace(/_(l|r)$/, '');
    return `${SYNONYM[stem] ?? stem}${side}`.replace(/_/g, '');
  };
  const byNormal = new Map<string, string[]>();
  for (const seg of segments) {
    const key = normalise(seg);
    byNormal.set(key, [...(byNormal.get(key) ?? []), seg]);
  }
  const out: BodyPair[] = [];
  for (const body of model.bodies) {
    if (ours.has(body.name)) {
      out.push({ theirs: body.name, ours: body.name });
      continue;
    }
    const candidates = byNormal.get(normalise(body.name));
    // Exactly one match, or none: an ambiguous name is left for a person.
    if (candidates?.length === 1) out.push({ theirs: body.name, ours: candidates[0] as string });
  }
  return out;
}

/**
 * Work out where each paired bone of theirs sits on ours.
 *
 * The joints do the work. A joint is a place both models agree about -- a hip is a hip -- and a
 * joint on body B joins B to B's parent, so once two bones are paired the joints around them can
 * be matched by asking which paired bone is on the other side of each. That gives corresponding
 * points in both worlds, and corresponding points give a rotation, a scale and a position.
 *
 * Taking our segment's own rest orientation instead, which is what this did at first, is wrong
 * in a way that looks almost right: the two models disagree about which way a bone's frame
 * points, so bones land a quarter turn off the ones they are paired with.
 *
 * Bones are fitted parents first, because a bone with too few joints of its own inherits its
 * roll, or its whole orientation, from the one above it.
 */
export function fitBodies(
  model: SourceModel,
  pairs: readonly BodyPair[],
  articulation: CompiledArticulation,
  ourJointsOn: (segment: string) => readonly { at: Vector3; other: string; axes: Vector3[] }[],
): Map<string, BodyFit> {
  const theirBody = new Map(model.bodies.map((b) => [b.name, b]));
  const ourFor = new Map(pairs.map((p) => [p.theirs, p.ours]));
  const segments = new Set(articulation.segments.map((s) => s.id));

  /**
   * Their joints touching a body, each with the body on the other side of it.
   *
   * A joint belongs to its child, so a body's own joints lead to its parent and its children's
   * joints lead to those children. Several degrees of freedom may share one anchor -- three at a
   * hip -- and collapse to the one place they describe.
   */
  const touching = new Map<string, { at: Vector3; other: string; axes: Vector3[] }[]>();
  const add = (body: string, at: Vector3, other: string, axis: Vector3): void => {
    const list = touching.get(body) ?? [];
    const already = list.find((p) => p.other === other && p.at.distanceTo(at) < 1e-4);
    // Several degrees of freedom may share one anchor -- three at a hip -- and describe one
    // place with several axes, so they collapse to one point carrying all of them.
    if (already) {
      if (axis.lengthSq() > 1e-9 && !already.axes.some((a) => Math.abs(a.dot(axis)) > 0.999)) {
        already.axes.push(axis);
      }
      return;
    }
    list.push({ at, other, axes: axis.lengthSq() > 1e-9 ? [axis] : [] });
    touching.set(body, list);
  };
  for (const joint of model.joints) {
    const body = joint.body;
    if (!body) continue;
    const parent = theirBody.get(body)?.parent;
    if (!parent) continue;
    const at = vec(joint.anchor);
    const axis = vec(joint.axis).normalize();
    add(body, at, parent, axis);
    add(parent, at, body, axis);
  }

  // Parents first, so an inherited roll has something to inherit from.
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const parent = theirBody.get(name)?.parent;
    if (parent) visit(parent);
    order.push(name);
  };
  for (const pair of pairs) visit(pair.theirs);

  const fits = new Map<string, BodyFit>();
  const fitted = new Map<string, Fitted>();
  for (const name of order) {
    const ours = ourFor.get(name);
    if (!ours || !segments.has(ours)) continue;
    // Match each of their joints to one of ours by the paired bone on the other side of it.
    const ourTouching = ourJointsOn(ours);
    const theirPoints: Vector3[] = [];
    const ourPoints: Vector3[] = [];
    for (const theirs of touching.get(name) ?? []) {
      const otherOurs = ourFor.get(theirs.other);
      if (!otherOurs) continue;
      const match = ourTouching.find((p) => p.other === otherOurs);
      if (!match) continue;
      theirPoints.push(theirs.at);
      ourPoints.push(match.at);
    }
    const parentName = theirBody.get(name)?.parent ?? undefined;
    const fit = fitOne(theirPoints, ourPoints, parentName ? fitted.get(parentName) : undefined, 1);
    fitted.set(name, fit);
    fits.set(name, {
      theirs: name,
      ours,
      position: fit.position,
      rotation: fit.rotation,
      scale: fit.scale,
      kind: fit.kind,
      matched: fit.matched,
      residual: fit.residual,
    });
  }
  return fits;
}

/**
 * A muscle path of theirs, expressed on our bones.
 *
 * Each point is taken into the frame of the body that carries it, scaled, and put back out
 * through our segment's frame. A point whose body is not paired is dropped rather than left
 * where it was: half a path drawn on our bones and half on theirs is a picture of nothing.
 */
export function retargetPath(
  path: readonly number[],
  on: readonly string[],
  theirBodies: readonly SourceBody[],
  fits: ReadonlyMap<string, BodyFit>,
): number[] | undefined {
  const pose = new Map(theirBodies.map((b) => [b.name, b]));
  const out: number[] = [];
  const point = new Vector3();
  const inverse = new Quaternion();
  for (let i = 0; i < on.length; i++) {
    const body = on[i] as string;
    const fit = fits.get(body);
    const them = pose.get(body);
    if (!fit || !them) return undefined;
    point.set(path[3 * i] as number, path[3 * i + 1] as number, path[3 * i + 2] as number);
    // Into their body's frame.
    point.sub(vec(them.pos));
    inverse.copy(quat(them.quat)).invert();
    point.applyQuaternion(inverse);
    // Sized to our bone, then out through our segment's frame.
    point.multiplyScalar(fit.scale);
    point.applyQuaternion(fit.rotation);
    point.add(fit.position);
    out.push(point.x, point.y, point.z);
  }
  return out.length >= 6 ? out : undefined;
}
