/**
 * Anatomical landmarks.
 *
 * Landmarks are the measurement substrate of the whole model. Bone local frames are built from
 * them, joint frames and joint centres follow from bone frames, and every joint definition follows
 * from those. They are the root of the dependency tree, not a leaf.
 *
 * **That is precisely why ADR-009 forbids picking them off mesh geometry.** A landmark coordinate
 * clicked on a CC BY-SA mesh is arguably a derivative of that mesh, and because landmarks
 * propagate into frames, centres and joints, one afternoon of convenient picking would carry a
 * Share-Alike obligation through the entire core.
 *
 * So every landmark carries a citation, and the citation is expected to resolve to a *textual*
 * source. The ISB recommendations define their landmarks as palpable bony features in prose.
 * Rajagopal 2016 documents its coordinate systems relative to named landmarks. MyoSuite's models
 * are Apache-2.0. These are also better provenance than a click position.
 *
 * Where a landmark cannot be derived from a citable source, use `provisional()` and record it in
 * `docs/sources/open-questions.md` rather than reaching for the mesh.
 */

import { z } from 'zod';
import { CitationSchema } from './citation.js';
import { type ScalarExpr, ScalarExprSchema } from './expr.js';
import { ExtensionsSchema } from './extensions.js';
import { IdSchema } from './primitives.js';

export const LandmarkDefSchema = z
  .object({
    /** Unique within the document. E.g. `femur_r__epicondylus_lateralis`. */
    id: IdSchema,
    /** The bone this landmark sits on. */
    bone: IdSchema,
    /** Terminologia Anatomica term, where the landmark has one. */
    ta: z.string().min(1).optional(),
    displayName: z.string().min(1),
    /**
     * Position in the owning bone's local frame, metres.
     *
     * Expressions, not constants, so landmarks move with morphology. A landmark pinned to a fixed
     * offset would drift off the bone as the bone rescales, which silently corrupts every frame
     * derived from it.
     */
    position: z.object({ x: ScalarExprSchema, y: ScalarExprSchema, z: ScalarExprSchema }).strict(),
    /**
     * Where this landmark's definition comes from. Required -- see the module comment.
     */
    source: CitationSchema,
    /**
     * True for landmarks that are palpable on a living subject.
     *
     * Motion-capture pipelines can only place markers on palpable features, so this flags which
     * landmarks are usable for comparison against marker-driven published data.
     */
    palpable: z.boolean().optional(),
    ext: ExtensionsSchema,
  })
  .strict();

z.globalRegistry.add(LandmarkDefSchema, { id: 'LandmarkDef' });

export type LandmarkDef = z.infer<typeof LandmarkDefSchema>;

/**
 * A landmark position, resolved.
 *
 * Convenience type for consumers that have already evaluated the expressions.
 */
export interface ResolvedLandmark {
  readonly id: string;
  readonly bone: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
}

export type LandmarkPosition = {
  readonly x: ScalarExpr;
  readonly y: ScalarExpr;
  readonly z: ScalarExpr;
};
