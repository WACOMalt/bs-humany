/**
 * Muscle and ligament attachment sites.
 *
 * **Nothing in Phase 1 reads this.** It exists because spec section 14.5 obligation 2 requires it:
 *
 * > Retrofitting attachment geometry after the bone frames have drifted is painful.
 *
 * A muscle module arriving in Phase 3 needs origins and insertions in *bone-local* coordinates, on
 * bones that may or may not be independent rigid bodies at the time. If those coordinates are
 * added after the frames have been revised a few times, every one of them has to be re-derived.
 * Adding the section now, populated for major landmarks, costs almost nothing and keeps the
 * Phase 3 path open.
 *
 * Wrapping surfaces are here for the same reason: MuJoCo supports them natively as tendon
 * wrapping geometry, and a muscle path that cannot route around bone passes through it.
 */

import { z } from 'zod';
import { CitationSchema } from './citation.js';
import { ScalarExprSchema } from './expr.js';
import { ExtensionsSchema } from './extensions.js';
import { IdSchema, TransformSchema } from './primitives.js';

export const AttachmentKindSchema = z.enum([
  'muscle_origin',
  'muscle_insertion',
  'ligament',
  'tendon_via_point',
]);

export const AttachmentSiteDefSchema = z
  .object({
    id: IdSchema,
    /** Bone the site is fixed to, in that bone's local frame. */
    bone: IdSchema,
    kind: AttachmentKindSchema,
    displayName: z.string().min(1),
    position: z.object({ x: ScalarExprSchema, y: ScalarExprSchema, z: ScalarExprSchema }).strict(),
    /**
     * Name of the structure that attaches here, where known. Free text in Phase 1 -- a muscle
     * module will define its own identifier space and bind through `ext`.
     */
    structure: z.string().min(1).optional(),
    source: CitationSchema,
    ext: ExtensionsSchema,
  })
  .strict();

z.globalRegistry.add(AttachmentSiteDefSchema, { id: 'AttachmentSiteDef' });

export type AttachmentSiteDef = z.infer<typeof AttachmentSiteDefSchema>;

/**
 * A surface a muscle or tendon path routes around.
 *
 * Cylinders and ellipsoids only, matching what MuJoCo's tendon wrapping supports natively.
 */
export const WrappingSurfaceDefSchema = z
  .object({
    id: IdSchema,
    bone: IdSchema,
    displayName: z.string().min(1),
    /** Placement in the bone's local frame. */
    transform: TransformSchema,
    shape: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('cylinder'),
          radius: ScalarExprSchema,
          length: ScalarExprSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('ellipsoid'),
          radii: z
            .object({ x: ScalarExprSchema, y: ScalarExprSchema, z: ScalarExprSchema })
            .strict(),
        })
        .strict(),
    ]),
    source: CitationSchema.optional(),
    ext: ExtensionsSchema,
  })
  .strict();

export type WrappingSurfaceDef = z.infer<typeof WrappingSurfaceDefSchema>;
