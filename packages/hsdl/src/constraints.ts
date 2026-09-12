/**
 * Equality constraints.
 *
 * Spec section 7.4. High-fidelity spinal articulation needs coupling: lumbar flexion distributes
 * across levels in roughly fixed proportions rather than each level moving independently. Without
 * it, a per-vertebra spine is a chain of free joints that folds in implausible places.
 *
 * MJCF supports this natively through `<equality>`. Rapier does not, and its backend MUST
 * implement these as a soft post-solve corrective module and MUST report them as approximated in
 * its capability report (ADR-002: silent approximation is forbidden).
 */

import { z } from 'zod';
import { CitationSchema } from './citation.js';
import { ExtensionsSchema } from './extensions.js';
import { IdSchema } from './primitives.js';

/** Reference to one degree of freedom: a joint ID and the DoF's index within that joint. */
export const DofRefSchema = z
  .object({
    joint: IdSchema,
    dof: z.number().int().nonnegative(),
  })
  .strict();

export type DofRef = z.infer<typeof DofRefSchema>;

export const ConstraintDefSchema = z
  .object({
    id: IdSchema,
    displayName: z.string().min(1).optional(),
    kind: z.discriminatedUnion('type', [
      /**
       * Linear coupling: `dependent = sum(coefficient_i * driver_i) + offset`.
       *
       * This is the form that expresses spinal level coupling, and the minimum the spec requires.
       */
      z
        .object({
          type: z.literal('jointCoupling'),
          dependent: DofRefSchema,
          drivers: z
            .array(z.object({ dof: DofRefSchema, coefficient: z.number().finite() }).strict())
            .min(1),
          offset: z.number().finite().optional(),
        })
        .strict(),
      /** Two bodies share a point. Used for closed loops such as the patella. */
      z
        .object({
          type: z.literal('weld'),
          bodyA: IdSchema,
          bodyB: IdSchema,
        })
        .strict(),
    ]),
    /**
     * Soft constraints are solved with a finite stiffness, so they may be violated under load.
     * Hard constraints are enforced exactly where the backend supports it.
     */
    soft: z.boolean().optional(),
    source: CitationSchema.optional(),
    ext: ExtensionsSchema,
  })
  .strict();

z.globalRegistry.add(ConstraintDefSchema, { id: 'ConstraintDef' });

export type ConstraintDef = z.infer<typeof ConstraintDefSchema>;
