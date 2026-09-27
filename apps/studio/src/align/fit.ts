/**
 * Working out how one body of theirs sits on one segment of ours.
 *
 * The naive answer -- take our segment's rest orientation and use it -- is wrong, and wrong in a
 * way that looks almost right: the two models do not agree about which way a bone's own frame
 * points, so bones land a quarter turn out from the ones they are paired with. Their models are
 * converted from OpenSim and carry its conventions; ours are ours.
 *
 * The orientation has to be *derived*, and the thing to derive it from is the joints. A joint is
 * a place both models agree about -- the hip is the hip -- so once two bones are paired, the
 * joints around them can be matched by which paired bone is on the other side, and the rotation
 * that carries one set of points onto the other is the answer.
 *
 * How much that determines depends on how many joints a bone has:
 *
 * - **three or more**, not all on one line, and the fit is complete: a rotation, a scale and a
 *   translation, by Horn's method. A pelvis in a model that carries both hips and the
 *   lumbosacral joint is fully determined.
 * - **two** gives the bone's long axis and its length but leaves the roll about that axis free.
 *   The roll is kept from the bone above, which is right whenever a bone is not twisted against
 *   the one above it; at the top of the chain, where there is no bone above, it is taken from the
 *   model's placement, which is what stands the model up in our axes in the first place. The
 *   joint *axes* looked like the better evidence and were tried: a knee hinges about the same
 *   anatomical line in both models. But their joints carry slides and coupled degrees of freedom
 *   beside the hinges, and matching those as axes measured worse -- the knee 25 degrees off and
 *   the pelvis upside down -- so they are not used.
 * - **one** gives a position and nothing else; the parent's rotation and scale are inherited
 *   whole.
 * - **none** leaves the bone where the bone above it puts it: the parent's placement entire, or
 *   the model's own placement for a bone with nothing fitted above it.
 *
 * Every fit says which of those happened, because a fit from two points and a fit from five are
 * not the same claim and a person choosing whether to trust one should be told which they have.
 */

import { Quaternion, Vector3 } from 'three';

export type FitKind =
  | 'kabsch'
  | 'axis and inherited roll'
  | 'axis and inherited scale'
  | 'inherited'
  | 'model';

/**
 * What each kind of fit rested on, in the words the fit note uses.
 *
 * A record over the whole union rather than a switch, so a kind added to `FitKind` without words
 * of its own fails the typecheck instead of printing nothing. `kabsch` is still called that for
 * the family of fits it names -- the rotation that best carries one cloud of points onto another
 * -- whichever algorithm finds it.
 */
export const FIT_KIND_NOTE: Readonly<Record<FitKind, string>> = {
  kabsch: 'from three joints or more',
  'axis and inherited roll': 'from two joints, roll from the bone above',
  'axis and inherited scale': 'from two joints, too short to size, size from the bone above',
  inherited: 'placed at one joint, turned and sized as the bone above',
  model: 'with no matched joint',
};

export interface Fitted {
  readonly rotation: Quaternion;
  readonly position: Vector3;
  readonly scale: number;
  readonly kind: FitKind;
  /** How many joints both models had in the same place. */
  readonly matched: number;
  /** Root-mean-square of what is left over, in millimetres; null when nothing was fitted. */
  readonly residual: number | null;
}

/**
 * The rotation that best carries one centred cloud onto another, by Horn's quaternion method.
 *
 * Horn (1987), "Closed-form solution of absolute orientation using unit quaternions", J. Opt.
 * Soc. Am. A 4(4):629-642: the best rotation is the unit quaternion along the eigenvector of the
 * largest eigenvalue of a symmetric 4x4 matrix built from the cross-covariance `S`, where
 * `S[j][k]` sums their coordinate j against our coordinate k.
 *
 * This replaced the polar decomposition of `S`, which inverts it on every step and so needs it to
 * have full rank. Three points are always in one plane and so are four that happen to be; their
 * `S` has rank two, the inverse does not exist, and three joints -- the commonest case there is
 * after two -- came out 170 mm wrong or not at all. Horn's matrix has a single largest eigenvalue
 * whenever the points are not on one line, planar or not, and its eigenvector is a rotation by
 * construction, never a reflection.
 */
function hornRotation(s: readonly (readonly number[])[]): Quaternion {
  const at = (j: number, k: number): number => (s[j] as readonly number[])[k] as number;
  const [xx, xy, xz] = [at(0, 0), at(0, 1), at(0, 2)];
  const [yx, yy, yz] = [at(1, 0), at(1, 1), at(1, 2)];
  const [zx, zy, zz] = [at(2, 0), at(2, 1), at(2, 2)];
  const n = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const { values, vectors } = symmetricEigen(n);
  let best = 0;
  for (let i = 1; i < 4; i++) if ((values[i] as number) > (values[best] as number)) best = i;
  const column = (row: number): number => (vectors[row] as number[])[best] as number;
  // Horn's quaternion is w first; three's is w last.
  return new Quaternion(column(1), column(2), column(3), column(0)).normalize();
}

/**
 * Eigenvalues and eigenvectors of a small symmetric matrix, by cyclic Jacobi rotations.
 *
 * Jacobi is the method for this size: each rotation zeroes one off-diagonal entry, a sweep
 * visits them all, and the off-diagonal mass falls quadratically once it is small, so a 4x4
 * settles in a handful of sweeps to the last bit. It needs nothing but arithmetic, where a
 * general eigensolver is a great deal of code to carry for one use. The eigenvectors come back
 * as the columns of `vectors`.
 */
function symmetricEigen(input: readonly (readonly number[])[]): {
  values: number[];
  vectors: number[][];
} {
  const size = input.length;
  const a = input.map((row) => [...row]);
  const v = a.map((_, i) => a.map((__, j) => (i === j ? 1 : 0)));
  const get = (m: number[][], i: number, j: number): number => (m[i] as number[])[j] as number;
  const put = (m: number[][], i: number, j: number, x: number): void => {
    (m[i] as number[])[j] = x;
  };
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < size; p++) for (let q = p + 1; q < size; q++) off += get(a, p, q) ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < size; p++) {
      for (let q = p + 1; q < size; q++) {
        const apq = get(a, p, q);
        if (Math.abs(apq) < 1e-300) continue;
        // The angle that zeroes a[p][q], taken as its tangent the numerically stable way.
        const theta = (get(a, q, q) - get(a, p, p)) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const sn = t * c;
        for (let k = 0; k < size; k++) {
          const akp = get(a, k, p);
          const akq = get(a, k, q);
          put(a, k, p, c * akp - sn * akq);
          put(a, k, q, sn * akp + c * akq);
        }
        for (let k = 0; k < size; k++) {
          const apk = get(a, p, k);
          const aqk = get(a, q, k);
          put(a, p, k, c * apk - sn * aqk);
          put(a, q, k, sn * apk + c * aqk);
        }
        for (let k = 0; k < size; k++) {
          const vkp = get(v, k, p);
          const vkq = get(v, k, q);
          put(v, k, p, c * vkp - sn * vkq);
          put(v, k, q, sn * vkp + c * vkq);
        }
      }
    }
  }
  return { values: a.map((_, i) => get(a, i, i)), vectors: v };
}

/**
 * How long a bone has to be before the ratio of its length to theirs means anything.
 *
 * A scale is a ratio of two lengths and is only as good as the shorter one. The two models place
 * a joint centre a few millimetres apart as a matter of course, so over a femur's four hundred
 * that is a per cent and over a talus's twenty it is most of the answer. The talus is the case
 * that showed it: their subtalar joint sits 65 mm from the ankle and ours sits about 18, so the
 * ratio comes out at 0.28 and the whole foot is drawn at a quarter size. The arithmetic is
 * right; the question was bad.
 *
 * A bone shorter than this keeps its place -- which the matched joints give exactly -- and takes
 * its size from the bone above, which is a guess but an honest one. The whole model's scale is
 * held to the same line (see `fitBodies`).
 */
export const RELIABLE_SPAN = 0.15;

const centroid = (points: readonly Vector3[]): Vector3 =>
  points
    .reduce((sum, p) => sum.add(p), new Vector3())
    .multiplyScalar(points.length ? 1 / points.length : 0);

/**
 * Fit one bone from matched points, falling back as far as the evidence runs out.
 *
 * `parent` is the fit already worked out for the bone above, which is where a roll or a whole
 * orientation is inherited from when this bone's own joints cannot say. `fallbackScale` stands in
 * for the parent's scale when there is no parent at all.
 */
export function fitOne(
  theirs: readonly Vector3[],
  ours: readonly Vector3[],
  parent: Fitted | undefined,
  fallbackScale: number,
): Fitted {
  const n = Math.min(theirs.length, ours.length);
  const inheritedRotation = parent?.rotation.clone() ?? new Quaternion();
  const inheritedScale = parent?.scale ?? fallbackScale;

  if (n === 0) {
    // The parent's placement entire, not the world origin. A bone with nothing matched still
    // hangs off the one above it, and putting it at the origin flings it -- and every muscle
    // that runs over it -- out of the body altogether. That is what the strays under the feet
    // were: the toes, whose joint our foot does not carry under the name theirs expects.
    return {
      rotation: inheritedRotation,
      position: parent?.position.clone() ?? new Vector3(),
      scale: inheritedScale,
      kind: 'model',
      matched: 0,
      residual: null,
    };
  }

  const theirMid = centroid(theirs.slice(0, n));
  const ourMid = centroid(ours.slice(0, n));
  /** Put at the matched point with the parent's turn and size, when nothing better is known. */
  const placedAtMid = (matched: number): Fitted => ({
    rotation: inheritedRotation,
    position: ourMid
      .clone()
      .sub(theirMid.clone().multiplyScalar(inheritedScale).applyQuaternion(inheritedRotation)),
    scale: inheritedScale,
    kind: 'inherited',
    matched,
    residual: null,
  });

  if (n === 1) return placedAtMid(1);

  if (n === 2) {
    // Two points give the bone's axis and its length. The roll about that axis is not in the
    // evidence, so the parent's is kept: a bone is usually not twisted against the one above it.
    const theirAxis = (theirs[1] as Vector3).clone().sub(theirs[0] as Vector3);
    const ourAxis = (ours[1] as Vector3).clone().sub(ours[0] as Vector3);
    const theirLength = theirAxis.length();
    const ourLength = ourAxis.length();
    if (theirLength < 1e-6 || ourLength < 1e-6) return placedAtMid(n);
    // Only over a long enough bone; otherwise the parent's, since a ratio taken across twenty
    // millimetres is measuring where the two models disagree rather than how big the bone is.
    const measurable = theirLength > RELIABLE_SPAN && ourLength > RELIABLE_SPAN;
    const scale = measurable ? ourLength / theirLength : inheritedScale;
    // Start from the parent's orientation, then turn by the least that carries their axis onto
    // ours. Whatever roll the parent had about the shared direction survives that.
    const rotation = new Quaternion()
      .setFromUnitVectors(
        theirAxis.clone().normalize().applyQuaternion(inheritedRotation),
        ourAxis.clone().normalize(),
      )
      .multiply(inheritedRotation);
    return {
      rotation,
      position: ourMid
        .clone()
        .sub(theirMid.clone().multiplyScalar(scale).applyQuaternion(rotation)),
      scale,
      kind: measurable ? 'axis and inherited roll' : 'axis and inherited scale',
      matched: n,
      residual: null,
    };
  }

  // Three or more points determine a rotation only if they are not on a line, and a bone's
  // joints very often are: a hip, a knee and a patella are three points down the length of a
  // femur, with the patella barely off the line between the other two. Fitting a rotation to
  // that is fitting the roll to rounding error. Collinear sets fall back to the long axis and the
  // inherited roll, which is the information actually present.
  const spread = (points: readonly Vector3[], mid: Vector3): number => {
    let longest = new Vector3();
    let extent = 0;
    for (const p of points) {
      const d = p.clone().sub(mid);
      if (d.length() > extent) {
        extent = d.length();
        longest = d.clone().normalize();
      }
    }
    // How far the cloud strays from its own longest direction, relative to its length.
    let off = 0;
    for (const p of points) {
      const d = p.clone().sub(mid);
      off = Math.max(off, d.clone().addScaledVector(longest, -d.dot(longest)).length());
    }
    return extent > 1e-9 ? off / extent : 0;
  };
  const straightness = Math.min(
    spread(theirs.slice(0, n), theirMid),
    spread(ours.slice(0, n), ourMid),
  );
  if (straightness < 0.15) {
    // Take the two furthest apart and fit as a long bone, which is what it is.
    let best: [number, number] = [0, 1];
    let longest = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = (theirs[i] as Vector3).distanceTo(theirs[j] as Vector3);
        if (d > longest) {
          longest = d;
          best = [i, j];
        }
      }
    }
    return fitOne(
      [theirs[best[0]] as Vector3, theirs[best[1]] as Vector3],
      [ours[best[0]] as Vector3, ours[best[1]] as Vector3],
      parent,
      fallbackScale,
    );
  }

  // Not on a line: the cross-covariance of the centred clouds, the rotation Horn's method takes
  // from it, and the scale from the ratio of their spreads.
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  let theirSpread = 0;
  let ourSpread = 0;
  for (let i = 0; i < n; i++) {
    const a = (theirs[i] as Vector3).clone().sub(theirMid).toArray();
    const b = (ours[i] as Vector3).clone().sub(ourMid).toArray();
    for (let j = 0; j < 3; j++) {
      theirSpread += (a[j] as number) ** 2;
      ourSpread += (b[j] as number) ** 2;
      const row = cov[j] as number[];
      for (let k = 0; k < 3; k++) row[k] = (row[k] as number) + (a[j] as number) * (b[k] as number);
    }
  }
  if (theirSpread < 1e-12) return placedAtMid(n);
  const rotation = hornRotation(cov);
  // Scale from the spreads rather than from one pair of points, so a stray joint moves it less.
  // The same guard as the two-point case: a spread of a couple of centimetres is not a length the
  // two models can be compared over.
  const measurableSpread =
    Math.sqrt(theirSpread / n) > RELIABLE_SPAN && Math.sqrt(ourSpread / n) > RELIABLE_SPAN;
  const scale = measurableSpread ? Math.sqrt(ourSpread / theirSpread) : inheritedScale;
  const position = ourMid
    .clone()
    .sub(theirMid.clone().multiplyScalar(scale).applyQuaternion(rotation));

  // What is left over after the best fit: how far the two models disagree about this bone even
  // once it is placed as well as it can be.
  let squared = 0;
  for (let i = 0; i < n; i++) {
    const moved = (theirs[i] as Vector3)
      .clone()
      .multiplyScalar(scale)
      .applyQuaternion(rotation)
      .add(position);
    squared += moved.distanceToSquared(ours[i] as Vector3);
  }
  return {
    rotation,
    position,
    scale,
    kind: 'kabsch',
    matched: n,
    residual: Number((1000 * Math.sqrt(squared / n)).toFixed(2)),
  };
}

/** A body fit as `describeFits` needs it: whose it is, what it rested on, and how well. */
interface Described {
  readonly theirs: string;
  readonly ours: string;
  readonly kind: FitKind;
  readonly residual: number | null;
}

/** A scale for the eye: two places, and no trailing zeros, so a model at its own size reads 1x. */
const times = (scale: number): string => `${Number(scale.toFixed(2))}x`;

/**
 * What a set of body fits rested on, as one line for the Align tab.
 *
 * Each kind is counted and named in its own words, and a kind that did not happen is left out
 * rather than printed as a zero. Every bone that matched no joint at all is named, theirs to
 * ours, because those are the ones a person has to do something about: one below a bone that
 * matched something is merely unmeasured, and one with no such bone above it is still in their
 * model's own frame, which no amount of looking at it will fix -- a neighbouring bone has
 * to be paired. The scale the whole model took is said last, with whether it was measured.
 */
export function describeFits(
  result: {
    readonly fits: ReadonlyMap<string, Described>;
    readonly overallScale: number;
    readonly overallMeasured: boolean;
  },
  bodies: readonly { readonly name: string; readonly parent: string | null }[],
): string {
  const parentOf = new Map(bodies.map((b) => [b.name, b.parent]));
  const all = [...result.fits.values()];
  const kinds = Object.keys(FIT_KIND_NOTE) as FitKind[];
  const parts: string[] = [];
  for (const kind of kinds) {
    const these = all.filter((f) => f.kind === kind);
    if (these.length === 0) continue;
    let text = `${these.length} ${FIT_KIND_NOTE[kind]}`;
    if (kind === 'kabsch') {
      const worst = Math.max(...these.map((f) => f.residual ?? 0));
      text += ` (worst ${worst.toFixed(1)} mm out)`;
    }
    if (kind === 'model') {
      const named = these.map((f) => {
        // Hanging off a bone above that something was fitted to, or off nothing but the model.
        let above = parentOf.get(f.theirs) ?? null;
        while (above && (result.fits.get(above)?.kind ?? 'model') === 'model') {
          above = parentOf.get(above) ?? null;
        }
        return above
          ? `${f.theirs} → ${f.ours}`
          : `${f.theirs} → ${f.ours} left in their own frame; pair a neighbouring bone`;
      });
      text += `: ${named.join(', ')}`;
    }
    parts.push(text);
  }
  const scale = result.overallMeasured
    ? `Overall scale ${times(result.overallScale)}, measured across the matched joints.`
    : `Overall scale at ${times(result.overallScale)}, no span long enough to measure one.`;
  return `${all.length} of their bones placed: ${parts.join('; ')}. ${scale}`;
}
