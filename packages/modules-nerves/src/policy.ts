/**
 * The policy: a small feed-forward network, weights in one flat array, that turns an observation
 * into muscle commands.
 *
 * Small on purpose. The controller runs inside the tick at a hundred hertz, in TypeScript, in a
 * web view or a headset's publisher, and a few thousand multiply-adds is what that budget buys.
 * It is also what the training method wants: evolution strategies search the weight vector
 * directly, with no gradient through the simulation, and their cost grows with its length.
 *
 * Every layer's activations are kept from the last call, because the studio draws them: the
 * "brain" on screen is these arrays as pixels, input to output, each frame.
 */

export interface PolicyFile {
  readonly format: 'bs-humany.policy/1';
  /** What it was trained to do -- `stand`, later `walk` -- for the studio to say. */
  readonly task: string;
  /** Layer widths, input to output. */
  readonly sizes: readonly number[];
  /** What each input is, in order; what each output drives. Documentation and a check. */
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** The weights, little-endian float32, base64. */
  readonly weights: string;
  readonly trained?: {
    readonly generations: number;
    readonly fitness: number;
    readonly episodes: number;
    readonly at: string;
  };
}

export class MlpPolicy {
  readonly sizes: readonly number[];
  readonly weights: Float32Array;
  /** Each layer's last activations, the input first. */
  readonly layers: Float64Array[];

  constructor(sizes: readonly number[], weights?: Float32Array) {
    if (sizes.length < 2) throw new Error('A policy needs an input and an output layer.');
    this.sizes = sizes;
    const count = MlpPolicy.parameterCount(sizes);
    if (weights && weights.length !== count) {
      throw new Error(`These sizes need ${count} weights; ${weights.length} were given.`);
    }
    this.weights = weights ?? new Float32Array(count);
    this.layers = sizes.map((n) => new Float64Array(n));
  }

  /** Weights and biases, layer by layer: `out * in` weights row-major, then `out` biases. */
  static parameterCount(sizes: readonly number[]): number {
    let count = 0;
    for (let l = 1; l < sizes.length; l++) {
      count += (sizes[l] as number) * (sizes[l - 1] as number) + (sizes[l] as number);
    }
    return count;
  }

  /** Small random weights, so an untrained policy is a quiet one rather than a saturated one. */
  static random(sizes: readonly number[], random: () => number, scale = 0.05): MlpPolicy {
    const weights = new Float32Array(MlpPolicy.parameterCount(sizes));
    let at = 0;
    for (let l = 1; l < sizes.length; l++) {
      const fanIn = sizes[l - 1] as number;
      const n = (sizes[l] as number) * fanIn;
      for (let i = 0; i < n; i++) weights[at++] = ((random() * 2 - 1) * scale) / Math.sqrt(fanIn);
      at += sizes[l] as number; // biases stay zero
    }
    return new MlpPolicy(sizes, weights);
  }

  /** tanh through the hidden layers and the output: every command lands in [-1, 1]. */
  act(input: ArrayLike<number>): Float64Array {
    const first = this.layers[0] as Float64Array;
    for (let i = 0; i < first.length; i++) first[i] = input[i] ?? 0;
    let at = 0;
    for (let l = 1; l < this.sizes.length; l++) {
      const from = this.layers[l - 1] as Float64Array;
      const to = this.layers[l] as Float64Array;
      const fanIn = from.length;
      for (let o = 0; o < to.length; o++) {
        let sum = 0;
        const row = at + o * fanIn;
        for (let i = 0; i < fanIn; i++)
          sum += (this.weights[row + i] as number) * (from[i] as number);
        to[o] = sum;
      }
      at += to.length * fanIn;
      for (let o = 0; o < to.length; o++)
        to[o] = Math.tanh((to[o] as number) + (this.weights[at + o] as number));
      at += to.length;
    }
    return this.layers[this.layers.length - 1] as Float64Array;
  }

  static fromFile(file: PolicyFile): MlpPolicy {
    if (file.format !== 'bs-humany.policy/1') throw new Error(`not a policy file: ${file.format}`);
    const binary = atob(file.weights);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const weights = new Float32Array(bytes.buffer, 0, bytes.byteLength / 4);
    return new MlpPolicy(file.sizes, weights);
  }

  toFile(meta: Omit<PolicyFile, 'format' | 'sizes' | 'weights'>): PolicyFile {
    const bytes = new Uint8Array(
      this.weights.buffer,
      this.weights.byteOffset,
      this.weights.byteLength,
    );
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { format: 'bs-humany.policy/1', sizes: [...this.sizes], weights: btoa(binary), ...meta };
  }
}
