/**
 * Axis handling for recipes.
 *
 * Primitives are generated along a canonical local axis and then permuted onto the axis the recipe
 * asked for. Generating three variants of every primitive would triple the code and the bug
 * surface for no gain.
 *
 * The default is `y`, because a bone's local frame puts its long axis on Y by convention.
 */

import type { Axis } from '@bs-humany/hsdl';

export const DEFAULT_AXIS: Axis = 'y';

/**
 * Map a point generated in canonical space -- with the long axis on Y, and the cross-section in
 * the XZ plane -- onto the requested axis.
 *
 * `along` is the position along the long axis. `u` and `v` are the cross-section coordinates.
 * The permutations are chosen to preserve handedness, so surface winding stays correct and normals
 * keep pointing outward.
 */
export function place(axis: Axis, along: number, u: number, v: number): [number, number, number] {
  switch (axis) {
    case 'x':
      return [along, v, u];
    case 'y':
      return [u, along, v];
    case 'z':
      return [v, u, along];
  }
}
