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

import type { BodyFingerprint } from './bodyFingerprint.js';

export interface PolicyFile {
  readonly format: 'bs-humany.policy/1';
  /** What it was trained to do -- `stand`, later `walk` -- for the studio to say. */
  readonly task: string;
  /** The fidelity profile it was trained on, when known; it fits any, by the names below. */
  readonly profile?: string;
  /** Layer widths, input to output. */
  readonly sizes: readonly number[];
  /** What each input is, in order; what each output drives. The key a policy is fitted by. */
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** The weights, little-endian float32, base64. */
  readonly weights: string;
  readonly trained?: {
    readonly generations: number;
    /**
     * What it scored. For a record, the score that made it the record; for a search's centre,
     * the centre's own last score, taken at `scoredAt` -- files written before that field was
     * kept hold the population's mean here instead.
     */
    readonly fitness: number;
    readonly episodes: number;
    readonly at: string;
    /**
     * The generation `fitness` was measured at. A centre is scored every few generations, so the
     * score a centre file carries can be older than the weights beside it.
     */
    readonly scoredAt?: number;
    /** The mean score of the population around it in the generation it was written. */
    readonly populationMean?: number;
    /** Seconds an episode lasted while it was scored, which bounds how much a score can be. */
    readonly seconds?: number;
  };
  /**
   * What it was trained in -- the scenario and its parameters, the body, what played under the
   * brain -- so a studio can set itself up the same way before handing over. The trainer's
   * `TrainingRecipe`; kept loose here so a policy file never depends on the trainer.
   */
  readonly recipe?: {
    readonly name: string;
    readonly task: string;
    /** Ticks a second, and ticks between policy evaluations, as it was trained. */
    readonly stepsPerSecond?: number;
    readonly controlDivisor?: number;
    readonly scenario: string;
    readonly parameters: Readonly<Record<string, number>>;
    readonly profile: string;
    readonly morphology: {
      readonly sex: number;
      readonly stature: number;
      readonly mass: number;
      readonly proportions?: Readonly<Partial<Record<string, number>>> | undefined;
    };
    readonly passive: boolean;
    readonly redistribute: boolean;
    readonly feedforward:
      | { readonly kind: 'clip'; readonly clip: string }
      | { readonly kind: 'script' }
      | { readonly kind: 'none' };
    readonly authority: number;
    /** The tremor on its muscles and the grain on its senses while it was learning. */
    readonly noise?: {
      readonly motor: number;
      readonly sense: number;
      readonly tau: number;
    };
    /**
     * The cord it was trained over. A policy brought up on a body that answered its own stretch
     * is not the same controller on a body that does not, so the gains travel with it.
     */
    readonly reflex?: {
      readonly stretch: number;
      readonly velocity: number;
      readonly setPoint: number;
      readonly inhibition: number;
      readonly forceCeiling: number;
      readonly forceInhibition: number;
      readonly delaySeconds: number;
    };
    /** Context units it carried between control steps; also readable from its drive names. */
    readonly memory?: number;
  };
  /**
   * The body it was trained in, as `bodyFingerprint` takes it: profile, step, what its senses
   * meant, its drives, its muscles and its cord. Absent on a file written before checkpoints
   * recorded their body, which still loads and fits exactly as it did; `compareBody` against the
   * body it is handed to says what is different, and nothing refuses it for that. The format stays
   * `bs-humany.policy/1` because a reader that does not know the field loses nothing by skipping it.
   */
  readonly body?: BodyFingerprint;
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

  /**
   * A policy for a body with these senses and drives, carrying what the file has by name: a
   * sense the file knows keeps its column, a drive the file knows keeps its row, and the ones
   * it has never met start at zero, so a policy trained on a coarser body layers onto a finer
   * one and behaves as it did until the new senses learn to matter. The hidden layers are the
   * file's and must be the same widths as wanted.
   */
  static fit(
    file: PolicyFile,
    inputs: readonly string[],
    outputs: readonly string[],
  ): { policy: MlpPolicy; carried: { inputs: number; outputs: number } } {
    const from = MlpPolicy.fromFile(file);
    const hidden = file.sizes.slice(1, -1);
    const sizes = [inputs.length, ...hidden, outputs.length];
    if (
      sizes.join('x') === file.sizes.join('x') &&
      inputs.join('\n') === file.inputs.join('\n') &&
      outputs.join('\n') === file.outputs.join('\n')
    ) {
      return { policy: from, carried: { inputs: inputs.length, outputs: outputs.length } };
    }
    const to = new MlpPolicy(sizes);
    const inputAt = new Map(file.inputs.map((name, i) => [name, i]));
    const outputAt = new Map(file.outputs.map((name, i) => [name, i]));
    const carried = { inputs: 0, outputs: 0 };
    // First layer: rows are hidden units, columns are senses; copy the columns by name.
    const h0 = sizes[1] as number;
    const fromIn = file.sizes[0] as number;
    for (let i = 0; i < inputs.length; i++) {
      const j = inputAt.get(inputs[i] as string);
      if (j === undefined) continue;
      carried.inputs += 1;
      for (let o = 0; o < h0; o++)
        to.weights[o * inputs.length + i] = from.weights[o * fromIn + j] as number;
    }
    let toAt = h0 * inputs.length;
    let fromAt = h0 * fromIn;
    to.weights.set(from.weights.subarray(fromAt, fromAt + h0), toAt); // first biases
    toAt += h0;
    fromAt += h0;
    // Hidden layers between: the same widths, copied whole.
    for (let l = 2; l < sizes.length - 1; l++) {
      const n = (sizes[l] as number) * ((sizes[l - 1] as number) + 1);
      to.weights.set(from.weights.subarray(fromAt, fromAt + n), toAt);
      toAt += n;
      fromAt += n;
    }
    // Last layer: rows are drives; copy the rows and their biases by name.
    const last = sizes[sizes.length - 2] as number;
    const fromOut = file.sizes[file.sizes.length - 1] as number;
    for (let o = 0; o < outputs.length; o++) {
      const j = outputAt.get(outputs[o] as string);
      if (j === undefined) continue;
      carried.outputs += 1;
      to.weights.set(
        from.weights.subarray(fromAt + j * last, fromAt + (j + 1) * last),
        toAt + o * last,
      );
      to.weights[toAt + outputs.length * last + o] = from.weights[
        fromAt + fromOut * last + j
      ] as number;
    }
    return { policy: to, carried };
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
