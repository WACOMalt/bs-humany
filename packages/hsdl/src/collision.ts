/**
 * Collision proxies and contact rules.
 *
 * ADR-006: **collision geometry is never anatomical geometry.** Concave meshes at this body count
 * are not real-time, and vertebral and carpal geometry in particular would produce catastrophic
 * contact behaviour. Every dynamic segment therefore declares its own proxies, defined here
 * independently of render geometry.
 *
 * Convex hulls are stored as precomputed vertex lists. They are **never** generated at runtime
 * from render geometry -- that would cost frame time, and it would create a derivative-work path
 * from a licensed mesh pack straight into the core (ADR-009).
 */

import { z } from 'zod';
import { ScalarExprSchema } from './expr.js';
import { ExtensionsSchema } from './extensions.js';
import { IdSchema, TransformSchema, Vec3Schema } from './primitives.js';

export const CollisionProxySchema = z
  .object({
    id: IdSchema,
    /** Placement in the owning segment's frame. */
    transform: TransformSchema,
    shape: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('capsule'),
          radius: ScalarExprSchema,
          /** Length of the cylindrical section, excluding the hemispherical caps. */
          length: ScalarExprSchema,
        })
        .strict(),
      z.object({ kind: z.literal('sphere'), radius: ScalarExprSchema }).strict(),
      z
        .object({
          kind: z.literal('box'),
          halfExtents: z
            .object({ x: ScalarExprSchema, y: ScalarExprSchema, z: ScalarExprSchema })
            .strict(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('convexHull'),
          /**
           * Precomputed vertices in the proxy's local frame. Not generated at runtime -- see the
           * module comment.
           */
          vertices: z.array(Vec3Schema).min(4),
        })
        .strict(),
    ]),
    /** Collision group bitmask. Both backends support this natively. */
    group: z.number().int().nonnegative().optional(),
    /** Which groups this proxy collides with. */
    mask: z.number().int().nonnegative().optional(),
    ext: ExtensionsSchema,
  })
  .strict();

export type CollisionProxy = z.infer<typeof CollisionProxySchema>;

/**
 * Contact parameters for a class of pair.
 *
 * Bone-on-bone, bone-on-ground and bone-on-object genuinely want different values, so they are
 * named classes rather than one global setting.
 */
export const ContactParamsSchema = z
  .object({
    friction: z.number().finite().nonnegative(),
    restitution: z.number().finite().min(0).max(1),
    /** Solver softness. Higher is squishier. Interpretation is backend-specific but monotonic. */
    softness: z.number().finite().nonnegative().optional(),
  })
  .strict();

export type ContactParams = z.infer<typeof ContactParamsSchema>;

export const ContactRuleDefSchema = z
  .object({
    /**
     * Pairs that never collide.
     *
     * Naive all-pairs self-collision on a human skeleton explodes immediately, because adjacent
     * bones at a joint interpenetrate by design. Parent/child segment pairs are excluded
     * automatically by the compiler; this list is for the ones that are not adjacent but still
     * overlap -- scapula against ribs, pelvis against femoral head, the carpals.
     */
    exclude: z.array(z.tuple([IdSchema, IdSchema])).optional(),
    /** Named contact parameter classes. */
    classes: z.record(z.string().min(1), ContactParamsSchema).optional(),
    /** Which class applies to a given pair. Falls back to `defaultClass`. */
    assign: z
      .array(
        z
          .object({
            pair: z.tuple([IdSchema, IdSchema]),
            class: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    defaultClass: z.string().min(1).optional(),
    ext: ExtensionsSchema,
  })
  .strict();

z.globalRegistry.add(CollisionProxySchema, { id: 'CollisionProxy' });
z.globalRegistry.add(ContactRuleDefSchema, { id: 'ContactRuleDef' });

export type ContactRuleDef = z.infer<typeof ContactRuleDefSchema>;
