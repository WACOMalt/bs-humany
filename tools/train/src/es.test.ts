import { describe, expect, it } from 'vitest';
import { Gaussian, OpenAiEs } from './es.js';

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
