import { describe, expect, it } from 'vitest';
import { MlpPolicy } from './policy.js';

describe('MlpPolicy', () => {
  it('counts its parameters, runs, and round-trips through a file', () => {
    const sizes = [5, 4, 3];
    expect(MlpPolicy.parameterCount(sizes)).toBe(5 * 4 + 4 + 4 * 3 + 3);
    let seed = 7;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const policy = MlpPolicy.random(sizes, random);
    const out = policy.act([0.1, -0.2, 0.3, 0.4, -0.5]);
    expect(out.length).toBe(3);
    for (const v of out) {
      expect(v).toBeGreaterThan(-1);
      expect(v).toBeLessThan(1);
    }
    // Every layer's activations are kept, input first, for the picture of the brain.
    expect(policy.layers.map((l) => l.length)).toEqual(sizes);
    expect(policy.layers[0]?.[2]).toBeCloseTo(0.3, 12);
    const file = policy.toFile({
      task: 'test',
      inputs: ['a', 'b', 'c', 'd', 'e'],
      outputs: ['x', 'y', 'z'],
    });
    const back = MlpPolicy.fromFile(file);
    expect(Array.from(back.weights)).toEqual(Array.from(policy.weights));
    const again = back.act([0.1, -0.2, 0.3, 0.4, -0.5]);
    for (let i = 0; i < 3; i++) expect(again[i]).toBeCloseTo(out[i] as number, 12);
  });

  it('refuses weights of the wrong length', () => {
    expect(() => new MlpPolicy([3, 2], new Float32Array(5))).toThrow(/weights/);
  });
});
