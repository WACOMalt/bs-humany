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
 * The reward is standing, on the feet: a point a second, counted each control step, while the
 * head is near its resting height with a foot on the ground; a little for the whole body's
 * centre of mass sitting over the midpoint of the two feet, a little for the pelvis staying
 * level and where it was, a little off for moving and for effort, and more off for moving up or
 * down (`standReward`; the balance task scores the head instead, in `balanceReward`). The
 * episode ends when the head leaves its band -- a fall, a crouch, or a jump -- or when the feet
 * have been off the ground for more than a moment, and nothing is scored while they are, so
 * leaving the ground can never be the way to stay up.
 *
 * A seed is the episode's whole disturbance, and there is a lot of it, because a silent body
 * trains a policy with nothing to answer -- one that picks a posture, holds it, and is never
 * shown a reason to do otherwise. The seed draws the floor where the scenario has one to draw,
 * a twitch (a random group given a burst at a random moment), a tremor that wanders over every
 * muscle group all episode long, and the grain on the senses the policy reads. A policy that
 * stands is then one that stands through all of it, and two candidates that differ a little in
 * their weights differ visibly in where they end up, which is what lets the search rank them.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import {
  type CompiledArticulation,
  type StaticBox,
  compileArticulation,
} from '@bs-humany/compiler';
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
  EFFERENT_ALPHA_MOTOR,
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
import {
  type BodyFingerprint,
  MlpPolicy,
  MotorNoiseModule,
  NervesModule,
  SpinalModule,
  feetOf,
} from '@bs-humany/modules-nerves';
import { ALL_MUSCLES } from '@bs-humany/muscle-data';
import {
  type CompiledClip,
  GOAL_SIZE,
  SCENARIO_DEFINITIONS,
  type Scenario,
  type ScenarioApi,
  type ScenarioDefinition,
  driveOutputs,
  loadActivationClips,
  placeArticulation,
  reflexGroups,
  unitsNamedByClips,
} from '@bs-humany/scenarios';
import { buildDocument } from '@bs-humany/skeleton';
import { DEFAULT_NOISE, NO_REFLEX, type RigOptions, TASKS, type Task, isTask } from './recipe.js';

// The recipe -- its types, its defaults, its limits and the rig options it turns into -- lives
// in a module of its own that loads nothing that runs, so the dashboard and the studio's main
// thread can read it without MuJoCo. Re-exported whole, so everything that has always imported
// it from here still does.
export * from './recipe.js';

/** How far below and above its resting height the head may be and still count as standing. */
const HEAD_BELOW = 0.1;
const HEAD_ABOVE = 0.05;
/** How long the feet may all be off the ground before the episode ends, in seconds. */
const AIRBORNE_GRACE = 0.05;
/**
 * How long the head may be outside its band before the episode ends.
 *
 * It used to end on the first step out, which made a stumble and a fall the same event and
 * ended most episodes at about the same moment -- so a generation's scores differed by almost
 * nothing and the rank transform ranked noise. A body that dips and comes back is the behaviour
 * worth rewarding, and it cannot be rewarded if the episode is already over. Nothing is scored
 * while the head is out, so this buys a recovery the chance to happen without paying for the
 * time spent recovering, and a body that stays out is still ended.
 */
const RECOVERY_GRACE = 0.25;
/** The twitch: how hard one group is pushed, and for how long. */
const TWITCH_LEVEL = 0.25;
const TWITCH_SECONDS = 0.15;

export interface EpisodeResult {
  readonly fitness: number;
  readonly aliveSeconds: number;
}

/**
 * This episode's twitch, from its seed: which output is pushed, and when, in seconds.
 *
 * Two draws from the seed's own stream, the output first and then the moment, which is the
 * order `arm` has always drawn them in -- the same seed must give the same twitch as it did, or
 * every recorded score stops being reproducible. The moment lands between half a second in and
 * a second and a half before the end, so there is time to answer it; in an episode too short
 * for that, it lands in the tenth of a second after the first half second.
 */
export function twitchSchedule(
  seed: number,
  outputs: number,
  seconds: number,
): { output: number; at: number } {
  const random = seeded(seed);
  const output = Math.floor(random() * outputs);
  const at = 0.5 + random() * Math.max(0.1, seconds - 1.5);
  return { output, at };
}

/**
 * Everything `build` makes that the rig keeps, by name. One object rather than a long list of
 * positional arguments, so that two of the same type -- the head and the pelvis, say -- cannot
 * be passed in each other's places.
 */
interface StandRigParts {
  readonly options: RigOptions;
  readonly task: Task;
  readonly kernel: Kernel;
  readonly physics: PhysicsModule;
  readonly articulation: CompiledArticulation;
  readonly spine: SpinalModule;
  readonly nerves: NervesModule;
  readonly tremor: MotorNoiseModule;
  readonly drive: MuscleTestDriveModule;
  readonly clip: CompiledClip | undefined;
  readonly scenario: Scenario | undefined;
  readonly definition: ScenarioDefinition | undefined;
  readonly scenery: StaticBox[];
  readonly groundHeight: number;
  readonly units: readonly string[];
  readonly head: number;
  readonly pelvis: number;
  readonly rate: number;
  readonly boneOrder: readonly string[];
  readonly restContext: unknown;
  readonly parents: readonly number[];
  readonly segmentIds: readonly string[];
  readonly volume: MuscleVolumeModule | undefined;
  readonly maxForce: Float64Array;
  readonly feet: { readonly left: Int32Array; readonly right: Int32Array };
}

export class StandRig {
  sizes: readonly number[] = [];
  inputNames: readonly string[] = [];
  outputNames: readonly string[] = [];
  private readonly kernel: Kernel;
  private readonly physics: PhysicsModule;
  private angular: Float64Array;
  private readonly nerves: NervesModule;
  /** The tremor on the muscles, reseeded every episode. */
  private readonly tremor: MotorNoiseModule;
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
  private readonly task: Task;
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
  /** This episode's twitch: which output, and when. Armed by `arm`, from the seed. */
  private twitchOutput = 0;
  private twitchAt = Number.POSITIVE_INFINITY;
  private startX = 0;
  private startZ = 0;
  /** Seconds in a row with no foot on the ground. */
  private airborne = 0;
  /** How long the head has been outside its band, for the recovery grace. */
  private outOfBand = 0;
  /** The head's height at rest, the middle of the band it must stay in. */
  private readonly restHead: number;
  private readonly leftFeet: Int32Array;
  private readonly rightFeet: Int32Array;
  /** The support base as `addFoot` sums it: the feet's origins along the floor, and how many. */
  private baseX = 0;
  private baseZ = 0;
  private baseCount = 0;
  private readonly contacts: { count: number; pair: Int32Array; impulse: Float64Array };
  /** The body's mass distribution, for the centre of mass the support reward is measured from. */
  private readonly segmentMass: Float64Array;
  private readonly segmentCom: Float64Array;
  private readonly totalMass: number;
  private position: Float64Array;
  private orientation: Float64Array;
  private linear: Float64Array;
  private activation: Float64Array;

  private constructor(parts: StandRigParts) {
    const { options, kernel, nerves, segmentIds } = parts;
    this.tremor = parts.tremor;
    this.leftFeet = parts.feet.left;
    this.rightFeet = parts.feet.right;
    this.volume = parts.volume;
    this.maxForce = parts.maxForce;
    this.boneOrder = parts.boneOrder;
    this.restContext = parts.restContext;
    this.parents = parts.parents;
    this.segmentIds = segmentIds;
    this.options = options;
    this.kernel = kernel;
    this.physics = parts.physics;
    this.articulation = parts.articulation;
    this.angular = kernel.channels.storage(BODY_VELOCITY).fields.angular as Float64Array;
    this.spine = parts.spine;
    this.nerves = nerves;
    this.drive = parts.drive;
    this.clip = parts.clip;
    this.clipUnits = parts.clip?.units ?? [];
    this.scenario = parts.scenario;
    this.definition = parts.definition;
    this.scenery = parts.scenery;
    this.groundHeight = parts.groundHeight;
    this.task = parts.task;
    this.units = parts.units;
    this.head = parts.head;
    this.pelvis = parts.pelvis;
    this.dt = 1 / parts.rate;
    this.sizes = nerves.policy.sizes;
    // The policy's own names, not the body's: with memory these carry the context units too,
    // and a checkpoint saved without them would not fit back onto the body that made it.
    const names = nerves.policyNames;
    this.inputNames = names.inputs;
    this.outputNames = names.outputs;
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
    // Segment masses and their local centres, for the whole body's centre of mass: the quantity
    // balance is actually about, and the one the reward needs if it is to tell a body leaning
    // from a body already gone.
    const articulation = parts.articulation;
    this.segmentMass = Float64Array.from(articulation.segments, (seg) => seg.mass);
    this.segmentCom = new Float64Array(3 * articulation.segments.length);
    for (const seg of articulation.segments) {
      this.segmentCom[3 * seg.index] = seg.com.x;
      this.segmentCom[3 * seg.index + 1] = seg.com.y;
      this.segmentCom[3 * seg.index + 2] = seg.com.z;
    }
    this.totalMass = this.segmentMass.reduce((a, b) => a + b, 0) || 1;
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
      moveStaticBox: (id, position, rotation) => {
        // The list is what a showcase publishes, so it is kept in step with the solver rather
        // than left where the scenery started. A tilting platform moves every tick, and a
        // viewer drawing it where it began while the body stands on where it is now makes a
        // real force look like a trick of the rendering.
        const at = this.scenery.findIndex((b) => b.id === id);
        const box = this.scenery[at];
        if (box) {
          this.scenery[at] = { ...box, position: { ...position }, rotation: { ...rotation } };
        }
        this.physics.setStaticBoxTransform(id, position, rotation);
      },
    };
  }

  static async build(options: RigOptions): Promise<StandRig> {
    // Refused before anything is built. The rig used to score anything that was not 'balance'
    // as a stand, so a typo in a task trained a stand under another name.
    const task = options.task ?? 'stand';
    if (!isTask(task)) {
      throw new Error(`unknown task "${task}"; known tasks: ${TASKS.join(', ')}`);
    }
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
    const soles = feetOf(articulation);
    // A body with no foot found cannot be scored: `standing` would read it as airborne from the
    // first control step, and every episode would end at the grace with nothing learned. That
    // is what L2 did before the feet were found by their bone; it is refused now, and before
    // the kernel is built, rather than trained.
    for (const [side, list] of [
      ['left', soles.left],
      ['right', soles.right],
    ] as const) {
      if (list.length === 0) {
        throw new Error(
          `profile ${options.profileId} has no ${side} foot: the stand/balance tasks cannot be scored`,
        );
      }
    }
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
      [...ALL_MUSCLES],
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
    const noise = options.noise ?? DEFAULT_NOISE;
    const reflex = options.reflex ?? NO_REFLEX;
    const divisor = options.controlDivisor ?? Math.max(1, Math.round(rate / 100));
    // The cord first: it is the layer the brain corrects, so it goes into the accumulator
    // before the brain does. Its gains at zero leave the excitation exactly as it was.
    const spine = new SpinalModule(muscles, {
      groups: reflexGroups(),
      gains: reflex,
      stepSeconds: 1 / rate,
    });
    kernel.register(spine);
    const nerves = new NervesModule(articulation, muscles, {
      policy: (inputs, outs) => new MlpPolicy([inputs, ...options.hidden, outs]),
      outputs,
      goalSize: GOAL_SIZE,
      goal: () => goal,
      controlDivisor: divisor,
      authority: options.authority,
      senseNoise: noise.sense,
      memory: options.memory ?? 0,
    });
    kernel.register(nerves);
    // After the nerves, so the tremor lands on top of the policy's correction and the clamp to
    // [0, 1] is the last thing done to a unit's excitation.
    const tremor = new MotorNoiseModule(muscles, {
      outputs,
      level: noise.motor,
      tau: noise.tau,
      divisor,
    });
    kernel.register(tremor);
    await kernel.init();

    let clip: CompiledClip | undefined;
    if (options.feedforward.kind === 'clip') {
      clip = loadActivationClips(unitsNamedByClips()).get(options.feedforward.clip);
      if (!clip) throw new Error(`No activation clip '${options.feedforward.clip}'.`);
    }
    const index = new Map(articulation.segments.map((s) => [s.id, s.index]));
    const feet = {
      left: Int32Array.from(soles.left, (id) => index.get(id) ?? -1).filter((i) => i >= 0),
      right: Int32Array.from(soles.right, (id) => index.get(id) ?? -1).filter((i) => i >= 0),
    };
    return new StandRig({
      options,
      task,
      kernel,
      physics,
      articulation,
      spine,
      nerves,
      tremor,
      drive,
      clip,
      scenario,
      definition,
      scenery: [...(scenario?.staticBoxes ?? [])],
      groundHeight,
      units: muscles.units.map((u) => u.id),
      head: index.get('head') ?? 0,
      pelvis: index.get('pelvis') ?? 0,
      rate,
      boneOrder,
      restContext: morphology.context,
      parents: articulation.segments.map((seg) => seg.parent),
      segmentIds: articulation.segments.map((seg) => seg.id),
      volume,
      maxForce: Float64Array.from(muscles.units, (u) => u.parameters.maxIsometricForce),
      feet,
    });
  }

  /**
   * How well the body is over its own feet, from 0 to 1.
   *
   * The centre of mass is what balance is about, and the base of support is where it has to
   * stay: a body whose mass has left the ground under its feet is falling, however level its
   * head still looks and however long the head stays inside its band. The reward needs this
   * because without it every candidate in a generation dies at about the same moment and the
   * rank transform is ranking noise -- there is nothing in the score that says one of them
   * nearly stood and the other went straight over.
   *
   * The support point is the unweighted mean of every foot segment's origin, both feet, loaded
   * or not. Contact does not enter into it, so a body standing on one leg, or with all its
   * weight shifted onto one foot, is scored against the midpoint of the two feet rather than
   * against the foot it is actually on. The margin is scaled by a quarter of a metre, which is
   * about a foot's length: at the edge of the base the term is near zero, and well inside it is
   * near one.
   */
  private overFeet(): number {
    let mx = 0;
    let mz = 0;
    for (let i = 0; i < this.segmentMass.length; i++) {
      const m = this.segmentMass[i] as number;
      if (m <= 0) continue;
      // The segment's own centre, turned into the world by its orientation.
      const qx = this.orientation[4 * i] as number;
      const qy = this.orientation[4 * i + 1] as number;
      const qz = this.orientation[4 * i + 2] as number;
      const qw = this.orientation[4 * i + 3] as number;
      const cx = this.segmentCom[3 * i] as number;
      const cy = this.segmentCom[3 * i + 1] as number;
      const cz = this.segmentCom[3 * i + 2] as number;
      const ix = qw * cx + qy * cz - qz * cy;
      const iy = qw * cy + qz * cx - qx * cz;
      const iz = qw * cz + qx * cy - qy * cx;
      const iw = -qx * cx - qy * cy - qz * cz;
      const wx = ix * qw - iw * qx - iy * qz + iz * qy;
      const wz = iz * qw - iw * qz - ix * qy + iy * qx;
      mx += m * ((this.position[3 * i] as number) + wx);
      mz += m * ((this.position[3 * i + 2] as number) + wz);
    }
    const comX = mx / this.totalMass;
    const comZ = mz / this.totalMass;

    // The base: every segment of both feet, left then right, whether it is on the ground or not.
    this.baseX = 0;
    this.baseZ = 0;
    this.baseCount = 0;
    this.addFoot(this.leftFeet);
    this.addFoot(this.rightFeet);
    if (this.baseCount === 0) return 0;
    const dx = comX - this.baseX / this.baseCount;
    const dz = comZ - this.baseZ / this.baseCount;
    return 1 - Math.min(1, Math.sqrt(dx * dx + dz * dz) / 0.25);
  }

  /**
   * Add one foot's segment origins, along the floor, to the support base `overFeet` is summing.
   * A method writing into fields rather than a closure over locals, so a control step makes no
   * function object.
   */
  private addFoot(list: Int32Array): void {
    for (let k = 0; k < list.length; k++) {
      const i = list[k] as number;
      this.baseX += this.position[3 * i] as number;
      this.baseZ += this.position[3 * i + 2] as number;
      this.baseCount += 1;
    }
  }

  /**
   * Whether the body is standing as of now: the head within its band of the resting height,
   * and a foot on the ground -- or the feet only just off it -- with the head allowed out of
   * its band for the recovery grace. `sinceLast` is the time since the last call, which the
   * airborne and out-of-band clocks advance by.
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
    this.outOfBand = inBand ? 0 : this.outOfBand + sinceLast;
    return {
      headHeight,
      inBand,
      grounded,
      up: this.outOfBand <= RECOVERY_GRACE && this.airborne <= AIRBORNE_GRACE,
    };
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

  /**
   * This body as a checkpoint records it, with the cord under its brain: what the trainer writes
   * into every file this rig's run keeps. Here because the rig is the one thing holding both the
   * nerves and the cord.
   */
  get body(): BodyFingerprint {
    return this.nerves.bodyFingerprint(this.spine.gains);
  }

  /** The cord in this rig, for a probe or a panel that wants to see what the reflexes do. */
  readonly spine: SpinalModule;

  /**
   * The scenario's scenery, where the solver has it now: what a showcase publishes so a viewer
   * following this run draws the floor the body is actually standing on. The array is fixed;
   * its boxes are replaced as the scenario moves them.
   */
  readonly scenery: StaticBox[];
  /** Where the ground plane sits, which a scenario may lower or raise. */
  readonly groundHeight: number;

  /** The excitation on every muscle as it stands, for measuring what the cord contributes. */
  get excitation(): Float64Array {
    return this.kernel.channels.storage(EFFERENT_ALPHA_MOTOR).fields.excitation as Float64Array;
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
   *
   * It is also the one reset: `episode` begins through it too, so the tick-by-tick run a
   * showcase plays and the scored run the trainer makes start from the same state, with the
   * same disturbance armed and the same clocks at zero.
   */
  begin(weights: Float32Array, seed = 0): void {
    this.nerves.policy.weights.set(weights);
    this.kernel.restore(this.snapshot);
    this.nerves.forget();
    for (const unit of this.units) this.drive.setOverride(unit, null, 'script');
    this.arm(seed);
    this.live = 0;
    this.airborne = 0;
    this.outOfBand = 0;
  }

  /**
   * Arm this episode's disturbance from its seed: the floor it runs on, the twitch it gets, the
   * tremor on its muscles and the grain on its senses.
   *
   * One place, called by `begin` and by `episode` alike, because a showcase that plays an
   * episode tick by tick must play the episode the trainer scored. It did not before -- the
   * twitch was set up inside the scoring loop and nowhere else -- so what was on screen was a
   * quieter, easier run than the number beside it.
   *
   * Every stream is a function of the seed and nothing else. The two halves of a mirrored pair
   * share a seed, so they meet the same floor, the same twitch, the same tremor and the same
   * lying senses, and the difference in their scores is the difference in their weights.
   */
  private arm(seed: number): void {
    this.reseedScenario(seed);
    const twitch = twitchSchedule(seed, this.nerves.outputs.length, this.options.seconds);
    this.twitchOutput = twitch.output;
    this.twitchAt = twitch.at;
    // Distinct constants, so the tremor and the senses are never the same stream as each other
    // or as the twitch, and never the same stream twice for two different seeds.
    this.tremor.reseed(0x9e3779b9 ^ (seed >>> 0));
    this.nerves.reseedSenses(0x85ebca6b ^ (seed >>> 0));
  }

  /** The twitch, on or off as the moment says: a burst on one group, added to the muscles. */
  private disturb(time: number): void {
    const on = time >= this.twitchAt && time < this.twitchAt + TWITCH_SECONDS;
    this.tremor.bias[this.twitchOutput] = on ? TWITCH_LEVEL : 0;
  }

  /**
   * Draw this episode's scenario afresh, where the scenario has a seed of its own.
   *
   * The tilting floor does. A policy scored on one floor learns that floor, so every episode
   * gets its own -- and the two halves of a mirrored pair get the same one, because the search
   * is asking which of them stands better through the same disturbance and a pair disturbed
   * differently answers with the difference between the disturbances instead.
   */
  private reseedScenario(seed: number): void {
    if (!this.definition?.parameters.some((p) => p.id === 'seed')) return;
    this.scenario = this.definition.build({
      ...(this.options.scenario?.parameters ?? {}),
      seed: 1 + (Math.abs(seed) % 9999),
    });
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
    this.disturb(time);
    this.kernel.step();
    this.live += 1;
    const { headHeight, up } = this.standing(this.dt);
    return { time, up, headHeight };
  }

  /** Run one episode with these weights, from the start, and score it. */
  episode(weights: Float32Array, seed: number): EpisodeResult {
    this.begin(weights, seed);
    this.startX = this.position[3 * this.pelvis] as number;
    this.startZ = this.position[3 * this.pelvis + 2] as number;
    const ticks = Math.round(this.options.seconds / this.dt);
    const every = this.nerves.divisor;
    const stepSeconds = every * this.dt;
    let fitness = 0;
    let alive = 0;
    for (let tick = 0; tick < ticks; tick++) {
      const time = tick * this.dt;
      // Feedforward, if any, into the script layer; the twitch and the tremor onto the muscles.
      this.feed(time);
      this.disturb(time);
      this.kernel.step();
      if (tick % every === 0) {
        const { inBand, grounded, up } = this.standing(stepSeconds);
        if (!up) break;
        // Off the ground, within the grace: still up, but there is nothing to score.
        if (!grounded || !inBand) continue;
        alive = time;
        // Where the mass sits over the feet. Added to both tasks, because both are standing.
        const support = this.overFeet();
        fitness +=
          this.task === 'balance'
            ? this.balanceReward(stepSeconds, this.effort(), support)
            : this.standReward(stepSeconds, this.effort(), support);
      }
    }
    return { fitness, aliveSeconds: alive };
  }

  /** The mean activation over every muscle unit, 0 to 1: what standing is costing. */
  private effort(): number {
    let effort = 0;
    for (let u = 0; u < this.activation.length; u++) effort += this.activation[u] as number;
    effort /= this.activation.length;
    return effort;
  }

  /**
   * One control step of standing, scored: a point a second for being up, more for the pelvis
   * level, the mass over the feet and the pelvis where it started; less for swaying, for
   * effort, and above all for moving up or down.
   */
  private standReward(stepSeconds: number, effort: number, support: number): number {
    const p = this.pelvis;
    // Level: the pelvis's up axis against the world's, from its quaternion.
    const qx = this.orientation[4 * p] as number;
    const qz = this.orientation[4 * p + 2] as number;
    const upY = 1 - 2 * (qx * qx + qz * qz);
    const vx = this.linear[3 * p] as number;
    const vy = this.linear[3 * p + 1] as number;
    const vz = this.linear[3 * p + 2] as number;
    // Along the floor, capped: a sway. Up or down, uncapped: a jump or a drop, which is never
    // standing however long the head stays in its band.
    const speed = Math.sqrt(vx * vx + vz * vz);
    const vertical = Math.abs(vy);
    // Where the pelvis has gone from where it started, along the floor: standing still is
    // standing here, and drifting off is the start of a fall the head has not shown yet.
    const px = this.position[3 * p] as number;
    const pz = this.position[3 * p + 2] as number;
    const drift = Math.sqrt((px - this.startX) ** 2 + (pz - this.startZ) ** 2);
    return (
      stepSeconds *
      (1 +
        0.5 * Math.max(0, upY) +
        0.5 * support +
        0.5 * (1 - Math.min(1, drift / 0.25)) -
        0.5 * Math.min(1, speed) -
        vertical -
        0.5 * effort)
    );
  }

  /**
   * One control step of balancing, scored on the head: how fast it moves and turns, and how
   * level it is. A point a second for being up, most of it lost to a head that is thrown about,
   * a little to effort, so a body that rides the floor out with its head still scores and one
   * that holds a posture and topples does not.
   */
  private balanceReward(stepSeconds: number, effort: number, support: number): number {
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
    return (
      stepSeconds *
      (1 +
        0.5 * Math.max(0, headUp) +
        0.5 * support -
        Math.min(1, hv / 0.5) -
        Math.min(1, hw / 2) -
        0.25 * effort)
    );
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
