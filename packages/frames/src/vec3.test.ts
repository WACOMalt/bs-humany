import { describe, expect, it } from 'vitest';
import { makeTestRandom, randomVec3 } from './testing.js';
import {
  UNIT_X,
  UNIT_Y,
  UNIT_Z,
  add,
  approxEquals,
  cross,
  distance,
  dot,
  length as len,
  lengthSquared,
  lerp,
  multiply,
  negate,
  normalize,
  readFromArray,
  rejectFrom,
  scale,
  sub,
  vec3,
  writeToArray,
} from './vec3.js';

describe('vec3 arithmetic', () => {
  it('adds, subtracts, scales and negates component-wise', () => {
    const a = vec3(1, 2, 3);
    const b = vec3(10, 20, 30);
    expect(add(a, b)).toEqual(vec3(11, 22, 33));
    expect(sub(b, a)).toEqual(vec3(9, 18, 27));
    expect(scale(a, 2)).toEqual(vec3(2, 4, 6));
    expect(negate(a)).toEqual(vec3(-1, -2, -3));
    expect(multiply(a, b)).toEqual(vec3(10, 40, 90));
  });

  it('computes dot products', () => {
    expect(dot(UNIT_X, UNIT_X)).toBe(1);
    expect(dot(UNIT_X, UNIT_Y)).toBe(0);
    expect(dot(vec3(1, 2, 3), vec3(4, 5, 6))).toBe(32);
  });

  it('measures length and distance', () => {
    expect(len(vec3(3, 4, 0))).toBe(5);
    expect(lengthSquared(vec3(3, 4, 0))).toBe(25);
    expect(distance(vec3(1, 0, 0), vec3(4, 4, 0))).toBe(5);
  });

  it('interpolates linearly', () => {
    expect(lerp(vec3(0, 0, 0), vec3(10, 20, 30), 0.5)).toEqual(vec3(5, 10, 15));
    expect(lerp(vec3(0, 0, 0), vec3(10, 0, 0), 0)).toEqual(vec3(0, 0, 0));
    expect(lerp(vec3(0, 0, 0), vec3(10, 0, 0), 1)).toEqual(vec3(10, 0, 0));
  });
});

describe('vec3 cross product', () => {
  it('follows the right-hand rule on the canonical axes', () => {
    // This is the definition the whole coordinate system rests on. If it were wrong, every
    // derived frame in the project would be mirrored.
    expect(approxEquals(cross(UNIT_X, UNIT_Y), UNIT_Z)).toBe(true);
    expect(approxEquals(cross(UNIT_Y, UNIT_Z), UNIT_X)).toBe(true);
    expect(approxEquals(cross(UNIT_Z, UNIT_X), UNIT_Y)).toBe(true);
  });

  it('anticommutes', () => {
    const next = makeTestRandom(12345);
    for (let i = 0; i < 200; i++) {
      const a = randomVec3(next);
      const b = randomVec3(next);
      expect(approxEquals(cross(a, b), negate(cross(b, a)), 1e-12)).toBe(true);
    }
  });

  it('produces a vector perpendicular to both inputs', () => {
    const next = makeTestRandom(777);
    for (let i = 0; i < 200; i++) {
      const a = randomVec3(next);
      const b = randomVec3(next);
      const c = cross(a, b);
      expect(Math.abs(dot(c, a))).toBeLessThan(1e-12);
      expect(Math.abs(dot(c, b))).toBeLessThan(1e-12);
    }
  });
});

describe('vec3 normalize', () => {
  it('returns unit length', () => {
    const next = makeTestRandom(999);
    for (let i = 0; i < 200; i++) {
      const v = randomVec3(next, 100);
      if (len(v) < 1e-6) continue;
      expect(len(normalize(v))).toBeCloseTo(1, 12);
    }
  });

  it('throws on a degenerate vector rather than returning NaN', () => {
    // A zero-length direction almost always means two landmarks are coincident. Failing loudly
    // here is worth far more than a NaN surfacing three layers downstream.
    expect(() => normalize(vec3(0, 0, 0))).toThrow(/Cannot normalize/);
    expect(() => normalize(vec3(1e-12, 0, 0))).toThrow(/coincident|Cannot normalize/);
  });
});

describe('vec3 rejectFrom', () => {
  it('removes the component along the axis', () => {
    const result = rejectFrom(vec3(3, 4, 0), UNIT_X);
    expect(approxEquals(result, vec3(0, 4, 0))).toBe(true);
  });

  it('leaves a perpendicular vector untouched', () => {
    expect(approxEquals(rejectFrom(UNIT_Y, UNIT_X), UNIT_Y)).toBe(true);
  });

  it('yields something perpendicular to the axis', () => {
    const next = makeTestRandom(4242);
    for (let i = 0; i < 100; i++) {
      const axis = normalize(randomVec3(next));
      const v = randomVec3(next);
      expect(Math.abs(dot(rejectFrom(v, axis), axis))).toBeLessThan(1e-12);
    }
  });
});

describe('vec3 typed-array interop', () => {
  it('round-trips through a flat buffer at the right offset', () => {
    const buffer = new Float64Array(9);
    writeToArray(buffer, 2, vec3(1.5, -2.5, 3.5));
    expect(readFromArray(buffer, 2)).toEqual(vec3(1.5, -2.5, 3.5));
    // Neighbouring elements must be untouched.
    expect(readFromArray(buffer, 0)).toEqual(vec3(0, 0, 0));
    expect(readFromArray(buffer, 1)).toEqual(vec3(0, 0, 0));
  });
});
