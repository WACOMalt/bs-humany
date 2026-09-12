import { describe, expect, it } from 'vitest';
import {
  type ScalarExpr,
  ScalarExprSchema,
  add,
  blend,
  clamp,
  dependencies,
  div,
  evaluate,
  isConstant,
  lerp,
  max,
  min,
  mul,
  ofStature,
  param,
  pow,
  sub,
} from './expr.js';

const ctx = { sex: 0.5, stature: 1.7, mass: 70 };

describe('evaluate', () => {
  it('returns constants unchanged', () => {
    expect(evaluate(42, ctx)).toBe(42);
    expect(evaluate(-0.5, ctx)).toBe(-0.5);
  });

  it('resolves parameters', () => {
    expect(evaluate(param('stature'), ctx)).toBe(1.7);
    expect(evaluate(param('mass'), ctx)).toBe(70);
  });

  it('computes arithmetic', () => {
    expect(evaluate(add(1, 2, 3), ctx)).toBe(6);
    expect(evaluate(mul(2, 3, 4), ctx)).toBe(24);
    expect(evaluate(sub(10, 4), ctx)).toBe(6);
    expect(evaluate(div(10, 4), ctx)).toBe(2.5);
    expect(evaluate(pow(2, 10), ctx)).toBe(1024);
    expect(evaluate(min(3, 1, 2), ctx)).toBe(1);
    expect(evaluate(max(3, 1, 2), ctx)).toBe(3);
  });

  it('clamps in [value, low, high] order', () => {
    expect(evaluate(clamp(5, 0, 1), ctx)).toBe(1);
    expect(evaluate(clamp(-5, 0, 1), ctx)).toBe(0);
    expect(evaluate(clamp(0.5, 0, 1), ctx)).toBe(0.5);
  });

  it('interpolates', () => {
    expect(evaluate(lerp(10, 20, 0.5), ctx)).toBe(15);
    expect(evaluate(lerp(10, 20, 0), ctx)).toBe(10);
    expect(evaluate(lerp(10, 20, 1), ctx)).toBe(20);
  });

  it('nests', () => {
    // 0.245 * stature, the usual shape for a long-bone dimension.
    expect(evaluate(ofStature(0.245), ctx)).toBeCloseTo(0.4165, 12);
    expect(evaluate(add(mul(2, param('stature')), div(param('mass'), 10)), ctx)).toBeCloseTo(
      10.4,
      12,
    );
  });
});

describe('blend', () => {
  it('interpolates female-typical toward male-typical using sex', () => {
    // Spec section 6.2: sex is a blend coefficient over two parameter sets, not a scale factor.
    const dimorphic = blend(0.28, 0.24);
    expect(evaluate(dimorphic, { ...ctx, sex: 0 })).toBeCloseTo(0.28, 12);
    expect(evaluate(dimorphic, { ...ctx, sex: 1 })).toBeCloseTo(0.24, 12);
    expect(evaluate(dimorphic, { ...ctx, sex: 0.5 })).toBeCloseTo(0.26, 12);
  });

  it('is exactly lerp with sex as the interpolant', () => {
    const viaBlend = blend(3, 9);
    const viaLerp = lerp(3, 9, param('sex'));
    for (const sex of [0, 0.25, 0.5, 0.75, 1]) {
      expect(evaluate(viaBlend, { ...ctx, sex })).toBeCloseTo(
        evaluate(viaLerp, { ...ctx, sex }),
        12,
      );
    }
  });

  it('nests inside other expressions', () => {
    const expr = mul(blend(0.25, 0.26), param('stature'));
    expect(evaluate(expr, { ...ctx, sex: 0 })).toBeCloseTo(0.425, 12);
    expect(evaluate(expr, { ...ctx, sex: 1 })).toBeCloseTo(0.442, 12);
  });
});

describe('evaluate error reporting', () => {
  it('names the missing parameter and lists what was available', () => {
    // A silently-zero stature would produce a zero-length skeleton, a division by zero, and an
    // inertia tensor full of NaN -- three symptoms, none of which names the cause.
    expect(() => evaluate(param('stature'), { mass: 70 })).toThrow(/'stature' is not set/);
    expect(() => evaluate(param('stature'), { mass: 70 })).toThrow(/Available: mass/);
  });

  it('says so when blend is used without sex', () => {
    expect(() => evaluate(blend(1, 2), { stature: 1.7 })).toThrow(/needs the 'sex' morphology/);
  });

  it('refuses division by zero', () => {
    expect(() => evaluate(div(1, 0), ctx)).toThrow(/Division by zero/);
  });

  it('refuses inverted clamp bounds', () => {
    expect(() => evaluate(clamp(0.5, 1, 0), ctx)).toThrow(/bounds are inverted/);
  });

  it('refuses a non-finite result', () => {
    expect(() => evaluate(pow(-1, 0.5), ctx)).toThrow(/evaluated to NaN/);
  });
});

describe('dependencies', () => {
  it('finds every referenced parameter', () => {
    const expr = add(mul(param('stature'), 2), param('mass'));
    expect([...dependencies(expr)].sort()).toEqual(['mass', 'stature']);
  });

  it('counts sex as a dependency of blend even when it is not named', () => {
    expect([...dependencies(blend(1, 2))]).toEqual(['sex']);
  });

  it('recurses into blend operands', () => {
    expect([...dependencies(blend(param('stature'), 2))].sort()).toEqual(['sex', 'stature']);
  });

  it('identifies constants', () => {
    expect(isConstant(42)).toBe(true);
    expect(isConstant(add(1, 2))).toBe(true);
    expect(isConstant(param('stature'))).toBe(false);
    // Useful as a test that a dimension actually responds to morphology rather than merely
    // looking parametric.
    expect(isConstant(ofStature(0.245))).toBe(false);
  });
});

describe('schema', () => {
  it('accepts well-formed expressions', () => {
    const valid: ScalarExpr[] = [
      1.5,
      param('stature'),
      add(1, param('mass')),
      blend(mul(0.25, param('stature')), 0.44),
      clamp(param('sex'), 0, 1),
    ];
    for (const expr of valid) {
      expect(ScalarExprSchema.safeParse(expr).success).toBe(true);
    }
  });

  it('rejects an unknown parameter name', () => {
    expect(ScalarExprSchema.safeParse({ param: 'height' }).success).toBe(false);
  });

  it('rejects an unknown operator', () => {
    expect(ScalarExprSchema.safeParse({ sqrt: [4] }).success).toBe(false);
  });

  it('rejects a non-finite constant', () => {
    expect(ScalarExprSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(ScalarExprSchema.safeParse(Number.NaN).success).toBe(false);
  });

  it('rejects an empty operand list', () => {
    expect(ScalarExprSchema.safeParse({ add: [] }).success).toBe(false);
  });

  it('survives a JSON round-trip, since HSDL is a wire format', () => {
    const expr = blend(mul(0.25, param('stature')), add(1, param('mass')));
    const roundTripped = JSON.parse(JSON.stringify(expr));
    expect(ScalarExprSchema.safeParse(roundTripped).success).toBe(true);
    expect(evaluate(roundTripped as ScalarExpr, ctx)).toBeCloseTo(evaluate(expr, ctx), 12);
  });
});
