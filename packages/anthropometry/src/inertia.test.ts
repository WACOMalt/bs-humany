import {
  type Mat3,
  UNIT_Y,
  approxEqualsMat3,
  at,
  diagonal,
  fromAxisAngle,
  mat3FromQuat,
  vec3,
} from '@bs-humany/frames';
import { describe, expect, it } from 'vitest';
import { DE_LEVA_FEMALE, DE_LEVA_MALE, DE_LEVA_SEGMENTS, blendDeLeva } from './deleva.js';
import {
  type MassProperties,
  assertValidInertia,
  combineMassProperties,
  inertiaFromRadiiOfGyration,
  principalMoments,
  rotateInertia,
  segmentMassProperties,
  translateInertia,
  validateInertia,
} from './inertia.js';

describe('inertiaFromRadiiOfGyration', () => {
  it('computes I = m * k^2 on each axis', () => {
    const inertia = inertiaFromRadiiOfGyration(10, 0.5, {
      transverse: 0.3,
      longitudinal: 0.1,
      sagittal: 0.4,
    });
    // k = fraction * length, so 0.15, 0.05 and 0.20 metres.
    expect(at(inertia, 0, 0)).toBeCloseTo(10 * 0.15 ** 2, 12);
    expect(at(inertia, 1, 1)).toBeCloseTo(10 * 0.05 ** 2, 12);
    expect(at(inertia, 2, 2)).toBeCloseTo(10 * 0.2 ** 2, 12);
  });

  it('puts the longitudinal radius on local Y, the long axis', () => {
    // The axis mapping is the thing most likely to be silently swapped, so it gets its own test.
    const inertia = inertiaFromRadiiOfGyration(1, 1, {
      transverse: 0.5,
      longitudinal: 0.01,
      sagittal: 0.5,
    });
    const moments = [at(inertia, 0, 0), at(inertia, 1, 1), at(inertia, 2, 2)];
    expect(Math.min(...moments)).toBe(moments[1]);
  });

  it('rejects a non-positive mass or length', () => {
    const radii = { transverse: 0.3, longitudinal: 0.1, sagittal: 0.4 };
    expect(() => inertiaFromRadiiOfGyration(0, 0.5, radii)).toThrow(/mass must be positive/);
    expect(() => inertiaFromRadiiOfGyration(10, 0, radii)).toThrow(/length must be positive/);
    expect(() => inertiaFromRadiiOfGyration(10, 0, radii)).toThrow(/missing parameter/);
  });
});

describe('segmentMassProperties', () => {
  it('scales mass by the body mass', () => {
    const props = segmentMassProperties(DE_LEVA_MALE.thigh, 80, 0.42);
    expect(props.mass).toBeCloseTo(0.1416 * 80, 10);
  });

  it('places the centre of mass distally along the negative local Y axis', () => {
    // Local Y points proximally, so a centre of mass measured distally from the proximal joint
    // centre sits at negative Y.
    const props = segmentMassProperties(DE_LEVA_MALE.thigh, 80, 0.42);
    expect(props.com.x).toBe(0);
    expect(props.com.z).toBe(0);
    expect(props.com.y).toBeCloseTo(-0.4095 * 0.42, 10);
    expect(props.com.y).toBeLessThan(0);
  });

  it('produces a physically valid tensor for every segment and both sexes', () => {
    for (const table of [DE_LEVA_FEMALE, DE_LEVA_MALE]) {
      for (const segment of DE_LEVA_SEGMENTS) {
        const props = segmentMassProperties(table[segment], 70, 0.35);
        const result = validateInertia(props.inertia);
        expect(result.problems, segment).toEqual([]);
        expect(result.valid, segment).toBe(true);
      }
    }
  });

  it('produces a physically valid tensor at every blend value', () => {
    // Spec section 6.4 step 5. A blend that produced an impossible tensor would give subtly wrong
    // dynamics only at intermediate slider positions, which is close to undiagnosable.
    for (const sex of [0, 0.17, 0.33, 0.5, 0.66, 0.83, 1]) {
      const table = blendDeLeva(sex);
      for (const segment of DE_LEVA_SEGMENTS) {
        const props = segmentMassProperties(table[segment], 70, 0.4);
        expect(validateInertia(props.inertia).problems, `${segment} at sex=${sex}`).toEqual([]);
      }
    }
  });
});

describe('parallel-axis theorem', () => {
  it('leaves the tensor unchanged for a zero offset', () => {
    const inertia = diagonal(vec3(1, 2, 3));
    expect(approxEqualsMat3(translateInertia(inertia, 5, vec3(0, 0, 0)), inertia, 1e-15)).toBe(
      true,
    );
  });

  it('adds m*d^2 about axes perpendicular to the offset', () => {
    const inertia = diagonal(vec3(1, 2, 3));
    const shifted = translateInertia(inertia, 4, vec3(0, 3, 0));
    // Offset along Y: Ixx and Izz each gain m*d^2 = 36; Iyy is unchanged.
    expect(at(shifted, 0, 0)).toBeCloseTo(1 + 36, 12);
    expect(at(shifted, 1, 1)).toBeCloseTo(2, 12);
    expect(at(shifted, 2, 2)).toBeCloseTo(3 + 36, 12);
  });

  it('creates products of inertia for a diagonal offset', () => {
    const shifted = translateInertia(diagonal(vec3(1, 1, 1)), 2, vec3(1, 1, 0));
    expect(at(shifted, 0, 1)).toBeCloseTo(-2, 12);
    expect(at(shifted, 1, 0)).toBeCloseTo(-2, 12);
  });

  it('is reversible', () => {
    const original = diagonal(vec3(0.4, 0.2, 0.5));
    const offset = vec3(0.1, -0.3, 0.2);
    const out = translateInertia(original, 3, offset);
    const back = translateInertia(out, -3, offset);
    expect(approxEqualsMat3(back, original, 1e-12)).toBe(true);
  });

  it('stays symmetric', () => {
    const shifted = translateInertia(diagonal(vec3(1, 2, 3)), 7, vec3(0.3, -0.2, 0.5));
    expect(validateInertia(shifted).problems).toEqual([]);
  });
});

describe('combineMassProperties', () => {
  it('returns a single body unchanged', () => {
    const only: MassProperties = { mass: 3, com: vec3(1, 2, 3), inertia: diagonal(vec3(1, 1, 1)) };
    expect(combineMassProperties([only])).toBe(only);
  });

  it('sums mass and takes a mass-weighted centre', () => {
    const combined = combineMassProperties([
      { mass: 1, com: vec3(0, 0, 0), inertia: diagonal(vec3(0.01, 0.01, 0.01)) },
      { mass: 3, com: vec3(4, 0, 0), inertia: diagonal(vec3(0.01, 0.01, 0.01)) },
    ]);
    expect(combined.mass).toBe(4);
    expect(combined.com.x).toBeCloseTo(3, 12);
  });

  it('matches the analytic result for two point-like masses', () => {
    // Two 1 kg bodies 2 m apart about their common centre: I = 2 * (1 * 1^2) = 2 kg m^2 about the
    // axes perpendicular to the separation.
    const tiny = diagonal(vec3(1e-12, 1e-12, 1e-12));
    const combined = combineMassProperties([
      { mass: 1, com: vec3(-1, 0, 0), inertia: tiny },
      { mass: 1, com: vec3(1, 0, 0), inertia: tiny },
    ]);
    expect(at(combined.inertia, 1, 1)).toBeCloseTo(2, 9);
    expect(at(combined.inertia, 2, 2)).toBeCloseTo(2, 9);
    expect(at(combined.inertia, 0, 0)).toBeCloseTo(0, 9);
  });

  it('is order-independent', () => {
    // Determinism: combining a lumped segment must not depend on the order bones happen to be
    // listed in, or the same fidelity profile would give different results between runs.
    const parts: MassProperties[] = [
      { mass: 2, com: vec3(0.1, -0.2, 0.05), inertia: diagonal(vec3(0.02, 0.01, 0.03)) },
      { mass: 5, com: vec3(-0.3, 0.4, -0.1), inertia: diagonal(vec3(0.05, 0.04, 0.06)) },
      { mass: 1.5, com: vec3(0.2, 0.1, 0.3), inertia: diagonal(vec3(0.01, 0.02, 0.01)) },
    ];
    const forward = combineMassProperties(parts);
    const backward = combineMassProperties([...parts].reverse());
    expect(backward.mass).toBeCloseTo(forward.mass, 12);
    expect(approxEqualsMat3(backward.inertia, forward.inertia, 1e-12)).toBe(true);
  });

  it('is associative, so lumping in stages matches lumping at once', () => {
    // This is what makes a fidelity profile coherent: combining a hand into a forearm and then
    // into an arm must equal combining all three directly.
    const a: MassProperties = {
      mass: 2,
      com: vec3(0, 0, 0),
      inertia: diagonal(vec3(0.02, 0.01, 0.03)),
    };
    const b: MassProperties = {
      mass: 1,
      com: vec3(0.3, 0, 0),
      inertia: diagonal(vec3(0.01, 0.01, 0.01)),
    };
    const c: MassProperties = {
      mass: 0.5,
      com: vec3(0.6, 0, 0),
      inertia: diagonal(vec3(0.005, 0.005, 0.005)),
    };

    const staged = combineMassProperties([combineMassProperties([a, b]), c]);
    const direct = combineMassProperties([a, b, c]);

    expect(staged.mass).toBeCloseTo(direct.mass, 12);
    expect(staged.com.x).toBeCloseTo(direct.com.x, 12);
    expect(approxEqualsMat3(staged.inertia, direct.inertia, 1e-12)).toBe(true);
  });

  it('produces a valid tensor when lumping a whole limb', () => {
    const upperArm = segmentMassProperties(DE_LEVA_MALE.upperArm, 80, 0.3);
    const forearm = segmentMassProperties(DE_LEVA_MALE.forearm, 80, 0.27);
    const hand = segmentMassProperties(DE_LEVA_MALE.hand, 80, 0.19);
    const combined = combineMassProperties([
      upperArm,
      { ...forearm, com: vec3(0, forearm.com.y - 0.3, 0) },
      { ...hand, com: vec3(0, hand.com.y - 0.57, 0) },
    ]);
    expect(combined.mass).toBeCloseTo((0.0271 + 0.0162 + 0.0061) * 80, 8);
    expect(validateInertia(combined.inertia).problems).toEqual([]);
  });

  it('rejects an empty list', () => {
    expect(() => combineMassProperties([])).toThrow(/zero bodies/);
  });
});

describe('rotateInertia', () => {
  it('leaves an isotropic tensor unchanged', () => {
    const isotropic = diagonal(vec3(2, 2, 2));
    const rotation = mat3FromQuat(fromAxisAngle(UNIT_Y, 0.7));
    expect(approxEqualsMat3(rotateInertia(isotropic, rotation), isotropic, 1e-12)).toBe(true);
  });

  it('preserves the principal moments', () => {
    // Rotation changes the frame, not the body. The eigenvalues are invariant.
    const original = diagonal(vec3(0.1, 0.4, 0.3));
    const rotation = mat3FromQuat(fromAxisAngle(vec3(1, 2, 3), 1.1));
    const rotated = rotateInertia(original, rotation);
    const before = principalMoments(original);
    const after = principalMoments(rotated);
    for (let i = 0; i < 3; i++) {
      expect(after[i]).toBeCloseTo(before[i] ?? 0, 10);
    }
  });

  it('keeps the result valid', () => {
    const rotation = mat3FromQuat(fromAxisAngle(vec3(0.3, 1, -0.2), 2.4));
    const rotated = rotateInertia(diagonal(vec3(0.05, 0.2, 0.18)), rotation);
    expect(validateInertia(rotated).problems).toEqual([]);
  });
});

describe('principalMoments', () => {
  it('returns the diagonal, sorted, for a diagonal tensor', () => {
    expect(principalMoments(diagonal(vec3(3, 1, 2)))).toEqual([1, 2, 3]);
  });

  it('recovers the eigenvalues of a rotated tensor', () => {
    const rotation = mat3FromQuat(fromAxisAngle(vec3(1, 1, 1), 0.9));
    const rotated = rotateInertia(diagonal(vec3(0.2, 0.5, 0.9)), rotation);
    const moments = principalMoments(rotated);
    expect(moments[0]).toBeCloseTo(0.2, 9);
    expect(moments[1]).toBeCloseTo(0.5, 9);
    expect(moments[2]).toBeCloseTo(0.9, 9);
  });

  it('handles repeated eigenvalues', () => {
    const rotation = mat3FromQuat(fromAxisAngle(vec3(0.4, 1, 0.2), 1.3));
    const rotated = rotateInertia(diagonal(vec3(0.3, 0.3, 0.7)), rotation);
    const moments = principalMoments(rotated);
    expect(moments[0]).toBeCloseTo(0.3, 8);
    expect(moments[1]).toBeCloseTo(0.3, 8);
    expect(moments[2]).toBeCloseTo(0.7, 8);
  });
});

describe('validateInertia', () => {
  it('accepts a realistic segment tensor', () => {
    const props = segmentMassProperties(DE_LEVA_FEMALE.shank, 60, 0.4);
    expect(validateInertia(props.inertia).valid).toBe(true);
  });

  it('rejects a tensor violating the triangle inequality', () => {
    // I1 = 10 exceeds I2 + I3 = 2. No distribution of mass produces this, so it describes no
    // object -- and a solver handed it produces motion that looks almost right.
    const impossible = diagonal(vec3(10, 1, 1));
    const result = validateInertia(impossible);
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/triangle inequality/);
    expect(result.problems.join(' ')).toMatch(/describes no physical object/);
  });

  it('accepts the exact boundary case of a flat plate', () => {
    // A lamina has I3 = I1 + I2 exactly, which is legal.
    expect(validateInertia(diagonal(vec3(1, 1, 2))).valid).toBe(true);
  });

  it('rejects a non-positive moment', () => {
    expect(validateInertia(diagonal(vec3(1, 0, 1))).problems.join(' ')).toMatch(/not positive/);
    expect(validateInertia(diagonal(vec3(1, -1, 1))).problems.join(' ')).toMatch(/not positive/);
  });

  it('rejects NaN and Infinity', () => {
    expect(validateInertia(diagonal(vec3(Number.NaN, 1, 1))).valid).toBe(false);
    expect(validateInertia(diagonal(vec3(1, Number.POSITIVE_INFINITY, 1))).valid).toBe(false);
  });

  it('rejects an asymmetric tensor and suggests the likely cause', () => {
    const asymmetric: Mat3 = [1, 0.5, 0, -0.5, 1, 0, 0, 0, 1];
    const problems = validateInertia(asymmetric).problems.join(' ');
    expect(problems).toMatch(/not symmetric/);
    expect(problems).toMatch(/parallel-axis shift/);
  });

  it('scales its tolerance so a phalanx is judged like a torso', () => {
    // Absolute tolerances would either pass everything at phalanx scale or fail everything at
    // torso scale.
    const tiny = diagonal(vec3(1e-8, 1e-8, 2e-8));
    const large = diagonal(vec3(1, 1, 2));
    expect(validateInertia(tiny).valid).toBe(true);
    expect(validateInertia(large).valid).toBe(true);
  });

  it('throws with context from the asserting form', () => {
    expect(() => assertValidInertia(diagonal(vec3(10, 1, 1)), 'femur_r')).toThrow(/femur_r/);
    expect(() => assertValidInertia(diagonal(vec3(10, 1, 1)), 'femur_r')).toThrow(
      /triangle inequality/,
    );
  });
});
