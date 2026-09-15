import { describe, expect, it } from 'vitest';
import { activeForceLength, passiveForceLength, tendonForceLength } from './curves.js';
import {
  DEFAULT_MUSCULOTENDON,
  FIBER_LENGTH_MAXIMUM,
  FIBER_LENGTH_MINIMUM,
  type MusculotendonParameters,
  equilibriumFiberLength,
  fiberWidth,
  pennationAt,
  pennationCosine,
  solveEquilibrium,
  stepFiber,
} from './fiber.js';

/**
 * A muscle of unremarkable proportions, for exercising the mechanics.
 *
 * These are not anyone's measured parameters and are not claimed to be: the point of this suite
 * is the arithmetic of the equilibrium, which is the same whatever muscle it is applied to. Real
 * parameters arrive with their citations in N2.
 */
const MUSCLE: MusculotendonParameters = {
  ...DEFAULT_MUSCULOTENDON,
  maxIsometricForce: 500,
  optimalFiberLength: 0.1,
  tendonSlackLength: 0.2,
  pennationAngle: 0.15,
};

/** The same muscle with its fibers running straight along the tendon. */
const PARALLEL: MusculotendonParameters = { ...MUSCLE, pennationAngle: 0 };

/** Length of the whole unit when the fibers sit at `fiber` and the tendon at `tendon`. */
function unitLength(fiber: number, tendon: number, p = MUSCLE): number {
  const width = fiberWidth(p.pennationAngle);
  return (
    fiber * p.optimalFiberLength * pennationCosine(fiber, width) + tendon * p.tendonSlackLength
  );
}

describe('pennation', () => {
  it('is zero for fibers that run along the tendon, and they lose no force to it', () => {
    expect(fiberWidth(0)).toBe(0);
    expect(pennationAt(1, 0)).toBe(0);
    expect(pennationCosine(0.4, 0)).toBe(1);
  });

  it('reads back the angle it was built from, at the optimal fiber length', () => {
    const width = fiberWidth(MUSCLE.pennationAngle);
    expect(pennationAt(1, width)).toBeCloseTo(MUSCLE.pennationAngle, 12);
    expect(pennationCosine(1, width)).toBeCloseTo(Math.cos(MUSCLE.pennationAngle), 12);
  });

  it('keeps the fibers at a constant width as they change length', () => {
    // Zajac's assumption, stated as the invariant it is: length times sine is the width, always.
    const width = fiberWidth(MUSCLE.pennationAngle);
    for (const length of [0.5, 0.75, 1, 1.25, 1.6]) {
      expect(length * Math.sin(pennationAt(length, width)), `at ${length}`).toBeCloseTo(width, 12);
    }
  });

  it('steepens as the muscle shortens, so a short muscle pulls its tendon less directly', () => {
    const width = fiberWidth(MUSCLE.pennationAngle);
    expect(pennationAt(0.6, width)).toBeGreaterThan(pennationAt(1.4, width));
    expect(pennationCosine(0.6, width)).toBeLessThan(pennationCosine(1.4, width));
  });

  it('reports a right angle rather than a NaN when asked for an impossible fiber', () => {
    // A fiber shorter than its own width cannot exist. The honest answer is the limit, because
    // a NaN here would travel silently into the solver and surface somewhere unrelated.
    const width = fiberWidth(1.2);
    expect(pennationAt(width / 2, width)).toBeCloseTo(Math.PI / 2, 12);
    expect(pennationCosine(width / 2, width)).toBe(0);
    expect(Number.isFinite(pennationAt(0, width))).toBe(true);
  });
});

describe('the equilibrium solve', () => {
  it('balances the forces it says it has balanced', () => {
    // The defining property. Whatever velocity comes back, the fiber force resolved along the
    // tendon must equal the tendon force at that same state, or the solution is not one.
    for (const activation of [0.001, 0.2, 0.5, 1]) {
      for (const fiberLength of [0.6, 0.8, 1, 1.2, 1.4]) {
        for (const tendon of [1.0, 1.02, 1.05]) {
          const length = unitLength(fiberLength, tendon);
          const solution = solveEquilibrium({ activation, fiberLength }, length, MUSCLE);
          if (solution.failed) continue;
          const cosine = Math.cos(solution.pennation);
          const label = `a=${activation} lM=${fiberLength} lT=${tendon}`;
          expect(cosine * solution.fiberForce, label).toBeCloseTo(solution.tendonForce, 6);
        }
      }
    }
  });

  it('solves at zero activation, which is why the model is damped', () => {
    // M-ADR-001 in one test. Without the damping term the residual stops depending on velocity
    // as activation goes to zero and there is no root to find; with it there is always exactly
    // one. A relaxed body is the common case, so this is the case that had to work.
    const length = unitLength(1.1, 1.03);
    const solution = solveEquilibrium({ activation: 0, fiberLength: 1.1 }, length, MUSCLE);
    expect(solution.failed).toBe(false);
    expect(Number.isFinite(solution.fiberVelocity)).toBe(true);
    const cosine = Math.cos(solution.pennation);
    expect(cosine * solution.fiberForce).toBeCloseTo(solution.tendonForce, 6);
  });

  it('lets a buckled tendon carry nothing rather than pushing back', () => {
    // Below slack a tendon folds. The fibers are then shortening against nothing at all.
    const length = unitLength(1.2, 0.9);
    const solution = solveEquilibrium({ activation: 0.5, fiberLength: 1.2 }, length, MUSCLE);
    expect(solution.tendonLength).toBeLessThan(1);
    expect(solution.tendonForce).toBe(0);
    expect(solution.fiberVelocity).toBeLessThan(0);
  });

  it('never reports a tendon pulling the wrong way', () => {
    for (const fiberLength of [0.4, 0.7, 1, 1.3, 1.7]) {
      for (const tendon of [0.95, 1, 1.03, 1.08]) {
        const length = unitLength(fiberLength, tendon);
        const solution = solveEquilibrium({ activation: 0.7, fiberLength }, length, MUSCLE);
        expect(solution.tendonForce, `lM=${fiberLength} lT=${tendon}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('shortens the fibers harder the more the muscle is activated', () => {
    // At a fixed geometry, more activation means more fiber force than the tendon is carrying,
    // and the only way to restore the balance is to shorten faster.
    const length = unitLength(1, 1.02);
    let previous = Number.POSITIVE_INFINITY;
    for (const activation of [0.01, 0.25, 0.5, 0.75, 1]) {
      const solution = solveEquilibrium({ activation, fiberLength: 1 }, length, MUSCLE);
      expect(solution.fiberVelocity, `at a=${activation}`).toBeLessThan(previous);
      previous = solution.fiberVelocity;
    }
  });

  it('stretches the fibers when the tendon is pulled harder', () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (const tendon of [1.0, 1.01, 1.02, 1.03, 1.04]) {
      const length = unitLength(1, tendon);
      const solution = solveEquilibrium({ activation: 0.3, fiberLength: 1 }, length, MUSCLE);
      expect(solution.fiberVelocity, `at lT=${tendon}`).toBeGreaterThan(previous);
      previous = solution.fiberVelocity;
    }
  });

  it('agrees with the force it should make when held still', () => {
    // At the velocity that comes back as zero, the force-velocity term is 1 and the whole model
    // collapses to the two force-length curves. That is a closed-form answer to check against.
    const fiberLength = 1.05;
    const activation = 0.6;
    const expected = activation * activeForceLength(fiberLength) + passiveForceLength(fiberLength);
    const cosine = pennationCosine(fiberLength, fiberWidth(MUSCLE.pennationAngle));
    // Pick the unit length whose tendon carries exactly that force, so nothing needs to move.
    const tendonForce = cosine * expected;
    const tendonLength = Math.log(tendonForce / 0.2 + Math.exp(35 * 0.005)) / 35 + 0.995;
    expect(tendonForceLength(tendonLength)).toBeCloseTo(tendonForce, 9);
    const solution = solveEquilibrium(
      { activation, fiberLength },
      unitLength(fiberLength, tendonLength),
      MUSCLE,
    );
    expect(solution.fiberVelocity).toBeCloseTo(0, 6);
    expect(solution.fiberForce).toBeCloseTo(expected, 6);
    expect(solution.tendonForce * MUSCLE.maxIsometricForce).toBeCloseTo(
      cosine * expected * MUSCLE.maxIsometricForce,
      4,
    );
  });

  it('loses force to pennation, by exactly the cosine of the angle', () => {
    // The same state in a pennated muscle and a parallel one: the tendon feels less in the
    // pennated one, and the shortfall is the cosine rather than anything vaguer.
    const fiberLength = 1;
    const activation = 0.5;
    const expected = activation * activeForceLength(fiberLength) + passiveForceLength(fiberLength);
    const straight = solveEquilibrium(
      { activation, fiberLength },
      unitLength(fiberLength, 1, PARALLEL),
      PARALLEL,
    );
    expect(straight.pennation).toBe(0);
    expect(straight.fiberForce).toBeCloseTo(expected * 0 + straight.fiberForce, 12);
    const angled = solveEquilibrium(
      { activation, fiberLength },
      unitLength(fiberLength, 1, MUSCLE),
      MUSCLE,
    );
    expect(angled.pennation).toBeCloseTo(MUSCLE.pennationAngle, 9);
    expect(Math.cos(angled.pennation)).toBeLessThan(1);
  });
});

describe('the equilibrium fiber length', () => {
  it('starts a muscle without a transient, at any activation', () => {
    // The purpose of this function: a muscle initialised here must not move on its first step.
    // Anything else shows up in a simulation as a twitch at t=0 that nothing asked for.
    for (const activation of [0.001, 0.1, 0.5, 1]) {
      const length = 0.3;
      const fiberLength = equilibriumFiberLength(activation, length, MUSCLE);
      const solution = solveEquilibrium({ activation, fiberLength }, length, MUSCLE);
      expect(solution.fiberVelocity, `at a=${activation}`).toBeCloseTo(0, 5);
      const stepped = stepFiber({ activation, fiberLength }, length, activation, 1e-3, MUSCLE);
      expect(stepped.state.fiberLength, `stepped at a=${activation}`).toBeCloseTo(fiberLength, 6);
    }
  });

  it('shortens the fibers as activation rises, because the tendon takes up the slack', () => {
    const length = 0.3;
    let previous = Number.POSITIVE_INFINITY;
    for (const activation of [0.01, 0.3, 0.6, 1]) {
      const fiberLength = equilibriumFiberLength(activation, length, MUSCLE);
      expect(fiberLength, `at a=${activation}`).toBeLessThan(previous);
      previous = fiberLength;
    }
  });

  it('stays inside the range the model is valid over', () => {
    for (const length of [0.24, 0.28, 0.32, 0.36]) {
      const fiberLength = equilibriumFiberLength(0.5, length, MUSCLE);
      expect(fiberLength).toBeGreaterThanOrEqual(FIBER_LENGTH_MINIMUM);
      expect(fiberLength).toBeLessThanOrEqual(FIBER_LENGTH_MAXIMUM);
    }
  });
});

describe('the fiber step', () => {
  it('holds a muscle that starts balanced, for as long as it is left alone', () => {
    const length = 0.3;
    const activation = 0.4;
    let state = { activation, fiberLength: equilibriumFiberLength(activation, length, MUSCLE) };
    const started = state.fiberLength;
    for (let i = 0; i < 2000; i++) {
      state = stepFiber(state, length, activation, 5e-4, MUSCLE).state;
    }
    expect(state.fiberLength).toBeCloseTo(started, 4);
  });

  it('settles back to the equilibrium after being displaced, rather than ringing', () => {
    // The damping is what makes this a settle rather than an oscillation. A displaced fiber
    // should approach the balance point from one side and stay there.
    const length = 0.3;
    const activation = 0.4;
    const target = equilibriumFiberLength(activation, length, MUSCLE);
    let state = { activation, fiberLength: target * 1.15 };
    let previousError = Math.abs(state.fiberLength - target);
    for (let i = 0; i < 4000; i++) {
      state = stepFiber(state, length, activation, 2e-4, MUSCLE).state;
      const error = Math.abs(state.fiberLength - target);
      expect(error, `grew at step ${i}`).toBeLessThanOrEqual(previousError + 1e-9);
      previousError = error;
    }
    expect(state.fiberLength).toBeCloseTo(target, 3);
  });

  it('takes the activation it is handed rather than the one already in the state', () => {
    // Semi-implicit: the fiber advances on the new activation, not the old one.
    const length = 0.3;
    const state = { activation: 0.1, fiberLength: 1 };
    const stepped = stepFiber(state, length, 0.9, 1e-3, MUSCLE);
    expect(stepped.state.activation).toBe(0.9);
    const atOld = solveEquilibrium({ activation: 0.1, fiberLength: 1 }, length, MUSCLE);
    expect(stepped.solution.fiberVelocity).not.toBeCloseTo(atOld.fiberVelocity, 6);
  });

  it('reports a fiber driven out of range instead of quietly carrying on', () => {
    // The spec asks for this to be a diagnostic. A muscle pulled to twice its optimal length is
    // a broken path or too long a step, and hiding it makes the cause impossible to find.
    const stepped = stepFiber({ activation: 1, fiberLength: 1.99 }, 0.45, 1, 0.05, MUSCLE);
    expect(stepped.outOfRange).toBe(true);
    expect(stepped.state.fiberLength).toBeLessThanOrEqual(FIBER_LENGTH_MAXIMUM);
    expect(stepped.state.fiberLength).toBeGreaterThanOrEqual(FIBER_LENGTH_MINIMUM);
  });

  it('keeps every reported number finite across the whole working range', () => {
    for (const activation of [0, 0.001, 0.5, 1]) {
      for (const fiberLength of [0.2, 0.6, 1, 1.5, 1.9]) {
        for (const length of [0.2, 0.25, 0.3, 0.35, 0.4]) {
          const stepped = stepFiber({ activation, fiberLength }, length, activation, 1e-3, MUSCLE);
          const label = `a=${activation} lM=${fiberLength} lMT=${length}`;
          expect(Number.isFinite(stepped.state.fiberLength), label).toBe(true);
          expect(Number.isFinite(stepped.solution.fiberVelocity), label).toBe(true);
          expect(Number.isFinite(stepped.solution.tendonForce), label).toBe(true);
          expect(Number.isFinite(stepped.solution.fiberForce), label).toBe(true);
        }
      }
    }
  });
});
