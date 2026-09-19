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
