import { describe, expect, it } from 'vitest';
import { Gaussian, OpenAiEs } from './es.js';

/** FNV-1a over the float64 bit patterns: equal only if every value is equal to the last bit. */
function bitHash(values: readonly number[]): string {
  const words = new Uint32Array(new Float64Array(values).buffer);
  let h = 2166136261;
  for (let i = 0; i < words.length; i++) {
    h ^= words[i] as number;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

describe('OpenAiEs', () => {
  it('climbs a quadratic bowl, deterministically', () => {
    // Fitness is minus the distance to a target: the plain hill that any working ES climbs.
    const target = Float32Array.from({ length: 20 }, (_, i) => Math.sin(i));
    const fitnessOf = (w: Float32Array) => {
      let d = 0;
      for (let i = 0; i < w.length; i++) d += ((w[i] as number) - (target[i] as number)) ** 2;
      return -d;
    };
    const run = () => {
      const es = new OpenAiEs({
        dimension: 20,
        population: 16,
        sigma: 0.1,
        learningRate: 0.05,
        seed: 3,
      });
      const start = fitnessOf(es.theta);
      for (let g = 0; g < 150; g++) es.tell(es.ask().map(fitnessOf));
      return { start, end: fitnessOf(es.theta), theta: Array.from(es.theta) };
    };
    const a = run();
    const b = run();
    expect(a.end).toBeGreaterThan(a.start + 0.9 * -a.start);
    expect(a.theta).toEqual(b.theta);
    // Where it ended before the generator became the nerves' stream: the same search, to the bit.
    expect(bitHash(a.theta)).toBe('32e76b42');
  });

  it('draws the normals it drew before it shared the nerves stream, for a thousand draws', () => {
    // Hashes of the first thousand normals, taken from the private xorshift32 this file had before
    // it drew from @bs-humany/modules-nerves. Every recorded run's perturbations came from those,
    // so a Gaussian that drew anything else would replay none of them. A zero seed still falls
    // back to 0x9e3779b9, not to the nerves' 1, so seeds 0 and 0x9e3779b9 name one stream here.
    const captured: Record<number, string> = {
      0: 'b69096f1',
      1: '5e466a40',
      7: '0336e05d',
      [0x9e3779b9]: 'b69096f1',
    };
    for (const [seed, hash] of Object.entries(captured)) {
      const g = new Gaussian(Number(seed));
      expect(bitHash(Array.from({ length: 1000 }, () => g.normal()))).toBe(hash);
    }
  });

  it('draws normals that look like normals', () => {
    const g = new Gaussian(11);
    let sum = 0;
    let sumSq = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const x = g.normal();
      sum += x;
      sumSq += x * x;
    }
    expect(sum / n).toBeCloseTo(0, 1);
    expect(sumSq / n).toBeCloseTo(1, 1);
  });
});
