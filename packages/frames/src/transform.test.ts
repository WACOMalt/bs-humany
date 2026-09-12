import { describe, expect, it } from 'vitest';
import { IDENTITY_QUAT, approxEqualsQuat, fromAxisAngle, quat } from './quat.js';
import { makeTestRandom, randomQuat, randomVec3 } from './testing.js';
import {
  IDENTITY_TRANSFORM,
  approxEqualsTransform,
  compose,
  fromRotation,
  fromTranslation,
  interpolate,
  invert,
  isValidTransform,
  relativeTo,
  transform,
  transformDirection,
  transformPoint,
  translationBetween,
} from './transform.js';
import { UNIT_X, UNIT_Y, UNIT_Z, approxEquals, vec3 } from './vec3.js';

function randomTransform(next: () => number) {
  return transform(randomVec3(next, 5), randomQuat(next));
}

describe('transform composition', () => {
  it('applies the right operand first', () => {
    const translateThenRotate = compose(
      fromRotation(fromAxisAngle(UNIT_Z, Math.PI / 2)),
      fromTranslation(UNIT_X),
    );
    // The translation is carried through the rotation, so the point ends up on +Y.
    expect(approxEquals(transformPoint(translateThenRotate, vec3(0, 0, 0)), UNIT_Y, 1e-12)).toBe(
      true,
    );
  });

  it('matches sequential application', () => {
    const next = makeTestRandom(101);
    for (let i = 0; i < 300; i++) {
      const a = randomTransform(next);
      const b = randomTransform(next);
      const p = randomVec3(next, 3);
      expect(
        approxEquals(
          transformPoint(compose(a, b), p),
          transformPoint(a, transformPoint(b, p)),
          1e-10,
        ),
      ).toBe(true);
    }
  });

  it('is associative', () => {
    const next = makeTestRandom(202);
    for (let i = 0; i < 200; i++) {
      const a = randomTransform(next);
      const b = randomTransform(next);
      const c = randomTransform(next);
      expect(
        approxEqualsTransform(compose(compose(a, b), c), compose(a, compose(b, c)), 1e-10),
      ).toBe(true);
    }
  });

  it('has the identity as a neutral element', () => {
    const next = makeTestRandom(303);
    for (let i = 0; i < 100; i++) {
      const t = randomTransform(next);
      expect(approxEqualsTransform(compose(t, IDENTITY_TRANSFORM), t, 1e-14)).toBe(true);
      expect(approxEqualsTransform(compose(IDENTITY_TRANSFORM, t), t, 1e-14)).toBe(true);
    }
  });
});

describe('transform inversion', () => {
  it('composes to the identity in both directions', () => {
    const next = makeTestRandom(404);
    for (let i = 0; i < 300; i++) {
      const t = randomTransform(next);
      expect(approxEqualsTransform(compose(t, invert(t)), IDENTITY_TRANSFORM, 1e-10)).toBe(true);
      expect(approxEqualsTransform(compose(invert(t), t), IDENTITY_TRANSFORM, 1e-10)).toBe(true);
    }
  });

  it('undoes a point transform', () => {
    const next = makeTestRandom(505);
    for (let i = 0; i < 300; i++) {
      const t = randomTransform(next);
      const p = randomVec3(next, 4);
      expect(approxEquals(transformPoint(invert(t), transformPoint(t, p)), p, 1e-10)).toBe(true);
    }
  });
});

describe('points versus directions', () => {
  it('translates points but not directions', () => {
    // A joint axis is a direction. Passing one through transformPoint adds a spurious offset,
    // giving an axis that drifts as the body moves -- subtly wrong rather than obviously broken.
    const t = transform(vec3(10, 20, 30), IDENTITY_QUAT);
    expect(approxEquals(transformPoint(t, UNIT_X), vec3(11, 20, 30))).toBe(true);
    expect(approxEquals(transformDirection(t, UNIT_X), UNIT_X)).toBe(true);
  });

  it('rotates directions identically to points at the origin', () => {
    const next = makeTestRandom(606);
    for (let i = 0; i < 200; i++) {
      const rotation = randomQuat(next);
      const d = randomVec3(next);
      const withTranslation = transform(randomVec3(next, 9), rotation);
      const withoutTranslation = fromRotation(rotation);
      expect(
        approxEquals(
          transformDirection(withTranslation, d),
          transformPoint(withoutTranslation, d),
          1e-12,
        ),
      ).toBe(true);
    }
  });

  it('preserves direction length', () => {
    const next = makeTestRandom(707);
    for (let i = 0; i < 200; i++) {
      const t = randomTransform(next);
      const d = randomVec3(next, 3);
      const lengthOf = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);
      expect(lengthOf(transformDirection(t, d))).toBeCloseTo(lengthOf(d), 10);
    }
  });
});

describe('relativeTo', () => {
  it('inverts compose', () => {
    const next = makeTestRandom(808);
    for (let i = 0; i < 200; i++) {
      const parent = randomTransform(next);
      const childLocal = randomTransform(next);
      const childWorld = compose(parent, childLocal);
      expect(approxEqualsTransform(relativeTo(childWorld, parent), childLocal, 1e-10)).toBe(true);
    }
  });

  it('gives the identity for a transform relative to itself', () => {
    const next = makeTestRandom(909);
    const t = randomTransform(next);
    expect(approxEqualsTransform(relativeTo(t, t), IDENTITY_TRANSFORM, 1e-12)).toBe(true);
  });
});

describe('interpolation', () => {
  it('returns the endpoints', () => {
    const next = makeTestRandom(1001);
    const a = randomTransform(next);
    const b = randomTransform(next);
    expect(approxEqualsTransform(interpolate(a, b, 0), a, 1e-12)).toBe(true);
    expect(approxEqualsTransform(interpolate(a, b, 1), b, 1e-12)).toBe(true);
  });

  it('lerps translation and slerps rotation', () => {
    const a = transform(vec3(0, 0, 0), IDENTITY_QUAT);
    const b = transform(vec3(10, 0, 0), fromAxisAngle(UNIT_Y, Math.PI / 2));
    const mid = interpolate(a, b, 0.5);
    expect(approxEquals(mid.translation, vec3(5, 0, 0), 1e-12)).toBe(true);
    expect(approxEqualsQuat(mid.rotation, fromAxisAngle(UNIT_Y, Math.PI / 4), 1e-10)).toBe(true);
  });
});

describe('validity', () => {
  it('accepts a well-formed transform', () => {
    expect(isValidTransform(IDENTITY_TRANSFORM)).toBe(true);
  });

  it('rejects NaN and Infinity', () => {
    // A NaN propagates through an entire kinematic chain in one tick. Catching it where it appears
    // is far cheaper than diagnosing a vanished model three frames later.
    expect(isValidTransform(transform(vec3(Number.NaN, 0, 0), IDENTITY_QUAT))).toBe(false);
    expect(
      isValidTransform(transform(vec3(0, 0, 0), quat(0, 0, 0, Number.POSITIVE_INFINITY))),
    ).toBe(false);
  });
});

describe('translationBetween', () => {
  it('gives the displacement from the first to the second', () => {
    const a = transform(vec3(1, 2, 3), IDENTITY_QUAT);
    const b = transform(vec3(4, 6, 8), IDENTITY_QUAT);
    expect(approxEquals(translationBetween(a, b), vec3(3, 4, 5))).toBe(true);
  });
});
