/**
 * Noise: the tremor in a real motor system, and the grain in a real sense.
 *
 * A simulated body is silent in a way no body is. Every episode from the same start runs the
 * same way, so two candidates that differ a little in their weights can produce the same
 * trajectory to the last digit and score the same, and a search that cannot tell them apart
 * cannot climb. Worse, a policy that never meets a disturbance never learns to answer one: it
 * settles on a posture, holds it, and that is enough, which is what a brain that "chooses a
 * state and holds it" looks like from the outside.
 *
 * So both ends of the loop get noise. `MotorNoiseModule` adds a slow random wander onto every
 * drive output, the way recruitment and rate coding make a held contraction wobble. And the
 * nerves add grain to the observation before the policy reads it, because no receptor reports
 * an exact number. The body is then never twice in the same place, the policy must keep
 * correcting to stay up, and two candidates score differently because they answer the same
 * disturbance differently.
 *
 * The wander is an Ornstein-Uhlenbeck process, not white noise: it has a correlation time, so
 * it pushes for a while rather than cancelling itself out within a tick, which is what makes it
 * a disturbance the body must ride rather than a jitter the muscles' own dynamics filter away.
 * At a stationary `level` and correlation `tau`, each step is
 *
 *     x <- rho * x + sqrt(1 - rho^2) * level * g,   rho = exp(-step / tau)
 *
 * with `g` a unit normal, which holds the standard deviation at `level` for any step size.
 *
 * Every stream is seeded and nothing here touches `Math.random`, because the trainer compares
 * the two halves of a mirrored pair through the *same* disturbance. A pair given different
 * noise answers with the difference between the noises instead of the difference between the
 * weights, and the search learns nothing. Same seed, same tremor, for every candidate that
 * gets it.
 */

import {
  type ModuleInitContext,
  type ModuleManifest,
  type ModuleStepContext,
  type SimModule,
  type Stateful,
  packState,
  unpackState,
} from '@bs-humany/kernel';
import {
  type CompiledMuscleSet,
  EFFERENT_ALPHA_MOTOR,
  MUSCLE_CHANNEL_VERSION,
} from '@bs-humany/modules-muscle';
import type { DriveOutput } from './nervesModule.js';

/** What a `XorShift32` must carry through a snapshot to draw on exactly where it left off. */
export interface XorShift32State {
  /** The 32-bit word the next uniform is made from. */
  readonly s: number;
  /** The second normal of the last Box-Muller pair, meaningful only when `hasSpare`. */
  readonly spare: number;
  readonly hasSpare: boolean;
}

/**
 * The shared xorshift32 stream: uniforms on (0, 1), and standard normals from them by Box-Muller.
 *
 * The motor tremor and the sense grain both draw from it. It was two closures, which drew the
 * same numbers but kept their state where nothing could reach it, so a snapshot could not capture
 * a stream half-way through and a restored run drew different noise from the run it was restored
 * from (spec 13.7). A class keeps the same word and the same spare where `getState` can read them.
 *
 * A zero seed would be a stream of zeros, which xorshift never leaves, so zero falls back to 1:
 * seeds 0 and 1 name the same stream. The trainer's `Gaussian` in `tools/train/src/es.ts` is the
 * same generator with a different fallback, 0x9e3779b9, so the two agree for every seed but zero.
 *
 * Both of a Box-Muller pair are used, so a normal costs half a logarithm and half a cosine rather
 * than a whole one -- and the unused half is state, which is why it travels with the word.
 */
export class XorShift32 {
  private s: number;
  private spare = 0;
  private hasSpare = false;

  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }

  /** Start again as the stream this seed names, with no normal held over. */
  reseed(seed: number): void {
    this.s = seed >>> 0 || 1;
    this.spare = 0;
    this.hasSpare = false;
  }

  /** Uniform on (0, 1), never at either end, so a logarithm of it is finite. */
  uniform(): number {
    let s = this.s;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    this.s = s;
    return (s + 0.5) / 4294967296;
  }

  /** Standard normal, mean 0 and variance 1. */
  normal(): number {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spare;
    }
    const radius = Math.sqrt(-2 * Math.log(this.uniform()));
    const angle = 2 * Math.PI * this.uniform();
    this.spare = radius * Math.sin(angle);
    this.hasSpare = true;
    return radius * Math.cos(angle);
  }

  getState(): XorShift32State {
    return { s: this.s, spare: this.spare, hasSpare: this.hasSpare };
  }

  setState(state: XorShift32State): void {
    this.s = state.s >>> 0;
    this.spare = state.spare;
    this.hasSpare = state.hasSpare;
  }
}

/** A seeded uniform stream on (0, 1): a `XorShift32`'s uniforms, as a function. */
export function seededUniform(seed: number): () => number {
  const stream = new XorShift32(seed);
  return () => stream.uniform();
}

/** A seeded standard normal stream: a `XorShift32`'s normals, as a function. */
export function seededNormal(seed: number): () => number {
  const stream = new XorShift32(seed);
  return () => stream.normal();
}

/**
 * Band-limited noise on several channels at once: one Ornstein-Uhlenbeck wander each, all from
 * one seeded stream, advanced together.
 */
export class NoiseField {
  /** The current value of each channel. */
  readonly values: Float64Array;
  /** The stream every channel draws from, in turn; state, so a snapshot carries it. */
  readonly stream: XorShift32;
  private level: number;
  private tau: number;

  constructor(channels: number, level: number, tau: number, seed = 1) {
    this.values = new Float64Array(channels);
    this.level = Math.max(0, level);
    this.tau = Math.max(1e-3, tau);
    this.stream = new XorShift32(seed);
  }

  /** Start again from rest with a new stream: a new episode's disturbance. */
  reseed(seed: number): void {
    this.values.fill(0);
    this.stream.reseed(seed);
  }

  set strength(value: number) {
    this.level = Math.max(0, value);
  }

  get strength(): number {
    return this.level;
  }

  set correlation(seconds: number) {
    this.tau = Math.max(1e-3, seconds);
  }

  /** Advance every channel by `step` seconds. */
  advance(step: number): void {
    if (this.level === 0) {
      this.values.fill(0);
      return;
    }
    const rho = Math.exp(-Math.max(0, step) / this.tau);
    const kick = Math.sqrt(Math.max(0, 1 - rho * rho)) * this.level;
    for (let i = 0; i < this.values.length; i++) {
      this.values[i] = rho * (this.values[i] as number) + kick * this.stream.normal();
    }
  }
}

export const MOTOR_NOISE_MODULE_ID = 'bsums.xyz.bs-humany.motor-noise';

export interface MotorNoiseOptions {
  /** The drive outputs to wobble: the same groups the policy commands. */
  readonly outputs: readonly DriveOutput[];
  /** Standard deviation of the wander on an output, in excitation; 0 is a silent body. */
  readonly level?: number;
  /** Correlation time in seconds: how long one push lasts before it wanders elsewhere. */
  readonly tau?: number;
  /**
   * Ticks between fresh draws. The control divisor, so the tremor lives in the band the policy
   * answers in -- noise the policy cannot see in time to correct is only a handicap.
   */
  readonly divisor?: number;
}

/**
 * Adds a slow random wander onto the muscles, group by group, in the `control` phase.
 *
 * Adds onto `efferent.alphaMotor` rather than setting it, like every other writer of that
 * channel: the clip's tone, the person's slider, the policy's correction and this tremor all
 * land on the same accumulator, and the sum is clamped to [0, 1] once, by the muscle dynamics
 * that read it, not by each writer in turn. Spread over a group's units by their weights, so a
 * group half-driven by the policy is half-wobbled too.
 *
 * One consequence worth knowing: a resting body given a tremor does not stay perfectly slack.
 * Excitation cannot go below zero, so the downward half of a zero-mean wander on a resting
 * muscle is clipped away where the sum is read and the upward half is not, and what is left is a
 * small tone -- about `0.4 * level` on a muscle that is otherwise silent. (On a muscle something
 * else is driving, a downward swing still takes its share off, because nothing is clipped until
 * every writer has added.) That is the muscle, not the noise: a slack muscle cannot be relaxed
 * further. A body that is meant to be limp wants `level` 0.
 *
 * `bias` rides along the same path for a disturbance that is aimed rather than random -- the
 * trainer's twitch, a burst on one group at one moment -- so a nudge is added to the muscles
 * and summed with everything else, instead of overriding a layer the feedforward is also
 * writing and having to be taken back afterwards.
 */
export class MotorNoiseModule implements SimModule, Stateful {
  readonly manifest: ModuleManifest;
  readonly field: NoiseField;
  /** A steady push on an output, added with the wander; zero unless something sets it. */
  readonly bias: Float64Array;
  private readonly outputUnits: Int32Array[];
  private readonly outputWeights: Float64Array[];
  private readonly divisor: number;
  private excitation: Float64Array | undefined;
  private sinceDraw: number;

  constructor(muscles: CompiledMuscleSet, options: MotorNoiseOptions) {
    const unitIndex = new Map(muscles.units.map((u, i) => [u.id, i]));
    this.outputUnits = options.outputs.map((o) =>
      Int32Array.from(o.units, (u) => {
        const at = unitIndex.get(u.id);
        if (at === undefined) throw new Error(`No muscle unit '${u.id}' for output ${o.id}.`);
        return at;
      }),
    );
    this.outputWeights = options.outputs.map((o) => Float64Array.from(o.units, (u) => u.weight));
    this.divisor = Math.max(1, Math.round(options.divisor ?? 5));
    this.sinceDraw = this.divisor;
    this.field = new NoiseField(options.outputs.length, options.level ?? 0, options.tau ?? 0.25);
    this.bias = new Float64Array(options.outputs.length);
    this.manifest = {
      id: MOTOR_NOISE_MODULE_ID,
      version: '1.0.0',
      phase: 'control',
      dependsOn: [],
      reads: [],
      writes: [],
      accumulates: [{ id: EFFERENT_ALPHA_MOTOR, version: MUSCLE_CHANNEL_VERSION }],
      gives: [],
    };
  }

  /** How hard the tremor pushes, in excitation; 0 takes it out of the loop. */
  get level(): number {
    return this.field.strength;
  }

  set level(value: number) {
    this.field.strength = value;
  }

  /** Start a new episode's tremor: back to rest, no push, with the stream this seed names. */
  reseed(seed: number): void {
    this.field.reseed(seed);
    this.bias.fill(0);
    this.sinceDraw = this.divisor;
  }

  init(ctx: ModuleInitContext): void {
    this.bind(ctx);
  }

  reset(ctx: ModuleInitContext): void {
    this.bind(ctx);
  }

  private bind(ctx: ModuleInitContext): void {
    this.excitation = ctx.accumulate(EFFERENT_ALPHA_MOTOR).fields.excitation as Float64Array;
  }

  /**
   * The tremor as it stands, for a snapshot: the ticks since the last draw, the stream's word,
   * spare and whether it has one, then each output's wander and its bias.
   *
   * The wander is a process with a memory -- each draw is most of the last one plus a kick -- and
   * the kicks come from a stream that has moved on by every draw so far. Neither is in a channel.
   * Without them a restored run was pushed by a different tremor from the moment it was restored,
   * which is a different run, and the trainer's point about noise holds here too: the same seed has
   * to mean the same disturbance, wherever the run was picked up from.
   */
  getState(): Uint8Array {
    const stream = this.field.stream.getState();
    const outputs = this.field.values.length;
    const values = new Float64Array(4 + 2 * outputs);
    values[0] = this.sinceDraw;
    values[1] = stream.s;
    values[2] = stream.spare;
    values[3] = stream.hasSpare ? 1 : 0;
    values.set(this.field.values, 4);
    values.set(this.bias, 4 + outputs);
    return packState(values);
  }

  setState(state: unknown): void {
    const values = unpackState(state, MOTOR_NOISE_MODULE_ID);
    const outputs = this.field.values.length;
    if (values.length !== 4 + 2 * outputs) {
      throw new Error(
        `MotorNoiseModule state has ${values.length} numbers; expected ${4 + 2 * outputs} for ` +
          `${outputs} outputs. The snapshot was taken with a different set of drive outputs.`,
      );
    }
    this.sinceDraw = values[0] as number;
    this.field.stream.setState({
      s: values[1] as number,
      spare: values[2] as number,
      hasSpare: values[3] === 1,
    });
    this.field.values.set(values.subarray(4, 4 + outputs));
    this.bias.set(values.subarray(4 + outputs));
  }

  step(ctx: ModuleStepContext): void {
    const excitation = this.excitation;
    if (!excitation) return;
    if (this.sinceDraw >= this.divisor) {
      this.sinceDraw = 0;
      this.field.advance(this.divisor * ctx.dt);
    }
    this.sinceDraw += 1;
    const values = this.field.values;
    for (let o = 0; o < values.length; o++) {
      const delta = (values[o] as number) + (this.bias[o] as number);
      if (delta === 0) continue;
      const units = this.outputUnits[o] as Int32Array;
      const weights = this.outputWeights[o] as Float64Array;
      for (let k = 0; k < units.length; k++) {
        const at = units[k] as number;
        excitation[at] = (excitation[at] as number) + delta * (weights[k] as number);
      }
    }
  }

  dispose(): void {}
}
