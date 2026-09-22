/**
 * Landmarks derived from bone geometry by an explicit rule.
 *
 * The export marks most features the ISB recommendations use, but not all: it has no marker for
 * the jugular notch, the C7 and T8 spinous tips, the xiphoid tip or the metatarsal heads. Each of
 * those is an extreme point of a bone in a named direction, so it is computed here from the bone's
 * own vertices with the rule written down beside it. ADR-011 permits measuring from the dataset;
 * CONTRIBUTING rule 5 asks that the derivation be recorded so it can be re-run.
 *
 * Directions are in the canonical world frame: +X right, +Y superior, +Z posterior.
 */

import type { WorldMesh } from './geometry.js';

export interface DerivedRule {
  readonly bone: string;
  readonly feature: string;
  /** Human-readable rule, copied into the landmark's provenance. */
  readonly rule: string;
  /** The point, from the bone's mesh and, when the rule needs them, other bones and markers. */
  readonly pick: (mesh: WorldMesh, context: DerivedContext) => [number, number, number];
}

export interface DerivedContext {
  readonly meshOf: (bone: string) => WorldMesh | undefined;
  /** A marker's world position, as the dataset places it. */
  readonly landmark: (bone: string, feature: string) => Vec3 | undefined;
}

/** The vertex of the mesh nearest a point. */
function nearest(mesh: WorldMesh, to: Vec3): Vec3 {
  const p = mesh.positions;
  let best = Number.POSITIVE_INFINITY;
  let at = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const d = Math.hypot(
      (p[i * 3] ?? 0) - to[0],
      (p[i * 3 + 1] ?? 0) - to[1],
      (p[i * 3 + 2] ?? 0) - to[2],
    );
    if (d < best) {
      best = d;
      at = i;
    }
  }
  return [p[at * 3] ?? 0, p[at * 3 + 1] ?? 0, p[at * 3 + 2] ?? 0];
}

type Axis = 0 | 1 | 2;

/** The vertex with the largest (`sign = 1`) or smallest (`-1`) coordinate on `axis`. */
function extreme(mesh: WorldMesh, axis: Axis, sign: 1 | -1): [number, number, number] {
  let best = Number.NEGATIVE_INFINITY;
  let at = 0;
  const p = mesh.positions;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const v = (p[i * 3 + axis] ?? 0) * sign;
    if (v > best) {
      best = v;
      at = i;
    }
  }
  return [p[at * 3] ?? 0, p[at * 3 + 1] ?? 0, p[at * 3 + 2] ?? 0];
}

/**
 * Extreme along `axis` restricted to vertices near the midline (|x| below `halfWidth`).
 * Used for midline features on bones whose extreme point overall is off-centre.
 */
function midlineExtreme(
  mesh: WorldMesh,
  axis: Axis,
  sign: 1 | -1,
  halfWidth: number,
): [number, number, number] {
  let best = Number.NEGATIVE_INFINITY;
  let at = -1;
  const p = mesh.positions;
  for (let i = 0; i < mesh.vertexCount; i++) {
    if (Math.abs(p[i * 3] ?? 0) > halfWidth) continue;
    const v = (p[i * 3 + axis] ?? 0) * sign;
    if (v > best) {
      best = v;
      at = i;
    }
  }
  if (at < 0) return extreme(mesh, axis, sign);
  return [p[at * 3] ?? 0, p[at * 3 + 1] ?? 0, p[at * 3 + 2] ?? 0];
}

/**
 * Extreme along `axis` restricted to one side of the midline: `side` 'r' keeps vertices with
 * x > 0, 'l' those with x < 0. For the transverse processes of a midline bone, whose two tips are
 * its most lateral points, one a side.
 */
function sideExtreme(mesh: WorldMesh, side: 'l' | 'r', axis: Axis, sign: 1 | -1): Vec3 {
  let best = Number.NEGATIVE_INFINITY;
  let at = -1;
  const p = mesh.positions;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const x = p[i * 3] ?? 0;
    if (side === 'r' ? x <= 0 : x >= 0) continue;
    const v = (p[i * 3 + axis] ?? 0) * sign;
    if (v > best) {
      best = v;
      at = i;
    }
  }
  if (at < 0) return extreme(mesh, axis, sign);
  return [p[at * 3] ?? 0, p[at * 3 + 1] ?? 0, p[at * 3 + 2] ?? 0];
}

type Vec3 = [number, number, number];

/**
 * The long axis of an elongated bone: the dominant eigenvector of its vertex covariance, found by
 * power iteration. A phalanx or a metacarpal is far longer than it is wide, so this axis is the
 * bone's own shaft direction, whichever way the digit happens to point.
 */
function longAxis(mesh: WorldMesh): { axis: Vec3; centre: Vec3 } {
  const p = mesh.positions;
  const n = mesh.vertexCount;
  const centre: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    centre[0] += p[i * 3] ?? 0;
    centre[1] += p[i * 3 + 1] ?? 0;
    centre[2] += p[i * 3 + 2] ?? 0;
  }
  centre[0] /= n;
  centre[1] /= n;
  centre[2] /= n;
  // Upper triangle of the covariance, then mirrored: [xx, xy, xz, yy, yz, zz].
  const c: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const x = (p[i * 3] ?? 0) - centre[0];
    const y = (p[i * 3 + 1] ?? 0) - centre[1];
    const z = (p[i * 3 + 2] ?? 0) - centre[2];
    c[0] += x * x;
    c[1] += x * y;
    c[2] += x * z;
    c[3] += y * y;
    c[4] += y * z;
    c[5] += z * z;
  }
  let v: Vec3 = [1, 1, 1];
  for (let k = 0; k < 64; k++) {
    const a = c[0] * v[0] + c[1] * v[1] + c[2] * v[2];
    const b = c[1] * v[0] + c[3] * v[1] + c[4] * v[2];
    const d = c[2] * v[0] + c[4] * v[1] + c[5] * v[2];
    const length = Math.hypot(a, b, d);
    if (length === 0) break;
    v = [a / length, b / length, d / length];
  }
  return { axis: v, centre };
}

/** The centroid of the vertices in the terminal `fraction` of the bone along `axis`, `+axis` end. */
function endBand(mesh: WorldMesh, axis: Vec3, fraction: number): Vec3 {
  const p = mesh.positions;
  const n = mesh.vertexCount;
  const along = new Float64Array(n);
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const t =
      (p[i * 3] ?? 0) * axis[0] + (p[i * 3 + 1] ?? 0) * axis[1] + (p[i * 3 + 2] ?? 0) * axis[2];
    along[i] = t;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  const cut = hi - (hi - lo) * fraction;
  const sum: Vec3 = [0, 0, 0];
  let taken = 0;
  for (let i = 0; i < n; i++) {
    if ((along[i] ?? 0) < cut) continue;
    sum[0] += p[i * 3] ?? 0;
    sum[1] += p[i * 3 + 1] ?? 0;
    sum[2] += p[i * 3 + 2] ?? 0;
    taken += 1;
  }
  if (taken === 0) return longAxis(mesh).centre;
  return [sum[0] / taken, sum[1] / taken, sum[2] / taken];
}

/** How much of a bone's length the end band takes in: an eighth, which is the articular end. */
const END_BAND = 0.125;

/**
 * The base or the head of a bone in a digit, measured from the bone itself.
 *
 * A digit's bones are short, and the dataset's markers are label anchors floating 12 to 30 mm
 * clear of the hand -- further than a phalanx is wide -- so there is nothing to read a tendon's
 * ending off. There is the bone. A phalanx is a shaft with an articular surface at each end, so
 * the base is the centroid of the end band nearer the bone it articulates with proximally, and
 * the head is the centroid of the band at the other end.
 *
 * Taking the *centroid of a band* rather than the single most extreme vertex matters: the extreme
 * vertex is a corner of the rim, on the dorsal or the palmar edge, and a tendon put there runs a
 * centimetre off the bone's axis. The band's centroid is on the axis, which is where the base of
 * a phalanx is.
 *
 * The check that it is right is continuity: down every digit of both hands and both feet, a
 * bone's head and the next bone's base come out 1.2 to 7.6 mm apart -- a joint space -- and the
 * bone lengths that fall out (metacarpal 2 at 65 mm, the middle phalanx of the little toe at
 * 8 mm) are the published ones.
 */
function digitEnd(mesh: WorldMesh, proximal: WorldMesh | undefined, end: 'base' | 'head'): Vec3 {
  const { axis, centre } = longAxis(mesh);
  // Orient the axis proximally: toward the bone this one articulates with at its base.
  const toward = proximal ? longAxis(proximal).centre : centre;
  const dot =
    axis[0] * (toward[0] - centre[0]) +
    axis[1] * (toward[1] - centre[1]) +
    axis[2] * (toward[2] - centre[2]);
  const proximalAxis: Vec3 = dot < 0 ? [-axis[0], -axis[1], -axis[2]] : axis;
  const wanted: Vec3 =
    end === 'base' ? proximalAxis : [-proximalAxis[0], -proximalAxis[1], -proximalAxis[2]];
  return endBand(mesh, wanted, END_BAND);
}

/** Bins along a rib's arc, from its head to its anterior end. */
export const RIB_BINS = 24;

/**
 * A rib's arc, parametrised from its head to its anterior end.
 *
 * A rib's head lies against the body of its own vertebra, and from there the bone sweeps out to
 * the side, forward, and down to its front end: every step along it is a step further from the
 * head, so distance from the head orders the vertices along the bone, on the flat first rib and
 * the short twelfth as on the deep C of the sixth. The head is the vertex nearest the centroid
 * of the vertebra the rib belongs to. The arc is cut into `RIB_BINS` bins of equal distance
 * from the head to the furthest vertex, and within a bin the upper border is the highest
 * vertex, the lower the lowest, and the outer surface the vertex furthest from the rib's
 * centroid in the transverse plane.
 */
export function ribArc(
  mesh: WorldMesh,
  vertebra: WorldMesh | undefined,
  side: 'l' | 'r',
): {
  /** Bin centroids from head to anterior end. */
  readonly bins: readonly Vec3[];
  readonly upper: readonly Vec3[];
  readonly lower: readonly Vec3[];
  readonly outer: readonly Vec3[];
  /** Length along the bin centroids from the tubercle bin to the anterior end, metres. */
  readonly length: number;
  readonly rule: string;
} {
  const p = mesh.positions;
  const [cx, cy, cz] = mesh.centroid;
  const at = (i: number): Vec3 => [p[i * 3] ?? 0, p[i * 3 + 1] ?? 0, p[i * 3 + 2] ?? 0];
  // The head: nearest the vertebra's centroid; failing a vertebra, the most posterior vertex on
  // the rib's medial half.
  let head = 0;
  if (vertebra) {
    const [vx, vy, vz] = vertebra.centroid;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const d = Math.hypot(
        (p[i * 3] ?? 0) - vx,
        (p[i * 3 + 1] ?? 0) - vy,
        (p[i * 3 + 2] ?? 0) - vz,
      );
      if (d < best) {
        best = d;
        head = i;
      }
    }
  } else {
    let headZ = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const x = p[i * 3] ?? 0;
      const medial = side === 'r' ? x < cx : x > cx;
      const z = p[i * 3 + 2] ?? 0;
      if (medial && z > headZ) {
        headZ = z;
        head = i;
      }
    }
  }
  const h = at(head);
  const distances = new Float64Array(mesh.vertexCount);
  let reach = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const d = Math.hypot(
      (p[i * 3] ?? 0) - h[0],
      (p[i * 3 + 1] ?? 0) - h[1],
      (p[i * 3 + 2] ?? 0) - h[2],
    );
    distances[i] = d;
    if (d > reach) reach = d;
  }
  const bins: Vec3[] = [];
  const upper: Vec3[] = [];
  const lower: Vec3[] = [];
  const outer: Vec3[] = [];
  for (let b = 0; b < RIB_BINS; b++) {
    const lo = (reach * b) / RIB_BINS;
    const hi = (reach * (b + 1)) / RIB_BINS;
    let n = 0;
    const c: Vec3 = [0, 0, 0];
    let top = -1;
    let bottom = -1;
    let far = -1;
    let farD = -1;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const d = distances[i] as number;
      if (d < lo || (d >= hi && b < RIB_BINS - 1)) continue;
      n += 1;
      const x = p[i * 3] ?? 0;
      const y = p[i * 3 + 1] ?? 0;
      const z = p[i * 3 + 2] ?? 0;
      c[0] += x;
      c[1] += y;
      c[2] += z;
      if (top < 0 || y > (p[top * 3 + 1] ?? 0)) top = i;
      if (bottom < 0 || y < (p[bottom * 3 + 1] ?? 0)) bottom = i;
      const r = Math.hypot(x - cx, z - cz);
      if (r > farD) {
        farD = r;
        far = i;
      }
    }
    if (n === 0) {
      const prev = bins[b - 1] ?? [cx, cy, cz];
      bins.push(prev);
      upper.push(upper[b - 1] ?? prev);
      lower.push(lower[b - 1] ?? prev);
      outer.push(outer[b - 1] ?? prev);
      continue;
    }
    bins.push([c[0] / n, c[1] / n, c[2] / n]);
    upper.push(at(top));
    lower.push(at(bottom));
    outer.push(at(far));
  }
  // Bruno 2015 measures a rib from its tubercle to its anterior end; the tubercle sits a little
  // way out from the head, taken here as the end of the third bin.
  let length = 0;
  for (let b = 3; b < RIB_BINS; b++) {
    const a = bins[b - 1] as Vec3;
    const c = bins[b] as Vec3;
    length += Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  }
  return {
    bins,
    upper,
    lower,
    outer,
    length,
    rule:
      `the rib's vertices ordered by distance from its head (the vertex nearest its vertebra's ` +
      `centroid) in ${RIB_BINS} bins of equal distance to the furthest vertex; length summed ` +
      'along the bin centroids from the end of the third bin (the tubercle) to the last',
  };
}

/** The point on a rib's border at a fraction of its arc, named for the muscles that take it. */
function ribPoint(
  n: number,
  side: 'l' | 'r',
  border: 'upper' | 'lower' | 'outer',
  fraction: number,
): DerivedRule {
  const where =
    border === 'upper'
      ? 'the highest vertex'
      : border === 'lower'
        ? 'the lowest vertex'
        : 'the vertex furthest from the centroid in the transverse plane';
  return {
    bone: `rib_${n}_${side}`,
    feature: `${border === 'outer' ? 'Outer_surface' : border === 'upper' ? 'Upper_border' : 'Lower_border'}_at_${Math.round(fraction * 100)}`,
    rule:
      `${where} of the bin at ${Math.round(fraction * 100)} per cent of the rib's arc from its ` +
      'head to its anterior end (see rib-arcs.json for the arc)',
    pick: (m, { meshOf }) => {
      const arc = ribArc(m, meshOf(`vertebra_t${n}`), side);
      const b = Math.min(RIB_BINS - 1, Math.max(0, Math.round(fraction * RIB_BINS - 0.5)));
      return (arc[border][b] as Vec3).slice() as Vec3;
    },
  };
}

/**
 * The ribs' attachment points: for the intercostals, running from a rib's lower border to the
 * upper border of the rib below; for the muscles that arise from the ribs' outer faces -- the
 * scalenes on the first two, serratus anterior, pectoralis minor, quadratus lumborum on the
 * twelfth. Every rib gets the same set so a muscle may take any rib it needs.
 */
export const RIB_RULES: readonly DerivedRule[] = Array.from(
  { length: 12 },
  (_, i) => i + 1,
).flatMap((n) =>
  (['l', 'r'] as const).flatMap((s) => [
    ribPoint(n, s, 'upper', 0.5),
    ribPoint(n, s, 'upper', 0.6),
    ribPoint(n, s, 'lower', 0.5),
    ribPoint(n, s, 'lower', 0.7),
    ribPoint(n, s, 'outer', 0.7),
    ribPoint(n, s, 'outer', 0.9),
  ]),
);

/**
 * Every bone in a digit, with the bone proximal to it -- which is what orients its long axis.
 *
 * The hallux and the thumb have two phalanges, the other eight digits three. A metacarpal's or a
 * metatarsal's proximal neighbour is a carpal or a tarsal, and the ones chosen here are the bones
 * each actually articulates with: the trapezium under the thumb, the capitate under the third
 * finger, the hamate under the fourth and fifth, and in the foot the cuneiforms and the cuboid.
 * Only the direction matters, so a neighbouring carpal would do as well; naming the right one
 * costs nothing and says what the bone is.
 */
const CARPAL_UNDER: Record<number, string> = {
  1: 'trapezium',
  2: 'trapezoid',
  3: 'capitate',
  4: 'hamate',
  5: 'hamate',
};
const TARSAL_UNDER: Record<number, string> = {
  1: 'cuneiform_medial',
  2: 'cuneiform_intermediate',
  3: 'cuneiform_lateral',
  4: 'cuboid',
  5: 'cuboid',
};

const DIGIT_BONES: readonly { readonly id: string; readonly proximal: string }[] = (
  ['l', 'r'] as const
).flatMap((s) =>
  ([1, 2, 3, 4, 5] as const).flatMap((d) =>
    (
      [
        ['hand', 'metacarpal', 'phalanx', CARPAL_UNDER],
        ['foot', 'metatarsal', 'phalanx_pedis', TARSAL_UNDER],
      ] as const
    ).flatMap(([, long, phalanx, under]) => {
      // The thumb and the hallux have no middle phalanx.
      const parts =
        d === 1 ? (['proximal', 'distal'] as const) : (['proximal', 'middle', 'distal'] as const);
      const chain = [`${long}_${d}_${s}`, ...parts.map((part) => `${phalanx}_${part}_${d}_${s}`)];
      return chain.map((id, i) => ({
        id,
        proximal: i === 0 ? `${under[d]}_${s}` : (chain[i - 1] as string),
      }));
    }),
  ),
);

export const DERIVED_RULES: readonly DerivedRule[] = [
  {
    bone: 'vertebra_c7',
    feature: 'Spinous_process_tip',
    rule: 'most posterior vertex of the C7 mesh (max Z, world frame)',
    pick: (m) => extreme(m, 2, 1),
  },
  {
    bone: 'vertebra_t8',
    feature: 'Spinous_process_tip',
    rule: 'most posterior vertex of the T8 mesh (max Z, world frame)',
    pick: (m) => extreme(m, 2, 1),
  },
  {
    bone: 'sternum',
    feature: 'Jugular_notch',
    rule: 'most superior vertex of the fused sternum within 8 mm of the midline (max Y, |X| < 0.008)',
    pick: (m) => midlineExtreme(m, 1, 1, 0.008),
  },
  {
    bone: 'sternum',
    feature: 'Xiphoid_tip',
    rule: 'most inferior vertex of the fused sternum within 8 mm of the midline (min Y, |X| < 0.008)',
    pick: (m) => midlineExtreme(m, 1, -1, 0.008),
  },
  ...([1, 2, 3, 4, 5] as const).flatMap((d) =>
    (['l', 'r'] as const).map(
      (s): DerivedRule => ({
        bone: `metatarsal_${d}_${s}`,
        feature: 'Head_of_metatarsal_bone',
        rule: 'most anterior vertex of the metatarsal mesh (min Z, world frame)',
        pick: (m) => extreme(m, 2, -1),
      }),
    ),
  ),
  /**
   * The base and the head of every bone in every digit, hand and foot.
   *
   * Gray puts flexor digitorum longus on the bases of the distal phalanges of the four lesser
   * toes and flexor hallucis longus on the base of the great toe's, the extensors on the phalanges
   * likewise, and in the hand flexor digitorum superficialis on the middle phalanges and profundus
   * on the distal ones. The export marks a phalangeal feature on one digit only -- the third
   * finger -- and even there as a label anchor 16 mm clear of the bone. So every one of those
   * endings is measured from the bone, by `digitEnd`, which has the argument for the rule.
   *
   * The heads come with the bases because a long tendon runs over the head of the bone proximal
   * to its ending, and a via point there is what keeps it on the digit instead of cutting the
   * corner: the flexors over the palmar side, the extensors over the dorsal.
   */
  ...DIGIT_BONES.flatMap((bone) =>
    (['base', 'head'] as const).map(
      (end): DerivedRule => ({
        bone: bone.id,
        feature: end === 'base' ? 'Base_of_digit_bone' : 'Head_of_digit_bone',
        rule:
          'centroid of the vertices in the terminal eighth of the bone along its own long axis ' +
          '(dominant eigenvector of the vertex covariance), at the end ' +
          (end === 'base' ? `nearer ${bone.proximal}` : `away from ${bone.proximal}`),
        pick: (m, context) => digitEnd(m, context.meshOf(bone.proximal), end),
      }),
    ),
  ),
  // ISB 2002 defines MM and LM as the *tips* of the malleoli. The export's markers are surface
  // patches -- the left lateral malleolus is a 390-vertex patch whose centroid sits well above
  // the tip -- and the two sides differed enough to tilt the tibia frame by 22 degrees. The tip is
  // the most inferior point of the bone, on both sides, so it is derived rather than read.
  ...(['l', 'r'] as const).map(
    (s): DerivedRule => ({
      bone: `tibia_${s}`,
      feature: 'Medial_malleolus',
      rule: 'most inferior vertex of the tibia mesh (min Y): the tip of the medial malleolus',
      pick: (m) => extreme(m, 1, -1),
    }),
  ),
  ...(['l', 'r'] as const).map(
    (s): DerivedRule => ({
      bone: `fibula_${s}`,
      feature: 'Lateral_malleolus',
      rule: 'most inferior vertex of the fibula mesh (min Y): the tip of the lateral malleolus',
      pick: (m) => extreme(m, 1, -1),
    }),
  ),
  ...(['l', 'r'] as const).map(
    (s): DerivedRule => ({
      bone: `calcaneus_${s}`,
      feature: 'Posterior_calcaneal_tuberosity_point',
      rule: 'most posterior vertex of the calcaneus mesh (max Z, world frame)',
      pick: (m) => extreme(m, 2, 1),
    }),
  ),
  // The neck's and upper back's attachments, for the muscles that hold the head up and the
  // shoulder girdle back: a transverse process tip is a vertebra's most lateral point on its
  // side, a spinous process tip its most posterior, and the front of its body its most anterior
  // point near the midline.
  ...(
    ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 't1', 't2', 't3', 't4', 't5', 't6'] as const
  ).flatMap((level) =>
    (['l', 'r'] as const).map(
      (s): DerivedRule => ({
        bone: `vertebra_${level}`,
        feature: `Transverse_process_tip_${s}`,
        rule: `most lateral vertex of the ${level.toUpperCase()} mesh on the ${s === 'r' ? 'right' : 'left'} (${s === 'r' ? 'max' : 'min'} X)`,
        pick: (m) => sideExtreme(m, s, 0, s === 'r' ? 1 : -1),
      }),
    ),
  ),
  ...(['t1', 't2', 't3', 't4', 't5', 't6', 't10', 't12'] as const).map(
    (level): DerivedRule => ({
      bone: `vertebra_${level}`,
      feature: 'Spinous_process_tip',
      rule: `most posterior vertex of the ${level.toUpperCase()} mesh (max Z, world frame)`,
      pick: (m) => extreme(m, 2, 1),
    }),
  ),
  ...(['c5', 't2'] as const).map(
    (level): DerivedRule => ({
      bone: `vertebra_${level}`,
      feature: 'Anterior_surface_of_body',
      rule: `most anterior vertex of the ${level.toUpperCase()} mesh within 8 mm of the midline (min Z, |X| < 0.008)`,
      pick: (m) => midlineExtreme(m, 2, -1, 0.008),
    }),
  ),
  // The nuchal lines are marked once, on the left; the skull is symmetric, so the right's is
  // the vertex nearest the marker's mirror image.
  ...(['Superior_nuchal_line', 'Inferior_nuchal_line'] as const).flatMap((line) =>
    (['l', 'r'] as const).map(
      (s): DerivedRule => ({
        bone: 'occipital',
        feature: `${line}_${s}`,
        rule: `the occipital vertex nearest the '${line}' marker${s === 'l' ? '' : ' mirrored across the midline (X negated)'}`,
        pick: (m, { landmark }) => {
          const marker = landmark('occipital', line) ?? [0, 0, 0];
          const flip = marker[0] < 0 === (s === 'l') ? 1 : -1;
          return nearest(m, [marker[0] * flip, marker[1], marker[2]]);
        },
      }),
    ),
  ),
  ...(['l', 'r'] as const).map(
    (s): DerivedRule => ({
      bone: `hip_${s}`,
      feature: 'Iliac_crest_highest',
      rule: 'most superior vertex of the hip bone mesh (max Y): the top of the iliac crest',
      pick: (m) => extreme(m, 1, 1),
    }),
  ),
];
