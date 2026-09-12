/**
 * The HSDL document -- the single source of truth for a body.
 *
 * Per ADR-002, HSDL is a project-owned, versioned, JSON-serializable schema whose dynamics
 * semantics are a **superset of MJCF's**: kinematic tree, one joint element per degree of freedom,
 * per-DoF stiffness/damping/armature/range, equality constraints, contact-pair exclusion. On top of
 * that it adds what MuJoCo has no concept of -- anatomical taxonomy, fidelity profiles, morphology
 * parameters and module-binding metadata.
 *
 * Backend representations (MJCF, Rapier builder calls) are **compile targets**: generated from
 * this, never hand-edited, never round-tripped back.
 */

import { z } from 'zod';
import { AttachmentSiteDefSchema, WrappingSurfaceDefSchema } from './attachment.js';
import { BoneDefSchema } from './bone.js';
import { CitationSchema } from './citation.js';
import { CollisionProxySchema, ContactRuleDefSchema } from './collision.js';
import { ConstraintDefSchema } from './constraints.js';
import { ExtensionsSchema } from './extensions.js';
import { JointDefSchema } from './joint.js';
import { LandmarkDefSchema } from './landmark.js';
import { MorphologySpecSchema } from './morphology.js';
import { HSDL_VERSION } from './namespace.js';
import { SegmentationDefSchema } from './segmentation.js';

/**
 * Units are fixed, and are declared in the document so a reader never has to guess and a future
 * version can never quietly change them.
 *
 * SI everywhere. No degrees in the data model -- degrees exist only in UI display code.
 */
export const UnitsSchema = z
  .object({
    length: z.literal('m'),
    mass: z.literal('kg'),
    angle: z.literal('rad'),
    time: z.literal('s'),
    force: z.literal('N'),
  })
  .strict();

export const UNITS = Object.freeze({
  length: 'm',
  mass: 'kg',
  angle: 'rad',
  time: 's',
  force: 'N',
} as const);

export const HsdlDocumentSchema = z
  .object({
    hsdlVersion: z.literal(HSDL_VERSION),
    id: z.string().min(1),
    meta: z
      .object({
        name: z.string().min(1),
        description: z.string().min(1).optional(),
        /** Every source the document draws on, so provenance travels with the model. */
        sources: z.array(CitationSchema).min(1),
        /** Axis convention the document's transforms are expressed in. */
        convention: z.enum(['world', 'isb', 'z_up']).default('world'),
      })
      .strict(),
    units: UnitsSchema,

    bones: z.array(BoneDefSchema).min(1),
    landmarks: z.array(LandmarkDefSchema),
    joints: z.array(JointDefSchema),
    /** One entry per fidelity profile. */
    segmentation: z.array(SegmentationDefSchema).min(1),
    collisionProxies: z.array(CollisionProxySchema),
    contactRules: ContactRuleDefSchema,
    constraints: z.array(ConstraintDefSchema),
    morphology: MorphologySpecSchema,

    /** Reserved for the Phase 3 muscle module. Nothing in Phase 1 reads these. See section 14.2. */
    attachmentSites: z.array(AttachmentSiteDefSchema),
    wrappingSurfaces: z.array(WrappingSurfaceDefSchema).optional(),

    ext: ExtensionsSchema,
  })
  .strict();

export type HsdlDocument = z.infer<typeof HsdlDocumentSchema>;
