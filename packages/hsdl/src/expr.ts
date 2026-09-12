/**
 * Scalar expressions over morphology parameters.
 *
 * A bone's dimensions are not constants -- femur length is a function of stature, pelvic breadth
 * blends between two sex-typical endpoint values, and so on (spec section 6). HSDL therefore needs
 * to store *expressions*, not numbers.
 *
 * It stores them as a small tagged AST rather than as strings.
 *
 * The alternative, a string like `"0.245 * stature"`, would need a parser, and a parser is code
 * that runs on data. HSDL "contains no code" by design: an AST is JSON-serializable, diffs
 * legibly in git, is type-checked by the compiler at authoring time, and cannot smuggle in an
 * `eval`. The cost is verbosity at the authoring site, which the builder helpers at the bottom of
 * this file take back.
 *
 * `blend` is the operator that matters most. Spec section 6.2 defines `sex` as a blend coefficient
 * over two complete parameter sets, not a scale factor, and `blend` encodes that directly so the
 * intent survives in the data.
 */

import { z } from 'zod';

/** Morphology parameters an expression may reference. Spec section 6.1. */
export const MORPHOLOGY_PARAMS = [
  'sex',
  'stature',
  'mass',
  'percentile',
  'biiliacBreadth',
  'biacromialBreadth',
  'crural',
  'brachial',
  'relativeLegLength',
  'asymmetry',
] as const;

export type MorphologyParam = (typeof MORPHOLOGY_PARAMS)[number];

export type ScalarExpr =
  | number
  | { readonly param: MorphologyParam }
  | { readonly add: readonly ScalarExpr[] }
  | { readonly mul: readonly ScalarExpr[] }
  | { readonly sub: readonly [ScalarExpr, ScalarExpr] }
  | { readonly div: readonly [ScalarExpr, ScalarExpr] }
  | { readonly pow: readonly [ScalarExpr, ScalarExpr] }
  | { readonly min: readonly ScalarExpr[] }
  | { readonly max: readonly ScalarExpr[] }
  | { readonly clamp: readonly [ScalarExpr, ScalarExpr, ScalarExpr] }
  | { readonly lerp: readonly [ScalarExpr, ScalarExpr, ScalarExpr] }
  /**
   * Interpolate between a female-typical and a male-typical value using the `sex` parameter.
   * `{ blend: [female, male] }` is exactly `{ lerp: [female, male, { param: 'sex' }] }`, spelled
   * so that the anthropometric meaning is visible in the data rather than inferred from which
   * parameter happens to be the interpolant.
   */
  | { readonly blend: readonly [ScalarExpr, ScalarExpr] };

export const ScalarExprSchema: z.ZodType<ScalarExpr> = z.lazy(() =>
  z.union([
    z.number().finite(),
    z.object({ param: z.enum(MORPHOLOGY_PARAMS) }).strict(),
    z.object({ add: z.array(ScalarExprSchema).min(1) }).strict(),
    z.object({ mul: z.array(ScalarExprSchema).min(1) }).strict(),
    z.object({ sub: z.tuple([ScalarExprSchema, ScalarExprSchema]) }).strict(),
    z.object({ div: z.tuple([ScalarExprSchema, ScalarExprSchema]) }).strict(),
    z.object({ pow: z.tuple([ScalarExprSchema, ScalarExprSchema]) }).strict(),
    z.object({ min: z.array(ScalarExprSchema).min(1) }).strict(),
    z.object({ max: z.array(ScalarExprSchema).min(1) }).strict(),
    z.object({ clamp: z.tuple([ScalarExprSchema, ScalarExprSchema, ScalarExprSchema]) }).strict(),
    z.object({ lerp: z.tuple([ScalarExprSchema, ScalarExprSchema, ScalarExprSchema]) }).strict(),
    z.object({ blend: z.tuple([ScalarExprSchema, ScalarExprSchema]) }).strict(),
  ]),
);

/** Resolved morphology parameter values, as the evaluator sees them. */
z.globalRegistry.add(ScalarExprSchema, { id: 'ScalarExpr' });

export type ExprContext = Readonly<Partial<Record<MorphologyParam, number>>>;

/**
 * Evaluate an expression.
 *
 * Throws on an unresolved parameter rather than defaulting to zero. A silently-zero stature would
 * produce a skeleton of length zero, a division by zero downstream, and an inertia tensor full of
 * NaN -- three symptoms, none of which names the cause.
 */
export function evaluate(expr: ScalarExpr, context: ExprContext): number {
  const result = evaluateInner(expr, context);
  if (!Number.isFinite(result)) {
    throw new Error(
      `Expression evaluated to ${result}. Expression: ${JSON.stringify(expr)}. ` +
        'This usually means a division by zero or a negative base raised to a fractional power.',
    );
  }
  return result;
}

function evaluateInner(expr: ScalarExpr, context: ExprContext): number {
  if (typeof expr === 'number') return expr;

  if ('param' in expr) {
    const value = context[expr.param];
    if (value === undefined) {
      throw new Error(
        `Morphology parameter '${expr.param}' is not set in this context. ` +
          `Available: ${Object.keys(context).sort().join(', ') || '(none)'}.`,
      );
    }
    return value;
  }

  if ('add' in expr) return expr.add.reduce<number>((sum, e) => sum + evaluateInner(e, context), 0);
  if ('mul' in expr) {
    return expr.mul.reduce<number>((product, e) => product * evaluateInner(e, context), 1);
  }
  if ('sub' in expr)
    return evaluateInner(expr.sub[0], context) - evaluateInner(expr.sub[1], context);
  if ('div' in expr) {
    const denominator = evaluateInner(expr.div[1], context);
    if (denominator === 0) {
      throw new Error(`Division by zero in expression: ${JSON.stringify(expr)}.`);
    }
    return evaluateInner(expr.div[0], context) / denominator;
  }
  if ('pow' in expr) {
    return evaluateInner(expr.pow[0], context) ** evaluateInner(expr.pow[1], context);
  }
  if ('min' in expr) return Math.min(...expr.min.map((e) => evaluateInner(e, context)));
  if ('max' in expr) return Math.max(...expr.max.map((e) => evaluateInner(e, context)));
  if ('clamp' in expr) {
    const [valueExpr, lowExpr, highExpr] = expr.clamp;
    const low = evaluateInner(lowExpr, context);
    const high = evaluateInner(highExpr, context);
    if (low > high) {
      throw new Error(
        `clamp bounds are inverted: low ${low} is greater than high ${high}. ` +
          'Argument order is [value, low, high].',
      );
    }
    const value = evaluateInner(valueExpr, context);
    return value < low ? low : value > high ? high : value;
  }
  if ('lerp' in expr) {
    const [aExpr, bExpr, tExpr] = expr.lerp;
    const a = evaluateInner(aExpr, context);
    const b = evaluateInner(bExpr, context);
    const t = evaluateInner(tExpr, context);
    return a + (b - a) * t;
  }
  // `blend` is lerp with `sex` as the interpolant.
  const [female, male] = expr.blend;
  const sex = context.sex;
  if (sex === undefined) {
    throw new Error(
      "A 'blend' expression needs the 'sex' morphology parameter, which is not set in this " +
        'context. blend interpolates a female-typical value toward a male-typical one.',
    );
  }
  const a = evaluateInner(female, context);
  const b = evaluateInner(male, context);
  return a + (b - a) * sex;
}

/**
 * Every morphology parameter an expression depends on.
 *
 * Lets the morphology solver work out what must be resolved before evaluation, and lets a test
 * assert that a bone's dimensions actually respond to stature rather than being a constant that
 * merely looks parametric.
 */
export function dependencies(
  expr: ScalarExpr,
  into: Set<MorphologyParam> = new Set(),
): Set<MorphologyParam> {
  if (typeof expr === 'number') return into;
  if ('param' in expr) {
    into.add(expr.param);
    return into;
  }
  if ('blend' in expr) {
    into.add('sex');
    for (const child of expr.blend) dependencies(child, into);
    return into;
  }
  for (const value of Object.values(expr) as ReadonlyArray<readonly ScalarExpr[]>) {
    for (const child of value) dependencies(child, into);
  }
  return into;
}

/** True when the expression is a constant, so it does not respond to morphology at all. */
export function isConstant(expr: ScalarExpr): boolean {
  return dependencies(expr).size === 0;
}

// ---------------------------------------------------------------------------------------------
// Builders. Authoring sugar -- these produce plain data, nothing more.
// ---------------------------------------------------------------------------------------------

export const param = (name: MorphologyParam): ScalarExpr => ({ param: name });
export const add = (...terms: ScalarExpr[]): ScalarExpr => ({ add: terms });
export const mul = (...factors: ScalarExpr[]): ScalarExpr => ({ mul: factors });
export const sub = (a: ScalarExpr, b: ScalarExpr): ScalarExpr => ({ sub: [a, b] });
export const div = (a: ScalarExpr, b: ScalarExpr): ScalarExpr => ({ div: [a, b] });
export const pow = (base: ScalarExpr, exponent: ScalarExpr): ScalarExpr => ({
  pow: [base, exponent],
});
export const min = (...terms: ScalarExpr[]): ScalarExpr => ({ min: terms });
export const max = (...terms: ScalarExpr[]): ScalarExpr => ({ max: terms });
export const clamp = (value: ScalarExpr, low: ScalarExpr, high: ScalarExpr): ScalarExpr => ({
  clamp: [value, low, high],
});
export const lerp = (a: ScalarExpr, b: ScalarExpr, t: ScalarExpr): ScalarExpr => ({
  lerp: [a, b, t],
});
export const blend = (female: ScalarExpr, male: ScalarExpr): ScalarExpr => ({
  blend: [female, male],
});

/**
 * A dimension expressed as a fraction of standing height.
 *
 * The overwhelmingly common shape for a skeletal dimension, and the one ANSUR II's percentile
 * relations are stated in.
 */
export const ofStature = (fraction: ScalarExpr): ScalarExpr => mul(fraction, param('stature'));
