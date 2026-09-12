import { describe, expect, it } from 'vitest';
import {
  type EulerOrder,
  ISB_REPORTING_ORDER,
  eulerFromMat3,
  eulerFromQuat,
  quatFromEuler,
} from './euler.js';
import { mat3FromQuat } from './mat3.js';
import { approxEqualsQuat, fromAxisAngle, multiplyQuat } from './quat.js';
import { makeTestRandom } from './testing.js';
import { UNIT_X, UNIT_Y, UNIT_Z } from './vec3.js';

const TAIT_BRYAN: EulerOrder[] = ['xyz', 'xzy', 'yxz', 'yzx', 'zxy', 'zyx'];
const PROPER_EULER: EulerOrder[] = ['xyx', 'xzx', 'yxy', 'yzy', 'zxz', 'zyz'];
const ALL_ORDERS: EulerOrder[] = [...TAIT_BRYAN, ...PROPER_EULER];

describe('euler order validation', () => {
  it('rejects a sequence with a repeated adjacent axis', () => {
    expect(() => quatFromEuler(0, 0, 0, 'xxy' as EulerOrder)).toThrow(
      /consecutive axes must differ/,
    );
  });

  it('rejects an unknown axis letter', () => {
    expect(() => quatFromEuler(0, 0, 0, 'abc' as EulerOrder)).toThrow(/Invalid Euler order/);
  });
});

describe('euler composition', () => {
  it('composes intrinsically, left to right', () => {
    const angles = [0.3, -0.7, 1.1] as const;
    const composed = quatFromEuler(angles[0], angles[1], angles[2], 'xyz');
    const manual = multiplyQuat(
      multiplyQuat(fromAxisAngle(UNIT_X, angles[0]), fromAxisAngle(UNIT_Y, angles[1])),
      fromAxisAngle(UNIT_Z, angles[2]),
    );
    expect(approxEqualsQuat(composed, manual, 1e-14)).toBe(true);
  });

  it('reduces to a single axis rotation when the other two angles are zero', () => {
    expect(
      approxEqualsQuat(quatFromEuler(0.9, 0, 0, 'zxy'), fromAxisAngle(UNIT_Z, 0.9), 1e-14),
    ).toBe(true);
    expect(
      approxEqualsQuat(quatFromEuler(0, 0.9, 0, 'zxy'), fromAxisAngle(UNIT_X, 0.9), 1e-14),
    ).toBe(true);
    expect(
      approxEqualsQuat(quatFromEuler(0, 0, 0.9, 'zxy'), fromAxisAngle(UNIT_Y, 0.9), 1e-14),
    ).toBe(true);
  });
});

describe('euler decomposition round-trips', () => {
  it('recovers the original rotation for all twelve orders', () => {
    // The decomposition is allowed to return a different angle triple than the one that went in --
    // several triples describe the same rotation. What must hold is that recomposing the extracted
    // angles reproduces the original orientation exactly.
    const next = makeTestRandom(4242);
    for (const order of ALL_ORDERS) {
      for (let i = 0; i < 200; i++) {
        const first = (next() * 2 - 1) * Math.PI;
        const second = (next() * 2 - 1) * Math.PI;
        const third = (next() * 2 - 1) * Math.PI;

        const original = quatFromEuler(first, second, third, order);
        const decomposed = eulerFromQuat(original, order);
        const recomposed = quatFromEuler(
          decomposed.first,
          decomposed.second,
          decomposed.third,
          order,
        );

        expect(
          approxEqualsQuat(recomposed, original, 1e-8),
          `order ${order} failed to round-trip (${first}, ${second}, ${third})`,
        ).toBe(true);
      }
    }
  });

  it('recovers exact angles within the principal range for Tait-Bryan orders', () => {
    // Inside the principal range the decomposition is unique, so the angles themselves must match.
    const next = makeTestRandom(1357);
    for (const order of TAIT_BRYAN) {
      for (let i = 0; i < 100; i++) {
        const first = (next() * 2 - 1) * (Math.PI * 0.9);
        const second = (next() * 2 - 1) * (Math.PI * 0.45); // clear of +/- pi/2
        const third = (next() * 2 - 1) * (Math.PI * 0.9);

        const decomposed = eulerFromQuat(quatFromEuler(first, second, third, order), order);
        expect(decomposed.gimbalLock).toBe(false);
        expect(decomposed.first).toBeCloseTo(first, 8);
        expect(decomposed.second).toBeCloseTo(second, 8);
        expect(decomposed.third).toBeCloseTo(third, 8);
      }
    }
  });

  it('recovers exact angles within the principal range for proper Euler orders', () => {
    const next = makeTestRandom(2468);
    for (const order of PROPER_EULER) {
      for (let i = 0; i < 100; i++) {
        const first = (next() * 2 - 1) * (Math.PI * 0.9);
        const second = 0.1 + next() * (Math.PI - 0.2); // clear of 0 and pi
        const third = (next() * 2 - 1) * (Math.PI * 0.9);

        const decomposed = eulerFromQuat(quatFromEuler(first, second, third, order), order);
        expect(decomposed.gimbalLock).toBe(false);
        expect(decomposed.first).toBeCloseTo(first, 8);
        expect(decomposed.second).toBeCloseTo(second, 8);
        expect(decomposed.third).toBeCloseTo(third, 8);
      }
    }
  });

  it('agrees whether given a quaternion or a matrix', () => {
    const next = makeTestRandom(8080);
    for (const order of ALL_ORDERS) {
      for (let i = 0; i < 40; i++) {
        const q = quatFromEuler(
          (next() * 2 - 1) * Math.PI,
          (next() * 2 - 1) * Math.PI,
          (next() * 2 - 1) * Math.PI,
          order,
        );
        const fromQuat = eulerFromQuat(q, order);
        const fromMat = eulerFromMat3(mat3FromQuat(q), order);
        expect(fromMat.first).toBeCloseTo(fromQuat.first, 10);
        expect(fromMat.second).toBeCloseTo(fromQuat.second, 10);
        expect(fromMat.third).toBeCloseTo(fromQuat.third, 10);
      }
    }
  });
});

describe('gimbal lock', () => {
  it('is flagged, not swallowed, for Tait-Bryan at the singular second angle', () => {
    // A joint angle silently reported at a singularity is a number that looks fine and means
    // nothing. The flag is what lets the inspector say so.
    for (const order of TAIT_BRYAN) {
      for (const second of [Math.PI / 2, -Math.PI / 2]) {
        const result = eulerFromQuat(quatFromEuler(0.4, second, 0.9, order), order);
        expect(result.gimbalLock, `order ${order} at second=${second}`).toBe(true);
        expect(result.third).toBe(0);
      }
    }
  });

  it('is flagged for proper Euler at a zero or pi second angle', () => {
    for (const order of PROPER_EULER) {
      for (const second of [0, Math.PI]) {
        const result = eulerFromQuat(quatFromEuler(0.4, second, 0.9, order), order);
        expect(result.gimbalLock, `order ${order} at second=${second}`).toBe(true);
        expect(result.third).toBe(0);
      }
    }
  });

  it('still round-trips the rotation when locked', () => {
    for (const order of ALL_ORDERS) {
      const isProper = order[0] === order[2];
      const singular = isProper ? 0 : Math.PI / 2;
      const original = quatFromEuler(0.4, singular, 0.9, order);
      const d = eulerFromQuat(original, order);
      expect(
        approxEqualsQuat(quatFromEuler(d.first, d.second, d.third, order), original, 1e-8),
        `order ${order}`,
      ).toBe(true);
    }
  });

  it('reports no lock for a generic rotation', () => {
    expect(eulerFromQuat(quatFromEuler(0.3, 0.4, 0.5, 'zxy'), 'zxy').gimbalLock).toBe(false);
  });
});

describe('ISB reporting orders', () => {
  it('names a valid order for every listed joint', () => {
    for (const [joint, order] of Object.entries(ISB_REPORTING_ORDER)) {
      expect(ALL_ORDERS, `${joint} uses an unrecognised order`).toContain(order);
      // Must be usable without throwing.
      expect(() => quatFromEuler(0.1, 0.2, 0.3, order)).not.toThrow();
    }
  });

  it('uses a proper Euler sequence for the glenohumeral joint', () => {
    // Wu 2005 chooses this so the singularity sits at the pole -- arm straight overhead -- rather
    // than in the middle of everyday range. A Tait-Bryan order would put a jump where the arm goes.
    expect(PROPER_EULER).toContain(ISB_REPORTING_ORDER.glenohumeral);
  });
});
