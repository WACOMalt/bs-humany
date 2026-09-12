import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_TICKS_PER_FRAME, SimClock, accumulateFrame } from './clock.js';

describe('SimClock construction', () => {
  it('derives dt from the rate', () => {
    expect(new SimClock(500).dt).toBeCloseTo(0.002, 15);
    expect(new SimClock(240).dt).toBeCloseTo(1 / 240, 15);
  });

  it('rejects a non-positive or non-finite rate', () => {
    expect(() => new SimClock(0)).toThrow(/positive finite/);
    expect(() => new SimClock(-100)).toThrow(/positive finite/);
    expect(() => new SimClock(Number.NaN)).toThrow(/positive finite/);
  });

  it('starts at tick zero', () => {
    const clock = new SimClock(500);
    expect(clock.tick).toBe(0);
    expect(clock.simTime).toBe(0);
  });
});

describe('simTime is derived, never accumulated', () => {
  it('equals tick * dt exactly', () => {
    // Spec section 10.6. Repeatedly adding dt to a running float accumulates rounding error
    // without bound; multiplying the integer tick does not.
    const clock = new SimClock(500);
    for (let i = 0; i < 10000; i++) clock.advance();
    expect(clock.simTime).toBe(10000 * clock.dt);
  });

  it('does not drift over a long run, unlike summation', () => {
    const rate = 500;
    const clock = new SimClock(rate);
    const steps = 1_000_000;

    for (let i = 0; i < steps; i++) clock.advance();

    // What naive accumulation would have produced.
    let accumulated = 0;
    for (let i = 0; i < steps; i++) accumulated += clock.dt;

    expect(clock.simTime).toBe(steps * clock.dt);
    // The two disagree, and the derived value is the correct one. If this assertion ever fails
    // because the drift vanished, the test is still fine -- but it documents why the rule exists.
    expect(Math.abs(accumulated - clock.simTime)).toBeGreaterThan(0);
    expect(clock.simTime).toBeCloseTo(2000, 9);
  });

  it('advances one tick at a time and returns the new tick', () => {
    const clock = new SimClock(100);
    expect(clock.advance()).toBe(1);
    expect(clock.advance()).toBe(2);
    expect(clock.tick).toBe(2);
    expect(clock.simTime).toBeCloseTo(0.02, 15);
  });

  it('resets to zero', () => {
    const clock = new SimClock(100);
    clock.advance();
    clock.advance();
    clock.reset();
    expect(clock.tick).toBe(0);
    expect(clock.simTime).toBe(0);
  });
});

describe('rate divisors', () => {
  it('runs every tick for a divisor of 1', () => {
    const clock = new SimClock(100);
    for (let i = 0; i < 10; i++) {
      expect(clock.shouldRun(1)).toBe(true);
      clock.advance();
    }
  });

  it('runs every nth tick', () => {
    const clock = new SimClock(100);
    const ran: number[] = [];
    for (let i = 0; i < 20; i++) {
      if (clock.shouldRun(5)) ran.push(clock.tick);
      clock.advance();
    }
    expect(ran).toEqual([0, 5, 10, 15]);
  });

  it('rejects an invalid divisor', () => {
    const clock = new SimClock(100);
    expect(() => clock.shouldRun(0)).toThrow(/positive integer/);
    expect(() => clock.shouldRun(-1)).toThrow(/positive integer/);
    expect(() => clock.shouldRun(1.5)).toThrow(/positive integer/);
  });
});

describe('snapshot and restore', () => {
  it('round-trips the tick', () => {
    const clock = new SimClock(500);
    for (let i = 0; i < 123; i++) clock.advance();
    const snapshot = clock.snapshot();

    const restored = new SimClock(500);
    restored.restore(snapshot);
    expect(restored.tick).toBe(123);
    expect(restored.simTime).toBe(clock.simTime);
  });

  it('refuses a snapshot taken at a different timestep', () => {
    // Timestep is part of a run's identity: the same model stepped at a different rate produces
    // different results, so restoring across rates would silently produce a hybrid run.
    const snapshot = new SimClock(500).snapshot();
    expect(() => new SimClock(240).restore(snapshot)).toThrow(/part of a run's identity/);
  });
});

describe('accumulateFrame', () => {
  const dt = 1 / 500;

  it('runs no ticks for less than one timestep', () => {
    const plan = accumulateFrame(0, dt * 0.5, dt);
    expect(plan.ticks).toBe(0);
    expect(plan.alpha).toBeCloseTo(0.5, 10);
    expect(plan.clamped).toBe(false);
  });

  it('runs whole ticks and carries the remainder', () => {
    const plan = accumulateFrame(0, dt * 3.25, dt);
    expect(plan.ticks).toBe(3);
    expect(plan.alpha).toBeCloseTo(0.25, 8);
    expect(plan.remainder).toBeCloseTo(dt * 0.25, 12);
  });

  it('carries the accumulator across frames so no time is lost', () => {
    // Three frames of 0.4 timesteps each should add up to one tick, not zero.
    let accumulator = 0;
    let total = 0;
    for (let i = 0; i < 3; i++) {
      const plan = accumulateFrame(accumulator, dt * 0.4, dt);
      total += plan.ticks;
      accumulator = plan.remainder;
    }
    expect(total).toBe(1);
  });

  it('converges on the right tick count over many frames', () => {
    // 60 Hz render against 500 Hz physics: the rates do not divide evenly, which is exactly the
    // case that produces judder if the leftover is dropped instead of carried. It also needs
    // 8.34 ticks per frame, so it is the configuration that caught the default tick ceiling
    // being set too low to sustain real time.
    let accumulator = 0;
    let ticks = 0;
    const frames = 600;
    for (let i = 0; i < frames; i++) {
      const plan = accumulateFrame(accumulator, 1 / 60, dt);
      ticks += plan.ticks;
      accumulator = plan.remainder;
      expect(plan.clamped).toBe(false);
    }
    // Ten seconds of real time at 500 Hz.
    expect(ticks).toBeGreaterThanOrEqual(4999);
    expect(ticks).toBeLessThanOrEqual(5000);
  });

  it('always reports alpha in [0, 1)', () => {
    let accumulator = 0;
    for (let i = 0; i < 500; i++) {
      const plan = accumulateFrame(accumulator, (i % 7) * 0.001, dt);
      expect(plan.alpha).toBeGreaterThanOrEqual(0);
      expect(plan.alpha).toBeLessThan(1);
      accumulator = plan.remainder;
    }
  });

  it('clamps a long stall and reports that it did', () => {
    // The clamp is what stops the death spiral where a slow frame schedules more steps, making
    // the next frame slower still. Reporting it matters: a UI that hides the clamp tells the user
    // their model runs faster than it does.
    const plan = accumulateFrame(0, 5, dt, 8);
    expect(plan.ticks).toBe(8);
    expect(plan.clamped).toBe(true);
    expect(plan.remainder).toBeLessThan(dt);
  });

  it('does not clamp any supported physics rate at ordinary display rates', () => {
    // The clamp is for stalls. If it engages in steady state the simulation silently runs slow,
    // so the default ceiling must clear every rate combination the project supports.
    for (const physicsRate of [240, 500, 1000]) {
      for (const displayRate of [30, 60, 120, 144]) {
        const plan = accumulateFrame(0, 1 / displayRate, 1 / physicsRate);
        expect(
          plan.clamped,
          `${physicsRate} Hz physics at ${displayRate} fps needs ` +
            `${(physicsRate / displayRate).toFixed(2)} ticks per frame, above the default ` +
            `ceiling of ${DEFAULT_MAX_TICKS_PER_FRAME}`,
        ).toBe(false);
      }
    }
  });

  it('still bounds a genuine stall', () => {
    // Five seconds backgrounded at 500 Hz would otherwise queue 2500 steps.
    const plan = accumulateFrame(0, 5, dt);
    expect(plan.ticks).toBe(DEFAULT_MAX_TICKS_PER_FRAME);
    expect(plan.clamped).toBe(true);
  });

  it('rejects negative or non-finite elapsed time', () => {
    expect(() => accumulateFrame(0, -0.1, dt)).toThrow(/non-negative finite/);
    expect(() => accumulateFrame(0, Number.NaN, dt)).toThrow(/non-negative finite/);
  });
});
