import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACTIVATION_PARAMETERS,
  DEFAULT_ACTIVATION_TIME,
  DEFAULT_DEACTIVATION_TIME,
  MINIMUM_ACTIVATION,
  activationRate,
  stepActivation,
} from './activation.js';

/**
 * The exact solution of `a' = (u - a) / tau` at constant excitation. The whole point of testing
 * against this rather than against a previous run is that it is the answer the integrator is
 * trying to approximate, so the tests measure error rather than change.
 */
function analytic(initial: number, excitation: number, time: number, tau: number): number {
  return excitation + (initial - excitation) * Math.exp(-time / tau);
}

/**
 * Runs the integrator for a fixed duration and returns where it ended up.
 *
 * Comparisons against `analytic` start from `MINIMUM_ACTIVATION` rather than from zero, because
 * that floor is where a resting muscle in this model actually sits. Starting at zero would have
 * the first step clamped up onto the floor, and that displacement then decays through the rest of
 * the run -- a real effect of the floor, but not an integration error, and reading it as one
 * would mean loosening tolerances until they stopped measuring the integrator at all.
 */
function integrate(initial: number, excitation: number, duration: number, dt: number): number {
  let activation = initial;
  const steps = Math.round(duration / dt);
  for (let i = 0; i < steps; i++) activation = stepActivation(activation, excitation, dt);
  return activation;
}

describe('activation rate', () => {
  it('uses the activation time constant while rising and the deactivation one while falling', () => {
    // The asymmetry is the physiology: calcium release is fast and its reuptake is slow.
    expect(activationRate(0.2, 0.8)).toBeCloseTo(0.6 / DEFAULT_ACTIVATION_TIME, 9);
    expect(activationRate(0.8, 0.2)).toBeCloseTo(-0.6 / DEFAULT_DEACTIVATION_TIME, 9);
  });

  it('is zero when the muscle already sits at its excitation', () => {
    expect(activationRate(0.5, 0.5)).toBe(0);
  });

  it('turns on faster than it turns off, by the ratio of the two constants', () => {
    const rising = activationRate(0.2, 0.8);
    const falling = Math.abs(activationRate(0.8, 0.2));
    expect(rising / falling).toBeCloseTo(DEFAULT_DEACTIVATION_TIME / DEFAULT_ACTIVATION_TIME, 9);
    expect(rising).toBeGreaterThan(falling);
  });
});

describe('the activation step', () => {
  it('follows the analytic step response', () => {
    // One time constant of rise from rest covers 1 - 1/e of the way to the excitation. That
    // number is the definition of a time constant, so getting it right is the test.
    const dt = 1e-5;
    const rest = MINIMUM_ACTIVATION;
    const afterOneTau = integrate(rest, 1, DEFAULT_ACTIVATION_TIME, dt);
    expect(afterOneTau).toBeCloseTo(1 - Math.exp(-1), 2);

    // The tolerance is the method's own error bound rather than a count of decimal places.
    // Implicit Euler on this equation is first order, and its accumulated error over a run is
    // bounded by about dt/tau, so that is what the answer is allowed to be wrong by. Writing it
    // this way means the test tightens by itself whenever the step shrinks.
    for (const time of [0.002, 0.005, 0.01, 0.02, 0.05]) {
      const rising = Math.abs(
        integrate(rest, 1, time, dt) - analytic(rest, 1, time, DEFAULT_ACTIVATION_TIME),
      );
      expect(rising, `rising at ${time}s`).toBeLessThan(dt / DEFAULT_ACTIVATION_TIME);
      const falling = Math.abs(
        integrate(1, 0, time, dt) - analytic(1, 0, time, DEFAULT_DEACTIVATION_TIME),
      );
      expect(falling, `falling at ${time}s`).toBeLessThan(dt / DEFAULT_DEACTIVATION_TIME);
    }
  });

  it('halves its error when the step is halved, which is the order it claims', () => {
    // A first-order method. If this ratio ever drifts toward one, the integrator has stopped
    // converging on the analytic answer and is converging on something else.
    const duration = 0.02;
    const exact = analytic(MINIMUM_ACTIVATION, 1, duration, DEFAULT_ACTIVATION_TIME);
    const coarse = Math.abs(integrate(MINIMUM_ACTIVATION, 1, duration, 1e-3) - exact);
    const fine = Math.abs(integrate(MINIMUM_ACTIVATION, 1, duration, 5e-4) - exact);
    expect(coarse / fine).toBeGreaterThan(1.8);
    expect(coarse / fine).toBeLessThan(2.2);
  });

  it('stays stable at a step far longer than the time constant, where an explicit step would not', () => {
    // 100 ms is ten activation time constants. The explicit form would multiply the error by -9
    // every step and diverge; the implicit form has to stay between the two activations.
    let activation = 0;
    for (let i = 0; i < 20; i++) {
      const next = stepActivation(activation, 1, 0.1);
      expect(next, `step ${i}`).toBeGreaterThanOrEqual(activation);
      expect(next).toBeLessThanOrEqual(1);
      activation = next;
    }
    expect(activation).toBeCloseTo(1, 6);
  });

  it('never overshoots the excitation it is heading for', () => {
    // Monotone approach, at every step length: overshoot here would read as a muscle that
    // momentarily makes more force than it was asked for.
    for (const dt of [1e-4, 1e-3, 1e-2, 0.1, 1]) {
      expect(stepActivation(0.2, 0.9, dt), `rising at dt=${dt}`).toBeLessThanOrEqual(0.9);
      expect(stepActivation(0.9, 0.2, dt), `falling at dt=${dt}`).toBeGreaterThanOrEqual(0.2);
    }
  });

  it('holds still when excitation matches activation', () => {
    expect(stepActivation(0.5, 0.5, 0.002)).toBeCloseTo(0.5, 12);
  });

  it('keeps activation inside its own range, whatever excitation it is handed', () => {
    // Excitation arrives from a controller that this module does not own, so out-of-range input
    // is an input to handle rather than a caller's bug to propagate.
    expect(stepActivation(0.5, 5, 0.002)).toBeLessThanOrEqual(1);
    expect(stepActivation(0.5, -5, 0.002)).toBeGreaterThanOrEqual(MINIMUM_ACTIVATION);
    expect(stepActivation(0.5, 5, 0.002)).toBe(stepActivation(0.5, 1, 0.002));
    expect(stepActivation(0.5, -5, 0.002)).toBe(stepActivation(0.5, 0, 0.002));
  });

  it('lifts a muscle starting below the floor onto it, in one step', () => {
    // The floor is a property of the state, not of the excitation: a muscle handed a state below
    // it must come back up immediately rather than be integrated up gradually from nothing.
    expect(stepActivation(0, 0, 0.002)).toBe(MINIMUM_ACTIVATION);
  });

  it('settles at the floor rather than at zero when excitation is removed', () => {
    let activation = 1;
    for (let i = 0; i < 2000; i++) activation = stepActivation(activation, 0, 0.002);
    expect(activation).toBe(MINIMUM_ACTIVATION);
  });

  it('honours per-muscle time constants rather than reaching for the defaults', () => {
    // The spec requires these to be per-muscle parameters. A slow muscle given slow constants
    // must lag a fast one given fast ones, by the ratio of the constants.
    const slow = { activationTime: 0.05, deactivationTime: 0.05 };
    const fast = { activationTime: 0.005, deactivationTime: 0.005 };
    const dt = 1e-5;
    const stepFor = (p: typeof slow) => {
      let a = MINIMUM_ACTIVATION;
      for (let i = 0; i < 0.01 / dt; i++) a = stepActivation(a, 1, dt, p);
      return a;
    };
    expect(Math.abs(stepFor(slow) - analytic(MINIMUM_ACTIVATION, 1, 0.01, 0.05))).toBeLessThan(
      dt / 0.05,
    );
    expect(Math.abs(stepFor(fast) - analytic(MINIMUM_ACTIVATION, 1, 0.01, 0.005))).toBeLessThan(
      dt / 0.005,
    );
    expect(stepFor(fast)).toBeGreaterThan(stepFor(slow));
  });

  it('defaults to the Thelen constants', () => {
    expect(DEFAULT_ACTIVATION_PARAMETERS.activationTime).toBe(DEFAULT_ACTIVATION_TIME);
    expect(DEFAULT_ACTIVATION_PARAMETERS.deactivationTime).toBe(DEFAULT_DEACTIVATION_TIME);
    expect(DEFAULT_ACTIVATION_TIME).toBeLessThan(DEFAULT_DEACTIVATION_TIME);
  });
});
