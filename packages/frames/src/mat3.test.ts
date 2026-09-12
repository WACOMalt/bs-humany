import { describe, expect, it } from 'vitest';
import {
  IDENTITY_MAT3,
  type Mat3,
  addMat3,
  approxEqualsMat3,
  at,
  column,
  determinant,
  diagonal,
  fromColumns,
  fromRows,
  invertMat3,
  isRotation,
  isSymmetric,
  mat3FromQuat,
  multiplyMat3,
  quatFromMat3,
  row,
  scaleMat3,
  trace,
  transformVec3,
  transpose,
} from './mat3.js';
import { IDENTITY_QUAT, approxEqualsQuat, fromAxisAngle, rotate } from './quat.js';
import { makeTestRandom, randomQuat, randomVec3 } from './testing.js';
import { UNIT_X, UNIT_Y, UNIT_Z, approxEquals, normalize, vec3 } from './vec3.js';

describe('mat3 storage order', () => {
  it('is column-major, so index = column * 3 + row', () => {
    // Getting this backwards silently transposes every rotation in the project.
    const m = fromColumns(vec3(1, 2, 3), vec3(4, 5, 6), vec3(7, 8, 9));
    expect(m[0]).toBe(1);
    expect(m[1]).toBe(2);
    expect(m[3]).toBe(4);
    expect(at(m, 0, 0)).toBe(1);
    expect(at(m, 1, 0)).toBe(2);
    expect(at(m, 0, 1)).toBe(4);
  });

  it('round-trips columns and rows', () => {
    const c0 = vec3(1, 2, 3);
    const c1 = vec3(4, 5, 6);
    const c2 = vec3(7, 8, 9);
    const m = fromColumns(c0, c1, c2);
    expect(column(m, 0)).toEqual(c0);
    expect(column(m, 2)).toEqual(c2);
    expect(row(m, 0)).toEqual(vec3(1, 4, 7));
    expect(approxEqualsMat3(transpose(fromRows(c0, c1, c2)), m)).toBe(true);
  });
});

describe('mat3 algebra', () => {
  it('multiplies so that the right operand applies first', () => {
    const rotZ = mat3FromQuat(fromAxisAngle(UNIT_Z, Math.PI / 2));
    const rotX = mat3FromQuat(fromAxisAngle(UNIT_X, Math.PI / 2));
    const composed = multiplyMat3(rotX, rotZ);
    expect(approxEquals(transformVec3(composed, UNIT_X), UNIT_Z, 1e-12)).toBe(true);
  });

  it('computes determinant and trace', () => {
    expect(determinant(IDENTITY_MAT3)).toBe(1);
    expect(trace(IDENTITY_MAT3)).toBe(3);
    expect(determinant(diagonal(vec3(2, 3, 4)))).toBeCloseTo(24, 12);
    expect(trace(diagonal(vec3(2, 3, 4)))).toBe(9);
  });

  it('scales and adds element-wise', () => {
    expect(approxEqualsMat3(scaleMat3(IDENTITY_MAT3, 2), diagonal(vec3(2, 2, 2)))).toBe(true);
    expect(approxEqualsMat3(addMat3(IDENTITY_MAT3, IDENTITY_MAT3), diagonal(vec3(2, 2, 2)))).toBe(
      true,
    );
  });

  it('inverts, and refuses a singular matrix', () => {
    const next = makeTestRandom(2468);
    for (let i = 0; i < 100; i++) {
      const m = fromColumns(randomVec3(next), randomVec3(next), randomVec3(next));
      if (Math.abs(determinant(m)) < 1e-3) continue;
      expect(approxEqualsMat3(multiplyMat3(m, invertMat3(m)), IDENTITY_MAT3, 1e-8)).toBe(true);
    }
    const singular: Mat3 = [1, 1, 1, 1, 1, 1, 1, 1, 1];
    expect(() => invertMat3(singular)).toThrow(/singular/);
  });
});

describe('mat3 rotation validity', () => {
  it('accepts proper rotations', () => {
    const next = makeTestRandom(3690);
    for (let i = 0; i < 200; i++) {
      expect(isRotation(mat3FromQuat(randomQuat(next)))).toBe(true);
    }
  });

  it('rejects a reflection', () => {
    // Determinant -1. This is the signature of a handedness error in an axis convention, and is
    // the precise failure `conventions.ts` is built to make impossible.
    const reflection: Mat3 = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
    expect(determinant(reflection)).toBe(-1);
    expect(isRotation(reflection)).toBe(false);
    expect(() => quatFromMat3(reflection)).toThrow(/reflection|proper rotation/);
  });

  it('rejects a non-orthonormal matrix', () => {
    expect(isRotation(diagonal(vec3(2, 1, 1)))).toBe(false);
  });

  it('identifies symmetric matrices, as inertia tensors must be', () => {
    expect(isSymmetric(diagonal(vec3(1, 2, 3)))).toBe(true);
    expect(isSymmetric([1, 2, 0, 0, 1, 0, 0, 0, 1])).toBe(false);
  });
});

describe('mat3 and quat interconversion', () => {
  it('round-trips through random orientations', () => {
    const next = makeTestRandom(4812);
    for (let i = 0; i < 500; i++) {
      const q = randomQuat(next);
      expect(approxEqualsQuat(quatFromMat3(mat3FromQuat(q)), q, 1e-9)).toBe(true);
    }
  });

  it('round-trips a half turn about each axis', () => {
    // Shepperd's branch selection exists for exactly this case. A naive single-branch extraction
    // loses catastrophic precision at 180 degrees, which is where anatomical frames often land.
    for (const axis of [
      UNIT_X,
      UNIT_Y,
      UNIT_Z,
      normalize(vec3(1, 1, 0)),
      normalize(vec3(1, 1, 1)),
    ]) {
      const q = fromAxisAngle(axis, Math.PI);
      expect(approxEqualsQuat(quatFromMat3(mat3FromQuat(q)), q, 1e-8)).toBe(true);
    }
  });

  it('maps the identity both ways', () => {
    expect(approxEqualsMat3(mat3FromQuat(IDENTITY_QUAT), IDENTITY_MAT3, 1e-15)).toBe(true);
    expect(approxEqualsQuat(quatFromMat3(IDENTITY_MAT3), IDENTITY_QUAT, 1e-15)).toBe(true);
  });

  it('agrees with quaternion rotation on random vectors', () => {
    const next = makeTestRandom(5924);
    for (let i = 0; i < 300; i++) {
      const q = randomQuat(next);
      const v = randomVec3(next, 5);
      expect(approxEquals(transformVec3(mat3FromQuat(q), v), rotate(q, v), 1e-10)).toBe(true);
    }
  });
});
