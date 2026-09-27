/**
 * The studio's simulation session: one compiled and placed articulation, one kernel, the
 * mechanical and muscle modules, the two captures the export and the playback read, and a few
 * kernel snapshots to go back to.
 *
 * The snapshots are the start of the run, always, which is what Reset returns to, and as many
 * restore points after it as the caller asks for, which is none in the studio: its timeline plays
 * the captures back rather than re-simulating, so a snapshot there would be megabytes of state
 * that nothing restores. The headless publisher asks for a minute of them, because its headset
 * scrub does re-simulate.
 *
 * Runs on the main thread. The worker host (M2.6) exists and is where this moves once the
 * transport is worth its cost (ADR-008); on the main thread a scrub is a synchronous restore.
 */

import type { ResolvedMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import {
  type BackendCapabilities,
  type CompileReport,
  type CompiledArticulation,
  type IPhysicsBackend,
  type StaticBox,
  compileArticulation,
  transferJointState,
} from '@bs-humany/compiler';
import { BoneCapture, MuscleRingCapture, defaultCaptureBudgetBytes } from '@bs-humany/export-gltf';
import type { Quat, Vec3 } from '@bs-humany/frames';
import type { HsdlDocument } from '@bs-humany/hsdl';
import { type FrameStepPlan, Kernel, type KernelSnapshot } from '@bs-humany/kernel';
import {
  BODY_BONE_TRANSFORMS,
  BODY_JOINT_STATE,
  BODY_POSE,
  CouplingModule,
  DIAGNOSTICS_ENERGY,
  GrabModule,
  MetricsModule,
  PassiveJointModule,
  PhysicsModule,
  SkeletonPoseModule,
} from '@bs-humany/modules-mechanics';
import {
  type CompiledMuscleSet,
  MUSCLE_STATE,
  MuscleDynamicsModule,
  MusclePathModule,
  MuscleTestDriveModule,
  MuscleVolumeModule,
  RENDER_MUSCLE_MESH,
  compileMuscleSet,
  extractMuscleRings,
} from '@bs-humany/modules-muscle';
import {
  MlpPolicy,
  NervesModule,
  type PolicyFile,
  type SpinalGains,
  SpinalModule,
} from '@bs-humany/modules-nerves';
import { ALL_MUSCLES } from '@bs-humany/muscle-data';
import {
  GOAL_SIZE,
  type NervesSetup,
  type Scenario,
  type ScenarioApi,
  controlDivisorFor,
  driveOutputs,
  placeArticulation,
  profileRateHz,
  reflexGroups,
} from '@bs-humany/scenarios';

/** The physics backend a run is on. MuJoCo is the only one. */
export type BackendId = 'mujoco';
/**
 * What a session saved before Rapier was deleted (ADR-003, 2026-09-26) may still say. Accepted
 * and run on MuJoCo, so that an old session file or a bug report's attachment still opens.
 */
export type LegacyBackendId = 'rapier';

export interface SimulationOptions {
  readonly profileId: string;
  /** Always MuJoCo in practice; a legacy 'rapier' is run on MuJoCo too. @see makeBackend */
  readonly backend: BackendId | LegacyBackendId;
  readonly passiveJoints: boolean;
  readonly redistribute: boolean;
  /** A committed scenario, or a free drop from `dropHeight` in the rest pose. */
  readonly scenario?: Scenario | undefined;
  readonly dropHeight: number;
  readonly groundHeight: number;
  /** Seconds between restore points, when there are any. @see restorePoints */
  readonly snapshotEverySeconds?: number | undefined;
  /**
   * How many kernel snapshots to keep after the start of the run, for `scrubTo` to restore from.
   *
   * None unless asked for. A snapshot of the whole body with its muscles is about four megabytes,
   * and the studio used to keep six hundred of them -- two and a third gigabytes of state that
   * nothing on its timeline ever restored, since that plays the captures back. With none, the
   * start of the run is still kept, so Reset and a scrub still work; a scrub to anywhere else
   * simply re-simulates from the start. The newest are kept and the oldest after the start are
   * dropped, so a caller that scrubs, as the headless publisher does, gets a window of
   * `restorePoints * snapshotEverySeconds` behind the present.
   */
  readonly restorePoints?: number | undefined;
  /** Sampled trajectory recording cadence, ticks. 0 disables recording. */
  readonly recordEveryTicks?: number | undefined;
  /**
   * Run the muscle set (N3.7).
   *
   * Off unless asked for, because every unit costs a solve per tick and plenty of what the studio
   * is used for has nothing to do with muscles -- though the studio now asks for them by default,
   * because a muscle module should open showing muscles. What is wired up is every region in
   * `ALL_MUSCLES` (packages/muscle-data/src/wholeBody.ts), the hand's extrinsic digit muscles --
   * the long tendons from the forearm -- included. The hand's intrinsics, the lumbricals, the
   * interossei and the thenar and hypothenar groups, are not modelled yet (hand.ts says why).
   */
  readonly muscles?: boolean | undefined;
  /**
   * Bytes each export capture may hold. Settable from the panel while a run is going, and
   * injectable here so a test can reach the limit without allocating a quarter of a gigabyte
   * twice over to prove what happens there.
   */
  readonly captureBudgetBytes?: number | undefined;
  /**
   * Simulation steps per second of simulated time. Defaults to the profile's own solver rate.
   *
   * Fixed for the life of the run: `dt` is immutable, which is what makes two runs of a scenario
   * identical, so the panel restarts rather than retunes.
   */
  readonly stepsPerSecond?: number | undefined;
  /** Frames a second of simulated time is divided into, for playback and for the export. */
  readonly outputFramerate?: number | undefined;
  /**
   * A policy in the loop, handed over from the brain panel; takes precedence over the scenario's.
   * Whether the scenario's script drives muscles under it follows from its recipe; see
   * `scriptFeedsUnder`.
   */
  readonly nerves?: NervesSetup | undefined;
  /**
   * The cord's gains for this run: whatever the Spine panel shows, passed in by the studio when it
   * starts a run, so every start, carry restart and session restore gets the cord the panel says.
   *
   * Left out, the cord is off -- stretch and damping both zero -- which is the body every headless
   * caller (publish-pose, the tests) has always run and must keep running: a default that turned
   * the reflexes on would change what they publish without anybody asking for it.
   */
  readonly reflex?: Partial<SpinalGains> | undefined;
}

export interface BoneTransformsView {
  readonly position: Float64Array;
  readonly orientation: Float64Array;
}

export interface RecordedSample {
  readonly tick: number;
  readonly time: number;
  readonly position: number[];
  readonly orientation: number[];
  readonly q: number[];
  readonly kinetic: number;
  readonly potential: number;
}

export interface Recording {
  readonly scenario: string;
  readonly profile: string;
  readonly backend: BackendId;
  readonly morphology: ResolvedMorphology['input'];
  readonly dt: number;
  readonly segments: readonly string[];
  readonly samples: RecordedSample[];
}

/** Frames a second of output is divided into, when nobody has said otherwise. */
export const DEFAULT_OUTPUT_FRAMERATE = 60;

/**
 * The most ticks one call to `advance` runs, which is the most one rendered frame waits for.
 *
 * An output frame is `stepsPerSecond / outputFramerate` ticks, and the panel allows 2000 steps a
 * second into 1 frame a second: two thousand ticks inside one animation frame, which at L3 with
 * the muscles is several seconds in which the page answers nothing -- Pause included. Sixty is
 * one output frame at 60 fps and 1000 Hz with room to spare, so every setting the panel opens at
 * is under it and unchanged; a bigger frame is spread over several rendered frames.
 *
 * A count of ticks and never a budget of milliseconds, because a budget would make how far a
 * frame gets depend on how fast the machine was, and the run would stop being the same run on
 * two machines (blenderExport.test.ts pins that it is).
 */
export const MAX_TICKS_PER_ADVANCE = 60;

/**
 * The backend for a run, which is MuJoCo whatever was asked for.
 *
 * MuJoCo became the only enabled backend at the ADR-003 reassessment of 2026-09-13, and the
 * owner deleted Rapier on 2026-09-26, so the studio no longer bundles its 2.7 MB of wasm. A saved
 * session or a script that still asks for 'rapier' is run on MuJoCo rather than refused, because
 * the body it describes runs the same on either; only its trajectory differs, and nothing
 * restores a Rapier trajectory into a new run.
 */
function makeBackend(_requested: BackendId | LegacyBackendId): IPhysicsBackend {
  return new MujocoBackend();
}

/**
 * Whether the scenario's script may drive muscles under `policy`: yes, unless the policy was
 * trained with nothing under it.
 *
 * A checkpoint whose recipe says its feedforward was `none` has never felt a scenario's tone, and
 * a run that adds one is not the run it learned, so its script's muscle drive is dropped.
 * Everything else a script does -- the floor, a grab -- happens either way, because that is the
 * scenario rather than the feedforward. A `clip` counts as fed, not only a `script`: the studio
 * plays a clip through the scenario script's drive (nerves-stand's `playClip`), so a policy
 * trained over a clip is trained over exactly what a script's drive delivers. No policy, or one
 * whose file does not say, keeps the script's drive, which is what every run did before
 * checkpoints recorded their recipe.
 *
 * Read from the policy actually in the loop -- the one the run was built with, then whichever was
 * handed over -- and never from a checkpoint merely selected in a list, which is not driving
 * anything.
 */
function scriptFeedsUnder(policy?: PolicyFile): boolean {
  return policy?.recipe?.feedforward.kind !== 'none';
}

export class Simulation {
  readonly articulation: CompiledArticulation;
  readonly compileReport: CompileReport;
  readonly kernel: Kernel;
  readonly physics: PhysicsModule;
  readonly pose: SkeletonPoseModule;
  readonly passive: PassiveJointModule | undefined;
  readonly grab: GrabModule;
  readonly metrics: MetricsModule;
  /** The muscle set, and the three modules that run it. Undefined when muscles are off. */
  readonly muscles: CompiledMuscleSet | undefined;
  readonly muscleDrive: MuscleTestDriveModule | undefined;
  readonly musclePath: MusclePathModule | undefined;
  readonly muscleDynamics: MuscleDynamicsModule | undefined;
  readonly muscleVolume: MuscleVolumeModule | undefined;
  /** The nerves: in every muscle run, dormant until a policy is handed to them. */
  readonly nerves: NervesModule | undefined;
  /** The cord under the brain: the reflexes, whose gains a panel sets and a recipe restores. */
  readonly spine: SpinalModule | undefined;
  /** Whether a policy is in charge, rather than the nerves lying dormant. */
  brainActive = false;
  /**
   * The policy file in charge of the body right now: the scenario's or the panel's at the start,
   * whichever was handed over since, and nothing once it is released.
   *
   * Tracked here rather than read back off the setup the run was built with, because a policy
   * handed over mid-run replaces that one and the panel describing the brain on screen has to
   * describe this one -- its generations and fitness -- not the checkpoint the run opened with.
   * Changed by a hand-over only once the nerves have taken the new file, so a refused one leaves
   * this naming the policy that is still driving.
   */
  private policyFile: PolicyFile | undefined;
  readonly backendId: BackendId;
  readonly capabilities: BackendCapabilities;
  readonly scenario: Scenario | undefined;
  readonly staticBoxes: StaticBox[];
  /** Height of the ground plane the physics runs on, metres. */
  readonly groundHeight: number;
  readonly dt: number;
  readonly recording: Recording;
  private started = false;
  private readonly snapshotEvery: number;
  private readonly recordEvery: number;
  /** Restore points kept after the start. @see SimulationOptions.restorePoints */
  private readonly restorePoints: number;
  /**
   * Kernel snapshots, oldest first. The first is always tick 0 of this run, taken by `start` --
   * the scenario's start on this body -- whatever has been carried or restored since, so Reset
   * always has somewhere to go back to. After it: where a carry or a restore put the run, and a
   * restore point every `snapshotEvery` ticks, at most `restorePoints` of them.
   */
  private readonly timeline: { tick: number; snapshot: KernelSnapshot }[] = [];
  private scriptApi: ScenarioApi | undefined;
  /**
   * Whether the scenario's script may drive muscles, under the policy in the loop now. Set when the
   * run is built, again on every hand-over, and back on at a release. @see scriptFeedsUnder
   */
  private scriptMuscleDrive: boolean;
  private gravityOn = true;
  /** Ticks run so far, and the wall-clock cost of the last frame's ticks. */
  ticks = 0;
  paused = false;
  /**
   * Why the run stopped on its own, if it did: the message of whatever threw during a tick, and
   * the tick it was on. A tick that throws leaves the kernel part-way through a step, so the run
   * pauses there rather than stepping on from a state nobody can vouch for, and the viewport
   * keeps showing the last good frame. The first failure of the run; it is not cleared.
   */
  failure: { readonly message: string; readonly tick: number } | undefined;
  /**
   * The tick at which the backend reset the body on its own, if it did -- MuJoCo's autoreset
   * after a bad acceleration. The body is then back at its reference and the run would carry on
   * as if it had started again, which is exactly what must not pass unremarked, so it pauses.
   */
  divergedAt: number | undefined;
  /** The backend's reset count when last looked at, so a new reset is the only thing noticed. */
  private resetsSeen = 0;
  lastStepMs = 0;
  /**
   * Frames a second of simulated time is divided into for playback and for the export.
   *
   * The wall clock has nothing to do with this and that is the point. One rendered frame advances
   * the simulation by one output frame's worth of simulated time -- `stepsPerSecond /
   * outputFramerate` ticks, with the remainder carried so the average is exact -- and it does that
   * whether the frame took two milliseconds or two seconds. A slow machine produces the same
   * frames more slowly. It never produces fewer of them. The one exception is an output frame
   * worth more than `MAX_TICKS_PER_ADVANCE` ticks, which is spread over several rendered frames
   * so that no one of them stops the page; the ticks, and the run, are the same.
   *
   * What that replaces is a pair of modes that both chased the wall clock, one of which discarded
   * elapsed time to stay with it and reported the loss as "frames are being dropped". No tick was
   * ever actually lost -- a fixed timestep cannot skip one -- but the phrase was earned in the
   * sense that mattered least and alarming in the sense that mattered most, and neither mode had
   * any business being the thing a capture for export depended on.
   *
   * Watched live, this means the picture advances one output frame per display refresh: at 60 fps
   * output on a 60 Hz display that is life speed, and at 24 it is two and a half times life.
   * Playback of what was captured (playback.ts) is paced by the clock instead, so it takes the
   * time the run took. The export does not notice either way -- a keyframe's time comes from its
   * tick index and `stepsPerSecond`, and neither of those knows what the display was doing.
   */
  outputFramerate: number;
  /**
   * Ticks owed to the output frames begun so far and not yet run: the fraction a non-integer
   * ticks-per-frame leaves over, carried so it averages out, and whatever is left of a frame too
   * big for one `advance` -- which the next `advance` runs before it begins another frame.
   */
  private owedTicks = 0;
  /**
   * Ticks actually run per second of wall-clock time, over the last half second.
   *
   * Not a target and not a fault: nothing is discarded to reach a number, so this is simply how
   * fast simulated time is coming out. Against `declaredRateHz` it reads as a speed -- equal is
   * life speed, half is half speed -- and on a machine that cannot keep up it is lower and the
   * run takes longer in wall-clock seconds and is otherwise identical.
   */
  achievedRateHz = 0;
  /** Wall-clock seconds and ticks accumulated toward the next `achievedRateHz` reading. */
  private rateWindowSeconds = 0;
  private rateWindowTicks = 0;
  /** Every bone's transform at every tick, for the Blender export. */
  readonly capture: BoneCapture;
  /**
   * Every muscle ring's frame, captured on every tick the bellies were swept.
   *
   * A belly cannot be exported the way a bone is -- it is swept anew along its path, so it is
   * rigid in nothing -- but it is rigid ring by ring, and a ring's position, orientation and
   * radius is all the PC2 vertex cache needs to rebuild every vertex of it, and all playback needs
   * to draw it. Eight floats a ring against the three hundred its vertices would take. Taken only
   * when the sweep ran, which is one tick in four at 500 Hz and one in eight at 1000 Hz, because a
   * frame taken between two sweeps is a copy of the one before; `indexForTick` finds the frame a
   * bone tick was showing.
   */
  readonly muscleCapture: MuscleRingCapture;
  /** Scratch for a tick's ring frames, sized on the first capture and reused after. */
  private ringPosition = new Float32Array(0);
  private ringOrientation = new Float32Array(0);
  private ringRadius = new Float32Array(0);
  /** The morphology the articulation was compiled at. */
  readonly resolved: ResolvedMorphology;

  constructor(document: HsdlDocument, morphology: ResolvedMorphology, options: SimulationOptions) {
    const profile = document.segmentation.find((p) => p.id === options.profileId);
    if (!profile) throw new Error(`No profile '${options.profileId}'.`);
    this.captureBudget = options.captureBudgetBytes ?? defaultCaptureBudgetBytes();
    this.capture = new BoneCapture(this.captureBudget);
    this.muscleCapture = new MuscleRingCapture(this.captureBudget);
    const compiled = compileArticulation(document, options.profileId, morphology);
    this.compileReport = compiled.report;
    this.resolved = morphology;
    this.scenario = options.scenario;
    // The policy the run opens with: the panel's hand-over when there is one, else the scenario's.
    // Whether the script feeds muscles under it is decided now, before the first tick, so a
    // checkpoint trained with nothing under it never feels a tick of tone.
    const setup = options.nerves ?? options.scenario?.nerves;
    this.scriptMuscleDrive = scriptFeedsUnder(setup?.policy);
    this.articulation = options.scenario
      ? placeArticulation(
          compiled.articulation,
          options.scenario.rootRotation,
          options.scenario.clearance,
          options.scenario.ground.height,
        )
      : placeArticulation(
          compiled.articulation,
          undefined,
          options.dropHeight + restClearance(compiled.articulation, options.groundHeight),
          options.groundHeight,
        );
    this.staticBoxes = [...(options.scenario?.staticBoxes ?? [])];
    this.groundHeight = options.scenario?.ground.height ?? options.groundHeight;
    // The profile's own rate unless somebody asked for another. It is fixed for the life of the
    // clock -- `dt` is immutable, which is what makes a run reproducible -- so changing it in the
    // panel starts a new run rather than bending this one.
    const rate = profileRateHz(profile, options.stepsPerSecond);
    this.dt = 1 / rate;
    const backend = makeBackend(options.backend);
    this.backendId = backend.id;
    this.capabilities = backend.capabilities;
    // The declared-access audit stays opt-in here even under vitest, which turns it on for every
    // kernel that does not choose. The studio carries the whole body with its render channels, and
    // comparing them after every module's step makes the studio's own tests about twice as slow
    // (the Blender export, 24 s to 49 s, measured with the word-by-word compare); the same modules
    // are audited in the testkit's scenario pass, where it costs a fraction of that.
    this.kernel = new Kernel({ rateHz: rate, seed: 1, preferShared: false, audit: false });
    this.physics = new PhysicsModule(backend, this.articulation, {
      ground: { height: options.scenario?.ground.height ?? options.groundHeight },
      iterations: profile.solver?.iterations,
      staticBoxes: this.staticBoxes,
    });
    this.pose = new SkeletonPoseModule(document.bones, this.articulation, {
      redistribute: options.redistribute,
    });
    this.grab = new GrabModule(backend, this.articulation);
    this.metrics = new MetricsModule(this.articulation);
    this.kernel.register(this.physics);
    this.kernel.register(this.pose);
    this.kernel.register(this.grab);
    this.kernel.register(this.metrics);
    this.kernel.register(new CouplingModule(this.articulation, backend.capabilities));
    // The scenario's own value is what the goldens run with and what the studio offers when you
    // pick one, but the studio is for trying things: the checkbox wins here. The testkit reads
    // `scenario.passiveJoints` itself, so nothing committed depends on this.
    const passive = options.passiveJoints;
    if (passive) {
      this.passive = new PassiveJointModule(this.articulation);
      this.kernel.register(this.passive);
    }
    if (options.muscles) {
      // The muscle set is resolved against this articulation, so it follows the fidelity profile
      // and the morphology without being re-authored: bone ids are the stable interface.
      this.muscles = compileMuscleSet(
        [...ALL_MUSCLES],
        document.attachmentSites,
        this.articulation,
        morphology.context,
        document.wrappingSurfaces ?? [],
      );
      // Every unit starts relaxed. The drive is a live override the panel writes to, rather than
      // a pattern, because what this is for is turning a muscle on and watching what happens.
      this.muscleDrive = new MuscleTestDriveModule(this.muscles, [
        { units: 'all', pattern: { kind: 'constant', level: 0 } },
      ]);
      this.musclePath = new MusclePathModule(this.articulation, this.muscles);
      this.muscleDynamics = new MuscleDynamicsModule(this.articulation, this.muscles);
      // Swept at `DEFAULT_UPDATE_HZ` rather than every tick, which is a reversal and the reason
      // is arithmetic. It used to be every tick so that a stepped tick always showed its own
      // shape, and that was cheap when it was written: 144 microseconds for fourteen units. It
      // measured 1.58 ms at a hundred and forty-eight units, when the divisor was armed -- forty
      // per cent of the whole tick then, spent on Tier V geometry that nothing reads back
      // (M-ADR-004) and that a display showing sixty frames a second discards ninety-two per
      // cent of.
      //
      // What it was protecting is kept: `sweepRenderMesh` runs the sweep on demand, and the panel
      // calls it after a hand-stepped frame, so a stepped tick still shows its own shape. The
      // divisor only applies while the thing is running, where nobody can see the difference.
      // The ring capture follows the sweep rather than the tick for the same reason: between two
      // sweeps there is nothing new to capture.
      this.muscleVolume = new MuscleVolumeModule(this.articulation, this.muscles, {
        simulationRateHz: rate,
      });
      this.kernel.register(this.muscleDrive);
      this.kernel.register(this.musclePath);
      this.kernel.register(this.muscleDynamics);
      this.kernel.register(this.muscleVolume);
      // The nerves are in every muscle run, dormant when nothing has been handed to them -- a
      // zero policy with no authority adds nothing to the drive -- so a policy can be put in
      // charge of a running body live, between one control step and the next, with nothing
      // restarted and the recording unbroken.
      this.policyFile = setup?.policy;
      // The cord goes in before the brain, as in the trainer: it is the layer the brain
      // corrects. It starts at whatever the caller passes, which in the studio is the Spine
      // panel's gains, so the panel and the body never disagree about which cord is running.
      // With nothing passed there is no cord at all: stretch and damping both zero, which is the
      // body every headless caller has always run.
      this.spine = new SpinalModule(this.muscles, {
        groups: reflexGroups(),
        gains: { stretch: 0, velocity: 0, ...options.reflex },
        stepSeconds: 1 / rate,
      });
      this.kernel.register(this.spine);
      const goal = new Float64Array(GOAL_SIZE);
      goal[Math.max(0, Math.min(GOAL_SIZE - 1, setup?.goal ?? 0))] = 1;
      this.nerves = new NervesModule(this.articulation, this.muscles, {
        policy: setup
          ? setup.policy
          : (inputs, outputs) => new MlpPolicy([inputs, 32, 32, outputs]),
        outputs: driveOutputs(),
        goalSize: GOAL_SIZE,
        goal: () => goal,
        // The setup's own divisor when it pins one; otherwise the period the policy was trained
        // at, at this run's rate -- which is also what a hand-over into this run will use.
        controlDivisor: setup?.controlDivisor ?? controlDivisorFor(rate, setup?.policy.recipe),
        authority: setup ? setup.authority : 0,
      });
      this.brainActive = setup !== undefined;
      this.kernel.register(this.nerves);
    }

    this.outputFramerate = options.outputFramerate ?? DEFAULT_OUTPUT_FRAMERATE;
    this.snapshotEvery = Math.max(1, Math.round((options.snapshotEverySeconds ?? 0.1) * rate));
    this.restorePoints = Math.max(0, Math.floor(options.restorePoints ?? 0));
    this.recordEvery = options.recordEveryTicks ?? Math.round(rate / 50);
    this.recording = {
      scenario: options.scenario?.id ?? 'free-drop',
      profile: options.profileId,
      backend: this.backendId,
      morphology: morphology.input,
      dt: this.dt,
      segments: this.articulation.segments.map((s) => s.id),
      samples: [],
    };
  }

  async start(): Promise<void> {
    await this.kernel.init();
    this.started = true;
    const position = this.channel(BODY_POSE).fields.position as Float64Array;
    const index = new Map(this.articulation.segments.map((s) => [s.id, s.index]));
    this.scriptApi = {
      segment: (id) => index.get(id) ?? -1,
      segmentPosition: (i) => ({
        x: position[3 * i] ?? 0,
        y: position[3 * i + 1] ?? 0,
        z: position[3 * i + 2] ?? 0,
      }),
      grab: (s, local, target) => this.grab.grab(s, local, target),
      moveGrab: (target) => this.grab.moveTo(target),
      release: () => this.grab.release(),
      // Ignored rather than refused when the run has no muscles, so a script can ask without
      // checking first -- and so the same scenario is watchable with the muscles switched off.
      drive: (unit, level) => {
        if (!this.scriptMuscleDrive) return;
        this.muscleDrive?.setOverride(unit, level, 'script');
      },
      moveStaticBox: (id, position, rotation) => {
        const at = this.staticBoxes.findIndex((b) => b.id === id);
        const box = this.staticBoxes[at];
        if (!box) return;
        if (
          box.position.x === position.x &&
          box.position.y === position.y &&
          box.position.z === position.z &&
          box.rotation?.x === rotation.x &&
          box.rotation?.y === rotation.y &&
          box.rotation?.z === rotation.z &&
          box.rotation?.w === rotation.w
        ) {
          return;
        }
        // The list is what the viewport draws and what the bridge publishes, so it is kept in
        // step with the solver rather than left where the scenery started.
        this.staticBoxes[at] = { ...box, position: { ...position }, rotation: { ...rotation } };
        this.physics.setStaticBoxTransform(id, position, rotation);
      },
    };
    this.timeline.push({ tick: 0, snapshot: this.kernel.snapshot() });
    this.record();
  }

  get backendReport(): CompileReport | undefined {
    return this.physics.report;
  }

  /** Simulation steps a second of simulated time is divided into. `dt` is the authority. */
  get stepsPerSecond(): number {
    return Math.round(1 / this.dt);
  }

  /** Ticks one output frame is worth, which is what a rendered frame advances. */
  get ticksPerOutputFrame(): number {
    return this.stepsPerSecond / Math.max(1, this.outputFramerate);
  }

  /**
   * Advance by one output frame, unless paused -- or by the next `MAX_TICKS_PER_ADVANCE` ticks of
   * one, when a frame is worth more than that.
   *
   * `elapsedSeconds` is measurement and nothing else -- it feeds `achievedRateHz` and does not
   * decide how much to run. That is the whole change: how far the simulation goes this frame is a
   * function of `stepsPerSecond` and `outputFramerate`, both of which somebody chose, and of
   * nothing the machine was doing at the time. Two runs of one scenario produce the same ticks in
   * the same frames on any machine, and the capture the export reads is the same either way.
   *
   * A new output frame is begun only once the last is paid off, so a frame too big for one call
   * is spread over as many as it takes and the average is still exactly one output frame's worth
   * of ticks. When a frame fits under the cap, which is every setting the panel opens at, this is
   * the same arithmetic as before the cap and gives the same ticks in the same calls.
   */
  advance(elapsedSeconds: number): FrameStepPlan {
    if (!this.started || this.paused) return { ticks: 0, alpha: 0, remainder: 0, clamped: false };
    if (this.owedTicks < 1) this.owedTicks += this.ticksPerOutputFrame;
    const ticks = Math.min(Math.floor(this.owedTicks), MAX_TICKS_PER_ADVANCE);
    this.owedTicks -= ticks;
    const started = performance.now();
    let ran = 0;
    try {
      while (ran < ticks) {
        this.tick();
        ran += 1;
        const resets = this.physics.backendResets;
        if (resets !== this.resetsSeen) {
          this.resetsSeen = resets;
          this.divergedAt ??= this.ticks;
          this.paused = true;
          break;
        }
      }
    } catch (error) {
      // Caught here so that one bad tick stops the run instead of the frame loop: the caller
      // renders after this returns, and an exception out of it would take the viewport too.
      this.failure ??= {
        message: error instanceof Error ? error.message : String(error),
        tick: this.ticks,
      };
      this.paused = true;
    }
    if (ran > 0) this.lastStepMs = (performance.now() - started) / ran;
    this.measureRate(elapsedSeconds, ran);
    return { ticks: ran, alpha: 0, remainder: this.owedTicks, clamped: false };
  }

  /**
   * How fast simulated time is being produced, averaged over half a second.
   *
   * Averaged because a per-frame figure is mostly the browser's frame jitter. Half a second is
   * long enough to be steady and short enough to react while someone is watching it.
   */
  private measureRate(elapsedSeconds: number, ticks: number): void {
    this.rateWindowSeconds += elapsedSeconds;
    this.rateWindowTicks += ticks;
    if (this.rateWindowSeconds < 0.5) return;
    this.achievedRateHz = this.rateWindowTicks / this.rateWindowSeconds;
    this.rateWindowSeconds = 0;
    this.rateWindowTicks = 0;
  }

  /**
   * Start the rate reading afresh, for a run carrying on after a pause.
   *
   * A pause stops `advance` from measuring, so the half-second window it was part-way through
   * would otherwise be finished by the first frames after the pause, and the first reading would
   * be half of one stretch of running and half of another. The last reading goes too: it was of
   * the run before the pause, and the status line would read it as the speed of this one.
   */
  resetRateWindow(): void {
    this.rateWindowSeconds = 0;
    this.rateWindowTicks = 0;
    this.achievedRateHz = 0;
  }

  /** The rate the fidelity profile asks the solver to step at. */
  get declaredRateHz(): number {
    return 1 / this.dt;
  }

  /** One fixed tick: script, kernel, captures, restore points, recording. */
  tick(): void {
    if (!this.started) return;
    if (this.scenario?.script && this.scriptApi)
      this.scenario.script(this.ticks * this.dt, this.scriptApi);
    const sweeps = this.muscleVolume?.sweeps ?? 0;
    this.kernel.step();
    this.ticks += 1;
    const bones = this.boneTransforms();
    this.capture.append(this.ticks, bones.position, bones.orientation);
    // The rings only when the bellies were swept this tick: on the others the mesh is the last
    // sweep's, and so would every ring taken off it be.
    const swept = this.muscleVolume !== undefined && this.muscleVolume.sweeps !== sweeps;
    if (swept) this.captureMuscleRings(true);
    this.keepCapturesLevel(swept);
    if (this.restorePoints > 0 && this.ticks % this.snapshotEvery === 0) {
      this.timeline.push({ tick: this.ticks, snapshot: this.kernel.snapshot() });
      if (this.timeline.length > 1 + this.restorePoints) this.timeline.splice(1, 1);
    }
    if (this.recordEvery > 0 && this.ticks % this.recordEvery === 0) this.record();
  }

  /**
   * Jump to a time on the timeline: restore the nearest earlier snapshot and step up to it.
   *
   * The nearest earlier snapshot is the start of the run when there are no restore points
   * (`SimulationOptions.restorePoints`), so a scrub is then a re-simulation from tick 0. The start
   * is this body's, too, even after a carry: a target between tick 0 and the tick a carry started
   * at re-simulates on the new body from tick 0, rather than finding the old body's history.
   */
  scrubTo(seconds: number): void {
    if (!this.started) return;
    const target = Math.max(0, Math.min(Math.round(seconds / this.dt), this.ticks));
    let best = 0;
    for (let i = 1; i < this.timeline.length; i++) {
      if ((this.timeline[i]?.tick ?? Number.POSITIVE_INFINITY) <= target) best = i;
      else break;
    }
    this.rewind(best, target);
  }

  /** Restore timeline entry `index`, drop everything after it, and step on to `target`. */
  private rewind(index: number, target: number): void {
    const from = this.timeline[index];
    if (!this.started || !from) return;
    this.kernel.restore(from.snapshot);
    this.ticks = from.tick;
    this.capture.truncate(from.tick);
    this.muscleCapture.truncate(from.tick);
    this.capturesStoppedBy = undefined;
    // Everything after the restored point is history no longer on the path; drop it.
    this.timeline.splice(index + 1);
    this.recording.samples.splice(
      this.recording.samples.findIndex((s) => s.tick > from.tick) >>> 0,
    );
    this.recordingStopped = this.recordingFull();
    this.grab.release();
    while (this.ticks < target) this.tick();
    this.pose.step();
    this.metrics.step();
  }

  /**
   * Back to tick 0 of this run: the scenario's start, on the body that is running now.
   *
   * What the Reset button says it does, and it now does it after a carry or a session load too.
   * Both used to replace the whole timeline with the tick they arrived at, so Reset went back to
   * the middle of a run -- to the tick a stature change carried the body into, which is neither
   * the start nor anywhere a person had asked for. The start of the run is kept through both, so
   * Reset lands there: the scenario's own starting pose, at the new stature or on the loaded body.
   * Everything captured and recorded after it is thrown away, as the button's title says.
   *
   * The first entry of the timeline by position rather than the newest at tick 0, because a carry
   * into a run that was sitting at tick 0 is also at tick 0, and it is the old body's pose.
   */
  reset(): void {
    this.rewind(0, 0);
  }

  /** Bytes one recorded sample holds, as numbers; set on the first sample, when it is known. */
  private sampleBytes = 0;

  /**
   * Whether the sampled recording has stopped because its next sample would pass the capture
   * budget. It keeps the samples it has; a budget raised to make room lets it go on.
   */
  recordingStopped = false;

  /** Roughly what the sampled recording holds, counting eight bytes a number. */
  get recordingBytes(): number {
    return this.recording.samples.length * this.sampleBytes;
  }

  /** Whether one more sample would pass the capture budget. */
  private recordingFull(): boolean {
    return (this.recording.samples.length + 1) * this.sampleBytes > this.captureBudget;
  }

  /**
   * Take one sample of the sampled recording, unless it would pass the capture budget.
   *
   * Bounded by the same budget as the two captures, because it grew without any bound at all: a
   * sample is every segment's pose and every joint coordinate as plain numbers, about ten
   * kilobytes at L3, fifty times a simulated second, for as long as the tab stayed open -- and the
   * Export recording button then turns all of it into one string, which a JavaScript engine
   * refuses with a RangeError once it passes about half a billion characters. Stopped rather than
   * rolled, like the captures, so what is held is the start of the run and still exports.
   */
  private record(): void {
    const pose = this.channel(BODY_POSE).fields;
    const joint = this.channel(BODY_JOINT_STATE).fields;
    const energy = this.channel(DIAGNOSTICS_ENERGY).fields;
    if (this.sampleBytes === 0) {
      // Seven numbers a segment (position and orientation), one a joint coordinate, and the tick,
      // the time and the two energies.
      const segments = (pose.position as Float64Array).length / 3;
      this.sampleBytes = (7 * segments + (joint.q as Float64Array).length + 4) * 8;
    }
    if (this.recordingStopped || this.recordingFull()) {
      this.recordingStopped = true;
      return;
    }
    this.recording.samples.push({
      tick: this.ticks,
      time: this.ticks * this.dt,
      position: Array.from(pose.position as Float64Array),
      orientation: Array.from(pose.orientation as Float64Array),
      q: Array.from(joint.q as Float64Array),
      kinetic: (energy.kinetic as Float64Array)[0] ?? 0,
      potential: (energy.potential as Float64Array)[0] ?? 0,
    });
  }

  /** The recording as a JSON string for export. */
  exportRecording(): string {
    return JSON.stringify(this.recording);
  }

  /** The generalized state, for carrying across a recompile (M5.6). */
  jointState(): { model: CompiledArticulation; q: Float64Array; qdot: Float64Array } {
    const fields = this.channel(BODY_JOINT_STATE).fields;
    return {
      model: this.articulation,
      q: Float64Array.from(fields.q as Float64Array),
      qdot: Float64Array.from(fields.qdot as Float64Array),
    };
  }

  /** Place this (fresh) simulation at another articulation's joint state, joint by joint. */
  carryFrom(
    state: { model: CompiledArticulation; q: Float64Array; qdot: Float64Array },
    ticks: number,
  ): string[] {
    const { q, qdot, unmatched } = transferJointState(state, this.articulation);
    this.physics.writeJointState(q, qdot);
    this.pose.step();
    this.metrics.step();
    this.ticks = ticks;
    this.capture.clear();
    this.muscleCapture.clear();
    this.capturesStoppedBy = undefined;
    // After the start rather than instead of it: the start of the run is this body's own tick 0,
    // which is where Reset goes, and the carried state is where a scrub back to now comes from.
    this.timeline.splice(1);
    this.timeline.push({ tick: ticks, snapshot: this.kernel.snapshot() });
    this.recording.samples.length = 0;
    this.recordingStopped = false;
    return unmatched;
  }

  /**
   * Turn gravity on or off while the body is running.
   *
   * Off is exactly zero rather than a small number: a body in free fall then coasts, which is
   * what makes it useful for looking at a pose. The energy readout follows, because the physics
   * module publishes what is in force and the metrics module reads that.
   */
  setGravity(on: boolean): void {
    this.gravityOn = on;
    this.applyGravity();
  }

  /** Gravity as it stands: the body's own, or none. The floor's tilt is the floor's. */
  private applyGravity(): void {
    this.physics.setGravity(this.gravityOn ? this.articulation.gravity : { x: 0, y: 0, z: 0 });
  }

  /**
   * Turn contact with the ground on or off while the body is running.
   *
   * The floor is still drawn and the furniture still collides; only the ground plane stops
   * taking part, so a body can be dropped through it to see what it does in free space.
   */
  setGroundCollision(enabled: boolean): void {
    this.physics.setGroundCollision(enabled);
  }

  /** Kernel snapshot of the present moment, for session save. */
  snapshot(): KernelSnapshot {
    return this.kernel.snapshot();
  }

  /**
   * Put a started run at a saved moment: a session file's snapshot and the tick it was taken at.
   *
   * The start of this run stays first on the timeline, as after a carry, so Reset still goes to
   * the scenario's tick 0 rather than to the moment the session was saved at.
   */
  restore(snapshot: KernelSnapshot, ticks: number): void {
    this.kernel.restore(snapshot);
    this.ticks = ticks;
    this.capture.clear();
    this.muscleCapture.clear();
    this.capturesStoppedBy = undefined;
    this.timeline.splice(1);
    this.timeline.push({ tick: ticks, snapshot });
    this.recordingStopped = this.recordingFull();
    this.pose.step();
    this.metrics.step();
  }

  /**
   * What each muscle is doing this tick, in the order `muscles.units` lists them.
   *
   * Newtons and optimal fiber lengths, straight off `muscle.state`. Undefined when muscles are
   * off, rather than an empty reading that looks like a relaxed body.
   */
  muscleState():
    | {
        readonly activation: Float64Array;
        readonly fiberLength: Float64Array;
        readonly tendonForce: Float64Array;
        readonly diagnostic: Int32Array;
      }
    | undefined {
    if (!this.muscles) return undefined;
    const fields = this.channel(MUSCLE_STATE).fields;
    return {
      activation: fields.activation as Float64Array,
      fiberLength: fields.fiberLength as Float64Array,
      tendonForce: fields.tendonForce as Float64Array,
      diagnostic: fields.diagnostic as unknown as Int32Array,
    };
  }

  /**
   * Read each ring's frame out of the swept mesh, and record it when `append` says to.
   *
   * It records rings from `extractMuscleRings` (packages/modules-muscle/src/rings.ts), which
   * measures them off the vertices the sweep wrote; allocation-free after the first tick.
   */
  private captureMuscleRings(append: boolean): void {
    const mesh = this.muscleMesh();
    const volume = this.muscleVolume;
    if (!mesh || !volume) return;
    const total = mesh.units * volume.rings;
    if (this.ringRadius.length !== total) {
      this.ringPosition = new Float32Array(total * 3);
      this.ringOrientation = new Float32Array(total * 4);
      this.ringRadius = new Float32Array(total);
    }
    extractMuscleRings(mesh, volume.rings, volume.segments, {
      position: this.ringPosition,
      orientation: this.ringOrientation,
      radius: this.ringRadius,
    });
    if (append) {
      this.muscleCapture.append(
        this.ticks,
        this.ringPosition,
        this.ringOrientation,
        this.ringRadius,
      );
    }
  }

  /**
   * Hold the two captures to the same span of ticks, because the exporter needs them to.
   *
   * The bone capture holds every tick and the ring capture every sweep, and a bone tick's bellies
   * are the newest ring frame at or before it. So the bone capture may run on past the newest ring
   * frame only as far as that frame is still what was showing: up to the tick before the next
   * sweep. A bone tick past that has no bellies -- and the exporter, faced with bones and no
   * muscles, once dropped every muscle and wrote the file anyway. What makes it happen is that the
   * two captures hold wildly different amounts on the same budget: a ring frame is dozens of
   * times a bone frame with the whole muscle set running, so even at one ring frame a sweep the
   * ring capture fills first, and everything between the two stopping exported a body with no
   * muscles in it and said nothing.
   *
   * So whichever fills first stops both, at the last tick both can account for. The export is
   * shorter than it was and it is a real export; the status line says which budget bound it.
   * `swept` is whether the bellies were swept this tick, because a sweep the ring capture refused
   * is a tick its newest frame no longer describes.
   */
  private keepCapturesLevel(swept: boolean): void {
    if (!this.muscleVolume) return;
    const bones = this.capture;
    const rings = this.muscleCapture;
    // Both taking frames, or both already stopped: nothing to level.
    if (bones.full === rings.full) return;
    const stoppedBy = rings.full ? 'muscles' : 'bones';
    if (rings.full) {
      // The newest ring frame shows up to the tick before a sweep it refused, and up to this one
      // when there was no sweep to refuse (the budget was lowered under it between ticks).
      const end = swept ? this.ticks - 1 : this.ticks;
      if (rings.frameCount === 0) bones.clear();
      else bones.truncate(end);
    } else if (bones.frameCount === 0) {
      rings.clear();
    } else {
      rings.truncate(bones.firstTick + bones.frameCount - 1);
    }
    // `truncate` and `clear` drop the full flag, because their usual caller is a rewind that makes
    // room. Here there is no room: the capture that filled is still full, and both must stay
    // stopped until a raised budget lets them go on.
    bones.stop();
    rings.stop();
    this.capturesStoppedBy = stoppedBy;
  }

  /** Which capture reached its budget first, once one has. */
  capturesStoppedBy: 'muscles' | 'bones' | undefined;

  /**
   * How many bytes each capture may hold, changeable while a run is going.
   *
   * Both get the same number rather than a split, because which of them binds depends on what is
   * loaded -- with the full muscle set running a muscle frame is many times a bone frame, and
   * without muscles there is none at all; the Recording panel works out the two a tick for the
   * run in hand -- and a fixed split would waste whichever side was idle.
   *
   * Raising it on a capture that has already stopped keeps what is held, and that is the whole of
   * what it can promise. The capture is contiguous in tick number, and by the time anybody reads
   * the stop message and reaches for the slider the run has gone on past the last captured tick:
   * the ticks in between were never taken, so the next append would find a gap and start the
   * capture over from that tick, throwing away every frame it held. That is what "raise the
   * budget and it carries on" used to do. So a stopped capture the run has moved past is stopped
   * again, with its frames intact, and a longer capture is a new run -- which, the run being
   * deterministic, is the same run given the same inputs. Only a stop the run has not moved past,
   * a budget filled on a hand-stepped frame and raised before the next, resumes contiguously.
   */
  set captureBudgetBytes(bytes: number) {
    const wasStopped =
      this.capturesStoppedBy !== undefined || this.capture.full || this.muscleCapture.full;
    this.captureBudget = bytes;
    this.capture.setBudget(bytes);
    this.muscleCapture.setBudget(bytes);
    // The sampled recording has no promise of a sample per tick to keep, so given room it simply
    // goes on from wherever the run is.
    if (this.recordingStopped && !this.recordingFull()) this.recordingStopped = false;
    if (wasStopped && this.runPastCapture()) {
      this.capture.stop();
      this.muscleCapture.stop();
      // A bones-only run never sets this, because `keepCapturesLevel` has nothing to level; the
      // bone capture is then the only one there is, and it is what stopped.
      this.capturesStoppedBy ??= 'bones';
      return;
    }
    // Given room again, forget which one had run out: it may not be the same one next time.
    if (!this.capture.full && !this.muscleCapture.full) this.capturesStoppedBy = undefined;
  }

  /** Whether the run has gone past the newest captured tick, a gap no resume can span. */
  private runPastCapture(): boolean {
    return (
      this.capture.frameCount > 0 &&
      this.ticks !== this.capture.firstTick + this.capture.frameCount - 1
    );
  }

  /**
   * The capture stopped and the run went on without it: what is held is kept and still exports,
   * and more of it takes a new run. The status line says so rather than promising a resume.
   */
  get captureBehindRun(): boolean {
    const stopped =
      this.capturesStoppedBy !== undefined || this.capture.full || this.muscleCapture.full;
    return stopped && this.runPastCapture();
  }

  get captureBudgetBytes(): number {
    return this.captureBudget;
  }

  private captureBudget: number;

  /**
   * Sweep the belly mesh now, whatever the divisor says, and read its rings again.
   *
   * For a hand-stepped tick, which is the one case where the rate limit would be visible: step
   * once and the mesh would otherwise be up to a divisor's worth of ticks behind the bones. The
   * rings are read off it too, so `muscleRings` -- what the headset and the headless publisher
   * draw from -- shows the same shape; they are not added to the capture, which holds only the
   * sweeps the run itself made, so a stepped run captures what a run left alone would have.
   */
  sweepRenderMesh(): void {
    this.muscleVolume?.step({ tick: this.ticks, dt: this.dt, simTime: this.ticks * this.dt });
    this.captureMuscleRings(false);
  }

  /**
   * Put a policy in charge of the running body, live: fitted to it by name, swapped into the
   * nerves between one control step and the next. Returns what the body could use of it.
   *
   * The cord is not touched. It used to be set here from the policy's recipe, which made the
   * running body's reflexes something other than what the Spine panel showed the moment anything
   * was handed over; now the panel is the one owner, the studio writes a recipe's cord onto its
   * sliders, and the sliders set the body.
   *
   * The policy is evaluated at the period it was trained at, at this run's rate
   * (`controlDivisorFor`), because the timestep cannot change live and the control period can.
   * The rate it was trained at and the rate this run steps at are returned beside what was
   * carried, so whoever reports the hand-over can say when the two differ -- the period is kept,
   * but contacts and the muscles' own dynamics still follow the step, and only a restart matches
   * that.
   *
   * And the scenario's script stops feeding muscles if this policy was trained with nothing under
   * it (`scriptFeedsUnder`), at once rather than at the next run: the script layer it already
   * wrote is cleared here, between ticks, because the script's next drive is refused and would
   * otherwise leave the last tone it set standing under the new brain for the rest of the run.
   */
  handOver(
    policy: PolicyFile,
    authority: number,
  ): {
    carried: { inputs: number; outputs: number };
    trainedRate: number | undefined;
    rate: number;
  } {
    const nerves = this.nerves;
    if (!nerves) throw new Error('This run has no muscles, so nothing for a policy to drive.');
    const carried = nerves.adopt(policy, {
      divisor: controlDivisorFor(this.stepsPerSecond, policy.recipe),
    });
    nerves.authorityLevel = authority;
    this.policyFile = policy;
    this.brainActive = true;
    this.feedScript(scriptFeedsUnder(policy));
    return { carried, trainedRate: policy.recipe?.stepsPerSecond, rate: this.stepsPerSecond };
  }

  /**
   * Let the scenario's script drive muscles, or stop it and clear what it had set.
   *
   * Only the script's layer: a person's slider is the person's and goes on saying what it said.
   * Called between ticks, never from `step`, so the loop over the units allocates nothing on the
   * tick path.
   */
  private feedScript(feeds: boolean): void {
    this.scriptMuscleDrive = feeds;
    if (feeds || !this.muscles || !this.muscleDrive) return;
    for (const unit of this.muscles.units) this.muscleDrive.setOverride(unit.id, null, 'script');
  }

  /**
   * Whether the scenario's script is driving muscles under the policy in the loop now: false while
   * a policy trained with nothing under it is in charge, true otherwise.
   */
  get scriptDrivingMuscles(): boolean {
    return this.scriptMuscleDrive;
  }

  /**
   * Change how much say the policy in charge has, and nothing else.
   *
   * Separate from `handOver` because adopting a policy again is not free: it refits the weights
   * by name and, for a policy with memory, starts its context over, so moving the Authority slider
   * would quietly wipe what a remembering policy had built up.
   */
  setAuthority(level: number): void {
    if (this.nerves) this.nerves.authorityLevel = level;
  }

  /** The policy file in charge, if one is; see `policyFile`. */
  get policyInCharge(): PolicyFile | undefined {
    return this.policyFile;
  }

  /** Set the cord's gains live, for a panel that offers them. */
  setReflex(gains: Partial<SpinalGains>): void {
    this.spine?.adjust(gains);
  }

  /** Take the policy out of the loop; the run carries on under the clip and the sliders. */
  releaseBrain(): void {
    this.nerves?.release();
    this.policyFile = undefined;
    // The run carries on under the scenario, and a scenario with no brain on it feeds its muscles
    // as it always has: its script sets the tone again on the next tick.
    this.feedScript(true);
    // The cord stays as it was: it is the body's own, not the policy's, and a person who turned
    // the reflexes up to watch them did not ask for them to go away with the brain.
    this.brainActive = false;
  }

  /**
   * Every belly's rings as of the last sweep: centre, orientation and radius, in the order the
   * units are in. The same eight floats a ring the capture records, which is what a renderer that
   * sweeps its own tubes needs and a hundred times less than the vertices.
   */
  muscleRings():
    | {
        readonly position: Float32Array;
        readonly orientation: Float32Array;
        readonly radius: Float32Array;
        readonly units: number;
        readonly rings: number;
        readonly segments: number;
      }
    | undefined {
    const volume = this.muscleVolume;
    if (!volume || !this.muscles) return undefined;
    return {
      position: this.ringPosition,
      orientation: this.ringOrientation,
      radius: this.ringRadius,
      units: this.muscles.units.length,
      rings: volume.rings,
      segments: volume.segments,
    };
  }

  /**
   * The swept muscle surfaces, for the renderer.
   *
   * Every unit's vertices lie end to end in one buffer, so a muscle's own begin at
   * `unit * verticesPerUnit`. The indices come from the module because they never change.
   */
  muscleMesh():
    | {
        readonly position: Float64Array;
        readonly normal: Float64Array;
        readonly index: Uint32Array;
        readonly verticesPerUnit: number;
        readonly units: number;
      }
    | undefined {
    const volume = this.muscleVolume;
    if (!volume || !this.muscles) return undefined;
    const fields = this.channel(RENDER_MUSCLE_MESH).fields;
    return {
      position: fields.position as Float64Array,
      normal: fields.normal as Float64Array,
      index: volume.index,
      verticesPerUnit: volume.verticesPerUnit,
      units: this.muscles.units.length,
    };
  }

  channel(id: string): {
    readonly fields: Readonly<Record<string, ArrayLike<number>>>;
    readonly count: number;
  } {
    const storage = this.kernel.channels.storage(id);
    return { fields: storage.fields, count: storage.count };
  }

  boneTransforms(): BoneTransformsView {
    const storage = this.kernel.channels.storage(BODY_BONE_TRANSFORMS);
    return {
      position: storage.fields.position as Float64Array,
      orientation: storage.fields.orientation as Float64Array,
    };
  }

  boneOrder(): readonly string[] {
    return this.pose.plan.bones;
  }

  segmentOfBone(boneId: string): number {
    const b = this.pose.plan.bones.indexOf(boneId);
    return b < 0 ? -1 : (this.pose.plan.segmentOf[b] ?? -1);
  }

  segmentPose(index: number): { position: Vec3; rotation: Quat } {
    const storage = this.kernel.channels.storage(BODY_POSE);
    const p = storage.fields.position as Float64Array;
    const o = storage.fields.orientation as Float64Array;
    return {
      position: { x: p[3 * index] ?? 0, y: p[3 * index + 1] ?? 0, z: p[3 * index + 2] ?? 0 },
      rotation: {
        x: o[4 * index] ?? 0,
        y: o[4 * index + 1] ?? 0,
        z: o[4 * index + 2] ?? 0,
        w: o[4 * index + 3] ?? 1,
      },
    };
  }

  dispose(): void {
    if (this.started) this.kernel.dispose();
    else this.physics.dispose();
  }
}

/** The rest pose's own clearance above the ground: its lowest segment origin minus the ground. */
function restClearance(model: CompiledArticulation, groundHeight: number): number {
  let lowest = Number.POSITIVE_INFINITY;
  for (const s of model.segments) lowest = Math.min(lowest, s.restWorld.translation.y);
  return lowest - groundHeight;
}
