/**
 * The training rig: one body, standing, with a policy in its nerves, that can run an episode
 * from the same start over and over with different weights.
 *
 * Built the way the golden runner builds a scenario -- physics, coupling, passive joints, the
 * full muscle set, the drive -- with a `NervesModule` on top, and the quiet-standing clip played
 * into the drive's script layer as the feedforward. The kernel is snapshotted once after init
 * and restored at the start of every episode, so an episode costs its ticks and nothing else.
 *
 * The reward is standing: a point for every hundredth of a second the head is up, a little for
 * the pelvis staying level and still, a little off for effort, and the episode ends when the
 * head drops. A seed changes the episode only through a twitch: a random group given a burst of
 * excitation at a random moment, so a policy that stands is one that stands through a nudge.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { compileArticulation } from '@bs-humany/compiler';
import { Kernel, type KernelSnapshot } from '@bs-humany/kernel';
import {
  BODY_BONE_TRANSFORMS,
  BODY_POSE,
  BODY_VELOCITY,
  CouplingModule,
  PassiveJointModule,
  PhysicsModule,
  SkeletonPoseModule,
} from '@bs-humany/modules-mechanics';
import {
  MUSCLE_STATE,
  MuscleDynamicsModule,
  MusclePathModule,
  MuscleTestDriveModule,
  compileMuscleSet,
} from '@bs-humany/modules-muscle';
import { MlpPolicy, NervesModule } from '@bs-humany/modules-nerves';
import {
  ANKLE_MUSCLES,
  ELBOW_MUSCLES,
  FOREARM_MUSCLES,
  HIP_MUSCLES,
  KNEE_MUSCLES,
  SHOULDER_MUSCLES,
  TORSO_MUSCLES,
  TRUNK_MUSCLES,
} from '@bs-humany/muscle-data';
import {
  type CompiledClip,
  FEET,
  GOAL_SIZE,
  driveOutputs,
  loadActivationClips,
  placeArticulation,
  unitsNamedByClips,
} from '@bs-humany/scenarios';
import { buildDocument } from '@bs-humany/skeleton';

export interface RigOptions {
  readonly profileId: string;
  /** Hidden layer widths; the input and output are the body's. */
  readonly hidden: readonly number[];
  readonly seconds: number;
  readonly controlDivisor: number;
  readonly authority: number;
  /** The clip played as feedforward; `quiet-standing` to learn to stand. */
  readonly clip: string;
  /** Also pose the skeleton's bones each tick, for a rig that publishes what it does. */
  readonly poseBones?: boolean;
}

export interface EpisodeResult {
  readonly fitness: number;
  readonly aliveSeconds: number;
}

export class StandRig {
  sizes: readonly number[] = [];
  inputNames: readonly string[] = [];
  outputNames: readonly string[] = [];
  private readonly kernel: Kernel;
  private readonly nerves: NervesModule;
  private readonly drive: MuscleTestDriveModule;
  private readonly clip: CompiledClip;
  private readonly clipUnits: readonly string[];
  private readonly units: readonly string[];
  private readonly snapshot: KernelSnapshot;
  private readonly dt: number;
  private readonly options: RigOptions;
  private readonly head: number;
  private readonly pelvis: number;
  /** The bone order and transforms, when `poseBones` was asked for. */
  readonly boneOrder: readonly string[];
  readonly restContext: unknown;
  private readonly parents: readonly number[];
  private readonly segmentIds: readonly string[];
  private live = 0;
  private position: Float64Array;
  private orientation: Float64Array;
  private linear: Float64Array;
  private activation: Float64Array;

  private constructor(
    options: RigOptions,
    kernel: Kernel,
    nerves: NervesModule,
    drive: MuscleTestDriveModule,
    clip: CompiledClip,
    units: readonly string[],
    head: number,
    pelvis: number,
    rate: number,
    boneOrder: readonly string[],
    restContext: unknown,
    parents: readonly number[],
    segmentIds: readonly string[],
  ) {
    this.boneOrder = boneOrder;
    this.restContext = restContext;
    this.parents = parents;
    this.segmentIds = segmentIds;
    this.options = options;
    this.kernel = kernel;
    this.nerves = nerves;
    this.drive = drive;
    this.clip = clip;
    this.clipUnits = clip.units;
    this.units = units;
    this.head = head;
    this.pelvis = pelvis;
    this.dt = 1 / rate;
    this.sizes = nerves.policy.sizes;
    this.inputNames = nerves.observation.names;
    this.outputNames = nerves.outputs.map((o) => o.id);
    this.position = kernel.channels.storage(BODY_POSE).fields.position as Float64Array;
    this.orientation = kernel.channels.storage(BODY_POSE).fields.orientation as Float64Array;
    this.linear = kernel.channels.storage(BODY_VELOCITY).fields.linear as Float64Array;
    this.activation = kernel.channels.storage(MUSCLE_STATE).fields.activation as Float64Array;
    this.snapshot = kernel.snapshot();
  }

  static async build(options: RigOptions): Promise<StandRig> {
    const document = buildDocument();
    const profile = document.segmentation.find((p) => p.id === options.profileId);
    if (!profile) throw new Error(`No profile '${options.profileId}'.`);
    const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
    const compiled = compileArticulation(document, options.profileId, morphology).articulation;
    const articulation = placeArticulation(compiled, undefined, 0, 0);
    const rate = profile.solver?.rate ?? 500;
    const kernel = new Kernel({ rateHz: rate, seed: 1, preferShared: false });
    const backend = new MujocoBackend();
    kernel.register(
      new PhysicsModule(backend, articulation, {
        ground: { height: 0 },
        iterations: profile.solver?.iterations,
      }),
    );
    kernel.register(new CouplingModule(articulation, backend.capabilities));
    kernel.register(new PassiveJointModule(articulation));
    let boneOrder: readonly string[] = [];
    if (options.poseBones) {
      const pose = new SkeletonPoseModule(document.bones, articulation, { redistribute: true });
      kernel.register(pose);
      boneOrder = pose.plan.bones;
    }
    const muscles = compileMuscleSet(
      [
        ...ELBOW_MUSCLES,
        ...SHOULDER_MUSCLES,
        ...KNEE_MUSCLES,
        ...HIP_MUSCLES,
        ...ANKLE_MUSCLES,
        ...TRUNK_MUSCLES,
        ...FOREARM_MUSCLES,
        ...TORSO_MUSCLES,
      ],
      document.attachmentSites,
      articulation,
      morphology.context,
      document.wrappingSurfaces ?? [],
    );
    const drive = new MuscleTestDriveModule(muscles, [
      { units: 'all', pattern: { kind: 'constant', level: 0 } },
    ]);
    kernel.register(drive);
    kernel.register(new MusclePathModule(articulation, muscles));
    kernel.register(new MuscleDynamicsModule(articulation, muscles));

    const outputs = driveOutputs();
    const goal = new Float64Array(GOAL_SIZE);
    goal[0] = 1;
    const nerves = new NervesModule(articulation, muscles, {
      policy: (inputs, outs) => new MlpPolicy([inputs, ...options.hidden, outs]),
      outputs,
      feet: FEET,
      goalSize: GOAL_SIZE,
      goal: () => goal,
      controlDivisor: options.controlDivisor,
      authority: options.authority,
    });
    kernel.register(nerves);
    await kernel.init();

    const clip = loadActivationClips(unitsNamedByClips()).get(options.clip);
    if (!clip) throw new Error(`No activation clip '${options.clip}'.`);
    const index = new Map(articulation.segments.map((s) => [s.id, s.index]));
    return new StandRig(
      options,
      kernel,
      nerves,
      drive,
      clip,
      muscles.units.map((u) => u.id),
      index.get('head') ?? 0,
      index.get('pelvis') ?? 0,
      rate,
      boneOrder,
      morphology.context,
      articulation.segments.map((seg) => seg.parent),
      articulation.segments.map((seg) => seg.id),
    );
  }

  get parameterCount(): number {
    return this.nerves.policy.weights.length;
  }

  /** The bones' world transforms as of now, in `boneOrder`; only with `poseBones`. */
  boneTransforms(): { position: Float64Array; orientation: Float64Array } {
    const fields = this.kernel.channels.storage(BODY_BONE_TRANSFORMS).fields;
    return {
      position: fields.position as Float64Array,
      orientation: fields.orientation as Float64Array,
    };
  }

  /** Every segment's world position, and each segment's parent, for a stick figure. */
  segments(): { position: Float64Array; parents: readonly number[]; ids: readonly string[] } {
    return { position: this.position, parents: this.parents, ids: this.segmentIds };
  }

  /** The policy's layers as they stand -- the brain, for drawing. */
  activity(): { layers: Float64Array[]; command: Float64Array; outputs: readonly string[] } {
    return {
      layers: this.nerves.policy.layers,
      command: this.nerves.lastCommand,
      outputs: this.outputNames,
    };
  }

  /**
   * Run one episode step by step under a caller's pacing: `begin` restores the start with the
   * weights, `tick` advances one tick with the clip playing, and says whether the body is
   * still up.
   */
  begin(weights: Float32Array): void {
    this.nerves.policy.weights.set(weights);
    this.kernel.restore(this.snapshot);
    this.nerves.forget();
    for (const unit of this.units) this.drive.setOverride(unit, null, 'script');
    this.live = 0;
  }

  tick(): { time: number; up: boolean; headHeight: number } {
    const time = this.live * this.dt;
    const at = this.clip.levels(time);
    for (let i = 0; i < this.clipUnits.length; i++) {
      this.drive.setOverride(this.clipUnits[i] as string, at[i] as number, 'script');
    }
    this.kernel.step();
    this.live += 1;
    const headHeight = this.position[3 * this.head + 1] as number;
    return { time, up: headHeight >= 1.15, headHeight };
  }

  /** Run one episode with these weights, from the start, and score it. */
  episode(weights: Float32Array, seed: number): EpisodeResult {
    const policy = this.nerves.policy;
    policy.weights.set(weights);
    this.kernel.restore(this.snapshot);
    this.nerves.forget();
    for (const unit of this.units) this.drive.setOverride(unit, null, 'script');
    // The twitch: a group, a moment, a burst -- from the seed, so a candidate's seeds are the
    // same nudges for every candidate that gets them.
    const random = seeded(seed);
    const twitchOutput = Math.floor(random() * this.nerves.outputs.length);
    const twitchAt = 0.5 + random() * Math.max(0.1, this.options.seconds - 1.5);
    const twitchUnits = this.nerves.outputs[twitchOutput]?.units.map((u) => u.id) ?? [];
    const twitchLevel = 0.25;

    const ticks = Math.round(this.options.seconds / this.dt);
    const every = this.options.controlDivisor;
    let fitness = 0;
    let alive = 0;
    for (let tick = 0; tick < ticks; tick++) {
      const time = tick * this.dt;
      // Feedforward: the clip, into the script layer, with the twitch on top of it.
      const at = this.clip.levels(time);
      for (let i = 0; i < this.clipUnits.length; i++) {
        this.drive.setOverride(this.clipUnits[i] as string, at[i] as number, 'script');
      }
      const twitching = time >= twitchAt && time < twitchAt + 0.15;
      if (twitching) {
        for (const unit of twitchUnits) this.drive.setOverride(unit, twitchLevel, 'script');
      }
      this.kernel.step();
      if (tick % every === 0) {
        const head = this.position[3 * this.head + 1] as number;
        if (head < 1.15) break;
        alive = time;
        const p = this.pelvis;
        // Level: the pelvis's up axis against the world's, from its quaternion.
        const qx = this.orientation[4 * p] as number;
        const qz = this.orientation[4 * p + 2] as number;
        const upY = 1 - 2 * (qx * qx + qz * qz);
        const vx = this.linear[3 * p] as number;
        const vy = this.linear[3 * p + 1] as number;
        const vz = this.linear[3 * p + 2] as number;
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        let effort = 0;
        for (let u = 0; u < this.activation.length; u++) effort += this.activation[u] as number;
        effort /= this.activation.length;
        const stepSeconds = every * this.dt;
        fitness +=
          stepSeconds * (1 + 0.5 * Math.max(0, upY) - 0.5 * Math.min(1, speed) - 0.5 * effort);
      }
    }
    return { fitness, aliveSeconds: alive };
  }

  dispose(): void {
    this.kernel.dispose();
  }
}

function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s + 0.5) / 4294967296;
  };
}
