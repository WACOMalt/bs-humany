import { describe, expect, it } from 'vitest';
import { defaultControlDivisor, profileRateHz } from './solverRate.js';

describe('the step rate a profile runs at', () => {
  it('is what the caller asked for, else the profile’s own, else 500', () => {
    expect(profileRateHz({ solver: { rate: 1000 } }, 240)).toBe(240);
    expect(profileRateHz({ solver: { rate: 1000 } })).toBe(1000);
    expect(profileRateHz({ solver: {} })).toBe(500);
    expect(profileRateHz({})).toBe(500);
    expect(profileRateHz(undefined)).toBe(500);
    expect(profileRateHz(undefined, 750)).toBe(750);
  });
});

describe('the default control divisor', () => {
  it('is as near a hundred hertz as whole ticks get, and never below one', () => {
    expect(defaultControlDivisor(500)).toBe(5);
    expect(defaultControlDivisor(1000)).toBe(10);
    expect(defaultControlDivisor(240)).toBe(2);
    expect(defaultControlDivisor(60)).toBe(1);
    expect(defaultControlDivisor(30)).toBe(1);
  });
});
