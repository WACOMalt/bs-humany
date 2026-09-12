/**
 * Shared primitive schemas.
 *
 * Units are SI throughout and are not negotiable per node: metres, kilograms, radians, seconds,
 * newtons. Degrees do not exist in the data model -- they appear only in UI code, converted at the
 * boundary by `@bs-humany/frames`.
 */

import { z } from 'zod';

/**
 * Identifier shape shared by bones, joints, segments and landmarks.
 *
 * Lowercase, snake_case, ASCII. Spec section 4.4: IDs are the ABI that downstream modules bind to,
 * so they must be stable and must not change without a major HSDL version bump.
 */
export const IdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'Identifiers are lowercase snake_case ASCII, starting with a letter. For example: femur_r, ' +
      'vertebra_l3, metacarpal_3_l.',
  );

export const Vec3Schema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  })
  .strict();

export const QuatSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
    w: z.number().finite(),
  })
  .strict()
  .refine(
    (q) => Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 1e-6,
    'Quaternions in HSDL must be unit length. A non-unit quaternion scales as it rotates, which ' +
      'shows up as a body that grows or shrinks while it turns.',
  );

export const TransformSchema = z
  .object({
    translation: Vec3Schema,
    rotation: QuatSchema,
  })
  .strict();

/** Metres. Non-negative, finite. */
export const LengthSchema = z.number().finite().nonnegative();

/** Kilograms. Strictly positive -- a zero-mass rigid body is a solver singularity. */
export const MassSchema = z.number().finite().positive();

/** Radians. No bounds: joint ranges legitimately exceed a half turn in a few places. */
export const AngleSchema = z.number().finite();

/** kg/m^3. */
export const DensitySchema = z.number().finite().positive();

z.globalRegistry.add(Vec3Schema, { id: 'Vec3' });
z.globalRegistry.add(QuatSchema, { id: 'Quat' });
z.globalRegistry.add(TransformSchema, { id: 'Transform' });
z.globalRegistry.add(IdSchema, { id: 'Id' });

export type Vec3Data = z.infer<typeof Vec3Schema>;
export type QuatData = z.infer<typeof QuatSchema>;
export type TransformData = z.infer<typeof TransformSchema>;

export const IDENTITY_TRANSFORM_DATA: TransformData = {
  translation: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
};
