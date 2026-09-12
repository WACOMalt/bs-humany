/**
 * Seeded pseudo-random number generation.
 *
 * CONTRIBUTING rule 7 bans `Math.random` in simulation code outright. The determinism contract
 * (spec section 10.7) requires that identical inputs produce bit-identical output, and a global
 * generator shared with the rest of the runtime cannot offer that.
 *
 * **The important design decision here is splitting.** If every module drew from one shared
 * stream, adding a module -- or changing how many numbers an existing one consumes -- would shift
 * every subsequent draw and change the behaviour of modules that were not touched. Reproducibility
 * would then be hostage to registration order and to unrelated edits.
 *
 * So each consumer gets its own stream, derived by name from the master seed:
 *
 * ```ts
 * const noise = ctx.random.derive('mechanics.contactJitter');
 * ```
 *
 * The same name and master seed always give the same stream, independently of what else exists.
 *
 * The algorithm is sfc32, seeded through splitmix32. Chosen for being small, fast, passing
 * PractRand, and having a state of four 32-bit words that serializes trivially -- snapshot and
 * restore (spec section 13.7) must capture generator state exactly, or a restored session diverges
 * from the one it was captured from.
 */

/** Serializable generator state. Four 32-bit words plus any cached normal-distribution spare. */
export interface PrngState {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  /**
   * Box-Muller produces two normals at a time. The unused one is cached, which means it is part
   * of the generator's observable state and must travel with a snapshot -- otherwise a restored
   * run draws a different first normal than the original did.
   */
  readonly normalSpare: number | null;
}

export interface Prng {
  /** Uniform 32-bit unsigned integer. */
  nextUint32(): number;
  /** Uniform in `[0, 1)`. */
  nextFloat(): number;
  /** Uniform in `[min, max)`. */
  nextRange(min: number, max: number): number;
  /** Uniform integer in `[0, maxExclusive)`. */
  nextInt(maxExclusive: number): number;
  /** Standard normal, mean 0 and variance 1. */
  nextNormal(): number;
  /** Fisher-Yates shuffle in place. Returns the same array. */
  shuffle<T>(items: T[]): T[];
  /**
   * An independent stream derived from this one's seed and the given name.
   *
   * Deterministic in `(masterSeed, name)` and independent of draw order, so adding a consumer
   * never perturbs an existing one.
   */
  derive(name: string): Prng;
  /** Capture state for a snapshot. */
  getState(): PrngState;
  /** Restore previously captured state. */
  setState(state: PrngState): void;
}

/** splitmix32: used to expand a single seed into well-distributed generator state. */
function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

/**
 * FNV-1a over the name, so a stream name maps to a 32-bit value.
 *
 * Not cryptographic and does not need to be. It needs to be stable across platforms and across
 * runs, which rules out anything involving object identity or iteration order.
 */
function hashName(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

class Sfc32Prng implements Prng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private normalSpare: number | null = null;
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    const next = splitmix32(this.seed);
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    // Discard the first few outputs so low-entropy seeds (0, 1, 2) do not produce visibly
    // correlated opening draws.
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  nextUint32(): number {
    // sfc32
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t >>> 0;
  }

  nextFloat(): number {
    // 2^-32, so the result is in [0, 1) with uniform spacing.
    return this.nextUint32() * 2.3283064365386963e-10;
  }

  nextRange(min: number, max: number): number {
    return min + this.nextFloat() * (max - min);
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt requires a positive integer bound, got ${maxExclusive}.`);
    }
    // Rejection sampling, so the result is exactly uniform rather than modulo-biased.
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    let value = this.nextUint32();
    while (value >= limit) value = this.nextUint32();
    return value % maxExclusive;
  }

  nextNormal(): number {
    if (this.normalSpare !== null) {
      const spare = this.normalSpare;
      this.normalSpare = null;
      return spare;
    }
    // Marsaglia polar method: rejection-sample the unit disc, which avoids the trig calls in
    // Box-Muller and, more usefully here, never evaluates log(0).
    let u: number;
    let v: number;
    let s: number;
    do {
      u = this.nextFloat() * 2 - 1;
      v = this.nextFloat() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const factor = Math.sqrt((-2 * Math.log(s)) / s);
    this.normalSpare = v * factor;
    return u * factor;
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const a = items[i];
      const b = items[j];
      if (a === undefined && !(i in items)) continue;
      items[i] = b as T;
      items[j] = a as T;
    }
    return items;
  }

  derive(name: string): Prng {
    // Mix the parent's seed with the name hash, then run it through splitmix so that similar
    // names -- 'spine.l1' and 'spine.l2' -- produce unrelated streams rather than adjacent ones.
    const mixed = splitmix32((this.seed ^ hashName(name)) >>> 0)();
    return new Sfc32Prng(mixed);
  }

  getState(): PrngState {
    return { a: this.a, b: this.b, c: this.c, d: this.d, normalSpare: this.normalSpare };
  }

  setState(state: PrngState): void {
    this.a = state.a >>> 0;
    this.b = state.b >>> 0;
    this.c = state.c >>> 0;
    this.d = state.d >>> 0;
    this.normalSpare = state.normalSpare;
  }
}

/** Create a generator from an integer seed. */
export function createPrng(seed: number): Prng {
  if (!Number.isInteger(seed)) {
    throw new Error(`PRNG seed must be an integer, got ${seed}.`);
  }
  return new Sfc32Prng(seed);
}

/**
 * Create a generator from a string seed.
 *
 * Convenient for scenarios and test fixtures, where a readable seed such as `'drop-supine-01'` is
 * far easier to correlate with a bug report than an opaque integer.
 */
export function createPrngFromString(seed: string): Prng {
  return new Sfc32Prng(hashName(seed));
}
