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
 * has a length in each model, and the ratio is that body's scale, provided the length is long
 * enough to be compared over (`RELIABLE_SPAN`). A body with fewer, or shorter, takes the scale of
 * the nearest fitted body above it, and failing that the model's overall scale: the ratio of the
 * spread of every matched joint in our body to the spread of the same joints in theirs, measured
 * when that spread is long enough and otherwise the placement's own. That is stated rather than
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
import { Euler, Quaternion, Vector3 } from 'three';
import { type FitKind, type Fitted, RELIABLE_SPAN, fitOne } from './fit.js';
import type { JointOnSegment } from './ourBody.js';
import type { Placement, SourceBody, SourceModel } from './sourceOverlay.js';

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

/** Everything `fitBodies` works out: each paired body's fit, and the scale of the whole model. */
export interface BodyFits {
  readonly fits: Map<string, BodyFit>;
  /**
   * How much bigger our body is than theirs over every matched joint at once, or the
   * placement's own scale when that spread is too short to measure one.
   */
  readonly overallScale: number;
  /** Whether `overallScale` was measured, rather than taken from the placement. */
  readonly overallMeasured: boolean;
}

const vec = (a: readonly number[]) => new Vector3(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);

/**
 * Suggest body pairings by name, which for the legs is nearly complete already: their `femur_r`
 * is our `thigh_r`, their `calcn_r` is our `calcaneus_r`. Suggestions are a starting point for
 * the eye, never a decision -- a wrong pair is worse than an absent one, so only unambiguous
 * matches are offered. Their torso's `torso`, `Abdomen`, `chest_r`, `Arm_attachment`,
 * `head_attach`, `neck` and `cervical_spine` are left for a person on purpose: each is a lump of
 * several of our segments, or a body their model draws nothing for, and none is one of ours
 * under another name.
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
   * Their tibia body wears the fibula's mesh too, as our shank carries both bones, so the one
   * name covers the pair. Their `sacrum` is the root of their torso and the bone our pelvis is
   * anchored on. Where both models split a bone the same way -- the ulna and the radius are a
   * segment each in ours as well -- the names already agree and need nothing here.
   */
  const SYNONYM: Readonly<Record<string, string>> = {
    femur: 'thigh',
    tibia: 'shank',
    calcn: 'calcaneus',
    humerus: 'upperarm',
    sacrum: 'pelvis',
  };
  const normalise = (s: string) => {
    const lower = s.toLowerCase();
    const side = /_(l|r)$/.exec(lower)?.[1] ?? '';
    // Their lumbar vertebrae are `lumbar5` to `lumbar1` and ours `l5` to `l1`.
    const stem = lower.replace(/_(l|r)$/, '').replace(/^lumbar(\d)$/, 'l$1');
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
 * The model's placement as a fit: the transform the overlay puts their whole model through.
 *
 * It is what a bone with nothing fitted above it starts from. Its rotation is what stands their
 * model up in our axes, so a two-joint bone at the top of the chain -- a pelvis between two hips
 * -- takes its roll from it rather than from the identity, which left their Z-up pelvis pitched a
 * quarter turn over. It has to mean exactly what `SourceOverlay.place` means, since it stands in
 * for it: a point is scaled, turned by the Euler angles in degrees in XYZ order, and moved.
 */
export function fittedFromPlacement(p: Placement): Fitted {
  const deg = Math.PI / 180;
  return {
    rotation: new Quaternion().setFromEuler(new Euler(p.rx * deg, p.ry * deg, p.rz * deg, 'XYZ')),
    position: new Vector3(p.x, p.y, p.z),
    scale: p.scale,
    kind: 'model',
    matched: 0,
    residual: null,
  };
}

/** Points closer than this are one point, whichever joints they came from. */
const SAME_POINT = 1e-4;

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
 * roll, or its whole orientation, from the nearest fitted bone above it. A bone with none above
 * it inherits from `root`, the model's own placement (see `fittedFromPlacement`), at the model's
 * overall scale.
 */
export function fitBodies(
  model: SourceModel,
  pairs: readonly BodyPair[],
  articulation: CompiledArticulation,
  ourJointsOn: (segment: string) => readonly JointOnSegment[],
  root: Fitted,
): BodyFits {
  const theirBody = new Map(model.bodies.map((b) => [b.name, b]));
  const ourFor = new Map(pairs.map((p) => [p.theirs, p.ours]));
  const segments = new Set(articulation.segments.map((s) => s.id));
  const children = new Map<string, SourceBody[]>();
  for (const body of model.bodies) {
    if (!body.parent) continue;
    children.set(body.parent, [...(children.get(body.parent) ?? []), body]);
  }

  /**
   * Their joints touching a body, each with the body on the other side of it and which way that
   * is.
   *
   * A joint belongs to its child, so a body's own joints lead up to its parent and its children's
   * joints lead down to those children. Several degrees of freedom may share one anchor -- three
   * at a hip -- and collapse to the one place they describe.
   */
  const touching = new Map<string, { at: Vector3; other: string; up: boolean }[]>();
  const add = (body: string, at: Vector3, other: string, up: boolean): void => {
    const list = touching.get(body) ?? [];
    if (list.some((p) => p.other === other && p.at.distanceTo(at) < SAME_POINT)) return;
    list.push({ at, other, up });
    touching.set(body, list);
  };
  for (const joint of model.joints) {
    const body = joint.body;
    if (!body) continue;
    const parent = theirBody.get(body)?.parent;
    if (!parent) continue;
    const at = vec(joint.anchor);
    add(body, at, parent, true);
    add(parent, at, body, false);
  }

  /**
   * The paired body a joint really leads to, through any phantoms in the way.
   *
   * Their arm hangs the scapula off the clavicle through `clavphant_r`, and the humerus off the
   * scapula through three more: bodies that exist to carry extra degrees of freedom and wear no
   * mesh. Nobody pairs those, so matching a joint's other side by name alone found nothing on
   * either side of them, and the clavicle, the scapula and the humerus all fell back to the
   * placement -- which put the shoulder at our feet. So an unpaired body with no mesh is passed
   * through, upward for a joint that leads to a parent and downward for one that leads to a
   * child, to the first paired body. A body that wears a mesh is a bone and is never passed
   * through, and a phantom that leads down to more than one paired body cannot say which it
   * means, so it matches nothing.
   */
  const resolve = (name: string, up: boolean): string | undefined => {
    if (ourFor.has(name)) return name;
    const body = theirBody.get(name);
    if (!body || body.meshes.length > 0) return undefined;
    if (up) return body.parent ? resolve(body.parent, true) : undefined;
    const found = new Set<string>();
    for (const child of children.get(name) ?? []) {
      const reached = resolve(child.name, false);
      if (reached) found.add(reached);
    }
    return found.size === 1 ? [...found][0] : undefined;
  };

  /** Their joints on one body matched to ours, as corresponding points in the two worlds. */
  const matched = (name: string): { theirs: Vector3[]; ours: Vector3[] } => {
    const theirs: Vector3[] = [];
    const ours: Vector3[] = [];
    const ourSegment = ourFor.get(name);
    if (!ourSegment || !segments.has(ourSegment)) return { theirs, ours };
    const ourTouching = ourJointsOn(ourSegment);
    const seen: { other: string; at: Vector3 }[] = [];
    for (const joint of touching.get(name) ?? []) {
      const other = resolve(joint.other, joint.up);
      if (!other) continue;
      // The same place reached twice -- a hip's three degrees of freedom, or a phantom's joint
      // and the bone's sitting on one anchor -- is one correspondence, not several.
      if (seen.some((s) => s.other === other && s.at.distanceTo(joint.at) < SAME_POINT)) continue;
      seen.push({ other, at: joint.at });
      const otherOurs = ourFor.get(other);
      const match = ourTouching.find((p) => p.other === otherOurs);
      if (!match) continue;
      theirs.push(joint.at);
      ours.push(match.at);
    }
    return { theirs, ours };
  };

  // Parents first, so an inherited roll has something to inherit from.
  const order: string[] = [];
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const parent = theirBody.get(name)?.parent;
    if (parent) visit(parent);
    order.push(name);
  };
  for (const pair of pairs) visit(pair.theirs);

  const evidence = new Map(order.map((name) => [name, matched(name)]));

  /**
   * The whole model's scale, from every matched joint at once.
   *
   * One bone's two joints can be too close together to size it by, but the joints of all the
   * paired bones together span a leg or an arm, and the ratio of that spread in ours to the same
   * joints' spread in theirs is the model's size against ours. A joint matched from both bones
   * either side of it is one joint, so repeats are dropped before the spread is taken. It is held
   * to the same span as a single bone; a model with too little paired to span that keeps the
   * scale its placement gave it, which is 1 unless a person set another.
   */
  const pooledTheirs: Vector3[] = [];
  const pooledOurs: Vector3[] = [];
  for (const { theirs, ours } of evidence.values()) {
    for (let i = 0; i < theirs.length; i++) {
      const t = theirs[i] as Vector3;
      const o = ours[i] as Vector3;
      const repeat = pooledTheirs.some(
        (p, j) =>
          p.distanceTo(t) < SAME_POINT && (pooledOurs[j] as Vector3).distanceTo(o) < SAME_POINT,
      );
      if (repeat) continue;
      pooledTheirs.push(t);
      pooledOurs.push(o);
    }
  }
  const rms = (points: readonly Vector3[]): number => {
    if (points.length === 0) return 0;
    const mid = points.reduce((sum, p) => sum.add(p), new Vector3()).divideScalar(points.length);
    return Math.sqrt(points.reduce((sum, p) => sum + p.distanceToSquared(mid), 0) / points.length);
  };
  const theirSpread = rms(pooledTheirs);
  const ourSpread = rms(pooledOurs);
  const overallMeasured = theirSpread > RELIABLE_SPAN && ourSpread > RELIABLE_SPAN;
  const overallScale = overallMeasured ? ourSpread / theirSpread : root.scale;
  const seed: Fitted = { ...root, scale: overallScale };

  const fits = new Map<string, BodyFit>();
  const fitted = new Map<string, Fitted>();
  for (const name of order) {
    const ours = ourFor.get(name);
    if (!ours || !segments.has(ours)) continue;
    const { theirs: theirPoints, ours: ourPoints } = evidence.get(name) ?? matched(name);
    // The nearest fitted body above, not merely the parent: a paired bone may hang off phantoms
    // and unpaired bones, and what it should inherit is the last thing above it that was placed.
    let above = theirBody.get(name)?.parent ?? null;
    while (above && !fitted.has(above)) above = theirBody.get(above)?.parent ?? null;
    const fit = fitOne(
      theirPoints,
      ourPoints,
      (above ? fitted.get(above) : undefined) ?? seed,
      overallScale,
    );
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
  return { fits, overallScale, overallMeasured };
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
  fits: ReadonlyMap<string, BodyFit>,
): number[] | undefined {
  const out: number[] = [];
  const point = new Vector3();
  for (let i = 0; i < on.length; i++) {
    const fit = fits.get(on[i] as string);
    if (!fit) return undefined;
    // A fit carries a point of their world straight to ours -- it was built from world points on
    // both sides -- so the path point, which is already in their world, goes through it as it
    // stands. Taking it into its body's frame first and then applying a world map to the result,
    // which is what this did, is two different coordinate systems in one expression.
    point
      .set(path[3 * i] as number, path[3 * i + 1] as number, path[3 * i + 2] as number)
      .multiplyScalar(fit.scale)
      .applyQuaternion(fit.rotation)
      .add(fit.position);
    out.push(point.x, point.y, point.z);
  }
  return out.length >= 6 ? out : undefined;
}
