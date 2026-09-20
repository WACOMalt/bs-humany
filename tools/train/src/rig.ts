/**
 * The training rig: one body, standing, with a policy in its nerves, that can run an episode
 * from the same start over and over with different weights.
 *
 * Built the way the golden runner builds a scenario -- physics, coupling, passive joints, the
 * full muscle set, the drive -- with a `NervesModule` on top. The body, its placement and the
 * scenery come from a scenario and a morphology when the recipe names them (the studio's own
 * Scene and Body tabs, so what is trained is what is shown), and from the reference body on the
 * ground when it does not. Under the brain there may be a feedforward: an activation clip such
 * as quiet standing played into the drive's script layer, the scenario's own muscle script, or
 * nothing at all, so the brain stands the body by itself. The kernel is snapshotted once after
 * init and restored at the start of every episode, so an episode costs its ticks and nothing
 * else.
 *
 * The reward is standing, on the feet: a point for every hundredth of a second the head is near
 * its resting height with a foot on the ground, a little for the pelvis staying level and where
 * it was, a little off for moving and for effort, and more off for moving up or down. The
 * episode ends when the head leaves its band -- a fall, a crouch, or a jump -- or when the feet
 * have been off the ground for more than a moment, and nothing is scored while they are, so
 * leaving the ground can never be the way to stay up. A seed changes the episode only through
 * a twitch: a random group given a burst of excitation at a random moment, so a policy that
 * stands is one that stands through a nudge.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { type CompiledArticulation, compileArticulation } from '@bs-humany/compiler';
import type { Morphology } from '@bs-humany/hsdl';
import { Kernel, type KernelSnapshot } from '@bs-humany/kernel';
import {
  BODY_BONE_TRANSFORMS,
  BODY_POSE,
  BODY_VELOCITY,
  CONTACT_MANIFOLDS,
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
  MuscleVolumeModule,
  RENDER_MUSCLE_MESH,
  type RingBuffers,
  compileMuscleSet,
  extractMuscleRings,
  ringBuffers,
} from '@bs-humany/modules-muscle';
import { MlpPolicy, NervesModule, feetOf } from '@bs-humany/modules-nerves';
import {
  ANKLE_MUSCLES,
  ELBOW_MUSCLES,
  FOREARM_MUSCLES,
  GIRDLE_MUSCLES,
  HIP_MUSCLES,
  KNEE_MUSCLES,
  NECK_MUSCLES,
  SHOULDER_MUSCLES,
  THORAX_MUSCLES,
  TORSO_MUSCLES,
  TRUNK_MUSCLES,
} from '@bs-humany/muscle-data';
import {
  type CompiledClip,
  GOAL_SIZE,
  SCENARIO_DEFINITIONS,
  type Scenario,
  type ScenarioApi,
  type ScenarioDefinition,
  driveOutputs,
  groundRotation,
  loadActivationClips,
  placeArticulation,
  unitsNamedByClips,
} from '@bs-humany/scenarios';
import { buildDocument } from '@bs-humany/skeleton';

/**
 * What drives the muscles under the brain: a clip by id, the scenario's own script, or nothing.
 * The scenario's script always runs for what it does to the world -- a floor that tilts, a hand
 * that grabs -- and only its muscle drive is gated by this.
 */
export type Feedforward =
  | { readonly kind: 'clip'; readonly clip: string }
  | { readonly kind: 'script' }
  | { readonly kind: 'none' };

/**
 * What a checkpoint was trained in, saved with it so the studio can set itself up the same way
 * before handing over: the scenario and its parameter values, the body, and what played under
 * the brain.
 */
export interface TrainingRecipe {
  /** The checkpoint's name: the file it is saved as, and the run files' prefix. */
  readonly name: string;
  /**
   * The timescale it was trained at: ticks a second, and ticks between policy evaluations.
   *
   * Written by the trainer rather than asked for, because both follow from the profile. A run
   * that plays the checkpoint at another step rate is not the physics it learned -- contacts
   * and the muscles' own dynamics both change with the timestep -- and a run that evaluates it
   * at another rate is not the controller it learned either. The studio sets itself to these
   * when a checkpoint is chosen.
   */
  readonly stepsPerSecond?: number;
  readonly controlDivisor?: number;
  readonly task: string;
  /** A scenario id from `SCENARIO_DEFINITIONS`; empty for the reference stand on the ground. */
  readonly scenario: string;
  readonly parameters: Readonly<Record<string, number>>;
  readonly profile: string;
  readonly morphology: Morphology;
  readonly passive: boolean;
  readonly redistribute: boolean;
  readonly feedforward: Feedforward;
  readonly authority: number;
}

export interface RigOptions {
  readonly profileId: string;
  /** Hidden layer widths; the input and output are the body's. */
  readonly hidden: readonly number[];
  readonly seconds: number;
  /** Ticks between policy evaluations; a hundred hertz at the profile's rate when not given. */
  readonly controlDivisor?: number;
  readonly authority: number;
  /** What is scored: `stand` (still, cheap, up) or `balance` (the head still and level). */
  readonly task?: string;
  /** What plays under the brain. */
  readonly feedforward: Feedforward;
  /** The scenario the body starts in: placement, ground, scenery; the reference stand when absent. */
  readonly scenario?: {
    readonly id: string;
    readonly parameters?: Readonly<Record<string, number>>;
  };
  /** The body; the reference one when absent. */
  readonly morphology?: Morphology;
  /** Passive joint resistance; on when absent. */
  readonly passiveJoints?: boolean;
  /** Also pose the skeleton's bones each tick, for a rig that publishes what it does. */
  readonly poseBones?: boolean;
}

/** The rig options a recipe asks for. */
export function rigOptionsFor(
  recipe: TrainingRecipe,
  rest: { hidden: readonly number[]; seconds: number; poseBones?: boolean },
): RigOptions {
  return {
    profileId: recipe.profile,
    hidden: rest.hidden,
    seconds: rest.seconds,
    authority: recipe.authority,
    task: recipe.task,
    feedforward: recipe.feedforward,
    ...(recipe.scenario
      ? { scenario: { id: recipe.scenario, parameters: recipe.parameters } }
      : {}),
    morphology: recipe.morphology,
    passiveJoints: recipe.passive,
    ...(rest.poseBones ? { poseBones: true } : {}),
  };
}

/** The recipe the old flags describe: the reference body, standing, with the clip under it. */
export function defaultRecipe(task: string, profile: string, authority: number): TrainingRecipe {
  return {
    name: task,
    task,
    scenario: '',
    parameters: {},
    profile,
    morphology: { sex: 0.5, stature: 1.7, mass: 70 },
    passive: true,
    redistribute: true,
    feedforward: { kind: 'clip', clip: task === 'walk' ? 'walk-normal' : 'quiet-standing' },
    authority,
  };
}

/** How far below and above its resting height the head may be and still count as standing. */
const HEAD_BELOW = 0.1;
const HEAD_ABOVE = 0.05;
/** How long the feet may all be off the ground before the episode ends, in seconds. */
const AIRBORNE_GRACE = 0.05;

export interface EpisodeResult {
  readonly fitness: number;
  readonly aliveSeconds: number;
}

export class StandRig {
  sizes: readonly number[] = [];
  inputNames: readonly string[] = [];
  outputNames: readonly string[] = [];
  private readonly kernel: Kernel;
  private readonly physics: PhysicsModule;
  private angular: Float64Array;
  private readonly nerves: NervesModule;
  private readonly drive: MuscleTestDriveModule;
  /** The clip under the brain, when the feedforward is one. */
  private readonly clip: CompiledClip | undefined;
  private readonly clipUnits: readonly string[];
  /** The scenario the body is in, whose script runs every tick. */
  private scenario: Scenario | undefined;
  private readonly scriptApi: ScenarioApi;
  /** The scenario's definition, to rebuild it with an episode's seed when it takes one. */
  private readonly definition: ScenarioDefinition | undefined;
  /** What the task scores: standing still and cheaply, or keeping the head still and level. */
  private readonly task: string;
  private readonly units: readonly string[];
  private readonly snapshot: KernelSnapshot;
  private readonly dt: number;
  private readonly options: RigOptions;
  private readonly head: number;
  private readonly pelvis: number;
  /** The bone order and transforms, when `poseBones` was asked for. */
  readonly boneOrder: readonly string[];
  /** The compiled body, for whatever wants to describe it -- the tissue table, say. */
  readonly articulation: CompiledArticulation;
  readonly restContext: unknown;
  private readonly volume: MuscleVolumeModule | undefined;
  private readonly maxForce: Float64Array;
  private tension: Float64Array | undefined;
  private rings: RingBuffers | undefined;
  private readonly parents: readonly number[];
  private readonly segmentIds: readonly string[];
  private live = 0;
  private startX = 0;
  private startZ = 0;
  /** Seconds in a row with no foot on the ground. */
  private airborne = 0;
  /** The head's height at rest, the middle of the band it must stay in. */
  private readonly restHead: number;
  private readonly leftFeet: Int32Array;
  private readonly rightFeet: Int32Array;
  private readonly contacts: { count: number; pair: Int32Array; impulse: Float64Array };
  private position: Float64Array;
  private orientation: Float64Array;
  private linear: Float64Array;
  private activation: Float64Array;

  private constructor(
    options: RigOptions,
    kernel: Kernel,
    physics: PhysicsModule,
    articulation: CompiledArticulation,
    nerves: NervesModule,
    drive: MuscleTestDriveModule,
    clip: CompiledClip | undefined,
    scenario: Scenario | undefined,
    definition: ScenarioDefinition | undefined,
    units: readonly string[],
    head: number,
    pelvis: number,
    rate: number,
    boneOrder: readonly string[],
    restContext: unknown,
    parents: readonly number[],
    segmentIds: readonly string[],
    volume: MuscleVolumeModule | undefined,
    maxForce: Float64Array,
    feet: { left: Int32Array; right: Int32Array },
  ) {
    this.leftFeet = feet.left;
    this.rightFeet = feet.right;
    this.volume = volume;
    this.maxForce = maxForce;
    this.boneOrder = boneOrder;
    this.restContext = restContext;
    this.parents = parents;
    this.segmentIds = segmentIds;
    this.options = options;
    this.kernel = kernel;
    this.physics = physics;
    this.articulation = articulation;
    this.angular = kernel.channels.storage(BODY_VELOCITY).fields.angular as Float64Array;
    this.nerves = nerves;
    this.drive = drive;
    this.clip = clip;
    this.clipUnits = clip?.units ?? [];
    this.scenario = scenario;
    this.definition = definition;
    this.task = options.task ?? 'stand';
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
    const contacts = kernel.channels.storage(CONTACT_MANIFOLDS);
    this.contacts = {
      get count() {
        return contacts.count;
      },
      pair: contacts.fields.pair as Int32Array,
      impulse: contacts.fields.impulse as Float64Array,
    };
    this.restHead = this.position[3 * this.head + 1] as number;
    this.snapshot = kernel.snapshot();
    // What a scenario's script may do here: drive muscles. A grab has no hand in a training rig.
    const index = new Map(segmentIds.map((id, i) => [id, i]));
    this.scriptApi = {
      segment: (id) => index.get(id) ?? -1,
      segmentPosition: (i) => ({
        x: this.position[3 * i] as number,
        y: this.position[3 * i + 1] as number,
        z: this.position[3 * i + 2] as number,
      }),
      grab: () => {},
      moveGrab: () => {},
      release: () => {},
      // The script's muscle drive reaches the body only when it is the feedforward asked for.
      drive: (unit, level) => {
        if (options.feedforward.kind === 'script') this.drive.setOverride(unit, level, 'script');
      },
      tiltWorld: (pitch, roll) =>
        this.physics.setGroundOrientation(groundRotation({ pitch, roll })),
    };
  }

  static async build(options: RigOptions): Promise<StandRig> {
    const document = buildDocument();
    const profile = document.segmentation.find((p) => p.id === options.profileId);
    if (!profile) throw new Error(`No profile '${options.profileId}'.`);
    // The scenario, when the recipe names one: where the body starts and what it stands on.
    let scenario: Scenario | undefined;
    let definition: ScenarioDefinition | undefined;
    if (options.scenario) {
      definition = SCENARIO_DEFINITIONS.find((d) => d.id === options.scenario?.id);
      if (!definition) throw new Error(`No scenario '${options.scenario.id}'.`);
      scenario = definition.build(options.scenario.parameters);
    }
    const morphology = resolveMorphology(
      options.morphology ?? scenario?.morphology ?? { sex: 0.5, stature: 1.7, mass: 70 },
    );
    const compiled = compileArticulation(document, options.profileId, morphology).articulation;
    const groundHeight = scenario?.ground.height ?? 0;
    const articulation = placeArticulation(
      compiled,
      scenario?.rootRotation,
      scenario?.clearance ?? 0,
      groundHeight,
    );
    const rate = profile.solver?.rate ?? 500;
    const kernel = new Kernel({ rateHz: rate, seed: 1, preferShared: false });
    const backend = new MujocoBackend();
    const physics = new PhysicsModule(backend, articulation, {
      ground: { height: groundHeight },
      iterations: profile.solver?.iterations,
      staticBoxes: scenario?.staticBoxes ?? [],
    });
    kernel.register(physics);
    kernel.register(new CouplingModule(articulation, backend.capabilities));
    if (options.passiveJoints ?? true) kernel.register(new PassiveJointModule(articulation));
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
        ...NECK_MUSCLES,
        ...GIRDLE_MUSCLES,
        ...THORAX_MUSCLES,
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
    let volume: MuscleVolumeModule | undefined;
    if (options.poseBones) {
      // The bellies too, for a rig that publishes; a training rig pays no sweep.
      volume = new MuscleVolumeModule(articulation, muscles, { simulationRateHz: rate });
      kernel.register(volume);
    }

    const outputs = driveOutputs();
    const goal = new Float64Array(GOAL_SIZE);
    goal[0] = 1;
    const nerves = new NervesModule(articulation, muscles, {
      policy: (inputs, outs) => new MlpPolicy([inputs, ...options.hidden, outs]),
      outputs,
      goalSize: GOAL_SIZE,
      goal: () => goal,
      controlDivisor: options.controlDivisor ?? Math.max(1, Math.round(rate / 100)),
      authority: options.authority,
    });
    kernel.register(nerves);
    await kernel.init();

    let clip: CompiledClip | undefined;
    if (options.feedforward.kind === 'clip') {
      clip = loadActivationClips(unitsNamedByClips()).get(options.feedforward.clip);
      if (!clip) throw new Error(`No activation clip '${options.feedforward.clip}'.`);
    }
    const index = new Map(articulation.segments.map((s) => [s.id, s.index]));
    const soles = feetOf(articulation);
    const feet = {
      left: Int32Array.from(soles.left, (id) => index.get(id) ?? -1).filter((i) => i >= 0),
      right: Int32Array.from(soles.right, (id) => index.get(id) ?? -1).filter((i) => i >= 0),
    };
    return new StandRig(
      options,
      kernel,
      physics,
      articulation,
      nerves,
      drive,
      clip,
      scenario,
      definition,
      muscles.units.map((u) => u.id),
      index.get('head') ?? 0,
      index.get('pelvis') ?? 0,
      rate,
      boneOrder,
      morphology.context,
      articulation.segments.map((seg) => seg.parent),
      articulation.segments.map((seg) => seg.id),
      volume,
      Float64Array.from(muscles.units, (u) => u.parameters.maxIsometricForce),
      feet,
    );
  }

  /**
   * Whether the body is standing as of now: the head within its band of the resting height,
   * and a foot on the ground -- or the feet only just off it.
   */
  private standing(sinceLast: number): {
    headHeight: number;
    inBand: boolean;
    grounded: boolean;
    up: boolean;
  } {
    const headHeight = this.position[3 * this.head + 1] as number;
    const inBand =
      headHeight >= this.restHead - HEAD_BELOW && headHeight <= this.restHead + HEAD_ABOVE;
    const c = this.contacts;
    const n = Math.min(c.count, c.impulse.length, c.pair.length >> 1);
    let grounded = false;
    for (let i = 0; i < n && !grounded; i++) {
      const a = c.pair[2 * i] as number;
      const b = c.pair[2 * i + 1] as number;
      // A foot against something that is not a segment: the ground.
      const foot =
        (b === -1 && (this.leftFeet.includes(a) || this.rightFeet.includes(a))) ||
        (a === -1 && (this.leftFeet.includes(b) || this.rightFeet.includes(b)));
      grounded = foot && (c.impulse[i] as number) > 0;
    }
    this.airborne = grounded ? 0 : this.airborne + sinceLast;
    return { headHeight, inBand, grounded, up: inBand && this.airborne <= AIRBORNE_GRACE };
  }

  /** The fidelity profile this body was built from. */
  get profileId(): string {
    return this.options.profileId;
  }

  /** Seconds a tick: the profile's solver rate. */
  get stepSeconds(): number {
    return this.dt;
  }

  /** Ticks a second: what a run has to match to be the same physics. */
  get stepsPerSecond(): number {
    return Math.round(1 / this.dt);
  }

  /** Ticks between policy evaluations: what a run has to match to be the same controller. */
  get controlDivisor(): number {
    return this.nerves.divisor;
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

  /** The bellies' rings as of now, or undefined without `poseBones`. */
  muscleRings():
    | { units: number; rings: number; segments: number; buffers: RingBuffers }
    | undefined {
    const volume = this.volume;
    if (!volume) return undefined;
    const units = volume.muscles.units.length;
    if (!this.rings) this.rings = ringBuffers(units, volume.rings);
    const fields = this.kernel.channels.storage(RENDER_MUSCLE_MESH).fields;
    extractMuscleRings(
      { position: fields.position as Float64Array, verticesPerUnit: volume.verticesPerUnit, units },
      volume.rings,
      volume.segments,
      this.rings,
    );
    return { units, rings: volume.rings, segments: volume.segments, buffers: this.rings };
  }

  /** Each unit's tendon force as a fraction of its maximum, for the slack-to-taut tint. */
  muscleTension(): Float64Array {
    const force = this.kernel.channels.storage(MUSCLE_STATE).fields.tendonForce as Float64Array;
    if (!this.tension) this.tension = new Float64Array(this.maxForce.length);
    for (let i = 0; i < this.maxForce.length; i++) {
      const maximum = this.maxForce[i] as number;
      this.tension[i] = maximum > 0 ? (force[i] as number) / maximum : 0;
    }
    return this.tension;
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
    this.airborne = 0;
  }

  /** What plays under the brain at this moment: the clip, the scenario's script, or nothing. */
  private feed(time: number): void {
    if (this.clip) {
      const at = this.clip.levels(time);
      for (let i = 0; i < this.clipUnits.length; i++) {
        this.drive.setOverride(this.clipUnits[i] as string, at[i] as number, 'script');
      }
    }
    this.scenario?.script?.(time, this.scriptApi);
  }

  tick(): { time: number; up: boolean; headHeight: number } {
    const time = this.live * this.dt;
    this.feed(time);
    this.kernel.step();
    this.live += 1;
    const { headHeight, up } = this.standing(this.dt);
    return { time, up, headHeight };
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
    // A scenario with a seed of its own -- the tilting floor -- draws afresh each episode, so a
    // policy is scored on floors it has not seen rather than on the one it has learned.
    if (this.definition?.parameters.some((p) => p.id === 'seed')) {
      this.scenario = this.definition.build({
        ...(this.options.scenario?.parameters ?? {}),
        seed: 1 + (Math.abs(seed) % 9999),
      });
    }
    const twitchOutput = Math.floor(random() * this.nerves.outputs.length);
    const twitchAt = 0.5 + random() * Math.max(0.1, this.options.seconds - 1.5);
    const twitchUnits = this.nerves.outputs[twitchOutput]?.units.map((u) => u.id) ?? [];
    const twitchLevel = 0.25;

    const ticks = Math.round(this.options.seconds / this.dt);
    this.startX = this.position[3 * this.pelvis] as number;
    this.startZ = this.position[3 * this.pelvis + 2] as number;
    this.airborne = 0;
    const every = this.nerves.divisor;
    const stepSeconds = every * this.dt;
    let fitness = 0;
    let alive = 0;
    for (let tick = 0; tick < ticks; tick++) {
      const time = tick * this.dt;
      // Feedforward, if any, into the script layer, with the twitch on top of it.
      this.feed(time);
      const twitching = time >= twitchAt && time < twitchAt + 0.15;
      if (twitching) {
        for (const unit of twitchUnits) this.drive.setOverride(unit, twitchLevel, 'script');
      }
      this.kernel.step();
      if (tick % every === 0) {
        const { inBand, grounded, up } = this.standing(stepSeconds);
        if (!up) break;
        // Off the ground, within the grace: still up, but there is nothing to score.
        if (!grounded || !inBand) continue;
        alive = time;
        const p = this.pelvis;
        // Level: the pelvis's up axis against the world's, from its quaternion.
        const qx = this.orientation[4 * p] as number;
        const qz = this.orientation[4 * p + 2] as number;
        const upY = 1 - 2 * (qx * qx + qz * qz);
        const vx = this.linear[3 * p] as number;
        const vy = this.linear[3 * p + 1] as number;
        const vz = this.linear[3 * p + 2] as number;
        // Along the floor, capped: a sway. Up or down, uncapped: a jump or a drop, which is
        // never standing however long the head stays in its band.
        const speed = Math.sqrt(vx * vx + vz * vz);
        const vertical = Math.abs(vy);
        let effort = 0;
        for (let u = 0; u < this.activation.length; u++) effort += this.activation[u] as number;
        effort /= this.activation.length;
        // Where the pelvis has gone from where it started, along the floor: standing still is
        // standing here, and drifting off is the start of a fall the head has not shown yet.
        const px = this.position[3 * p] as number;
        const pz = this.position[3 * p + 2] as number;
        const drift = Math.sqrt((px - this.startX) ** 2 + (pz - this.startZ) ** 2);
        if (this.task === 'balance') {
          // The head: how fast it moves and turns, and how level it is. A point a step for
          // being up, most of it lost to a head that is thrown about, a little to effort, so a
          // body that rides the floor out with its head still scores and one that holds a
          // posture and topples does not.
          const h = this.head;
          const hv = Math.sqrt(
            (this.linear[3 * h] as number) ** 2 +
              (this.linear[3 * h + 1] as number) ** 2 +
              (this.linear[3 * h + 2] as number) ** 2,
          );
          const hw = Math.sqrt(
            (this.angular[3 * h] as number) ** 2 +
              (this.angular[3 * h + 1] as number) ** 2 +
              (this.angular[3 * h + 2] as number) ** 2,
          );
          const hx = this.orientation[4 * h] as number;
          const hz = this.orientation[4 * h + 2] as number;
          const headUp = 1 - 2 * (hx * hx + hz * hz);
          fitness +=
            stepSeconds *
            (1 +
              0.5 * Math.max(0, headUp) -
              Math.min(1, hv / 0.5) -
              Math.min(1, hw / 2) -
              0.25 * effort);
        } else {
          fitness +=
            stepSeconds *
            (1 +
              0.5 * Math.max(0, upY) +
              0.5 * (1 - Math.min(1, drift / 0.25)) -
              0.5 * Math.min(1, speed) -
              vertical -
              0.5 * effort);
        }
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
