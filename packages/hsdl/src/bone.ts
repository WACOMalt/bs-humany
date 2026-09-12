/**
 * Bone definitions -- the anatomical layer.
 *
 * Per ADR-001 the anatomical layer is **always complete**: all ~206 bones, always present, always
 * with a valid world transform, regardless of which fidelity profile is active. A bone is not
 * necessarily a rigid body. Which bones get promoted to rigid bodies is a property of the
 * segmentation (see `segmentation.ts`), not of the bone.
 *
 * Bone `id`s are the project's public ABI. Spec section 4.4: downstream modules bind to them, so
 * they MUST NOT change without a major HSDL version bump. A muscle module attaches an origin to
 * `humerus_r` whether or not the humerus is currently its own rigid body.
 */

import { z } from 'zod';
import { CitationSchema } from './citation.js';
import { ScalarExprSchema } from './expr.js';
import { ExtensionsSchema } from './extensions.js';
import { GeometryRecipeSchema } from './geometry.js';
import { DensitySchema, IdSchema, TransformExprSchema } from './primitives.js';

/**
 * How a bone's local frame is built from landmarks.
 *
 * Frames are declared as landmark references rather than as authored matrices, so a reviewer can
 * check the definition against the publication it came from. Nine hand-written numbers per bone,
 * across ~206 bones, could not be reviewed at all.
 */
export const FrameDefSchema = z
  .object({
    /** Landmark ID used as the frame origin. */
    origin: IdSchema,
    /** The frame's primary axis runs from this landmark toward `primaryTo`. */
    primaryFrom: IdSchema,
    primaryTo: IdSchema,
    primaryAxis: z.enum(['x', 'y', 'z']),
    /** A second direction fixing roll about the primary axis. Orthogonalized, not assumed square. */
    secondaryFrom: IdSchema,
    secondaryTo: IdSchema,
    secondaryAxis: z.enum(['x', 'y', 'z']),
    /** Where this frame convention comes from. ISB where a standard exists. */
    source: CitationSchema,
  })
  .strict()
  .refine(
    (f) => f.primaryAxis !== f.secondaryAxis,
    "A frame's primary and secondary axes must differ.",
  );

export type FrameDef = z.infer<typeof FrameDefSchema>;

/**
 * Per-axis redistribution weights. Spec section 4.3.
 *
 * When a segment lumps an articulated region -- a torso owning 24 vertebrae -- keeping the
 * followers rigid makes the bend appear as a single crease at the segment joint. Redistribution
 * spreads the parent joint's deflection across followers in proportion to these weights, so a
 * torso bending 30 degrees forward produces a smooth curve across L5 to T1.
 *
 * **Cosmetic only.** It runs after the solve, before rendering, and never feeds back into
 * dynamics. Mass properties come from the rest pose and are not updated by it. This is what lets
 * the fidelity slider change cost without changing the model's visual identity.
 */
export const RedistributionWeightsSchema = z
  .object({
    flexion: z.number().finite().nonnegative().optional(),
    lateralBending: z.number().finite().nonnegative().optional(),
    axialRotation: z.number().finite().nonnegative().optional(),
  })
  .strict();

export type RedistributionWeights = z.infer<typeof RedistributionWeightsSchema>;

export const BoneDefSchema = z
  .object({
    /** Stable, anatomically specific. `femur_r`, `vertebra_l3`, `metacarpal_3_l`, `scapula_r`. */
    id: IdSchema,
    /** Terminologia Anatomica term. Required -- it is the interlingua for anatomical naming. */
    ta: z.string().min(1),
    displayName: z.string().min(1),
    /**
     * Anatomical parent, which is **not necessarily the dynamic parent**. The anatomical tree is
     * about where a bone sits in the body plan. The dynamic tree is derived from segmentation.
     */
    parent: IdSchema.nullable(),
    /** Side, for paired bones. Unpaired bones omit it. */
    side: z.enum(['left', 'right']).optional(),
    /** Anatomical region, used for grouping in the UI and for region-scoped fidelity options. */
    region: z.enum([
      'skull',
      'cervical',
      'thoracic',
      'lumbar',
      'sacral',
      'thorax',
      'shoulder_girdle',
      'arm',
      'forearm',
      'hand',
      'pelvis',
      'thigh',
      'leg',
      'foot',
    ]),
    /**
     * Rest transform relative to the anatomical parent, in the anatomical neutral pose.
     *
     * The translation is expressed as expressions over morphology parameters, not as fixed
     * numbers. Spec section 6.4 step 3: joint centres follow from bone geometry, so a transform
     * pinned to absolute offsets would leave the skeleton coming apart at the joints the moment a
     * morphology slider moved.
     */
    restTransform: TransformExprSchema,
    frame: FrameDefSchema.optional(),
    /**
     * Named dimensions, as expressions over morphology parameters. Referenced by the geometry
     * recipe and by landmark positions, so one edit reshapes both together.
     */
    dimensions: z.record(z.string().min(1), ScalarExprSchema),
    geometry: GeometryRecipeSchema,
    /** kg/m^3, used only where a segment's inertia falls back to geometric estimation. */
    density: DensitySchema.optional(),
    redistribution: RedistributionWeightsSchema.optional(),
    ext: ExtensionsSchema,
  })
  .strict();

z.globalRegistry.add(BoneDefSchema, { id: 'BoneDef' });
z.globalRegistry.add(FrameDefSchema, { id: 'FrameDef' });

export type BoneDef = z.infer<typeof BoneDefSchema>;

export type BoneRegion = BoneDef['region'];
