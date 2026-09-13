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
  readonly pick: (mesh: WorldMesh) => [number, number, number];
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
  ...(['l', 'r'] as const).map(
    (s): DerivedRule => ({
      bone: `calcaneus_${s}`,
      feature: 'Posterior_calcaneal_tuberosity_point',
      rule: 'most posterior vertex of the calcaneus mesh (max Z, world frame)',
      pick: (m) => extreme(m, 2, 1),
    }),
  ),
];
