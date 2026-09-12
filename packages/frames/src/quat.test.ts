import { describe, expect, it } from 'vitest';
import {
  IDENTITY_QUAT,
  angleBetween,
  approxEqualsQuat,
  conjugate,
  fromAxisAngle,
  invertQuat,
  isUnitQuat,
  multiplyQuat,
  normalizeQuat,
  quat,
  rotate,
  rotationBetween,
  slerp,
  toAxisAngle,
} from './quat.js';
import { makeTestRandom, randomQuat, randomVec3 } from './testing.js';
import {
  UNIT_X,
  UNIT_Y,
  UNIT_Z,
  approxEquals,
  dot,
  length as len,
  negate,
  normalize,
  vec3,
} from './vec3.js';

const HALF_PI = Math.PI / 2;

describe('quat construction', () => {
  it('builds a known quarter turn about Y', () => {
    const q = fromAxisAngle(UNIT_Y, HALF_PI);
    expect(q.x).toBeCloseTo(0, 12);
    expect(q.y).toBeCloseTo(Math.SQRT1_2, 12);
    expect(q.z).toBeCloseTo(0, 12);
    expect(q.w).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('round-trips through axis-angle', () => {
    const next = makeTestRandom(2024);
    for (let i = 0; i < 300; i++) {
      const axis = normalize(randomVec3(next));
      const angle = next() * Math.PI * 0.98 + 0.01;
      const { axis: outAxis, angle: outAngle } = toAxisAngle(fromAxisAngle(axis, angle));
      expect(outAngle).toBeCloseTo(angle, 9);
      expect(approxEquals(outAxis, axis, 1e-8)).toBe(true);
    }
  });

  it('reports a zero angle and an arbitrary but stable axis for the identity', () => {
    const { angle, axis } = toAxisAngle(IDENTITY_QUAT);
    expect(angle).toBe(0);
    // Determinism matters: an axis chosen by normalizing float noise would vary run to run and
    // break the bit-exact reproducibility contract.
    expect(axis).toEqual(vec3(1, 0, 0));
  });
});

describe('quat rotation', () => {
  it('rotates canonical axes by known quarter turns', () => {
    // Right-handed, so a positive rotation about +Z takes +X toward +Y.
    expect(approxEquals(rotate(fromAxisAngle(UNIT_Z, HALF_PI), UNIT_X), UNIT_Y, 1e-12)).toBe(true);
    expect(approxEquals(rotate(fromAxisAngle(UNIT_X, HALF_PI), UNIT_Y), UNIT_Z, 1e-12)).toBe(true);
    expect(approxEquals(rotate(fromAxisAngle(UNIT_Y, HALF_PI), UNIT_Z), UNIT_X, 1e-12)).toBe(true);
  });

  it('preserves length', () => {
    const next = makeTestRandom(31337);
    for (let i = 0; i < 300; i++) {
      const q = randomQuat(next);
      const v = randomVec3(next, 10);
      expect(len(rotate(q, v))).toBeCloseTo(len(v), 10);
    }
  });

  it('preserves angles between vectors', () => {
    const next = makeTestRandom(5150);
    for (let i = 0; i < 200; i++) {
      const q = randomQuat(next);
      const a = normalize(randomVec3(next));
      const b = normalize(randomVec3(next));
      expect(dot(rotate(q, a), rotate(q, b))).toBeCloseTo(dot(a, b), 10);
    }
  });

  it('leaves its own axis fixed', () => {
    const next = makeTestRandom(60606);
    for (let i = 0; i < 200; i++) {
      const axis = normalize(randomVec3(next));
      const q = fromAxisAngle(axis, next() * Math.PI);
      expect(approxEquals(rotate(q, axis), axis, 1e-10)).toBe(true);
    }
  });
});

describe('quat composition', () => {
  it('applies the right-hand operand first', () => {
    const first = fromAxisAngle(UNIT_Z, HALF_PI);
    const second = fromAxisAngle(UNIT_X, HALF_PI);
    const composed = multiplyQuat(second, first);
    // X --(rotate about Z)--> Y --(rotate about X)--> Z
    expect(approxEquals(rotate(composed, UNIT_X), UNIT_Z, 1e-12)).toBe(true);
  });

  it('matches sequential application for random pairs', () => {
    const next = makeTestRandom(80808);
    for (let i = 0; i < 300; i++) {
      const a = randomQuat(next);
      const b = randomQuat(next);
      const v = randomVec3(next);
      expect(approxEquals(rotate(multiplyQuat(a, b), v), rotate(a, rotate(b, v)), 1e-10)).toBe(
        true,
      );
    }
  });

  it('is associative', () => {
    const next = makeTestRandom(90909);
    for (let i = 0; i < 200; i++) {
      const a = randomQuat(next);
      const b = randomQuat(next);
      const c = randomQuat(next);
      const left = multiplyQuat(multiplyQuat(a, b), c);
      const right = multiplyQuat(a, multiplyQuat(b, c));
      expect(approxEqualsQuat(left, right, 1e-12)).toBe(true);
    }
  });

  it('composes to identity with its conjugate', () => {
    const next = makeTestRandom(11111);
    for (let i = 0; i < 200; i++) {
      const q = randomQuat(next);
      expect(approxEqualsQuat(multiplyQuat(q, conjugate(q)), IDENTITY_QUAT, 1e-12)).toBe(true);
      expect(approxEqualsQuat(multiplyQuat(q, invertQuat(q)), IDENTITY_QUAT, 1e-12)).toBe(true);
    }
  });
});

describe('quat rotationBetween', () => {
  it('maps one direction onto another', () => {
    const next = makeTestRandom(24680);
    for (let i = 0; i < 300; i++) {
      const from = normalize(randomVec3(next));
      const to = normalize(randomVec3(next));
      const q = rotationBetween(from, to);
      expect(approxEquals(rotate(q, from), to, 1e-9)).toBe(true);
      expect(isUnitQuat(q, 1e-9)).toBe(true);
    }
  });

  it('returns identity for parallel inputs', () => {
    expect(approxEqualsQuat(rotationBetween(UNIT_X, UNIT_X), IDENTITY_QUAT)).toBe(true);
  });

  it('handles the antiparallel case deterministically', () => {
    // Antiparallel is genuinely ambiguous -- any perpendicular axis works. The result must still
    // be correct, unit length, and identical on every run.
    for (const axis of [UNIT_X, UNIT_Y, UNIT_Z, normalize(vec3(1, 1, 1))]) {
      const q = rotationBetween(axis, negate(axis));
      expect(approxEquals(rotate(q, axis), negate(axis), 1e-9)).toBe(true);
      expect(isUnitQuat(q, 1e-9)).toBe(true);
      // The chosen axis must be perpendicular to the input, or the rotation is not a half turn.
      const { axis: turnAxis } = toAxisAngle(q);
      expect(Math.abs(dot(turnAxis, axis))).toBeLessThan(1e-9);
    }
    expect(rotationBetween(UNIT_X, negate(UNIT_X))).toEqual(
      rotationBetween(UNIT_X, negate(UNIT_X)),
    );
  });
});

describe('quat slerp', () => {
  it('returns the endpoints exactly', () => {
    const next = makeTestRandom(13579);
    for (let i = 0; i < 100; i++) {
      const a = randomQuat(next);
      const b = randomQuat(next);
      expect(approxEqualsQuat(slerp(a, b, 0), a, 1e-12)).toBe(true);
      expect(approxEqualsQuat(slerp(a, b, 1), b, 1e-12)).toBe(true);
    }
  });

  it('stays unit length throughout', () => {
    const next = makeTestRandom(97531);
    for (let i = 0; i < 100; i++) {
      const a = randomQuat(next);
      const b = randomQuat(next);
      for (let t = 0; t <= 1.0001; t += 0.125) {
        expect(isUnitQuat(slerp(a, b, t), 1e-10)).toBe(true);
      }
    }
  });

  it('reaches the halfway orientation at t = 0.5', () => {
    const a = IDENTITY_QUAT;
    const b = fromAxisAngle(UNIT_Y, HALF_PI);
    const mid = slerp(a, b, 0.5);
    expect(angleBetween(a, mid)).toBeCloseTo(HALF_PI / 2, 10);
    expect(angleBetween(mid, b)).toBeCloseTo(HALF_PI / 2, 10);
  });

  it('takes the short way round for obtuse pairs', () => {
    const a = IDENTITY_QUAT;
    // Deliberately negated: the same orientation, opposite hemisphere.
    const b = negateQuat(fromAxisAngle(UNIT_Y, 0.4));
    const mid = slerp(a, b, 0.5);
    expect(angleBetween(a, mid)).toBeCloseTo(0.2, 8);
  });
});

describe('quat equality', () => {
  it('treats q and -q as the same orientation', () => {
    const q = fromAxisAngle(UNIT_Z, 1.1);
    expect(approxEqualsQuat(q, negateQuat(q))).toBe(true);
  });
});

describe('quat guards', () => {
  it('rejects a zero quaternion', () => {
    expect(() => normalizeQuat(quat(0, 0, 0, 0))).toThrow(/zero quaternion/);
    expect(() => invertQuat(quat(0, 0, 0, 0))).toThrow(/zero quaternion/);
  });
});

function negateQuat(q: { x: number; y: number; z: number; w: number }) {
  return { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
}
