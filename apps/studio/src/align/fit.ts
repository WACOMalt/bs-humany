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
 * - **three or more** and the fit is complete: a rotation, a scale and a translation, by
 *   Kabsch. A femur has the hip, the knee and the patella, so a femur is fully determined.
 * - **two** gives the bone's long axis and its length but leaves the roll about that axis free.
 *   The roll is settled by the joint *axes*: a knee hinges about the same anatomical line in
 *   both models, so the roll that best lines their hinges up with ours is the right one. They
 *   are matched as unordered sets rather than by name, because the naming is exactly what does
 *   not correspond between the two models. Failing that -- a bone whose joints state no axes --
 *   the parent's roll is kept, which is right whenever a bone is not twisted against the one
 *   above it.
 * - **one** gives a position and nothing else; the parent's rotation and scale are inherited
 *   whole.
 * - **none** leaves the bone where the model's overall scale puts it.
 *
 * Every fit says which of those happened, because a fit from two points and a fit from five are
 * not the same claim and a person choosing whether to trust one should be told which they have.
 */

import { Matrix3, Quaternion, Vector3 } from 'three';

export type FitKind =
  | 'kabsch'
  | 'axis and hinge roll'
  | 'axis and inherited roll'
  | 'inherited'
  | 'model';

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
 * The rotation nearest a 3x3 matrix, by Newton's polar decomposition.
 *
 * `R <- (R + R^-T) / 2` converges on the orthogonal factor quickly -- a handful of steps is
 * plenty at this size -- and needs no singular value decomposition, which is a great deal of
 * code to carry for one use. A negative determinant would be a reflection rather than a
 * rotation, which no arrangement of bones can be, so it is refused.
 */
function nearestRotation(m: Matrix3): Matrix3 | undefined {
  const r = m.clone();
  for (let i = 0; i < 24; i++) {
    const inverseTranspose = r.clone().invert().transpose();
    const next = new Matrix3();
    for (let k = 0; k < 9; k++) {
      next.elements[k] =
        0.5 * ((r.elements[k] as number) + (inverseTranspose.elements[k] as number));
    }
    let delta = 0;
    for (let k = 0; k < 9; k++) {
      delta += Math.abs((next.elements[k] as number) - (r.elements[k] as number));
    }
    r.copy(next);
    if (delta < 1e-12) break;
  }
  return r.determinant() > 0 ? r : undefined;
}

const quatFrom = (m: Matrix3): Quaternion => {
  const e = m.elements;
  // three's Matrix3 is column-major; Quaternion.setFromRotationMatrix wants a Matrix4.
  const q = new Quaternion();
  const trace = (e[0] as number) + (e[4] as number) + (e[8] as number);
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q.set(
      ((e[5] as number) - (e[7] as number)) * s,
      ((e[6] as number) - (e[2] as number)) * s,
      ((e[1] as number) - (e[3] as number)) * s,
      0.25 / s,
    );
  } else if ((e[0] as number) > (e[4] as number) && (e[0] as number) > (e[8] as number)) {
    const s = 2 * Math.sqrt(1 + (e[0] as number) - (e[4] as number) - (e[8] as number));
    q.set(
      0.25 * s,
      ((e[3] as number) + (e[1] as number)) / s,
      ((e[6] as number) + (e[2] as number)) / s,
      ((e[5] as number) - (e[7] as number)) / s,
    );
  } else if ((e[4] as number) > (e[8] as number)) {
    const s = 2 * Math.sqrt(1 + (e[4] as number) - (e[0] as number) - (e[8] as number));
    q.set(
      ((e[3] as number) + (e[1] as number)) / s,
      0.25 * s,
      ((e[7] as number) + (e[5] as number)) / s,
      ((e[6] as number) - (e[2] as number)) / s,
    );
  } else {
    const s = 2 * Math.sqrt(1 + (e[8] as number) - (e[0] as number) - (e[4] as number));
    q.set(
      ((e[6] as number) + (e[2] as number)) / s,
      ((e[7] as number) + (e[5] as number)) / s,
      0.25 * s,
      ((e[1] as number) - (e[3] as number)) / s,
    );
  }
  return q.normalize();
};

const centroid = (points: readonly Vector3[]): Vector3 =>
  points
    .reduce((sum, p) => sum.add(p), new Vector3())
    .multiplyScalar(points.length ? 1 / points.length : 0);

/**
 * Fit one bone from matched points, falling back as far as the evidence runs out.
 *
 * `parent` is the fit already worked out for the bone above, which is where a roll or a whole
 * orientation is inherited from when this bone's own joints cannot say.
 */
export function fitOne(
  theirs: readonly Vector3[],
  ours: readonly Vector3[],
  parent: Fitted | undefined,
  fallbackScale: number,
  /** Joint axes in each world, for settling the roll a two-point fit leaves free. */
  theirAxes: readonly Vector3[] = [],
  ourAxes: readonly Vector3[] = [],
): Fitted {
  const n = Math.min(theirs.length, ours.length);
  const inheritedRotation = parent?.rotation.clone() ?? new Quaternion();
  const inheritedScale = parent?.scale ?? fallbackScale;

  if (n === 0) {
    return {
      rotation: inheritedRotation,
      position: new Vector3(),
      scale: inheritedScale,
      kind: 'model',
      matched: 0,
      residual: null,
    };
  }

  const theirMid = centroid(theirs.slice(0, n));
  const ourMid = centroid(ours.slice(0, n));

  if (n === 1) {
    return {
      rotation: inheritedRotation,
      position: ourMid
        .clone()
        .sub(theirMid.clone().multiplyScalar(inheritedScale).applyQuaternion(inheritedRotation)),
      scale: inheritedScale,
      kind: 'inherited',
      matched: 1,
      residual: null,
    };
  }

  if (n === 2) {
    // Two points give the bone's axis and its length. The roll about that axis is not in the
    // evidence, so the parent's is kept: a bone is usually not twisted against the one above it.
    const theirAxis = (theirs[1] as Vector3).clone().sub(theirs[0] as Vector3);
    const ourAxis = (ours[1] as Vector3).clone().sub(ours[0] as Vector3);
    const theirLength = theirAxis.length();
    const ourLength = ourAxis.length();
    if (theirLength < 1e-6 || ourLength < 1e-6) {
      return {
        rotation: inheritedRotation,
        position: ourMid
          .clone()
          .sub(theirMid.clone().multiplyScalar(inheritedScale).applyQuaternion(inheritedRotation)),
        scale: inheritedScale,
        kind: 'inherited',
        matched: n,
        residual: null,
      };
    }
    const scale = ourLength / theirLength;
    // Start from the parent's orientation, then turn by the least that carries their axis onto
    // ours. Whatever roll the parent had about the shared direction survives that.
    const along = ourAxis.clone().normalize();
    const rotation = new Quaternion().setFromUnitVectors(
      theirAxis.clone().normalize().applyQuaternion(inheritedRotation),
      along,
    );
    rotation.multiply(inheritedRotation);

    // The roll about the bone's own axis is still free. A hinge is the same anatomical line in
    // both models, so the roll that best lines their hinges up with ours is the one to take.
    // Swept rather than solved: it is one angle, the score has no closed form once the axes are
    // matched as sets, and a degree at a time over a full turn is nothing to compute.
    let kind: FitKind = 'axis and inherited roll';
    if (theirAxes.length > 0 && ourAxes.length > 0) {
      const score = (turn: Quaternion): number => {
        let total = 0;
        for (const theirAxisVector of theirAxes) {
          const moved = theirAxisVector.clone().applyQuaternion(turn).normalize();
          let best = 0;
          for (const ourAxisVector of ourAxes) {
            // Absolute, because a hinge has no preferred end: the two models may state one axis
            // pointing opposite ways and mean the same joint.
            best = Math.max(best, Math.abs(moved.dot(ourAxisVector)));
          }
          total += best;
        }
        return total;
      };
      let bestTurn = rotation.clone();
      let bestScore = score(rotation);
      for (let degrees = 1; degrees < 360; degrees += 1) {
        const turn = new Quaternion()
          .setFromAxisAngle(along, (degrees * Math.PI) / 180)
          .multiply(rotation);
        const value = score(turn);
        if (value > bestScore) {
          bestScore = value;
          bestTurn = turn;
        }
      }
      rotation.copy(bestTurn);
      kind = 'axis and hinge roll';
    }
    return {
      rotation,
      position: ourMid
        .clone()
        .sub(theirMid.clone().multiplyScalar(scale).applyQuaternion(rotation)),
      scale,
      kind,
      matched: n,
      residual: null,
    };
  }

  // Three or more points determine a rotation only if they are not on a line, and a bone's
  // joints very often are: a hip, a knee and a patella are three points down the length of a
  // femur, with the patella barely off the line between the other two. Fitting a rotation to
  // that is fitting the roll to rounding error. Collinear sets fall back to the long axis and
  // the hinges, which is the information actually present.
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
      theirAxes,
      ourAxes,
    );
  }

  // Not on a line: Kabsch. The cross-covariance of the centred clouds, its nearest rotation, and
  // the scale from the ratio of their spreads.
  const cov = new Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);
  let theirSpread = 0;
  for (let i = 0; i < n; i++) {
    const a = (theirs[i] as Vector3).clone().sub(theirMid);
    const b = (ours[i] as Vector3).clone().sub(ourMid);
    theirSpread += a.lengthSq();
    // Column-major: element(row, column) sits at column * 3 + row.
    const e = cov.elements;
    e[0] = (e[0] as number) + b.x * a.x;
    e[1] = (e[1] as number) + b.y * a.x;
    e[2] = (e[2] as number) + b.z * a.x;
    e[3] = (e[3] as number) + b.x * a.y;
    e[4] = (e[4] as number) + b.y * a.y;
    e[5] = (e[5] as number) + b.z * a.y;
    e[6] = (e[6] as number) + b.x * a.z;
    e[7] = (e[7] as number) + b.y * a.z;
    e[8] = (e[8] as number) + b.z * a.z;
  }
  const rotationMatrix = nearestRotation(cov);
  if (!rotationMatrix || theirSpread < 1e-12) {
    return {
      rotation: inheritedRotation,
      position: ourMid
        .clone()
        .sub(theirMid.clone().multiplyScalar(inheritedScale).applyQuaternion(inheritedRotation)),
      scale: inheritedScale,
      kind: 'inherited',
      matched: n,
      residual: null,
    };
  }
  const rotation = quatFrom(rotationMatrix);
  // Scale from the spreads rather than from one pair of points, so a stray joint moves it less.
  let ourSpread = 0;
  for (let i = 0; i < n; i++) ourSpread += (ours[i] as Vector3).clone().sub(ourMid).lengthSq();
  const scale = Math.sqrt(ourSpread / theirSpread);
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
