/**
 * Procedural geometry recipes.
 *
 * Per ADR-005, Phase 1 renders bones as procedurally generated geometry rather than from vendored
 * meshes. The reason is not licensing -- it is that procedural geometry is **parametric**, so the
 * morphology controls reshape bones for free. Every dimension here is a `ScalarExpr`, so a recipe
 * responds to stature and to the sex blend without anyone writing interpolation code.
 *
 * A recipe is data, evaluated by the render module into a three.js `BufferGeometry`. Nothing in
 * this file imports three.js, and nothing in it knows how a triangle is made.
 *
 * **Provenance (ADR-009, CONTRIBUTING rule 5).** Profile curves must come from cited textual
 * descriptions or measured published dimensions. They must **not** be traced from CC BY-SA mesh
 * geometry: a profile traced off a licensed mesh is a derivative of it, and would propagate a
 * Share-Alike obligation into the core. Meshes render. They do not measure.
 *
 * Quality bar for Phase 1: a person familiar with anatomy should recognize each bone and judge the
 * proportions credible. Not medical-illustration quality.
 */

import { z } from 'zod';
import { type ScalarExpr, ScalarExprSchema } from './expr.js';
import { TransformExprSchema } from './primitives.js';

/** Which local axis a recipe extrudes or revolves along. Defaults to the bone's long axis, `y`. */
export const AxisSchema = z.enum(['x', 'y', 'z']);
export type Axis = z.infer<typeof AxisSchema>;

/** A closed cross-section, in the plane perpendicular to the recipe's axis. */
export const ProfileSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ellipse'),
      /** Semi-axis along the section's local first axis. */
      radiusA: ScalarExprSchema,
      /** Semi-axis along the section's local second axis. Equal to `radiusA` gives a circle. */
      radiusB: ScalarExprSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('polygon'),
      /** Ordered, counter-clockwise seen down the positive axis. At least three points. */
      points: z.array(z.object({ u: ScalarExprSchema, v: ScalarExprSchema }).strict()).min(3),
    })
    .strict(),
]);
export type Profile = z.infer<typeof ProfileSchema>;

export const LoftSectionSchema = z
  .object({
    /** Distance along the recipe's axis from the origin, metres. Sections are sorted by this. */
    at: ScalarExprSchema,
    profile: ProfileSchema,
    /**
     * Lateral displacement of this section's centre, perpendicular to the axis.
     *
     * This is what gives a bone its curve. A femur's anterior bow and a rib's arc are offsets, not
     * rotations -- modelling them as a bent axis rather than a twisted one keeps the local frame
     * aligned with the mechanical long axis, which is what joints and inertia are defined against.
     */
    offset: z.object({ u: ScalarExprSchema, v: ScalarExprSchema }).strict().optional(),
    /** Twist of this section about the axis, radians. Gives torsion, e.g. the humeral shaft. */
    twist: ScalarExprSchema.optional(),
  })
  .strict();
export type LoftSection = z.infer<typeof LoftSectionSchema>;

export type GeometryRecipe =
  | {
      readonly kind: 'capsule';
      readonly length: ScalarExpr;
      readonly radiusProximal: ScalarExpr;
      readonly radiusDistal?: ScalarExpr | undefined;
      readonly axis?: Axis | undefined;
    }
  | {
      readonly kind: 'box';
      readonly size: { readonly x: ScalarExpr; readonly y: ScalarExpr; readonly z: ScalarExpr };
    }
  | { readonly kind: 'sphere'; readonly radius: ScalarExpr }
  | {
      readonly kind: 'loft';
      readonly sections: readonly LoftSection[];
      readonly axis?: Axis | undefined;
      readonly capped?: boolean | undefined;
    }
  | {
      readonly kind: 'revolve';
      readonly profile: readonly {
        readonly at: ScalarExpr;
        readonly radius: ScalarExpr;
      }[];
      readonly axis?: Axis | undefined;
      readonly segments?: number | undefined;
    }
  | {
      readonly kind: 'composite';
      readonly parts: readonly {
        readonly recipe: GeometryRecipe;
        readonly transform?: z.infer<typeof TransformExprSchema> | undefined;
        readonly name?: string | undefined;
      }[];
    };

export const GeometryRecipeSchema: z.ZodType<GeometryRecipe> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('capsule'),
        length: ScalarExprSchema,
        radiusProximal: ScalarExprSchema,
        /** Omit for a uniform capsule. Supplying it tapers the shaft, as most long bones do. */
        radiusDistal: ScalarExprSchema.optional(),
        axis: AxisSchema.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('box'),
        size: z.object({ x: ScalarExprSchema, y: ScalarExprSchema, z: ScalarExprSchema }).strict(),
      })
      .strict(),
    z.object({ kind: z.literal('sphere'), radius: ScalarExprSchema }).strict(),
    z
      .object({
        kind: z.literal('loft'),
        /** At least two sections, or there is nothing to loft between. */
        sections: z.array(LoftSectionSchema).min(2),
        axis: AxisSchema.optional(),
        capped: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('revolve'),
        profile: z
          .array(z.object({ at: ScalarExprSchema, radius: ScalarExprSchema }).strict())
          .min(2),
        axis: AxisSchema.optional(),
        segments: z.number().int().min(3).max(256).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('composite'),
        /**
         * A union of parts, each in its own local frame. This is how a vertebra is described:
         * body, pedicles, spinous process, transverse processes.
         */
        parts: z
          .array(
            z
              .object({
                recipe: GeometryRecipeSchema,
                /**
                 * Placement of this part in the composite's local frame.
                 *
                 * Expression-valued for the same reason a bone's rest transform is: a spinous
                 * process pinned to an absolute offset would detach from its vertebral body as
                 * soon as stature changed.
                 */
                transform: TransformExprSchema.optional(),
                /** Human-readable part name, shown in the inspector. E.g. `spinous_process`. */
                name: z.string().min(1).optional(),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
  ]),
);

z.globalRegistry.add(GeometryRecipeSchema, { id: 'GeometryRecipe' });
z.globalRegistry.add(ProfileSchema, { id: 'Profile' });
z.globalRegistry.add(LoftSectionSchema, { id: 'LoftSection' });

/** Recursively collect every recipe in a tree, including the root. Used by the render module. */
export function flattenRecipe(recipe: GeometryRecipe): GeometryRecipe[] {
  if (recipe.kind !== 'composite') return [recipe];
  return [recipe, ...recipe.parts.flatMap((part) => flattenRecipe(part.recipe))];
}
