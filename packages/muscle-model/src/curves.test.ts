import { describe, expect, it } from 'vitest';
import {
  PASSIVE_STRAIN,
  TENDON_FORCE_MAXIMUM,
  TENDON_LENGTH_MAXIMUM,
  activeForceLength,
  activeForceLengthSlope,
  forceVelocity,
  forceVelocitySlope,
  inverseForceVelocity,
  inverseTendonForceLength,
  passiveForceLength,
  passiveForceLengthSlope,
  tendonForceLength,
  tendonForceLengthSlope,
} from './curves.js';

/** Central difference, for checking an analytic derivative against the curve it belongs to. */
function numericalSlope(f: (x: number) => number, x: number, h = 1e-6): number {
  return (f(x + h) - f(x - h)) / (2 * h);
}

/** Samples across a range, for the monotonicity and continuity sweeps. */
function sweep(from: number, to: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1));
}

describe('active force-length', () => {
  it('peaks at the optimal fiber length, at the muscle’s full isometric force', () => {
    // The definition of "optimal": this is the length the maximum isometric force is measured at,
    // so the curve has to read 1 there or every force in the model is scaled wrongly. The
    // published Gaussian sum is a fit rather than a construction, so its own peak sits a little
    // past 1 and a hair above it; both are small enough to be inside the fit's own error.
    expect(activeForceLength(1)).toBeCloseTo(1, 2);
    let peak = Number.NEGATIVE_INFINITY;
    let peakAt = 0;
    for (const length of sweep(0.4, 1.8, 1401)) {
      const force = activeForceLength(length);
      if (force > peak) {
        peak = force;
        peakAt = length;
      }
    }
    expect(peakAt).toBeGreaterThan(0.98);
    expect(peakAt).toBeLessThan(1.02);
    expect(peak).toBeLessThan(1.01);
  });

  it('falls away on both sides and never goes negative', () => {
    expect(activeForceLength(0.5)).toBeLessThan(0.4);
    expect(activeForceLength(1.5)).toBeLessThan(0.4);
    for (const length of sweep(0.2, 2.0, 181)) {
      expect(activeForceLength(length)).toBeGreaterThanOrEqual(0);
    }
  });

  it('rises to the peak and falls after it, with no bumps on the way', () => {
    for (const length of sweep(0.6, 1.0, 41)) {
      expect(activeForceLengthSlope(length), `rising at ${length}`).toBeGreaterThan(0);
    }
    for (const length of sweep(1.15, 1.6, 41)) {
      expect(activeForceLengthSlope(length), `falling at ${length}`).toBeLessThan(0);
    }
  });

  it('reports the slope the curve actually has', () => {
    for (const length of sweep(0.4, 1.8, 29)) {
      expect(activeForceLengthSlope(length), `at ${length}`).toBeCloseTo(
        numericalSlope(activeForceLength, length),
        5,
      );
    }
  });
});

describe('passive force-length', () => {
  it('is negligible below optimal length and carries the whole force at the published strain', () => {
    // A relaxed muscle offers nothing until it is stretched past its optimal length, and by
    // definition of the strain parameter it alone carries one isometric force at that strain.
    expect(passiveForceLength(1)).toBeCloseTo(0, 9);
    expect(passiveForceLength(0.8)).toBeLessThan(0.01);
    expect(passiveForceLength(1 + PASSIVE_STRAIN)).toBeCloseTo(1, 9);
  });

  it('only ever rises, and steeply', () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (const length of sweep(0.5, 1.8, 131)) {
      const force = passiveForceLength(length);
      expect(force).toBeGreaterThan(previous);
      previous = force;
      expect(passiveForceLengthSlope(length)).toBeGreaterThan(0);
    }
    // Steeply: the last tenth of stretch costs more than the first half of it.
    expect(passiveForceLengthSlope(1.5)).toBeGreaterThan(10 * passiveForceLengthSlope(1.0));
  });

  it('reports the slope the curve actually has', () => {
    for (const length of sweep(0.6, 1.7, 23)) {
      expect(passiveForceLengthSlope(length), `at ${length}`).toBeCloseTo(
        numericalSlope(passiveForceLength, length),
        5,
      );
    }
  });
});

describe('force-velocity', () => {
  it('is exactly isometric at zero velocity', () => {
    // Exactly, not nearly: this is where maximum isometric force is defined, so any offset here
    // is a fixed scale error on every force the model reports. See FV_OFFSET.
    expect(forceVelocity(0)).toBeCloseTo(1, 12);
  });

  it('loses force when shortening and gains it when stretched, to a plateau', () => {
    expect(forceVelocity(-1)).toBeLessThan(0.1);
    expect(forceVelocity(-0.5)).toBeLessThan(forceVelocity(0));
    expect(forceVelocity(0.5)).toBeGreaterThan(forceVelocity(0));
    // Lengthening force plateaus rather than growing without bound: doubling the stretch rate
    // from an already-fast one adds little.
    const atOne = forceVelocity(1);
    const atTwo = forceVelocity(2);
    expect(atTwo - atOne).toBeLessThan(0.3);
    expect(atOne).toBeGreaterThan(1.2);
    expect(atOne).toBeLessThan(2.0);
  });

  it('only ever rises with velocity, which is what makes the equilibrium solvable', () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (const velocity of sweep(-1.2, 1.2, 121)) {
      const force = forceVelocity(velocity);
      expect(force, `at ${velocity}`).toBeGreaterThan(previous);
      previous = force;
      expect(forceVelocitySlope(velocity), `slope at ${velocity}`).toBeGreaterThan(0);
    }
  });

  it('inverts exactly', () => {
    for (const velocity of sweep(-1, 1, 41)) {
      expect(inverseForceVelocity(forceVelocity(velocity)), `at ${velocity}`).toBeCloseTo(
        velocity,
        9,
      );
    }
  });

  it('reports the slope the curve actually has', () => {
    for (const velocity of sweep(-1, 1, 21)) {
      expect(forceVelocitySlope(velocity), `at ${velocity}`).toBeCloseTo(
        numericalSlope(forceVelocity, velocity),
        5,
      );
    }
  });
});

describe('tendon force-length', () => {
  it('carries nothing at slack length, which is what slack means', () => {
    expect(tendonForceLength(1)).toBe(0);
  });

  it('never pushes: force is zero or positive from slack upward', () => {
    for (const length of sweep(1, 1.1, 101)) {
      expect(tendonForceLength(length), `at ${length}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('is stiff, and stiffer the further it is stretched', () => {
    // A few per cent of strain carries a large fraction of the muscle's force: that is what makes
    // a tendon a tendon rather than a spring.
    expect(tendonForceLength(1.049)).toBeGreaterThan(0.9);
    expect(tendonForceLengthSlope(1.05)).toBeGreaterThan(tendonForceLengthSlope(1.0));
    let previous = Number.NEGATIVE_INFINITY;
    for (const length of sweep(1, 1.1, 101)) {
      const force = tendonForceLength(length);
      expect(force).toBeGreaterThan(previous);
      previous = force;
    }
  });

  it('inverts exactly', () => {
    for (const force of sweep(0, 2, 41)) {
      expect(inverseTendonForceLength(force), `at ${force}`).toBeCloseTo(
        inverseTendonForceLength(force),
        12,
      );
      expect(tendonForceLength(inverseTendonForceLength(force))).toBeCloseTo(force, 9);
    }
  });

  it('reports the slope the curve actually has, over the strains it is fitted for', () => {
    // Up to the cap and not through it: past ten per cent strain the curve is held flat, so a
    // numerical derivative that straddles the cap measures the clamp rather than the curve.
    for (const length of sweep(0.98, TENDON_LENGTH_MAXIMUM - 0.005, 25)) {
      expect(tendonForceLengthSlope(length), `at ${length}`).toBeCloseTo(
        numericalSlope(tendonForceLength, length),
        4,
      );
    }
  });

  it('refuses to extrapolate past the strain a tendon survives', () => {
    // The curve is a fit over a few per cent of strain; a tendon ruptures between six and ten.
    // Asked about half again its slack length the unclamped exponential answers with 1e18 times
    // the muscle's maximum force, and a solver given that number throws the body out of the
    // scene. It is not a hypothetical: a muscle set carried onto a skeleton whose bones are not
    // the source's has paths its parameters do not expect, and this is how that surfaces.
    expect(tendonForceLength(1.5)).toBe(TENDON_FORCE_MAXIMUM);
    expect(tendonForceLength(3)).toBe(TENDON_FORCE_MAXIMUM);
    expect(tendonForceLengthSlope(1.5)).toBe(0);
    // Large, and finite: about seven and a half times the muscle's own maximum force.
    expect(TENDON_FORCE_MAXIMUM).toBeGreaterThan(5);
    expect(TENDON_FORCE_MAXIMUM).toBeLessThan(10);
    // And the inverse cannot be asked for a length the curve will not produce.
    expect(inverseTendonForceLength(1e9)).toBeCloseTo(TENDON_LENGTH_MAXIMUM, 12);
  });
});

describe('every curve', () => {
  const curves = [
    ['active force-length', activeForceLength, 0.3, 1.9] as const,
    ['passive force-length', passiveForceLength, 0.5, 1.7] as const,
    ['force-velocity', forceVelocity, -1, 1] as const,
    ['tendon force-length', tendonForceLength, 1, 1.1] as const,
  ];

  it('is twice differentiable, which a piecewise curve would not be', () => {
    // The implicit integrator needs the second derivative to exist and not jump. Neighbouring
    // second differences always differ a little, because the third derivative is not zero, so
    // the size of that difference proves nothing on its own. What separates a smooth curve from
    // a kinked one is how the difference behaves as the step shrinks: on a smooth curve it falls
    // with the step, and across a kink it stays where it is however close the samples get.
    for (const [name, curve, from, to] of curves) {
      const worstJump = (h: number) => {
        let worst = 0;
        for (const x of sweep(from + 2 * h, to - 2 * h, 200)) {
          const here = (curve(x + h) - 2 * curve(x) + curve(x - h)) / (h * h);
          const next = (curve(x + 2 * h) - 2 * curve(x + h) + curve(x)) / (h * h);
          expect(Number.isFinite(here), `${name} at ${x}`).toBe(true);
          worst = Math.max(worst, Math.abs(next - here));
        }
        return worst;
      };
      const coarse = (to - from) / 400;
      const ratio = worstJump(coarse) / worstJump(coarse / 2);
      // Halving the step halves the jump on a twice-differentiable curve, and leaves it alone
      // on a kinked one. Two is the smooth answer; anything near one would be a kink.
      expect(ratio, `${name}: jump does not shrink with the step`).toBeGreaterThan(1.8);
    }
  });

  it('returns a finite number everywhere it is defined', () => {
    for (const [name, curve, from, to] of curves) {
      for (const x of sweep(from, to, 200)) {
        expect(Number.isFinite(curve(x)), `${name} at ${x}`).toBe(true);
      }
    }
  });
});
