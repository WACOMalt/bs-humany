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
  /** How the scale was arrived at, so a reader knows what it rests on. */
  readonly scaleFrom: 'two joints' | 'inherited' | 'model' | 'none';
  /** Millimetres between their joint spacing and ours, where both were measurable. */
  readonly lengthTheirs: number | null;
  readonly lengthOurs: number | null;
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

/** The distance between the two joints furthest apart on a body, which is its length. */
function spanOf(points: readonly Vector3[]): number {
  let longest = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      longest = Math.max(longest, (points[i] as Vector3).distanceTo(points[j] as Vector3));
    }
  }
  return longest;
}

/**
 * Work out where each paired body of theirs sits on ours, and how much to scale it.
 *
 * `ourJointsOn` gives the world positions of our joints that touch a segment, which is how our
 * side of the length ratio is measured. A body nothing can be measured on keeps scale 1 and says
 * so, rather than borrowing a number that would look like evidence.
 */
export function fitBodies(
  model: SourceModel,
  pairs: readonly BodyPair[],
  articulation: CompiledArticulation,
  ourJointsOn: (segment: string) => readonly Vector3[],
): Map<string, BodyFit> {
  const theirBody = new Map(model.bodies.map((b) => [b.name, b]));
  const ourSegment = new Map(articulation.segments.map((s) => [s.id, s]));
  // Their joints, gathered by the body they are on. Several of theirs may sit at one anatomical
  // joint -- three `L4_L5_*` degrees of freedom share an anchor -- so near-duplicates collapse.
  //
  // A joint in MuJoCo belongs to its child body, so a bone's own joints all sit at its proximal
  // end: the three hip degrees of freedom share one anchor on the femur, and a span taken from
  // those alone is zero. A bone's length is that anchor to the joints of the bodies hanging off
  // it -- hip to knee for a femur -- so each body is given its own anchors and its children's.
  const own = new Map<string, Vector3[]>();
  for (const joint of model.joints) {
    if (!joint.body) continue;
    const list = own.get(joint.body) ?? [];
    const at = vec(joint.anchor);
    if (!list.some((p) => p.distanceTo(at) < 1e-4)) list.push(at);
    own.set(joint.body, list);
  }
  const theirJoints = new Map<string, Vector3[]>();
  for (const body of model.bodies) {
    const list = [...(own.get(body.name) ?? [])];
    for (const child of model.bodies) {
      if (child.parent !== body.name) continue;
      for (const at of own.get(child.name) ?? []) {
        if (!list.some((p) => p.distanceTo(at) < 1e-4)) list.push(at);
      }
    }
    theirJoints.set(body.name, list);
  }

  const fits = new Map<string, BodyFit>();
  const scales: number[] = [];
  for (const pair of pairs) {
    const them = theirBody.get(pair.theirs);
    const us = ourSegment.get(pair.ours);
    if (!them || !us) continue;
    const lengthTheirs = spanOf(theirJoints.get(pair.theirs) ?? []);
    const lengthOurs = spanOf(ourJointsOn(pair.ours));
    const measurable = lengthTheirs > 1e-3 && lengthOurs > 1e-3;
    const scale = measurable ? lengthOurs / lengthTheirs : 1;
    if (measurable) scales.push(scale);
    fits.set(pair.theirs, {
      theirs: pair.theirs,
      ours: pair.ours,
      position: new Vector3(
        us.restWorld.translation.x,
        us.restWorld.translation.y,
        us.restWorld.translation.z,
      ),
      rotation: new Quaternion(
        us.restWorld.rotation.x,
        us.restWorld.rotation.y,
        us.restWorld.rotation.z,
        us.restWorld.rotation.w,
      ),
      scale,
      scaleFrom: measurable ? 'two joints' : 'none',
      lengthTheirs: measurable ? Number((1000 * lengthTheirs).toFixed(1)) : null,
      lengthOurs: measurable ? Number((1000 * lengthOurs).toFixed(1)) : null,
    });
  }

  // A body with no length of its own takes the model's median rather than 1, which would draw it
  // at the source's size beside bones that are not.
  if (scales.length > 0) {
    const sorted = [...scales].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] as number;
    for (const [name, fit] of fits) {
      if (fit.scaleFrom === 'none') {
        fits.set(name, { ...fit, scale: median, scaleFrom: 'model' });
      }
    }
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
