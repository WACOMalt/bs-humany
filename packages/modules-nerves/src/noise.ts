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

import type {
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  SimModule,
} from '@bs-humany/kernel';
import {
  type CompiledMuscleSet,
  EFFERENT_ALPHA_MOTOR,
  MUSCLE_CHANNEL_VERSION,
} from '@bs-humany/modules-muscle';
import type { DriveOutput } from './nervesModule.js';

/** A seeded uniform stream on (0, 1): xorshift32, the trainer's own. */
export function seededUniform(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s + 0.5) / 4294967296;
  };
}

/**
 * A seeded standard normal stream, by Box-Muller. Both of a pair are used, so a draw costs half
 * a logarithm and half a cosine rather than a whole one.
 */
export function seededNormal(seed: number): () => number {
  const uniform = seededUniform(seed);
  let spare: number | undefined;
  return () => {
    if (spare !== undefined) {
      const value = spare;
      spare = undefined;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(uniform()));
    const angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

/**
 * Band-limited noise on several channels at once: one Ornstein-Uhlenbeck wander each, all from
 * one seeded stream, advanced together.
 */
export class NoiseField {
  /** The current value of each channel. */
  readonly values: Float64Array;
  private normal: () => number;
  private level: number;
  private tau: number;

  constructor(channels: number, level: number, tau: number, seed = 1) {
    this.values = new Float64Array(channels);
    this.level = Math.max(0, level);
    this.tau = Math.max(1e-3, tau);
    this.normal = seededNormal(seed);
  }

  /** Start again from rest with a new stream: a new episode's disturbance. */
  reseed(seed: number): void {
    this.values.fill(0);
    this.normal = seededNormal(seed);
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
      this.values[i] = rho * (this.values[i] as number) + kick * this.normal();
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
 * land on the same accumulator, and the unit's excitation is clamped to [0, 1] on the way in.
 * Spread over a group's units by their weights, so a group half-driven by the policy is
 * half-wobbled too.
 *
 * One consequence worth knowing: a resting body given a tremor does not stay perfectly slack.
 * Excitation cannot go below zero, so the downward half of a zero-mean wander on a resting
 * muscle is clipped away and the upward half is not, and what is left is a small tone -- about
 * `0.4 * level` on a muscle that is otherwise silent. That is the muscle, not the noise: a
 * slack muscle cannot be relaxed further. A body that is meant to be limp wants `level` 0.
 *
 * `bias` rides along the same path for a disturbance that is aimed rather than random -- the
 * trainer's twitch, a burst on one group at one moment -- so a nudge is added to the muscles
 * and clamped with everything else, instead of overriding a layer the feedforward is also
 * writing and having to be taken back afterwards.
 */
export class MotorNoiseModule implements SimModule {
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
        const next = (excitation[at] as number) + delta * (weights[k] as number);
        excitation[at] = next < 0 ? 0 : next > 1 ? 1 : next;
      }
    }
  }

  dispose(): void {}
}
