/**
 * Axis conventions and conversions between them.
 *
 * **This is the module the specification warns about.** Coordinate-convention bugs are the single
 * most likely source of silent wrongness in this project: a mirrored skeleton or a transposed
 * joint axis looks almost right, passes casual inspection, and poisons every downstream number.
 *
 * The defence is to never hand-write a conversion matrix. A convention is declared by saying which
 * *anatomical direction* each of its basis axes points along. The matrix is then derived, and the
 * derivation is checked for orthogonality and for right-handedness at construction time. A
 * convention with a sign error cannot be created -- it throws on the way in, at module load, with
 * the offending axes named.
 *
 * Adding a new convention means writing three words, not nine numbers.
 */

import {
  type Mat3,
  determinant,
  fromColumns,
  isRotation,
  multiplyMat3,
  transformVec3,
  transpose,
} from './mat3.js';
import { quatFromMat3 } from './mat3.js';
import { type Quat, conjugate, multiplyQuat } from './quat.js';
import type { Vec3 } from './vec3.js';
import { vec3 } from './vec3.js';

export type AnatomicalDirection =
  | 'right'
  | 'left'
  | 'superior'
  | 'inferior'
  | 'anterior'
  | 'posterior';

/**
 * The canonical anatomical basis, against which every convention is expressed.
 *
 * It is identical to the `WORLD` convention below. Choosing the project's own world frame as the
 * canonical basis means conversions to and from world -- overwhelmingly the common case -- are the
 * identity, and cost nothing.
 */
const CANONICAL_DIRECTION: Readonly<Record<AnatomicalDirection, Vec3>> = Object.freeze({
  right: vec3(1, 0, 0),
  left: vec3(-1, 0, 0),
  superior: vec3(0, 1, 0),
  inferior: vec3(0, -1, 0),
  posterior: vec3(0, 0, 1),
  anterior: vec3(0, 0, -1),
});

const OPPOSITE: Readonly<Record<AnatomicalDirection, AnatomicalDirection>> = Object.freeze({
  right: 'left',
  left: 'right',
  superior: 'inferior',
  inferior: 'superior',
  anterior: 'posterior',
  posterior: 'anterior',
});

export interface AxisConventionSpec {
  /** Stable identifier, used in error messages and in HSDL. */
  readonly id: string;
  /** What this convention is and where it comes from. Shown in diagnostics. */
  readonly description: string;
  /** Citation key for the defining publication, where there is one. */
  readonly source?: string;
  readonly x: AnatomicalDirection;
  readonly y: AnatomicalDirection;
  readonly z: AnatomicalDirection;
}

export interface AxisConvention extends AxisConventionSpec {
  /**
   * Rotation taking a vector expressed in this convention into the canonical basis.
   * Columns are the convention's basis axes expressed canonically.
   */
  readonly toCanonical: Mat3;
  /** Inverse of `toCanonical`. Orthonormal, so this is its transpose. */
  readonly fromCanonical: Mat3;
}

/**
 * Validate and complete a convention.
 *
 * Rejects, with a message naming the problem:
 *  - a repeated or opposed axis pair, which would make the basis degenerate;
 *  - a left-handed triple, which is a mirrored skeleton waiting to happen.
 */
export function defineConvention(spec: AxisConventionSpec): AxisConvention {
  const axes: ReadonlyArray<[string, AnatomicalDirection]> = [
    ['x', spec.x],
    ['y', spec.y],
    ['z', spec.z],
  ];

  for (let i = 0; i < axes.length; i++) {
    for (let j = i + 1; j < axes.length; j++) {
      const a = axes[i];
      const b = axes[j];
      if (!a || !b) continue;
      if (a[1] === b[1]) {
        throw new Error(
          `Convention '${spec.id}': axes ${a[0]} and ${b[0]} both point '${a[1]}'. ` +
            'A convention needs three mutually perpendicular directions.',
        );
      }
      if (OPPOSITE[a[1]] === b[1]) {
        throw new Error(
          `Convention '${spec.id}': axis ${a[0]} points '${a[1]}' and axis ${b[0]} points ` +
            `'${b[1]}', which are opposite. A convention needs three mutually perpendicular ` +
            'directions, not a collinear pair.',
        );
      }
    }
  }

  const toCanonical = fromColumns(
    CANONICAL_DIRECTION[spec.x],
    CANONICAL_DIRECTION[spec.y],
    CANONICAL_DIRECTION[spec.z],
  );

  if (!isRotation(toCanonical)) {
    const det = determinant(toCanonical);
    throw new Error(
      `Convention '${spec.id}' (x=${spec.x}, y=${spec.y}, z=${spec.z}) is left-handed: its ` +
        `determinant is ${det}, not +1. A left-handed convention would mirror the model. ` +
        'Flip one axis to its opposite direction.',
    );
  }

  return {
    ...spec,
    toCanonical,
    fromCanonical: transpose(toCanonical),
  };
}

// ---------------------------------------------------------------------------------------------
// The conventions this project actually uses.
// ---------------------------------------------------------------------------------------------

/**
 * **The canonical world frame for bs-humany.** Everything in HSDL, every channel buffer, and
 * everything handed to a physics backend or to three.js is expressed in this frame.
 *
 *  - `+X` is the subject's **right**
 *  - `+Y` is **superior** (up)
 *  - `+Z` is **posterior**, so the subject's anterior is `-Z`
 *
 * Right-handed, Y-up, as the specification requires.
 *
 * Two deliberate choices worth recording, because both are load-bearing and neither is forced:
 *
 * 1. **`+X` is the subject's right**, so `femur_r` sits at positive X. Left/right sign errors are
 *    the likeliest data-entry bug across ~206 bones, and this removes a mental negation from every
 *    one of them.
 * 2. **The subject faces `-Z`**, which matches three.js's own object-forward convention -- an
 *    `Object3D` looks down its local `-Z`. The skeleton's anterior is therefore its forward, and
 *    `lookAt` behaves the way a reader expects. The default camera consequently sits at negative Z
 *    for a front view, which is one line in the viewer.
 */
export const WORLD: AxisConvention = defineConvention({
  id: 'world',
  description:
    'bs-humany canonical world frame. X right, Y superior, Z posterior. Right-handed, Y-up, ' +
    'aligned with three.js object-forward (-Z).',
  x: 'right',
  y: 'superior',
  z: 'posterior',
});

/**
 * The ISB global frame, as recommended by Wu et al. (2002) and used by OpenSim and by the
 * Rajagopal 2016 model.
 *
 *  - `+X` is **anterior** (the direction of walking)
 *  - `+Y` is **superior**
 *  - `+Z` is the subject's **right**
 *
 * Also right-handed and Y-up, so converting to `WORLD` is a permutation with a sign flip -- a
 * proper rotation of +90 degrees about Y -- and *not* a handedness change. The specification calls
 * this out explicitly because assuming a handedness flip here would mirror the entire model.
 */
export const ISB: AxisConvention = defineConvention({
  id: 'isb',
  description:
    'ISB / OpenSim / Rajagopal 2016 global frame. X anterior, Y superior, Z right. Right-handed.',
  source: 'wu2002',
  x: 'anterior',
  y: 'superior',
  z: 'right',
});

/**
 * Alias for `ISB`. OpenSim models, including Rajagopal 2016, use the ISB global convention, so the
 * two are the same frame. Named separately because model-facing code reads more clearly as
 * `OPENSIM` and because the two could in principle diverge.
 */
export const OPENSIM: AxisConvention = ISB;

/**
 * A Z-up convention, for interoperating with tools that use it (Blender's default, many CAD
 * packages, some motion-capture exports).
 *
 * Nothing in the core uses this. It exists so that the day someone needs it, they reach for a
 * tested conversion instead of writing a matrix by hand at the call site.
 */
export const Z_UP: AxisConvention = defineConvention({
  id: 'z_up',
  description: 'Z-up right-handed frame. X right, Y anterior, Z superior. Blender-style.',
  x: 'right',
  y: 'anterior',
  z: 'superior',
});

export const CONVENTIONS: Readonly<Record<string, AxisConvention>> = Object.freeze({
  world: WORLD,
  isb: ISB,
  z_up: Z_UP,
});

// ---------------------------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------------------------

/**
 * Rotation matrix taking coordinates expressed in `from` to coordinates expressed in `to`.
 *
 * Derived by routing through the canonical basis: `M = fromCanonical(to) * toCanonical(from)`.
 */
export function conversionMatrix(from: AxisConvention, to: AxisConvention): Mat3 {
  return multiplyMat3(to.fromCanonical, from.toCanonical);
}

/** Convert a position, displacement, velocity, force, or any other true vector. */
export function convertVec3(v: Vec3, from: AxisConvention, to: AxisConvention): Vec3 {
  if (from.id === to.id) return v;
  return transformVec3(conversionMatrix(from, to), v);
}

/**
 * Convert an orientation.
 *
 * A rotation is not a vector and does **not** convert by applying the change of basis once. It is
 * a similarity transform: `R_to = M R_from M^-1`. Applying the vector rule to a quaternion is a
 * classic and very quiet bug -- it produces an orientation that is correct for some inputs and
 * wrong for others, so it survives a spot check.
 */
export function convertQuat(q: Quat, from: AxisConvention, to: AxisConvention): Quat {
  if (from.id === to.id) return q;
  const m = quatFromMat3(conversionMatrix(from, to));
  return multiplyQuat(multiplyQuat(m, q), conjugate(m));
}

/**
 * Convert an inertia tensor or any other rank-2 tensor.
 *
 * Same similarity rule as orientation: `I_to = M I_from M^T`.
 */
export function convertTensor(tensor: Mat3, from: AxisConvention, to: AxisConvention): Mat3 {
  if (from.id === to.id) return tensor;
  const m = conversionMatrix(from, to);
  return multiplyMat3(multiplyMat3(m, tensor), transpose(m));
}

/**
 * The unit vector pointing in an anatomical direction, expressed in the given convention.
 *
 * Lets data authors write `anatomicalAxis('superior', WORLD)` instead of remembering whether up is
 * Y or Z in the frame they are currently in.
 */
export function anatomicalAxis(
  direction: AnatomicalDirection,
  convention: AxisConvention = WORLD,
): Vec3 {
  return transformVec3(convention.fromCanonical, CANONICAL_DIRECTION[direction]);
}

/** Which anatomical direction a convention's named axis points along. */
export function axisDirection(
  convention: AxisConvention,
  axis: 'x' | 'y' | 'z',
): AnatomicalDirection {
  return convention[axis];
}
