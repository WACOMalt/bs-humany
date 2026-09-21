/**
 * The noise: that it is seeded and nothing else, that its size is what was asked for, and that
 * it reaches the muscles.
 */

import { describe, expect, it } from 'vitest';
import { NoiseField, seededNormal, seededUniform } from './noise.js';

const deviation = (values: readonly number[]): number => {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
};

describe('a seeded normal stream', () => {
  it('is standard, and is the same stream twice from the same seed', () => {
    const draws = Array.from({ length: 20000 }, seededNormal(7));
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(deviation(draws)).toBeGreaterThan(0.97);
    expect(deviation(draws)).toBeLessThan(1.03);
    expect(Array.from({ length: 5 }, seededNormal(7))).toEqual(
      Array.from({ length: 5 }, seededNormal(7)),
    );
    expect(Array.from({ length: 5 }, seededNormal(8))).not.toEqual(
      Array.from({ length: 5 }, seededNormal(7)),
    );
  });

  it('draws in (0, 1) and never at the ends, so a logarithm of it is finite', () => {
    const uniform = seededUniform(1);
    for (let i = 0; i < 10000; i++) {
      const u = uniform();
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
    }
  });
});

describe('a noise field', () => {
  it('holds its standard deviation whatever the step size', () => {
    for (const step of [0.002, 0.01, 0.05, 1]) {
      const field = new NoiseField(1, 0.2, 0.25, 11);
      const seen: number[] = [];
      // Past the first correlation time, so what is measured is the stationary spread.
      for (let i = 0; i < 40000; i++) {
        field.advance(step);
        if (i > 500) seen.push(field.values[0] as number);
      }
      expect(deviation(seen)).toBeGreaterThan(0.17);
      expect(deviation(seen)).toBeLessThan(0.23);
    }
  });

  it('wanders rather than jitters: one step is close to the last, many steps are not', () => {
    const field = new NoiseField(1, 1, 0.5, 3);
    const trace: number[] = [];
    for (let i = 0; i < 2000; i++) {
      field.advance(0.01);
      trace.push(field.values[0] as number);
    }
    const near = trace.slice(1).map((v, i) => Math.abs(v - (trace[i] as number)));
    const far = trace.slice(200).map((v, i) => Math.abs(v - (trace[i] as number)));
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(near)).toBeLessThan(0.25 * mean(far));
  });

  it('starts from rest on every reseed, and repeats for the seed it is given', () => {
    const field = new NoiseField(3, 0.1, 0.2, 5);
    for (let i = 0; i < 50; i++) field.advance(0.01);
    const wandered = Array.from(field.values);
    field.reseed(5);
    expect(Array.from(field.values)).toEqual([0, 0, 0]);
    for (let i = 0; i < 50; i++) field.advance(0.01);
    expect(Array.from(field.values)).toEqual(wandered);
    field.reseed(6);
    for (let i = 0; i < 50; i++) field.advance(0.01);
    expect(Array.from(field.values)).not.toEqual(wandered);
  });

  it('is silent at level zero, so a recipe can take it out of the loop', () => {
    const field = new NoiseField(2, 0, 0.2, 5);
    for (let i = 0; i < 20; i++) field.advance(0.01);
    expect(Array.from(field.values)).toEqual([0, 0]);
  });
});
