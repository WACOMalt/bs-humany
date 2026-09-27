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
 * What it drives is groups, not units -- seventy outputs for thirty-five groups a side --
 * because that is the dimension a controller can be trained in and the dimension a person
 * reasons in. Each output is a signed correction in [-authority, +authority], spread over the
 * group's units by their weights.
 *
 * ## Memory
 *
 * A network with no state answers the instant it is shown and nothing else. It cannot tell a
 * body leaning from a body that has leant and come back, cannot average a noisy sense over time,
 * and cannot predict -- which is what a real nervous system does with the hundred milliseconds
 * it spends waiting for its own afferents. Grain on the senses makes this worse, not better:
 * the one thing that makes a noisy sense usable is integrating it, and a feed-forward network
 * has nowhere to integrate.
 *
 * So the policy may be given `memory` context units. They are extra inputs it reads and extra
 * outputs it writes, fed from its own last answer: whatever it puts in them at one control step
 * it sees at the next. The network itself stays exactly what it was -- a plain perceptron, no
 * gates, no special case in `MlpPolicy` -- because the loop is closed out here. They are named
 * like any other sense, so a checkpoint trained without memory fits a body that has it, with
 * the context starting from nothing, and one trained with it fits a body that does not.
 *
 * The context is bounded by the output layer's own tanh, so a recurrent state cannot run away.
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
import { seededNormal } from './noise.js';
import { type Feet, ObservationBuilder } from './observation.js';
import { MlpPolicy, type PolicyFile } from './policy.js';

export const NERVES_MODULE_ID = 'bsums.xyz.bs-humany.nerves';

/**
 * The goal a module without one observes: nothing. One shared empty array rather than a fresh
 * literal at each evaluation, which was an allocation in `step` a hundred times a second (rule 9).
 */
const NO_GOAL: ArrayLike<number> = new Float64Array(0);

/** One output of the policy: a name, and the units it drives with their weights. */
export interface DriveOutput {
  readonly id: string;
  readonly units: readonly { readonly id: string; readonly weight: number }[];
}

/** The names a policy is fitted by: the body's senses and drives, in order. */
export interface PolicyNames {
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

export interface NervesOptions {
  /**
   * The policy: made, a file to fit to this body by its senses' and drives' names, or how to
   * make one once the body says what it observes.
   */
  readonly policy:
    | MlpPolicy
    | PolicyFile
    | ((inputs: number, outputs: number, names: PolicyNames) => MlpPolicy);
  readonly outputs: readonly DriveOutput[];
  /** Which segments are feet; found from the body by name when not given. */
  readonly feet?: Feet;
  /** The goal vector's size, and where to read it each control step. */
  readonly goalSize: number;
  readonly goal?: () => ArrayLike<number>;
  /** Ticks between policy evaluations; five at 500 Hz is a hundred hertz. */
  readonly controlDivisor?: number;
  /** The most a single output may add to or take from a unit's excitation. */
  readonly authority?: number;
  /**
   * Grain on the senses: the standard deviation of the noise added to every observation before
   * the policy reads it, in the observation's own units, which are all scaled to a few of
   * themselves. 0 is a perfect sense, which no body has.
   *
   * A policy trained on exact numbers can key on a digit that means nothing -- the fourth
   * decimal of a contact impulse -- and fall apart when the body it is put in reports that
   * digit differently. Grain makes it read the signal instead.
   */
  readonly senseNoise?: number;
  /**
   * Context units: state the policy carries from one control step to the next. 0 is the
   * memoryless policy the first checkpoints were trained as.
   */
  readonly memory?: number;
}

export class NervesModule implements SimModule {
  readonly manifest: ModuleManifest;
  readonly observation: ObservationBuilder;
  readonly outputs: readonly DriveOutput[];
  private readonly makePolicy: (inputs: number, outputs: number, names: PolicyNames) => MlpPolicy;
  /** How much of a fitted file this body could use; all of it when the file was its own. */
  carried: { inputs: number; outputs: number } | undefined;
  private policyInUse: MlpPolicy | undefined;
  private authority: number;
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
  private senseNoiseLevel: number;
  private senseNormal: () => number;
  private memorySize: number;
  /** What the policy put in its context units last step, and reads back this one. */
  private context: Float64Array;

  constructor(
    articulation: CompiledArticulation,
    muscles: CompiledMuscleSet,
    options: NervesOptions,
  ) {
    const given = options.policy;
    this.makePolicy =
      typeof given === 'function'
        ? given
        : 'format' in given
          ? (_inputs, _outputs, names) => {
              const fitted = MlpPolicy.fit(given, names.inputs, names.outputs);
              this.carried = fitted.carried;
              return fitted.policy;
            }
          : () => given;
    this.outputs = options.outputs;
    this.authority = options.authority ?? 0.5;
    this.controlDivisor = Math.max(1, Math.round(options.controlDivisor ?? 5));
    this.senseNoiseLevel = Math.max(0, options.senseNoise ?? 0);
    this.memorySize = Math.max(0, Math.round(options.memory ?? 0));
    this.context = new Float64Array(this.memorySize);
    this.senseNormal = seededNormal(1);
    this.goal = options.goal;
    this.observation = new ObservationBuilder(
      articulation,
      muscles,
      options.feet,
      options.goalSize,
      options.outputs,
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
    const names = this.policyNames;
    const inputs = names.inputs.length;
    const wanted = names.outputs.length;
    if (!this.policyInUse) {
      const policy = this.makePolicy(inputs, wanted, names);
      const sizes = policy.sizes;
      if (sizes[0] !== inputs) {
        throw new Error(`The policy takes ${sizes[0]} inputs and this body observes ${inputs}.`);
      }
      if (sizes[sizes.length - 1] !== wanted) {
        throw new Error(
          `The policy has ${sizes[sizes.length - 1]} outputs and ${wanted} drives were given.`,
        );
      }
      this.policyInUse = policy;
      this.obs = new Float64Array(inputs);
    }
  }

  /**
   * The senses the policy reads: the body's, then its own context units. And the drives it
   * writes: the muscle groups, then the context again. Named so that `MlpPolicy.fit` carries a
   * checkpoint across a change of memory the same way it carries one across a change of body.
   */
  get policyNames(): PolicyNames {
    const inputs = [...this.observation.names];
    const outputs = this.outputs.map((o) => o.id);
    for (let i = 0; i < this.memorySize; i++) {
      inputs.push(`context[${i}]`);
      outputs.push(`context[${i}]`);
    }
    return { inputs, outputs };
  }

  /** Context units the policy carries between control steps; 0 is a memoryless policy. */
  get memory(): number {
    return this.memorySize;
  }

  /** Ticks between evaluations, as settled. */
  get divisor(): number {
    return this.controlDivisor;
  }

  /** How much any one output may add to or take from a unit's excitation; 0 is silence. */
  get authorityLevel(): number {
    return this.authority;
  }

  set authorityLevel(value: number) {
    this.authority = Math.max(0, Math.min(1, value));
  }

  /** The grain on the senses, as a standard deviation; 0 is a perfect sense. */
  get senseNoise(): number {
    return this.senseNoiseLevel;
  }

  set senseNoise(value: number) {
    this.senseNoiseLevel = Math.max(0, value);
  }

  /**
   * Start a new episode's grain: the stream this seed names. Seeded rather than free-running
   * because the trainer scores the two halves of a mirrored pair against the same senses, and
   * a pair told different lies answers with the difference between the lies.
   */
  reseedSenses(seed: number): void {
    this.senseNormal = seededNormal(seed);
  }

  /**
   * Put a policy file in charge of this body, live: fitted by the names of its senses and
   * drives, so any checkpoint fits, and swapped in between one control step and the next with
   * nothing restarted. What the body could use of it is reported in `carried`.
   */
  adopt(file: PolicyFile): { inputs: number; outputs: number } {
    const inUse = this.policyInUse;
    if (!inUse) throw new Error('NervesModule.adopt before init.');
    // A policy file says how much memory it has, in its own drive names: a checkpoint trained
    // with context units carries them here, and the body takes that shape rather than the one
    // it happened to be built with. Otherwise handing a remembering policy to a forgetful body
    // would quietly drop the context and hand back a controller that is not the one trained.
    this.memorySize = file.outputs.filter((name) => /^context\[\d+\]$/.test(name)).length;
    if (this.context.length !== this.memorySize) this.context = new Float64Array(this.memorySize);
    const names = this.policyNames;
    if (this.obs.length !== names.inputs.length) {
      this.obs = new Float64Array(names.inputs.length);
    }
    const fitted = MlpPolicy.fit(file, names.inputs, names.outputs);
    this.policyInUse = fitted.policy;
    this.carried = fitted.carried;
    this.forget();
    return fitted.carried;
  }

  /** Take the policy out of the loop: zero weights, so the command is silence, and no authority. */
  release(): void {
    const inUse = this.policyInUse;
    if (!inUse) return;
    this.policyInUse = new MlpPolicy(inUse.sizes);
    this.carried = undefined;
    this.authority = 0;
    this.forget();
  }

  /** The policy in use; not until `init`, when the body has said how much it observes. */
  get policy(): MlpPolicy {
    if (!this.policyInUse) throw new Error('NervesModule.policy before init.');
    return this.policyInUse;
  }

  /** Drop the held command, as at the start of an episode. */
  forget(): void {
    this.command.fill(0);
    this.context.fill(0);
    this.sinceEvaluation = this.controlDivisor;
    this.evaluations = 0;
  }

  step(_ctx: ModuleStepContext): void {
    const excitation = this.excitation;
    if (!excitation) return;
    if (this.sinceEvaluation >= this.controlDivisor) {
      this.sinceEvaluation = 0;
      this.evaluations += 1;
      this.observation.fill(this.obs, this.goal ? this.goal() : NO_GOAL);
      // A NaN anywhere in the senses would become a NaN in every muscle within a tick; a sense
      // that has gone wrong reads as nothing instead, and the count says so.
      for (let i = 0; i < this.obs.length; i++) {
        if (!Number.isFinite(this.obs[i] as number)) {
          this.obs[i] = 0;
          this.unreadable += 1;
        }
      }
      // The grain, after the finiteness check so a sense that has gone wrong still reads as
      // nothing rather than as noise, and before the policy, which is the point of it. Only the
      // senses take it: the context units are not senses, and drawing for them too would make
      // the noise stream depend on how much memory a policy happens to have.
      const base = this.obs.length - this.memorySize;
      if (this.senseNoiseLevel > 0) {
        for (let i = 0; i < base; i++) {
          this.obs[i] = (this.obs[i] as number) + this.senseNoiseLevel * this.senseNormal();
        }
      }
      // The context: the policy's own state, fed back from its last answer.
      for (let i = 0; i < this.memorySize; i++) this.obs[base + i] = this.context[i] as number;
      const out = this.policy.act(this.obs);
      for (let o = 0; o < this.command.length; o++) this.command[o] = out[o] as number;
      for (let i = 0; i < this.memorySize; i++) {
        this.context[i] = out[this.command.length + i] as number;
      }
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
