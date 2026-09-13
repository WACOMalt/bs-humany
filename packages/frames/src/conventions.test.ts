/**
 * The specification names coordinate-convention bugs as the single most likely source of silent
 * wrongness in this project, so this file is deliberately the densest in the package.
 *
 * Three classes of bug are targeted:
 *  - a handedness flip, which mirrors the model and swaps left for right;
 *  - a transposed conversion, which looks right for symmetric inputs and wrong for everything else;
 *  - converting an orientation with the vector rule, which is correct for some rotations and wrong
 *    for others, so it survives a spot check.
 */

import { describe, expect, it } from 'vitest';
import {
  type AnatomicalDirection,
  CONVENTIONS,
  ISB,
  OPENSIM,
  WORLD,
  Z_ANATOMY_FBX,
  Z_UP,
  anatomicalAxis,
  axisDirection,
  conversionMatrix,
  convertQuat,
  convertTensor,
  convertVec3,
  defineConvention,
} from './conventions.js';
import {
  IDENTITY_MAT3,
  approxEqualsMat3,
  determinant,
  diagonal,
  isRotation,
  multiplyMat3,
  transpose,
} from './mat3.js';
import { approxEqualsQuat, fromAxisAngle, rotate } from './quat.js';
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

const ALL = Object.values(CONVENTIONS);

describe('convention validation', () => {
  it('rejects a repeated axis direction', () => {
    expect(() =>
      defineConvention({ id: 'bad', description: '', x: 'right', y: 'right', z: 'superior' }),
    ).toThrow(/both point 'right'/);
  });

  it('rejects an opposed axis pair', () => {
    expect(() =>
      defineConvention({ id: 'bad', description: '', x: 'right', y: 'left', z: 'superior' }),
    ).toThrow(/opposite/);
  });

  it('rejects a left-handed triple with a message naming the fix', () => {
    // x=right, y=superior forces z=posterior. Declaring z=anterior is a mirror, and a mirrored
    // skeleton is a bug that passes visual inspection.
    expect(() =>
      defineConvention({
        id: 'mirrored',
        description: '',
        x: 'right',
        y: 'superior',
        z: 'anterior',
      }),
    ).toThrow(/left-handed/);
  });

  it('produces a proper rotation for every shipped convention', () => {
    for (const convention of ALL) {
      expect(isRotation(convention.toCanonical)).toBe(true);
      expect(determinant(convention.toCanonical)).toBeCloseTo(1, 12);
    }
  });

  it('has fromCanonical as the exact inverse of toCanonical', () => {
    for (const convention of ALL) {
      expect(
        approxEqualsMat3(
          multiplyMat3(convention.fromCanonical, convention.toCanonical),
          IDENTITY_MAT3,
          1e-15,
        ),
      ).toBe(true);
      expect(approxEqualsMat3(convention.fromCanonical, transpose(convention.toCanonical))).toBe(
        true,
      );
    }
  });
});

describe('the canonical world frame', () => {
  it('is X right, Y superior, Z posterior', () => {
    expect(axisDirection(WORLD, 'x')).toBe('right');
    expect(axisDirection(WORLD, 'y')).toBe('superior');
    expect(axisDirection(WORLD, 'z')).toBe('posterior');
  });

  it('is the identity conversion, since it is the canonical basis', () => {
    expect(approxEqualsMat3(WORLD.toCanonical, IDENTITY_MAT3)).toBe(true);
  });

  it('places the subject facing -Z, matching three.js object-forward', () => {
    expect(approxEquals(anatomicalAxis('anterior', WORLD), negate(UNIT_Z))).toBe(true);
  });

  it('places the subject right at +X, so femur_r has positive X', () => {
    expect(approxEquals(anatomicalAxis('right', WORLD), UNIT_X)).toBe(true);
    expect(approxEquals(anatomicalAxis('left', WORLD), negate(UNIT_X))).toBe(true);
  });

  it('places superior at +Y', () => {
    expect(approxEquals(anatomicalAxis('superior', WORLD), UNIT_Y)).toBe(true);
  });
});

describe('the ISB frame', () => {
  it('is X anterior, Y superior, Z right, per Wu et al. 2002', () => {
    expect(axisDirection(ISB, 'x')).toBe('anterior');
    expect(axisDirection(ISB, 'y')).toBe('superior');
    expect(axisDirection(ISB, 'z')).toBe('right');
  });

  it('is the same frame OpenSim and Rajagopal 2016 use', () => {
    expect(OPENSIM).toBe(ISB);
  });

  it('converts its basis axes to the expected world axes', () => {
    // Known-value fixture. These three lines are the entire ISB-to-world mapping.
    expect(approxEquals(convertVec3(UNIT_X, ISB, WORLD), negate(UNIT_Z), 1e-15)).toBe(true); // anterior
    expect(approxEquals(convertVec3(UNIT_Y, ISB, WORLD), UNIT_Y, 1e-15)).toBe(true); // superior
    expect(approxEquals(convertVec3(UNIT_Z, ISB, WORLD), UNIT_X, 1e-15)).toBe(true); // right
  });

  it('is a permutation with a sign flip, NOT a handedness change', () => {
    // The specification calls this out explicitly. Both frames are right-handed and Y-up, so the
    // conversion is a proper rotation of -90 degrees about Y. Assuming a handedness flip here
    // would mirror the entire model while still looking plausible.
    const m = conversionMatrix(ISB, WORLD);
    expect(determinant(m)).toBeCloseTo(1, 15);
    expect(isRotation(m)).toBe(true);

    const plusNinetyAboutY = fromAxisAngle(UNIT_Y, Math.PI / 2);
    const next = makeTestRandom(1717);
    for (let i = 0; i < 100; i++) {
      const v = randomVec3(next, 3);
      expect(approxEquals(convertVec3(v, ISB, WORLD), rotate(plusNinetyAboutY, v), 1e-12)).toBe(
        true,
      );
    }
  });
});

describe('the Z-Anatomy FBX frame', () => {
  it('is X left, Y superior, Z anterior', () => {
    expect(axisDirection(Z_ANATOMY_FBX, 'x')).toBe('left');
    expect(axisDirection(Z_ANATOMY_FBX, 'y')).toBe('superior');
    expect(axisDirection(Z_ANATOMY_FBX, 'z')).toBe('anterior');
  });

  it('converts to world by a half turn about Y, not a reflection', () => {
    // A sternum at +Z and left teeth at +X in the FBX must land at -Z and -X in world. If this
    // were mistaken for a handedness flip the whole skeleton would be mirrored.
    expect(
      approxEquals(convertVec3(vec3(1, 0, 0), Z_ANATOMY_FBX, WORLD), vec3(-1, 0, 0), 1e-15),
    ).toBe(true);
    expect(
      approxEquals(convertVec3(vec3(0, 1, 0), Z_ANATOMY_FBX, WORLD), vec3(0, 1, 0), 1e-15),
    ).toBe(true);
    expect(
      approxEquals(convertVec3(vec3(0, 0, 1), Z_ANATOMY_FBX, WORLD), vec3(0, 0, -1), 1e-15),
    ).toBe(true);
    expect(determinant(conversionMatrix(Z_ANATOMY_FBX, WORLD))).toBeCloseTo(1, 15);
    const halfTurn = fromAxisAngle(UNIT_Y, Math.PI);
    const next = makeTestRandom(4321);
    for (let i = 0; i < 50; i++) {
      const v = randomVec3(next, 3);
      expect(approxEquals(convertVec3(v, Z_ANATOMY_FBX, WORLD), rotate(halfTurn, v), 1e-12)).toBe(
        true,
      );
    }
  });
});

describe('conversion round-trips', () => {
  it('returns vectors unchanged through every convention pair', () => {
    const next = makeTestRandom(8642);
    for (const from of ALL) {
      for (const to of ALL) {
        for (let i = 0; i < 50; i++) {
          const v = randomVec3(next, 10);
          expect(approxEquals(convertVec3(convertVec3(v, from, to), to, from), v, 1e-12)).toBe(
            true,
          );
        }
      }
    }
  });

  it('returns orientations unchanged through every convention pair', () => {
    const next = makeTestRandom(9753);
    for (const from of ALL) {
      for (const to of ALL) {
        for (let i = 0; i < 50; i++) {
          const q = randomQuat(next);
          expect(approxEqualsQuat(convertQuat(convertQuat(q, from, to), to, from), q, 1e-10)).toBe(
            true,
          );
        }
      }
    }
  });

  it('composes transitively through a third convention', () => {
    const next = makeTestRandom(1234321);
    for (let i = 0; i < 200; i++) {
      const v = randomVec3(next, 4);
      const direct = convertVec3(v, ISB, Z_UP);
      const viaWorld = convertVec3(convertVec3(v, ISB, WORLD), WORLD, Z_UP);
      expect(approxEquals(direct, viaWorld, 1e-12)).toBe(true);
    }
  });
});

describe('conversion preserves geometry', () => {
  it('keeps vector lengths', () => {
    const next = makeTestRandom(555);
    for (const from of ALL) {
      for (const to of ALL) {
        for (let i = 0; i < 30; i++) {
          const v = randomVec3(next, 7);
          expect(len(convertVec3(v, from, to))).toBeCloseTo(len(v), 12);
        }
      }
    }
  });

  it('keeps angles between vectors', () => {
    const next = makeTestRandom(666);
    for (const from of ALL) {
      for (const to of ALL) {
        for (let i = 0; i < 30; i++) {
          const a = normalize(randomVec3(next));
          const b = normalize(randomVec3(next));
          expect(dot(convertVec3(a, from, to), convertVec3(b, from, to))).toBeCloseTo(
            dot(a, b),
            12,
          );
        }
      }
    }
  });

  it('keeps anatomical directions meaning the same thing', () => {
    const directions: AnatomicalDirection[] = [
      'right',
      'left',
      'superior',
      'inferior',
      'anterior',
      'posterior',
    ];
    for (const from of ALL) {
      for (const to of ALL) {
        for (const direction of directions) {
          const converted = convertVec3(anatomicalAxis(direction, from), from, to);
          expect(approxEquals(converted, anatomicalAxis(direction, to), 1e-12)).toBe(true);
        }
      }
    }
  });
});

describe('orientation conversion uses the similarity rule', () => {
  it('is equivariant: converting then rotating equals rotating then converting', () => {
    // This is the property that fails if a quaternion is converted with the vector rule. That bug
    // gives correct answers for some rotations and wrong ones for others, so it is invisible to a
    // spot check and shows up much later as a joint axis that drifts.
    const next = makeTestRandom(31415);
    for (const from of ALL) {
      for (const to of ALL) {
        for (let i = 0; i < 40; i++) {
          const q = randomQuat(next);
          const v = randomVec3(next, 3);

          const rotateThenConvert = convertVec3(rotate(q, v), from, to);
          const convertThenRotate = rotate(convertQuat(q, from, to), convertVec3(v, from, to));

          expect(approxEquals(rotateThenConvert, convertThenRotate, 1e-10)).toBe(true);
        }
      }
    }
  });

  it('maps a rotation about an anatomical axis to a rotation about the same anatomical axis', () => {
    // A 30-degree rotation about ISB's superior axis must remain a 30-degree rotation about
    // world's superior axis -- same physical motion, different numbers.
    const angle = 0.5236;
    const inIsb = fromAxisAngle(anatomicalAxis('superior', ISB), angle);
    const inWorld = fromAxisAngle(anatomicalAxis('superior', WORLD), angle);
    expect(approxEqualsQuat(convertQuat(inIsb, ISB, WORLD), inWorld, 1e-12)).toBe(true);

    const aboutRight = fromAxisAngle(anatomicalAxis('right', ISB), angle);
    expect(
      approxEqualsQuat(
        convertQuat(aboutRight, ISB, WORLD),
        fromAxisAngle(anatomicalAxis('right', WORLD), angle),
        1e-12,
      ),
    ).toBe(true);
  });
});

describe('tensor conversion', () => {
  it('leaves an isotropic tensor unchanged', () => {
    const isotropic = diagonal(vec3(3, 3, 3));
    expect(approxEqualsMat3(convertTensor(isotropic, ISB, WORLD), isotropic, 1e-12)).toBe(true);
  });

  it('permutes a principal-axis inertia tensor to follow its axes', () => {
    // An inertia tensor with distinct principal moments along ISB's (anterior, superior, right)
    // must come out with those moments on world's (posterior, superior, right) axes -- so the
    // anterior moment lands on Z and the right moment lands on X.
    const inIsb = diagonal(vec3(1, 2, 3)); // anterior=1, superior=2, right=3
    const inWorld = convertTensor(inIsb, ISB, WORLD);
    expect(approxEqualsMat3(inWorld, diagonal(vec3(3, 2, 1)), 1e-12)).toBe(true);
  });

  it('preserves the trace, which is a rotation invariant', () => {
    const next = makeTestRandom(2718);
    for (let i = 0; i < 100; i++) {
      const t = diagonal(randomVec3(next, 5));
      const converted = convertTensor(t, ISB, Z_UP);
      const traceOf = (m: readonly number[]) => (m[0] ?? 0) + (m[4] ?? 0) + (m[8] ?? 0);
      expect(traceOf(converted)).toBeCloseTo(traceOf(t), 12);
    }
  });
});

describe('same-convention conversion is a no-op', () => {
  it('returns the identical object', () => {
    const v = vec3(1, 2, 3);
    expect(convertVec3(v, WORLD, WORLD)).toBe(v);
    const q = fromAxisAngle(UNIT_X, 0.3);
    expect(convertQuat(q, ISB, ISB)).toBe(q);
  });
});
