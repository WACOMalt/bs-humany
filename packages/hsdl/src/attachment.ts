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
import { IdSchema, TransformExprSchema } from './primitives.js';

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
 * Spheres, cylinders and ellipsoids. The first two are what MuJoCo's tendon wrapping supports
 * natively, and between them they cover every wrap surface in the reference arm model -- a
 * geodesic is a great circle on one and a helix on the other, so both have closed forms and both
 * are implemented (muscle module N1.4).
 *
 * The ellipsoid has neither: geodesics on it have no closed form and need an iterative solve.
 * It stays in the schema because published OpenSim models use them and the data should be
 * expressible before the solver catches up, but a path that names one is refused rather than
 * approximated. See OQ-016 and ticket N1.5.
 */
export const WrappingSurfaceDefSchema = z
  .object({
    id: IdSchema,
    bone: IdSchema,
    displayName: z.string().min(1),
    /**
     * Placement in the bone's local frame, as expressions over the morphology parameters.
     *
     * Expressions rather than fixed metres for the same reason bone rest transforms are (section
     * 6.4): a surface pinned to absolute numbers would stay where it was as the body changed size,
     * so the tendon that turns over it would be riding on nothing at any stature but the one it
     * was authored at. The radius has to scale with it, and does.
     */
    transform: TransformExprSchema,
    shape: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('sphere'),
          radius: ScalarExprSchema,
        })
        .strict(),
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
