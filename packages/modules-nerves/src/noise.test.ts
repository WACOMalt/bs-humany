/**
 * The noise: that it is seeded and nothing else, that its size is what was asked for, and that
 * it reaches the muscles.
 */

import { describe, expect, it } from 'vitest';
import { NoiseField, XorShift32, seededNormal, seededUniform } from './noise.js';

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

/**
 * The two closures `XorShift32` replaced, as they were written, so the class is held to the
 * numbers they drew rather than to itself. Kept verbatim: a copy tidied into a class would test
 * nothing.
 */
function closureUniform(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s + 0.5) / 4294967296;
  };
}

function closureNormal(seed: number): () => number {
  const uniform = closureUniform(seed);
  let spare: number | undefined;
  return () => {
    if (spare !== undefined) {
      const value = spare;
      spare = undefined;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(uniform()));
    const angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

/** FNV-1a over the float64 bit patterns: equal only if every draw is equal to the last bit. */
function bitHash(values: readonly number[]): string {
  const words = new Uint32Array(new Float64Array(values).buffer);
  let h = 2166136261;
  for (let i = 0; i < words.length; i++) {
    h ^= words[i] as number;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

describe('the shared xorshift32 stream', () => {
  const seeds = [0, 1, 7, 0x9e3779b9];

  it('draws what the closures it replaced drew, to the bit, for a thousand draws', () => {
    // Every seeded disturbance a checkpoint was trained under came from these closures, so a class
    // that drew anything else would replay none of them.
    for (const seed of seeds) {
      const stream = new XorShift32(seed);
      const uniform = closureUniform(seed);
      for (let i = 0; i < 1000; i++) expect(Object.is(stream.uniform(), uniform())).toBe(true);
      const normals = new XorShift32(seed);
      const normal = closureNormal(seed);
      for (let i = 0; i < 1000; i++) expect(Object.is(normals.normal(), normal())).toBe(true);
    }
  });

  it('draws the numbers captured from the closures before they were replaced', () => {
    // Hashes of the first thousand uniforms and normals, taken from the closures themselves before
    // the class existed, so the check above cannot pass by the reference copy drifting with it.
    // Seeds 0 and 1 are the same stream: zero falls back to 1.
    const captured: Record<number, [string, string]> = {
      0: ['52d11ca1', '5e466a40'],
      1: ['52d11ca1', '5e466a40'],
      7: ['ff2e3cca', '0336e05d'],
      [0x9e3779b9]: ['bbe92e82', 'b69096f1'],
    };
    for (const seed of seeds) {
      const uniforms = new XorShift32(seed);
      const normals = new XorShift32(seed);
      const u = Array.from({ length: 1000 }, () => uniforms.uniform());
      const n = Array.from({ length: 1000 }, () => normals.normal());
      expect([bitHash(u), bitHash(n)]).toEqual(captured[seed]);
      expect(bitHash(Array.from({ length: 1000 }, seededUniform(seed)))).toBe(captured[seed]?.[0]);
      expect(bitHash(Array.from({ length: 1000 }, seededNormal(seed)))).toBe(captured[seed]?.[1]);
    }
  });

  it('picks up where its state was taken, spare normal and all', () => {
    // An odd number of normals leaves the second of a pair held over: the case a restore that
    // carried only the word would get wrong.
    const stream = new XorShift32(7);
    for (let i = 0; i < 37; i++) stream.normal();
    const state = stream.getState();
    expect(state.hasSpare).toBe(true);
    const expected = Array.from({ length: 20 }, () => stream.normal());
    const restored = new XorShift32(99);
    restored.setState(state);
    expect(Array.from({ length: 20 }, () => restored.normal())).toEqual(expected);
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
