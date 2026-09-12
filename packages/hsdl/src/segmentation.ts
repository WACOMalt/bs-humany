/**
 * Segmentation -- the dynamic layer, and the fidelity axis.
 *
 * This is where ADR-001 becomes concrete. A `SegmentationDef` is one fidelity profile: it says
 * which bones are promoted to solver rigid bodies, and which ride along as kinematic followers.
 *
 * Every bone belongs to exactly one segment, in every profile. Exactly one bone per segment is the
 * **anchor** -- the segment's rigid body frame is the anchor bone's frame -- and the rest are
 * **followers**, posed at their rest transform relative to the anchor.
 *
 * Switching profile changes cost, not anatomy. The full ~206 bones stay present and renderable at
 * every level.
 */

import { z } from 'zod';
import { ExtensionsSchema } from './extensions.js';
import { IdSchema } from './primitives.js';

export const SegmentDefSchema = z
  .object({
    id: IdSchema,
    displayName: z.string().min(1),
    /**
     * The bone whose frame is this segment's rigid-body frame. Must appear in `bones`.
     */
    anchor: IdSchema,
    /** Every bone this segment owns, anchor included. */
    bones: z.array(IdSchema).min(1),
    /** Collision proxy IDs, resolved against the document's proxy definitions. */
    proxies: z.array(IdSchema).optional(),
    ext: ExtensionsSchema,
  })
  .strict()
  .refine((s) => s.bones.includes(s.anchor), {
    error: (issue) => {
      const s = issue.input as SegmentDefInput;
      return (
        `Segment '${s.id}' names anchor '${s.anchor}', which is not in its bone list. The anchor ` +
        "defines the segment's rigid-body frame, so it must be one of the bones the segment owns."
      );
    },
  })
  .refine((s) => new Set(s.bones).size === s.bones.length, {
    error: (issue) => {
      const s = issue.input as SegmentDefInput;
      return `Segment '${s.id}' lists the same bone more than once.`;
    },
  });

interface SegmentDefInput {
  readonly id: string;
  readonly anchor: string;
  readonly bones: readonly string[];
}

export type SegmentDef = z.infer<typeof SegmentDefSchema>;

/**
 * Solver settings that travel with a profile.
 *
 * Spec section 12 requires these be independently adjustable at runtime, so they are defaults
 * rather than fixed properties.
 */
export const SolverSettingsSchema = z
  .object({
    /** Physics rate, Hz. The spec calls out 240 / 500 / 1000 as the meaningful choices. */
    rate: z.number().int().min(30).max(4000),
    /** Solver iterations, or substeps, depending on backend. */
    iterations: z.number().int().min(1).max(255).optional(),
    /** Whether equality constraints are enforced at this fidelity. */
    equalityConstraints: z.boolean().optional(),
    /** Self-collision granularity. `none` is fastest and is honest about what it gives up. */
    selfCollision: z.enum(['none', 'coarse', 'full']).optional(),
  })
  .strict();

export type SolverSettings = z.infer<typeof SolverSettingsSchema>;

export const SegmentationDefSchema = z
  .object({
    /** `l0_ragdoll`, `l1_standard`, `l2_biomechanical`, `l3_anatomical`. */
    id: IdSchema,
    displayName: z.string().min(1),
    description: z.string().min(1),
    segments: z.array(SegmentDefSchema).min(1),
    /** Joints active in this profile. A joint whose two bones share a segment is dropped. */
    joints: z.array(IdSchema).optional(),
    defaultBackend: z.enum(['rapier', 'mujoco']).optional(),
    solver: SolverSettingsSchema.optional(),
    /**
     * What this profile gives up, in plain language, surfaced in the UI.
     *
     * Spec section 12: `L0-ragdoll` must say plainly that its spinal kinematics are cosmetic. A
     * fidelity control that only shows a quality label lets a user believe they are measuring
     * something they are not.
     */
    limitations: z.array(z.string().min(1)).min(1),
    ext: ExtensionsSchema,
  })
  .strict();

z.globalRegistry.add(SegmentationDefSchema, { id: 'SegmentationDef' });
z.globalRegistry.add(SegmentDefSchema, { id: 'SegmentDef' });

export type SegmentationDef = z.infer<typeof SegmentationDefSchema>;
