import { describe, expect, it } from 'vitest';
import { type Prng, createPrng, createPrngFromString } from './prng.js';

function draw(prng: Prng, count: number): number[] {
  return Array.from({ length: count }, () => prng.nextFloat());
}

describe('determinism', () => {
  it('gives the same sequence for the same seed', () => {
    // The whole determinism contract (spec section 10.7) rests on this.
    expect(draw(createPrng(12345), 100)).toEqual(draw(createPrng(12345), 100));
  });

  it('gives different sequences for different seeds', () => {
    expect(draw(createPrng(1), 50)).not.toEqual(draw(createPrng(2), 50));
  });

  it('produces well-separated streams even for adjacent low-entropy seeds', () => {
    // Seeds 0, 1, 2 are exactly what a test or a scenario file will use, so they must not
    // produce visibly correlated opening draws.
    const streams = [0, 1, 2, 3].map((s) => draw(createPrng(s), 20));
    for (let i = 0; i < streams.length; i++) {
      for (let j = i + 1; j < streams.length; j++) {
        const a = streams[i] ?? [];
        const b = streams[j] ?? [];
        const matches = a.filter((v, k) => v === b[k]).length;
        expect(matches).toBe(0);
      }
    }
  });

  it('accepts a readable string seed', () => {
    expect(draw(createPrngFromString('drop-supine-01'), 20)).toEqual(
      draw(createPrngFromString('drop-supine-01'), 20),
    );
    expect(draw(createPrngFromString('drop-supine-01'), 20)).not.toEqual(
      draw(createPrngFromString('drop-supine-02'), 20),
    );
  });

  it('rejects a non-integer seed', () => {
    expect(() => createPrng(1.5)).toThrow(/must be an integer/);
  });
});

describe('stream splitting', () => {
  it('derives a stream that is deterministic in its name', () => {
    const a = createPrng(999).derive('mechanics.contactJitter');
    const b = createPrng(999).derive('mechanics.contactJitter');
    expect(draw(a, 50)).toEqual(draw(b, 50));
  });

  it('gives unrelated streams to similar names', () => {
    // 'spine.l1' and 'spine.l2' differ in one character. Hashing through splitmix is what keeps
    // them from producing adjacent, correlated streams.
    const master = createPrng(7);
    const l1 = draw(master.derive('spine.l1'), 30);
    const l2 = draw(createPrng(7).derive('spine.l2'), 30);
    expect(l1.filter((v, i) => v === l2[i]).length).toBe(0);
  });

  it('is independent of draw order, so adding a consumer perturbs nothing', () => {
    // This is the property that makes splitting worth having. With one shared stream, adding a
    // module -- or changing how many numbers an existing one draws -- would shift every
    // subsequent draw and change the behaviour of modules nobody touched.
    const before = createPrng(42);
    const expected = draw(before.derive('module.b'), 40);

    const after = createPrng(42);
    const noisyNewModule = after.derive('module.a');
    draw(noisyNewModule, 1000);
    const actual = draw(after.derive('module.b'), 40);

    expect(actual).toEqual(expected);
  });

  it('derives independently of how much the parent has already drawn', () => {
    const fresh = createPrng(5);
    const expected = draw(fresh.derive('child'), 20);

    const used = createPrng(5);
    draw(used, 500);
    expect(draw(used.derive('child'), 20)).toEqual(expected);
  });
});

describe('distributions', () => {
  it('produces floats in [0, 1)', () => {
    const prng = createPrng(2024);
    for (let i = 0; i < 20000; i++) {
      const v = prng.nextFloat();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('produces uint32 values in range', () => {
    const prng = createPrng(2025);
    for (let i = 0; i < 20000; i++) {
      const v = prng.nextUint32();
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('is roughly uniform across buckets', () => {
    const buckets = new Array<number>(10).fill(0);
    const prng = createPrng(31415);
    const samples = 200000;
    for (let i = 0; i < samples; i++) {
      const index = Math.floor(prng.nextFloat() * 10);
      buckets[index] = (buckets[index] ?? 0) + 1;
    }
    const expected = samples / 10;
    for (const count of buckets) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.05);
    }
  });

  it('respects nextRange bounds', () => {
    const prng = createPrng(8);
    for (let i = 0; i < 10000; i++) {
      const v = prng.nextRange(-3, 7);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(7);
    }
  });

  it('produces unbiased integers', () => {
    // Rejection sampling rather than modulo. A modulo-biased die would be subtly loaded, which is
    // exactly the kind of thing nobody notices.
    const counts = new Array<number>(6).fill(0);
    const prng = createPrng(1618);
    const samples = 120000;
    for (let i = 0; i < samples; i++) {
      const roll = prng.nextInt(6);
      counts[roll] = (counts[roll] ?? 0) + 1;
    }
    const expected = samples / 6;
    for (const count of counts) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.05);
    }
  });

  it('rejects an invalid integer bound', () => {
    const prng = createPrng(1);
    expect(() => prng.nextInt(0)).toThrow(/positive integer/);
    expect(() => prng.nextInt(-1)).toThrow(/positive integer/);
    expect(() => prng.nextInt(2.5)).toThrow(/positive integer/);
  });

  it('produces normals with the right mean and variance', () => {
    const prng = createPrng(2718);
    const samples = 200000;
    let sum = 0;
    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
      const v = prng.nextNormal();
      sum += v;
      sumSquares += v * v;
    }
    const mean = sum / samples;
    const variance = sumSquares / samples - mean * mean;
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(Math.abs(variance - 1)).toBeLessThan(0.02);
  });
});

describe('shuffle', () => {
  it('is deterministic for a given seed', () => {
    const items = () => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(createPrng(77).shuffle(items())).toEqual(createPrng(77).shuffle(items()));
  });

  it('preserves every element', () => {
    const original = Array.from({ length: 50 }, (_, i) => i);
    const shuffled = createPrng(88).shuffle([...original]);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(original);
  });

  it('actually reorders', () => {
    const original = Array.from({ length: 50 }, (_, i) => i);
    expect(createPrng(99).shuffle([...original])).not.toEqual(original);
  });
});

describe('snapshot and restore', () => {
  it('resumes the identical sequence', () => {
    // Spec section 13.7: a restored session must continue exactly as the captured one would have.
    const prng = createPrng(555);
    draw(prng, 37);
    const state = prng.getState();
    const expected = draw(prng, 50);

    const restored = createPrng(1);
    restored.setState(state);
    expect(draw(restored, 50)).toEqual(expected);
  });

  it('carries the cached normal spare', () => {
    // Box-Muller style methods produce two normals at once. If the cached one is left out of the
    // snapshot, a restored run draws a different first normal than the original did.
    const prng = createPrng(123);
    prng.nextNormal();
    const state = prng.getState();
    expect(state.normalSpare).not.toBeNull();

    const expected = [prng.nextNormal(), prng.nextNormal(), prng.nextNormal()];
    const restored = createPrng(999);
    restored.setState(state);
    expect([restored.nextNormal(), restored.nextNormal(), restored.nextNormal()]).toEqual(expected);
  });

  it('survives a JSON round-trip', () => {
    const prng = createPrng(321);
    draw(prng, 10);
    prng.nextNormal();
    const state = JSON.parse(JSON.stringify(prng.getState()));
    const expected = draw(prng, 20);

    const restored = createPrng(0);
    restored.setState(state);
    expect(draw(restored, 20)).toEqual(expected);
  });
});
