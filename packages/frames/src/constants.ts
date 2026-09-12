/**
 * Numeric tolerances shared across the frames package.
 *
 * These are deliberately explicit constants rather than inline magic numbers, because a tolerance
 * that drifts is a tolerance that stops catching bugs.
 */

/** Tolerance for treating a float as zero in normalization and orthogonality checks. */
export const EPSILON = 1e-10;

/** Tolerance for asserting a matrix is orthonormal or a quaternion is unit length. */
export const ORTHONORMAL_TOLERANCE = 1e-9;

/**
 * Below this, a vector is too short to define a direction reliably. Normalizing it would amplify
 * float noise into a meaningless direction, so the frame builders throw instead.
 */
export const MIN_DIRECTION_LENGTH = 1e-7;
