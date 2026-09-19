/**
 * `NervesModule` -- the body's controller.
 *
 * In the `control` phase, after the senses and before the muscles: it builds an observation from
 * the channels, runs the policy, and adds what the policy says onto `efferent.alphaMotor`. Adds,
 * not sets: the channel is an accumulator, and whatever a scenario's clip or a person's slider
 * has already put there stays. The clip is the feedforward -- the tone of standing, the pattern
 * of walking -- and the nerves are the feedback that corrects it, which is how a spinal cord and
 * a pattern generator divide the work.
 *
 * The policy runs every `controlDivisor` ticks and its command is held between, because a
 * hundred hertz is plenty for muscles with forty-millisecond deactivation and the network is the
 * costly part of the tick. But the command is added every tick, since the accumulator is zeroed
 * every tick.
 *
 * What it drives is groups, not units -- forty-six outputs for twenty-three groups a side --
 * because that is the dimension a controller can be trained in and the dimension a person
 * reasons in. Each output is a signed correction in [-authority, +authority], spread over the
 * group's units by their weights.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import type {
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  SimModule,
} from '@bs-humany/kernel';
import {
  BODY_JOINT_STATE,
  BODY_POSE,
  BODY_VELOCITY,
  CHANNEL_VERSION,
  CONTACT_MANIFOLDS,
} from '@bs-humany/modules-mechanics';
import {
  type CompiledMuscleSet,
  EFFERENT_ALPHA_MOTOR,
  MUSCLE_CHANNEL_VERSION,
  MUSCLE_STATE,
} from '@bs-humany/modules-muscle';
import { type Feet, ObservationBuilder } from './observation.js';
import type { MlpPolicy } from './policy.js';

export const NERVES_MODULE_ID = 'bsums.xyz.bs-humany.nerves';

/** One output of the policy: a name, and the units it drives with their weights. */
export interface DriveOutput {
  readonly id: string;
  readonly units: readonly { readonly id: string; readonly weight: number }[];
}

export interface NervesOptions {
  /** The policy, or how to make one once the body says how many inputs there are. */
  readonly policy: MlpPolicy | ((inputs: number, outputs: number) => MlpPolicy);
  readonly outputs: readonly DriveOutput[];
  readonly feet: Feet;
  /** The goal vector's size, and where to read it each control step. */
  readonly goalSize: number;
  readonly goal?: () => ArrayLike<number>;
  /** Ticks between policy evaluations; five at 500 Hz is a hundred hertz. */
  readonly controlDivisor?: number;
  /** The most a single output may add to or take from a unit's excitation. */
  readonly authority?: number;
}

export class NervesModule implements SimModule {
  readonly manifest: ModuleManifest;
  readonly observation: ObservationBuilder;
  readonly outputs: readonly DriveOutput[];
  private readonly makePolicy: (inputs: number, outputs: number) => MlpPolicy;
  private policyInUse: MlpPolicy | undefined;
  private readonly authority: number;
  private readonly controlDivisor: number;
  private readonly goal: (() => ArrayLike<number>) | undefined;
  private obs = new Float64Array(0);
  private readonly command: Float64Array;
  private readonly unitIndex: Map<string, number>;
  private readonly outputUnits: Int32Array[];
  private readonly outputWeights: Float64Array[];
  private excitation: Float64Array | undefined;
  private sinceEvaluation = 0;
  private evaluations = 0;
  private unreadable = 0;

  constructor(
    articulation: CompiledArticulation,
    muscles: CompiledMuscleSet,
    options: NervesOptions,
  ) {
    const given = options.policy;
    this.makePolicy = typeof given === 'function' ? given : () => given;
    this.outputs = options.outputs;
    this.authority = options.authority ?? 0.5;
    this.controlDivisor = Math.max(1, Math.round(options.controlDivisor ?? 5));
    this.goal = options.goal;
    this.observation = new ObservationBuilder(
      articulation,
      muscles,
      options.feet,
      options.goalSize,
    );
    this.command = new Float64Array(options.outputs.length);
    this.unitIndex = new Map(muscles.units.map((u, i) => [u.id, i]));
    this.outputUnits = options.outputs.map((o) =>
      Int32Array.from(o.units, (u) => {
        const at = this.unitIndex.get(u.id);
        if (at === undefined) throw new Error(`No muscle unit '${u.id}' for output ${o.id}.`);
        return at;
      }),
    );
    this.outputWeights = options.outputs.map((o) => Float64Array.from(o.units, (u) => u.weight));
    this.manifest = {
      id: NERVES_MODULE_ID,
      version: '1.0.0',
      phase: 'control',
      dependsOn: [],
      reads: [
        { id: BODY_POSE, version: CHANNEL_VERSION },
        { id: BODY_VELOCITY, version: CHANNEL_VERSION },
        { id: BODY_JOINT_STATE, version: CHANNEL_VERSION },
        { id: CONTACT_MANIFOLDS, version: CHANNEL_VERSION },
        { id: MUSCLE_STATE, version: MUSCLE_CHANNEL_VERSION },
      ],
      writes: [],
      accumulates: [{ id: EFFERENT_ALPHA_MOTOR, version: MUSCLE_CHANNEL_VERSION }],
      gives: [],
    };
  }

  init(ctx: ModuleInitContext): void {
    this.bind(ctx);
    this.forget();
  }

  reset(ctx: ModuleInitContext): void {
    this.bind(ctx);
    this.forget();
  }

  private bind(ctx: ModuleInitContext): void {
    this.observation.bind({
      pose: ctx.read(BODY_POSE),
      velocity: ctx.read(BODY_VELOCITY),
      joints: ctx.read(BODY_JOINT_STATE),
      contacts: ctx.read(CONTACT_MANIFOLDS),
      muscles: ctx.read(MUSCLE_STATE),
    });
    this.excitation = ctx.accumulate(EFFERENT_ALPHA_MOTOR).fields.excitation as Float64Array;
    // The observation's size is known once the joints are: the policy is checked, or made, now.
    const inputs = this.observation.size;
    if (!this.policyInUse) {
      const policy = this.makePolicy(inputs, this.outputs.length);
      const sizes = policy.sizes;
      if (sizes[0] !== inputs) {
        throw new Error(`The policy takes ${sizes[0]} inputs and this body observes ${inputs}.`);
      }
      if (sizes[sizes.length - 1] !== this.outputs.length) {
        throw new Error(
          `The policy has ${sizes[sizes.length - 1]} outputs and ${this.outputs.length} drives were given.`,
        );
      }
      this.policyInUse = policy;
      this.obs = new Float64Array(inputs);
    }
  }

  /** The policy in use; not until `init`, when the body has said how much it observes. */
  get policy(): MlpPolicy {
    if (!this.policyInUse) throw new Error('NervesModule.policy before init.');
    return this.policyInUse;
  }

  /** Drop the held command, as at the start of an episode. */
  forget(): void {
    this.command.fill(0);
    this.sinceEvaluation = this.controlDivisor;
    this.evaluations = 0;
  }

  step(_ctx: ModuleStepContext): void {
    const excitation = this.excitation;
    if (!excitation) return;
    if (this.sinceEvaluation >= this.controlDivisor) {
      this.sinceEvaluation = 0;
      this.evaluations += 1;
      this.observation.fill(this.obs, this.goal ? this.goal() : []);
      // A NaN anywhere in the senses would become a NaN in every muscle within a tick; a sense
      // that has gone wrong reads as nothing instead, and the count says so.
      for (let i = 0; i < this.obs.length; i++) {
        if (!Number.isFinite(this.obs[i] as number)) {
          this.obs[i] = 0;
          this.unreadable += 1;
        }
      }
      const out = this.policy.act(this.obs);
      for (let o = 0; o < out.length; o++) this.command[o] = out[o] as number;
    }
    this.sinceEvaluation += 1;
    for (let o = 0; o < this.command.length; o++) {
      const delta = this.authority * (this.command[o] as number);
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

  /** The last command, one per output, in [-1, 1]. */
  get lastCommand(): Float64Array {
    return this.command;
  }

  /** The last observation the policy saw. */
  get lastObservation(): Float64Array {
    return this.obs;
  }

  get evaluationsSoFar(): number {
    return this.evaluations;
  }

  /** Inputs that were not finite and were read as zero, so far. Zero is the only good number. */
  get unreadableSoFar(): number {
    return this.unreadable;
  }

  dispose(): void {}
}
