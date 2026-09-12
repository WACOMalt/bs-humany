/**
 * Inertia computation and combination.
 *
 * Spec section 6.4 step 5 makes physical validity a **required test, not an optional check**: a
 * physically impossible inertia tensor produces subtly wrong dynamics that is very hard to
 * diagnose downstream. A solver handed a tensor violating the triangle inequality does not crash.
 * It produces motion that looks almost right.
 *
 * ## Axis mapping, stated explicitly because it is easy to swap
 *
 * de Leva names his three radii of gyration by anatomical plane and axis:
 *
 * | de Leva name   | Axis it is measured about | World axis (neutral pose) | Motion about it     |
 * |----------------|---------------------------|---------------------------|---------------------|
 * | `sagittal`     | antero-posterior          | Z                         | lateral bending     |
 * | `transverse`   | medio-lateral             | X                         | flexion / extension |
 * | `longitudinal` | the segment's long axis   | Y                         | axial rotation      |
 *
 * The assignment can be checked rather than taken on faith. For the trunk, mass is spread further
 * medio-laterally (width) than antero-posteriorly (depth), so the moment about the antero-posterior
 * axis must exceed the moment about the medio-lateral axis. de Leva's male trunk gives sagittal
 * 0.372 against transverse 0.347, which is consistent only with `sagittal` naming the
 * antero-posterior axis. For every limb segment `longitudinal` is much the smallest, as it must be
 * for a long thin body. Both checks are asserted in the tests.
 *
 * In a **bone's local frame** the long axis is Y by convention, so `Iyy` takes the longitudinal
 * radius and the other two follow the segment's orientation.
 */

import {
  type Mat3,
  type Vec3,
  addMat3,
  at,
  determinant,
  diagonal,
  isSymmetric,
  multiplyMat3,
  transpose,
  vec3,
} from '@bs-humany/frames';
import type { RadiiOfGyration, SegmentInertialParameters } from './deleva.js';

/** A rigid body's mass properties, expressed about its own centre of mass. */
export interface MassProperties {
  /** Kilograms. */
  readonly mass: number;
  /** Centre of mass, metres, in whatever frame the caller is working in. */
  readonly com: Vec3;
  /** Inertia tensor about the centre of mass, kg*m^2, in that same frame. */
  readonly inertia: Mat3;
}

/**
 * Principal moments of inertia for a segment, about its centre of mass, in the segment's local
 * frame with the long axis along Y.
 *
 * `I = m * k^2`, where `k` is a radius of gyration in metres -- de Leva's fractions multiplied by
 * the segment length.
 */
export function inertiaFromRadiiOfGyration(
  mass: number,
  segmentLength: number,
  radii: RadiiOfGyration,
): Mat3 {
  if (!(mass > 0)) {
    throw new Error(`Segment mass must be positive, got ${mass} kg.`);
  }
  if (!(segmentLength > 0)) {
    throw new Error(
      `Segment length must be positive, got ${segmentLength} m. A zero-length segment has no ` +
        'inertia and usually means a dimension expression resolved against a missing parameter.',
    );
  }

  const kTransverse = radii.transverse * segmentLength;
  const kLongitudinal = radii.longitudinal * segmentLength;
  const kSagittal = radii.sagittal * segmentLength;

  // Local X is medio-lateral, Y is the long axis, Z is antero-posterior. See the module comment.
  return diagonal(
    vec3(
      mass * kTransverse * kTransverse,
      mass * kLongitudinal * kLongitudinal,
      mass * kSagittal * kSagittal,
    ),
  );
}

/** Full mass properties for one de Leva segment at a given body mass and segment length. */
export function segmentMassProperties(
  parameters: SegmentInertialParameters,
  bodyMass: number,
  segmentLength: number,
): MassProperties {
  const mass = parameters.relativeMass * bodyMass;
  // The centre of mass lies along the long axis, measured distally from the proximal joint
  // centre. Local Y points proximally, so the offset is negative.
  const com = vec3(0, -parameters.comFromProximal * segmentLength, 0);
  return {
    mass,
    com,
    inertia: inertiaFromRadiiOfGyration(mass, segmentLength, parameters.radiiOfGyration),
  };
}

/**
 * Translate an inertia tensor from the centre of mass to a parallel frame offset by `offset`.
 *
 * `I_new = I_com + m * (|d|^2 * E - d (x) d)`, the parallel-axis theorem in tensor form. This is
 * what makes lumping segments possible: a fidelity profile that simulates the torso as one rigid
 * body combines several de Leva segments through this.
 */
export function translateInertia(inertia: Mat3, mass: number, offset: Vec3): Mat3 {
  const { x, y, z } = offset;
  const distanceSquared = x * x + y * y + z * z;

  const shift: Mat3 = [
    mass * (distanceSquared - x * x),
    mass * -(x * y),
    mass * -(x * z),
    mass * -(y * x),
    mass * (distanceSquared - y * y),
    mass * -(y * z),
    mass * -(z * x),
    mass * -(z * y),
    mass * (distanceSquared - z * z),
  ];

  return addMat3(inertia, shift);
}

/** Rotate an inertia tensor into another frame: `I' = R I R^T`. */
export function rotateInertia(inertia: Mat3, rotation: Mat3): Mat3 {
  return multiplyMat3(multiplyMat3(rotation, inertia), transpose(rotation));
}

/**
 * Combine several bodies into one.
 *
 * Masses add, centres of mass combine as a weighted average, and each body's inertia is shifted to
 * the combined centre of mass by the parallel-axis theorem before summing. All inputs must already
 * be expressed in a common frame.
 */
export function combineMassProperties(parts: readonly MassProperties[]): MassProperties {
  if (parts.length === 0) {
    throw new Error('Cannot combine zero bodies.');
  }
  if (parts.length === 1) {
    const only = parts[0];
    if (!only) throw new Error('Cannot combine zero bodies.');
    return only;
  }

  let totalMass = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const part of parts) {
    totalMass += part.mass;
    cx += part.com.x * part.mass;
    cy += part.com.y * part.mass;
    cz += part.com.z * part.mass;
  }
  if (!(totalMass > 0)) {
    throw new Error(`Combined mass must be positive, got ${totalMass} kg.`);
  }

  const com = vec3(cx / totalMass, cy / totalMass, cz / totalMass);

  let inertia: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const part of parts) {
    const offset = vec3(part.com.x - com.x, part.com.y - com.y, part.com.z - com.z);
    inertia = addMat3(inertia, translateInertia(part.inertia, part.mass, offset));
  }

  return { mass: totalMass, com, inertia };
}

export interface InertiaValidation {
  readonly valid: boolean;
  readonly problems: readonly string[];
}

/**
 * Check that an inertia tensor describes a physically possible rigid body.
 *
 * Three conditions, all necessary:
 *
 * 1. **Finite.** A NaN propagates silently through a whole kinematic chain.
 * 2. **Symmetric and positive definite.** An inertia tensor is symmetric by construction, and its
 *    principal moments are positive for any body with mass.
 * 3. **Triangle inequality.** For principal moments `I1, I2, I3`, each must be no greater than the
 *    sum of the other two. This is not a convention -- it follows from the moments being integrals
 *    of squared distances, and no distribution of mass can violate it. A tensor that does describes
 *    no object, and a solver handed one produces motion that looks almost right.
 *
 * Spec section 6.4 makes this a required test.
 */
export function validateInertia(inertia: Mat3, tolerance = 1e-9): InertiaValidation {
  const problems: string[] = [];

  for (let i = 0; i < 9; i++) {
    if (!Number.isFinite(inertia[i] ?? Number.NaN)) {
      problems.push(`Inertia tensor contains a non-finite value at index ${i}.`);
      return { valid: false, problems };
    }
  }

  if (!isSymmetric(inertia, 1e-6)) {
    problems.push(
      'Inertia tensor is not symmetric. Products of inertia must satisfy Ixy = Iyx, and an ' +
        'asymmetric tensor usually means a parallel-axis shift was applied with the wrong sign.',
    );
  }

  const moments = principalMoments(inertia);
  const [i1, i2, i3] = moments;

  for (const [index, moment] of moments.entries()) {
    if (moment <= 0) {
      problems.push(
        `Principal moment ${index} is ${moment}, which is not positive. Every body with mass has ` +
          'strictly positive principal moments.',
      );
    }
  }

  // Scale the tolerance to the magnitudes involved, so the check means the same thing for a
  // phalanx and for a torso.
  const scale = Math.max(Math.abs(i1), Math.abs(i2), Math.abs(i3), tolerance);
  const slack = tolerance * scale;

  const checks: ReadonlyArray<readonly [number, number, number, string]> = [
    [i1, i2, i3, 'I1 <= I2 + I3'],
    [i2, i1, i3, 'I2 <= I1 + I3'],
    [i3, i1, i2, 'I3 <= I1 + I2'],
  ];
  for (const [a, b, c, label] of checks) {
    if (a > b + c + slack) {
      problems.push(
        `Inertia tensor violates the triangle inequality (${label}): ${a} > ${b} + ${c}. No ` +
          'distribution of mass produces this tensor, so it describes no physical object. Check ' +
          'the radii of gyration and the axis assignment.',
      );
    }
  }

  return { valid: problems.length === 0, problems };
}

/** Throwing form, for use at model-build time where an invalid tensor must stop the build. */
export function assertValidInertia(inertia: Mat3, context: string): void {
  const result = validateInertia(inertia);
  if (!result.valid) {
    throw new Error(`Invalid inertia tensor for ${context}:\n  ${result.problems.join('\n  ')}`);
  }
}

/**
 * Principal moments, in ascending order.
 *
 * For a diagonal tensor these are the diagonal entries. For a general symmetric tensor they are
 * its eigenvalues, obtained here in closed form: the analytic solution for a symmetric 3x3 is
 * exact and allocation-free, where an iterative solver would be neither.
 */
export function principalMoments(inertia: Mat3): [number, number, number] {
  const m01 = at(inertia, 0, 1);
  const m02 = at(inertia, 0, 2);
  const m12 = at(inertia, 1, 2);

  const offDiagonalMagnitude = Math.abs(m01) + Math.abs(m02) + Math.abs(m12);
  const diagonalMagnitude =
    Math.abs(at(inertia, 0, 0)) + Math.abs(at(inertia, 1, 1)) + Math.abs(at(inertia, 2, 2));

  if (offDiagonalMagnitude <= 1e-12 * Math.max(diagonalMagnitude, 1)) {
    const values: [number, number, number] = [
      at(inertia, 0, 0),
      at(inertia, 1, 1),
      at(inertia, 2, 2),
    ];
    return values.sort((a, b) => a - b) as [number, number, number];
  }

  // Closed-form eigenvalues of a symmetric 3x3 (Smith 1961), which stays accurate where the
  // characteristic polynomial's roots are clustered.
  const p1 = m01 * m01 + m02 * m02 + m12 * m12;
  const trace = at(inertia, 0, 0) + at(inertia, 1, 1) + at(inertia, 2, 2);
  const q = trace / 3;
  const d0 = at(inertia, 0, 0) - q;
  const d1 = at(inertia, 1, 1) - q;
  const d2 = at(inertia, 2, 2) - q;
  const p2 = d0 * d0 + d1 * d1 + d2 * d2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);

  const b: Mat3 = [
    d0 / p,
    at(inertia, 1, 0) / p,
    at(inertia, 2, 0) / p,
    m01 / p,
    d1 / p,
    at(inertia, 2, 1) / p,
    m02 / p,
    m12 / p,
    d2 / p,
  ];

  const r = determinant(b) / 2;
  const phi = r <= -1 ? Math.PI / 3 : r >= 1 ? 0 : Math.acos(r) / 3;

  const eig1 = q + 2 * p * Math.cos(phi);
  const eig3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const eig2 = trace - eig1 - eig3;

  return [eig3, eig2, eig1].sort((a, b2) => a - b2) as [number, number, number];
}
