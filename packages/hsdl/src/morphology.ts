/**
 * Morphology parameters.
 *
 * Spec section 6. `sex` is a **blend coefficient over two complete parameter sets**, not a scale
 * factor: two endpoint tables -- female-typical and male-typical -- covering segment inertial
 * parameters from de Leva (1996), skeletal dimensions and proportion ratios from ANSUR II, and
 * joint ranges where sex differences are documented.
 *
 * **The honesty constraint (spec section 6.3) is a hard requirement, not a nicety.** A blend at
 * `sex = 0.5` is a modelling convenience for exploring the parameter space. It is not an
 * anthropometric description of any real population, and it is emphatically not a model of
 * intersex anatomy. The UI label is fixed here, in the schema, rather than left to each call site,
 * because getting it wrong is both scientifically sloppy and needlessly alienating.
 *
 * Population limitations are carried in the data for the same reason: de Leva's sample is
 * college-aged Caucasian adults, ANSUR II sampled US military personnel. Neither is a universal
 * human norm, and both must be documented rather than papered over.
 */

import { z } from 'zod';
import { CitationSchema } from './citation.js';
import { ExtensionsSchema } from './extensions.js';

/**
 * The label the UI must use for the `sex` control.
 *
 * Spec section 6.3 requires the control be described in terms of *skeletal proportions* rather
 * than identity. Defined once, here, so it cannot drift between panels.
 */
export const SEX_PARAMETER_LABEL = 'Skeletal proportions: female-typical to male-typical';

export const SEX_PARAMETER_NOTE =
  'A blend is a modelling convenience for exploring the parameter space. Intermediate values do ' +
  'not describe any real population and are not a model of intersex anatomy. Endpoint tables ' +
  'derive from specific source populations: de Leva (1996) sampled college-aged adults, and ' +
  'ANSUR II sampled US military personnel.';

export const MorphologySchema = z
  .object({
    /** 0.0 = female-typical, 1.0 = male-typical. See the note above before adding UI for this. */
    sex: z.number().min(0).max(1),
    /** Standing height, metres. */
    stature: z.number().finite().positive(),
    /** Total body mass, kilograms. */
    mass: z.number().finite().positive(),
    /**
     * Position in the ANSUR II distribution for the blended sex, 0..1. A convenience input that
     * fills stature, mass and proportions together.
     */
    percentile: z.number().min(0).max(1).optional(),
    /** Independent overrides. Default derived from sex and stature. */
    proportions: z
      .object({
        biiliacBreadth: z.number().finite().positive().optional(),
        biacromialBreadth: z.number().finite().positive().optional(),
        /** Tibia / femur length ratio. */
        crural: z.number().finite().positive().optional(),
        /** Radius / humerus length ratio. */
        brachial: z.number().finite().positive().optional(),
        relativeLegLength: z.number().finite().positive().optional(),
      })
      .strict()
      .optional(),
    /** 0 = perfectly symmetric. Small values add realistic left/right variation. */
    asymmetry: z.number().min(0).max(1).optional(),
  })
  .strict();

export type Morphology = z.infer<typeof MorphologySchema>;

/**
 * Declares which morphology parameters a document responds to, and their valid ranges.
 *
 * Separate from `Morphology` -- that is an instance, this is the contract the document offers.
 */
export const MorphologySpecSchema = z
  .object({
    /** Default instance, used when none is supplied. */
    default: MorphologySchema,
    /** Allowed stature range, metres. Outside this the dimension expressions are extrapolating. */
    statureRange: z.tuple([z.number().positive(), z.number().positive()]),
    massRange: z.tuple([z.number().positive(), z.number().positive()]),
    /**
     * Source populations behind the endpoint tables. **Required**, and surfaced in the UI, so a
     * user can see whose bodies this model is actually describing.
     */
    populations: z
      .array(
        z
          .object({
            describes: z.string().min(1),
            limitation: z.string().min(1),
            source: CitationSchema,
          })
          .strict(),
      )
      .min(1),
    ext: ExtensionsSchema,
  })
  .strict()
  .refine((m) => m.statureRange[0] < m.statureRange[1], 'statureRange must be ordered [min, max].')
  .refine((m) => m.massRange[0] < m.massRange[1], 'massRange must be ordered [min, max].');

z.globalRegistry.add(MorphologySchema, { id: 'Morphology' });
z.globalRegistry.add(MorphologySpecSchema, { id: 'MorphologySpec' });

export type MorphologySpec = z.infer<typeof MorphologySpecSchema>;
