/**
 * Evolution strategies, the OpenAI flavour: perturb the weights with Gaussian noise in mirrored
 * pairs, score every perturbation on the simulation, and step the weights along the
 * fitness-weighted noise. No gradient through the simulation, which there is not; no
 * backpropagation, which a policy this small does not need; and every evaluation independent,
 * which is what sixteen worker threads want.
 *
 * Fitness is rank-transformed before use -- the best perturbation counts +0.5, the worst -0.5,
 * the rest evenly between -- so one lucky episode cannot drag the whole step, and Adam smooths
 * the steps. All of it seeded, so a run replays.
 */

export interface EsOptions {
  readonly dimension: number;
  readonly population: number;
  readonly sigma: number;
  readonly learningRate: number;
  readonly weightDecay?: number;
  readonly seed: number;
}

/** A seeded normal generator: xorshift32 and Box-Muller. */
export class Gaussian {
  private state: number;
  private spare: number | null = null;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  uniform(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return (this.state + 0.5) / 4294967296;
  }

  normal(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    const u = this.uniform();
    const v = this.uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
}

export class OpenAiEs {
  readonly theta: Float32Array;
  private readonly options: EsOptions;
  private readonly random: Gaussian;
  private readonly m: Float32Array;
  private readonly v: Float32Array;
  private step = 0;
  private epsilons: Float32Array[] = [];

  constructor(options: EsOptions, initial?: Float32Array) {
    if (options.population % 2 !== 0)
      throw new Error('The population must be even: mirrored pairs.');
    this.options = options;
    this.theta = initial ? Float32Array.from(initial) : new Float32Array(options.dimension);
    this.random = new Gaussian(options.seed);
    this.m = new Float32Array(options.dimension);
    this.v = new Float32Array(options.dimension);
  }

  /** The candidates to score this generation: `population` of them, mirrored in pairs. */
  ask(): Float32Array[] {
    const { dimension, population, sigma } = this.options;
    this.epsilons = [];
    const candidates: Float32Array[] = [];
    for (let pair = 0; pair < population / 2; pair++) {
      const epsilon = new Float32Array(dimension);
      for (let i = 0; i < dimension; i++) epsilon[i] = this.random.normal();
      const plus = new Float32Array(dimension);
      const minus = new Float32Array(dimension);
      for (let i = 0; i < dimension; i++) {
        plus[i] = (this.theta[i] as number) + sigma * (epsilon[i] as number);
        minus[i] = (this.theta[i] as number) - sigma * (epsilon[i] as number);
      }
      this.epsilons.push(epsilon);
      candidates.push(plus, minus);
    }
    return candidates;
  }

  /** Score the candidates `ask` gave, in the same order, and step. */
  tell(fitness: readonly number[]): void {
    const { dimension, population, sigma, learningRate } = this.options;
    if (fitness.length !== population) throw new Error('tell: one fitness per candidate.');
    // Centred ranks: the best +0.5, the worst -0.5.
    const order = fitness.map((f, i) => [f, i] as const).sort((a, b) => a[0] - b[0]);
    const shaped = new Float64Array(population);
    order.forEach(([, i], rank) => {
      shaped[i] = rank / (population - 1) - 0.5;
    });
    const gradient = new Float64Array(dimension);
    for (let pair = 0; pair < population / 2; pair++) {
      const epsilon = this.epsilons[pair] as Float32Array;
      const weight =
        ((shaped[2 * pair] as number) - (shaped[2 * pair + 1] as number)) / (population * sigma);
      for (let i = 0; i < dimension; i++)
        gradient[i] = (gradient[i] as number) + weight * (epsilon[i] as number);
    }
    // Adam, on the ascent direction.
    this.step += 1;
    const b1 = 0.9;
    const b2 = 0.999;
    const decay = this.options.weightDecay ?? 0;
    for (let i = 0; i < dimension; i++) {
      const g = (gradient[i] as number) - decay * (this.theta[i] as number);
      this.m[i] = b1 * (this.m[i] as number) + (1 - b1) * g;
      this.v[i] = b2 * (this.v[i] as number) + (1 - b2) * g * g;
      const mHat = (this.m[i] as number) / (1 - b1 ** this.step);
      const vHat = (this.v[i] as number) / (1 - b2 ** this.step);
      this.theta[i] = (this.theta[i] as number) + (learningRate * mHat) / (Math.sqrt(vHat) + 1e-8);
    }
  }

  get generation(): number {
    return this.step;
  }
}
