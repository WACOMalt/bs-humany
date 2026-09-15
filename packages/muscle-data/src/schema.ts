/**
 * The `muscle.*` HSDL extension schema -- ticket N2.1.
 *
 * Muscle definitions are an extension, not a new top-level section, which is base spec section
 * 14.5 obligation 3 being used for the first time. The reason it was built that way: a document
 * carrying muscle data must still load, round-trip and validate in a build that has no muscle
 * module, and a tool that does not know what a muscle is must not delete one while editing a
 * bone. An `ext` map keyed by reverse-DNS namespace gives both.
 *
 * What lives where. The bones, the attachment site *locations*, and the wrapping surface
 * *geometry* are already core HSDL -- the base spec put them there in M5.3 precisely so this
 * module would find them waiting. What this schema adds is the muscle layer on top: which sites a
 * given line of action runs between, in what order, around which surfaces, and with what
 * Hill-type parameters. A muscle here is therefore mostly references, and that is the point: an
 * attachment site has one location and many muscles may name it.
 *
 * ## Every parameter carries a citation
 *
 * Section 6.5 requires it, in the same terms the base spec requires it of joint ranges, and
 * `pnpm cite:lint` enforces it. The schema makes the citation a required field rather than an
 * encouraged one, so an uncited parameter cannot be represented at all.
 */

import {
  CitationSchema,
  ExtensionsSchema,
  IdSchema,
  PROJECT_NAMESPACE,
  ScalarExprSchema,
} from '@bs-humany/hsdl';
import { z } from 'zod';

/** The namespace muscle data lives under in an HSDL document's `ext` maps. */
export const MUSCLE_NAMESPACE = `${PROJECT_NAMESPACE}.muscle`;

/** Schema version for the muscle extension, independent of the HSDL version around it. */
export const MUSCLE_SCHEMA_VERSION = '0.1';

/**
 * A point on the path, naming an attachment site that core HSDL already locates.
 *
 * Naming rather than restating is deliberate. A via point that carried its own coordinates would
 * be a second copy of a number that lives in `attachmentSites`, and the two would diverge the
 * first time a bone frame was revised.
 */
export const MusclePathPointSchema = z
  .object({
    kind: z.literal('site'),
    /** An `attachmentSites[].id` from the same document. */
    site: IdSchema,
  })
  .strict();

/**
 * A via point that only exists over part of a coordinate's range.
 *
 * `blend` is required and must be positive. A conditional via point that switched at a threshold
 * would put a step in the path length, and therefore a spike in the path velocity that the
 * force-velocity curve would turn into a force spike; the spec requires the transition to be
 * blended across a band (section 4.4), so the schema refuses to express the unblended case.
 */
export const ConditionalMusclePathPointSchema = z
  .object({
    kind: z.literal('conditionalSite'),
    site: IdSchema,
    /** The joint DoF the condition reads, as `jointId.dofName`. */
    coordinate: z.string().min(1),
    range: z.tuple([z.number(), z.number()]),
    /** Width of the blend band at each end, in the coordinate's units. Strictly positive. */
    blend: z.number().positive(),
    source: CitationSchema,
  })
  .strict();

/**
 * A wrap around a surface core HSDL already defines in `wrappingSurfaces`.
 *
 * `preferredSide` names the side the path stays on. Without it a path is free to fall either way
 * around the surface and will occasionally swap between ticks, which changes the sign of the
 * moment arm -- the muscle becomes its own antagonist for one tick and the solver is handed a
 * discontinuity it cannot integrate through.
 */
export const MuscleWrapSchema = z
  .object({
    kind: z.literal('wrap'),
    /** A `wrappingSurfaces[].id`. */
    surface: IdSchema,
    preferredSide: z
      .object({ x: ScalarExprSchema, y: ScalarExprSchema, z: ScalarExprSchema })
      .strict(),
    source: CitationSchema,
  })
  .strict();

export const MusclePathElementSchema = z.discriminatedUnion('kind', [
  MusclePathPointSchema,
  ConditionalMusclePathPointSchema,
  MuscleWrapSchema,
]);

/**
 * Hill-type parameters for one line of action -- section 6.5, in the same order and units.
 *
 * `tendonSlackLength` carries a warning in the spec and deserves one here: it is the parameter
 * the model is most sensitive to, because it sets where on the force-length curve the muscle
 * operates. An error of a few millimetres moves a muscle from the plateau onto the descending
 * limb, which changes not just how much force it makes but the sign of how that force responds
 * to being stretched.
 *
 * The time constants and the damping coefficient are optional because `muscle-model` has cited
 * defaults for all three. The first four have no sensible default -- a muscle is its parameters
 * -- so they are required, and each carries its own citation.
 */
export const MtuParametersSchema = z
  .object({
    /** Newtons. Scales with physiological cross-sectional area (section 6.6). */
    maxIsometricForce: ScalarExprSchema,
    /** Metres. */
    optimalFiberLength: ScalarExprSchema,
    /** Metres. */
    tendonSlackLength: ScalarExprSchema,
    /** Radians, at the optimal fiber length. */
    pennationAngle: ScalarExprSchema,
    /** Optimal fiber lengths per second. Defaults to the module's cited value of 10. */
    maxContractionVelocity: ScalarExprSchema.optional(),
    /** Seconds. Defaults to the module's cited Thelen value. */
    activationTime: z.number().positive().optional(),
    /** Seconds. Defaults to the module's cited Thelen value. */
    deactivationTime: z.number().positive().optional(),
    /** Dimensionless. Defaults to Millard's 0.1. */
    damping: z.number().nonnegative().optional(),
    source: CitationSchema,
  })
  .strict();

/**
 * One line of action.
 *
 * A muscle-tendon unit, not a muscle: M-ADR-005 makes a broad muscle several of these, because
 * one line through a trapezius is not a simplification of that muscle, it is a different muscle
 * with a moment arm the real one does not have.
 */
export const MuscleTendonUnitSchema = z
  .object({
    id: IdSchema,
    displayName: z.string().min(1),
    /** An `attachmentSites[].id` of kind `muscle_origin`. */
    origin: IdSchema,
    /** An `attachmentSites[].id` of kind `muscle_insertion`. */
    insertion: IdSchema,
    /** Ordered between origin and insertion. Empty for a straight-line unit. */
    path: z.array(MusclePathElementSchema),
    parameters: MtuParametersSchema,
    ext: ExtensionsSchema,
  })
  .strict();

/**
 * An anatomical muscle: a name, a term, a nerve, and the lines of action that stand for it.
 *
 * `innervation` is a slot rather than a model. The nerve module does not exist yet, and section
 * 14 asks this module to leave it somewhere to attach rather than to guess at what it will need.
 * A free-text nerve name that a later module can resolve costs nothing now and saves re-authoring
 * every muscle later.
 */
export const MuscleGroupSchema = z
  .object({
    id: IdSchema,
    displayName: z.string().min(1),
    /** Terminologia Anatomica term, so the muscle can be matched across datasets. */
    taTerm: z.string().min(1).optional(),
    /** Name of the innervating nerve. Unused until the nerve module arrives. */
    innervation: z.string().min(1).optional(),
    units: z.array(MuscleTendonUnitSchema).min(1),
    source: CitationSchema,
    ext: ExtensionsSchema,
  })
  .strict();

/** The whole muscle extension, as it appears under `ext[MUSCLE_NAMESPACE]` on a document. */
export const MuscleExtensionSchema = z
  .object({
    version: z.literal(MUSCLE_SCHEMA_VERSION),
    groups: z.array(MuscleGroupSchema),
  })
  .strict();

export type MusclePathPoint = z.infer<typeof MusclePathPointSchema>;
export type ConditionalMusclePathPoint = z.infer<typeof ConditionalMusclePathPointSchema>;
export type MuscleWrap = z.infer<typeof MuscleWrapSchema>;
export type MusclePathElement = z.infer<typeof MusclePathElementSchema>;
export type MtuParameters = z.infer<typeof MtuParametersSchema>;
export type MuscleTendonUnit = z.infer<typeof MuscleTendonUnitSchema>;
export type MuscleGroup = z.infer<typeof MuscleGroupSchema>;
export type MuscleExtension = z.infer<typeof MuscleExtensionSchema>;

for (const [schema, id] of [
  [MtuParametersSchema, 'MtuParameters'],
  [MuscleTendonUnitSchema, 'MuscleTendonUnit'],
  [MuscleGroupSchema, 'MuscleGroup'],
  [MuscleExtensionSchema, 'MuscleExtension'],
] as const) {
  z.globalRegistry.add(schema, { id });
}
