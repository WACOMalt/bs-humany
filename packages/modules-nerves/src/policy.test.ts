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

describe('MlpPolicy.fit', () => {
  it('carries weights by name onto a body with different senses and drives', () => {
    // Two senses and two drives, one hidden unit, weights numbered so each is recognisable.
    const from = new MlpPolicy([2, 1, 2], Float32Array.from([1, 2, 3, 4, 5, 6, 7]));
    const file = from.toFile({ task: 't', inputs: ['a', 'b'], outputs: ['x', 'y'] });
    // The new body senses c, b, a and drives y, z: b and a keep their columns, y its row.
    const { policy, carried } = MlpPolicy.fit(file, ['c', 'b', 'a'], ['y', 'z']);
    expect(policy.sizes).toEqual([3, 1, 2]);
    expect(carried).toEqual({ inputs: 2, outputs: 1 });
    // First layer: [c b a] columns then the bias; last layer: rows y, z then biases y, z.
    expect(Array.from(policy.weights)).toEqual([0, 2, 1, 3, 5, 0, 7, 0]);
    // Same senses and drives in the same order: the file's own weights, untouched.
    const same = MlpPolicy.fit(file, ['a', 'b'], ['x', 'y']);
    expect(Array.from(same.policy.weights)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('PolicyFile.body', () => {
  const body = {
    version: 1,
    profile: 'l1_standard',
    dtSeconds: 0.002,
    controlDivisor: 5,
    senses: { count: 2, names: '00000001', schema: '00000002', meanings: {} },
    drives: { count: 2, names: '00000003' },
    muscles: { count: 4, hash: '00000004' },
  };

  it('is carried through a file when given, and a file without one loads and fits as before', () => {
    const from = new MlpPolicy([2, 1, 2], Float32Array.from([1, 2, 3, 4, 5, 6, 7]));
    const recorded = from.toFile({ task: 't', inputs: ['a', 'b'], outputs: ['x', 'y'], body });
    expect(JSON.parse(JSON.stringify(recorded)).body).toEqual(body);
    // Written before bodies were recorded: the same format, no `body`, and nothing refuses it.
    const old = from.toFile({ task: 't', inputs: ['a', 'b'], outputs: ['x', 'y'] });
    expect(old.format).toBe('bs-humany.policy/1');
    expect(old.body).toBeUndefined();
    expect(Array.from(MlpPolicy.fromFile(old).weights)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const { carried } = MlpPolicy.fit(old, ['b', 'a'], ['x']);
    expect(carried).toEqual({ inputs: 2, outputs: 1 });
  });
});
