import { describe, expect, it } from 'vitest';
import { controlDivisorFor } from './nerves.js';

describe('the control divisor a policy runs at', () => {
  it('keeps the period it was trained at, not its tick count', () => {
    // Ten ticks at 1000 Hz is ten milliseconds, which at 500 Hz is five ticks.
    expect(controlDivisorFor(500, { stepsPerSecond: 1000, controlDivisor: 10 })).toBe(5);
    expect(controlDivisorFor(240, { stepsPerSecond: 240, controlDivisor: 2 })).toBe(2);
    expect(controlDivisorFor(1000, { stepsPerSecond: 500, controlDivisor: 5 })).toBe(10);
  });

  it('is never less than every tick', () => {
    expect(controlDivisorFor(60, { stepsPerSecond: 1000, controlDivisor: 2 })).toBe(1);
  });

  it('is a hundred hertz when the policy did not record both numbers', () => {
    expect(controlDivisorFor(1000, undefined)).toBe(10);
    expect(controlDivisorFor(1000)).toBe(10);
    // A divisor without the rate it was a divisor of is not a period, so it is not kept.
    expect(controlDivisorFor(500, { controlDivisor: 10 })).toBe(5);
    expect(controlDivisorFor(500, { stepsPerSecond: 1000 })).toBe(5);
  });
});
