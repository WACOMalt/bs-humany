/**
 * Joint definitions.
 *
 * Spec section 7.1: joints are **ordered lists of single degrees of freedom**, not composite types
 * with hidden semantics. A hip is three sequential hinges with explicit axes and per-axis ranges.
 * An elbow is one hinge, and pronation/supination is a separate radioulnar joint.
 *
 * Three things follow from that, all of them wanted:
 *   - it matches MJCF's model directly, so compiling to MuJoCo is close to mechanical (ADR-002);
 *   - per-axis ranges and passive properties become natural rather than special cases;
 *   - every DoF gets a stable index for the `actuation.jointTorque` channel, which is what lets a
 *     nerve module and a manual test harness drive the same joint without knowing about each other.
 *
 * And it avoids the Euler-order ambiguity that composite joint types smuggle in. Reporting order
 * is a separate, explicit concern -- see `reportingOrder` below.
 */

import { z } from 'zod';
import { CitationSchema } from './citation.js';
import { ExtensionsSchema } from './extensions.js';
import { AngleSchema, IdSchema, TransformExprSchema, Vec3Schema } from './primitives.js';

/**
 * Passive resistance through the range of motion.
 *
 * Spec section 7.3: a hard range stop alone produces a ragdoll that looks like a puppet -- limbs
 * swing freely and then slam into invisible walls. Real joints resist continuously.
 *
 * The form is the Riener & Edrich (1999) double exponential: resistance climbs steeply as either
 * end of range is approached, with an optional constant mid-range term from the joint capsule and
 * ligaments.
 *
 *   tau = -(k_lo * exp(-a_lo * (q - q_lo))) + (k_hi * exp(a_hi * (q - q_hi))) - c * q - d * qdot
 *
 * **This model MUST behave identically on both backends** (spec section 7.3). MuJoCo expresses it
 * natively through soft joint limits and per-DoF stiffness; Rapier needs an explicit module
 * writing to `actuation.jointTorque`. Ragdoll plausibility depends on this more than on the choice
 * of solver.
 */
export const StiffnessCurveSchema = z
  .object({
    /** Coefficient of the exponential rising toward the lower limit, N*m. */
    lowerGain: z.number().finite().nonnegative(),
    /** Rate of the lower exponential, 1/rad. Larger is a harder stop. */
    lowerRate: z.number().finite().nonnegative(),
    /** Coefficient of the exponential rising toward the upper limit, N*m. */
    upperGain: z.number().finite().nonnegative(),
    upperRate: z.number().finite().nonnegative(),
    /** Linear mid-range stiffness from capsule and ligaments, N*m/rad. Often zero. */
    linear: z.number().finite().nonnegative().optional(),
    /** Angle at which the linear term produces no moment, radians. Defaults to the DoF neutral. */
    linearNeutral: AngleSchema.optional(),
    source: CitationSchema,
  })
  .strict();

export type StiffnessCurve = z.infer<typeof StiffnessCurveSchema>;

/**
 * A single degree of freedom.
 *
 * The `axis` name is semantic (`flexion`, `abduction`), the `vector` is geometric. Both are
 * required: the name is what a UI label and a validation report use, the vector is what the solver
 * uses, and letting them drift apart is how a joint ends up abducting when the label says it is
 * flexing.
 */
export const DofDefSchema = z
  .object({
    /**
     * Semantic name. Free-form to allow joint-specific terminology (`pronation`, `inversion`,
     * `protraction`), but prefer the standard set where it applies.
     */
    axis: z.string().min(1),
    kind: z.enum(['hinge', 'slide']),
    /** Axis of rotation or direction of translation, in the joint frame. Unit length. */
    vector: Vec3Schema.refine(
      (v) => Math.abs(Math.hypot(v.x, v.y, v.z) - 1) < 1e-6,
      'A DoF vector must be unit length. A non-unit axis scales the effective joint velocity, ' +
        'which reads as a joint that moves at the wrong speed rather than as an obvious error.',
    ),
    /**
     * Hard limit, `[min, max]`, radians for a hinge and metres for a slide.
     *
     * The solver will not exceed this. Passive resistance (`passiveStiffness`) is what makes the
     * approach to it feel like a joint rather than a wall.
     */
    range: z.tuple([z.number().finite(), z.number().finite()]),
    /** Value in the anatomical neutral pose. Must lie within `range`. */
    neutral: z.number().finite(),
    passiveStiffness: StiffnessCurveSchema.optional(),
    /** Viscous damping, N*m*s/rad or N*s/m. */
    passiveDamping: z.number().finite().nonnegative().optional(),
    /**
     * Added rotor inertia, kg*m^2.
     *
     * Purely a numerical conditioning term. Deep chains of low-mass bodies -- the cervical spine,
     * the hands -- are the worst case for a constraint solver, and a small armature value buys a
     * lot of stability. It is a modelling artefact, so it is recorded per DoF where a reviewer can
     * see it rather than applied globally where nobody can.
     */
    armature: z.number().finite().nonnegative().optional(),
    /** Coulomb friction opposing motion, N*m or N. */
    frictionLoss: z.number().finite().nonnegative().optional(),
    /**
     * Where the range came from. **Required.** Spec section 5.3: a number without a source is a
     * bug, and this is the specific mechanism that keeps research accuracy from eroding into
     * plausible-looking invention as the model grows.
     */
    romSource: CitationSchema,
    ext: ExtensionsSchema,
  })
  .strict()
  .refine((d) => d.range[0] <= d.range[1], 'DoF range must be ordered [min, max].')
  .refine(
    (d) => d.neutral >= d.range[0] && d.neutral <= d.range[1],
    'A DoF neutral value must lie within its range. A neutral outside the range means the ' +
      'anatomical rest pose is already in violation of the joint limit.',
  );

export type DofDef = z.infer<typeof DofDefSchema>;

export const JointTypeSchema = z.enum([
  'spherical',
  'revolute',
  'universal',
  'saddle',
  'free',
  'fixed',
  'custom',
]);

export const JointDefSchema = z
  .object({
    /** `hip_r`, `l4_l5`, `glenohumeral_l`. */
    id: IdSchema,
    displayName: z.string().min(1),
    parentBone: IdSchema,
    childBone: IdSchema,
    /**
     * Descriptive only. The DoF list is authoritative -- this exists for UI grouping and for
     * sanity checks, such as warning when a joint labelled `revolute` carries three DoFs.
     */
    type: JointTypeSchema,
    /**
     * Joint coordinate system, expressed in the parent bone's local frame.
     *
     * The translation is expression-valued, like a bone's rest transform: a joint centre pinned to
     * fixed metres would detach from the bones it connects as soon as stature changed (spec 6.4
     * step 3). The rotation is a plain quaternion -- a joint axis's orientation does not scale.
     */
    frame: TransformExprSchema,
    /** Child-side frame, where it differs. Defaults to coincident with `frame` at neutral. */
    childFrame: TransformExprSchema.optional(),
    /**
     * Ordered. **Order is semantically significant** -- it is the rotation sequence, and it fixes
     * each DoF's index in the actuation channel.
     */
    dofs: z.array(DofDefSchema).min(0).max(6),
    /**
     * Euler order used when *reporting* this joint's angle, so values are comparable to published
     * literature. See `ISB_REPORTING_ORDER` in `@bs-humany/frames`.
     *
     * Separate from `dofs` on purpose. The DoF list is how the joint is simulated; this is how it
     * is described. Conflating them is what makes composite joint types ambiguous.
     */
    reportingOrder: z
      .enum(['xyz', 'xzy', 'yxz', 'yzx', 'zxy', 'zyx', 'xyx', 'xzx', 'yxy', 'yzy', 'zxz', 'zyz'])
      .optional(),
    /**
     * Known simplifications, surfaced in the UI.
     *
     * Spec section 7.3: several joint ranges are genuinely posture-dependent -- hip flexion range
     * depends on knee angle through the hamstrings, shoulder range depends on scapular position.
     * Phase 1 may use fixed conservative ranges, but each such simplification MUST be recorded
     * rather than presented as the real thing.
     */
    limitations: z.array(z.string().min(1)).optional(),
    ext: ExtensionsSchema,
  })
  .strict()
  .refine((j) => j.parentBone !== j.childBone, 'A joint cannot connect a bone to itself.')
  .refine(
    (j) => j.type !== 'revolute' || j.dofs.length === 1,
    "A joint typed 'revolute' must have exactly one DoF. If it has more, either the type or the " +
      'DoF list is wrong.',
  )
  .refine(
    (j) => j.type !== 'free' || j.dofs.length === 6,
    "A joint typed 'free' must have six DoFs: three translations and three rotations.",
  )
  .refine(
    (j) => j.type !== 'fixed' || j.dofs.length === 0,
    "A joint typed 'fixed' must have no DoFs.",
  );

z.globalRegistry.add(JointDefSchema, { id: 'JointDef' });
z.globalRegistry.add(DofDefSchema, { id: 'DofDef' });
z.globalRegistry.add(StiffnessCurveSchema, { id: 'StiffnessCurve' });

export type JointDef = z.infer<typeof JointDefSchema>;

/** Evaluate a stiffness curve at a joint angle, returning the passive moment in N*m. */
export function passiveMoment(
  curve: StiffnessCurve,
  angle: number,
  range: readonly [number, number],
): number {
  const [low, high] = range;
  const lower = curve.lowerGain * Math.exp(-curve.lowerRate * (angle - low));
  const upper = curve.upperGain * Math.exp(curve.upperRate * (angle - high));
  const neutral = curve.linearNeutral ?? 0;
  const linear = (curve.linear ?? 0) * (angle - neutral);
  // Lower-limit resistance pushes toward increasing angle, upper-limit resistance pushes back.
  return lower - upper - linear;
}
