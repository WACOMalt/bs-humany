/**
 * The studio's simulation session: one compiled and placed articulation, one kernel, the
 * mechanical modules, and a timeline of kernel snapshots.
 *
 * Runs on the main thread. The worker host (M2.6) exists and is where this moves once the
 * transport is worth its cost; on the main thread the timeline is simplest, since a scrub is a
 * synchronous restore.
 */

import type { ResolvedMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { RapierBackend } from '@bs-humany/backend-rapier';
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
} from '@bs-humany/modules-muscle';
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
import { type Scenario, type ScenarioApi, placeArticulation } from '@bs-humany/scenarios';

export type BackendId = 'rapier' | 'mujoco';

export interface SimulationOptions {
  readonly profileId: string;
  readonly backend: BackendId;
  readonly passiveJoints: boolean;
  readonly redistribute: boolean;
  /** A committed scenario, or a free drop from `dropHeight` in the rest pose. */
  readonly scenario?: Scenario | undefined;
  readonly dropHeight: number;
  readonly groundHeight: number;
  /** Seconds between timeline snapshots. */
  readonly snapshotEverySeconds?: number | undefined;
  /** Sampled trajectory recording cadence, ticks. 0 disables recording. */
  readonly recordEveryTicks?: number | undefined;
  /**
   * Run the muscle set (N3.7).
   *
   * Off unless asked for, because every unit costs a solve per tick and plenty of what the studio
   * is used for has nothing to do with muscles -- though the studio now asks for them by default,
   * because a muscle module should open showing muscles. What is wired up is the whole set: the
   * elbow, shoulder, forearm, hip, knee, ankle, trunk and torso, a hundred and forty-eight units.
   * The hand has none yet.
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

/**
 * MuJoCo is the only enabled backend. Rapier is kept as a vestigial remnant behind this switch
 * (ADR-003 reassessment, 2026-09-13): the studio never offers it, but nothing stops a scripted
 * session from asking for it.
 */
/**
 * Ticks one rendered frame may run in simulated-time mode.
 *
 * The same guard the wall-clock path has, for the same reason: without a ceiling a slow frame
 * schedules more work, which makes the next frame slower still. Sixty at 1000 Hz is 60 ms of
 * simulated time in one frame, which is far more than a display can use and still bounded.
 */
/** Frames a second of output is divided into, when nobody has said otherwise. */
export const DEFAULT_OUTPUT_FRAMERATE = 60;

function makeBackend(id: BackendId): IPhysicsBackend {
  return id === 'rapier' ? new RapierBackend() : new MujocoBackend();
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
  readonly backendId: BackendId;
  readonly capabilities: BackendCapabilities;
  readonly scenario: Scenario | undefined;
  readonly staticBoxes: readonly StaticBox[];
  /** Height of the ground plane the physics runs on, metres. */
  readonly groundHeight: number;
  readonly dt: number;
  readonly recording: Recording;
  private started = false;
  private readonly snapshotEvery: number;
  private readonly recordEvery: number;
  /** Timeline snapshots, one every `snapshotEvery` ticks, oldest first. */
  private readonly timeline: { tick: number; snapshot: KernelSnapshot }[] = [];
  private readonly timelineCapacity = 600;
  private scriptApi: ScenarioApi | undefined;
  /** Ticks run so far, and the wall-clock cost of the last frame's ticks. */
  ticks = 0;
  paused = false;
  lastStepMs = 0;
  /**
   * Frames a second of simulated time is divided into for playback and for the export.
   *
   * The wall clock has nothing to do with this and that is the point. One rendered frame advances
   * the simulation by exactly one output frame's worth of simulated time -- `stepsPerSecond /
   * outputFramerate` ticks, with the remainder carried so the average is exact -- and it does that
   * whether the frame took two milliseconds or two seconds. A slow machine produces the same
   * frames more slowly. It never produces fewer of them.
   *
   * What that replaces is a pair of modes that both chased the wall clock, one of which discarded
   * elapsed time to stay with it and reported the loss as "frames are being dropped". No tick was
   * ever actually lost -- a fixed timestep cannot skip one -- but the phrase was earned in the
   * sense that mattered least and alarming in the sense that mattered most, and neither mode had
   * any business being the thing a capture for export depended on.
   *
   * On playback this means the picture advances one output frame per display refresh: at 60 fps
   * output on a 60 Hz display that is life speed, and at 24 it is two and a half times life. The
   * export does not notice either way -- a keyframe's time comes from its tick index and
   * `stepsPerSecond`, and neither of those knows what the display was doing.
   */
  outputFramerate: number;
  /** Fractional ticks carried between frames, so a non-integer ticks-per-frame averages out. */
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
   * Every muscle ring's frame, captured alongside the bones.
   *
   * A belly cannot be exported the way a bone is -- it is swept anew every tick, so it is rigid
   * in nothing -- but it is rigid ring by ring, and a ring's position, orientation and radius is
   * all the glTF skin needs to reproduce it. Eight floats a ring against the three hundred its
   * vertices would take.
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
    this.staticBoxes = options.scenario?.staticBoxes ?? [];
    this.groundHeight = options.scenario?.ground.height ?? options.groundHeight;
    // The profile's own rate unless somebody asked for another. It is fixed for the life of the
    // clock -- `dt` is immutable, which is what makes a run reproducible -- so changing it in the
    // panel starts a new run rather than bending this one.
    const rate = options.stepsPerSecond ?? profile.solver?.rate ?? 500;
    this.dt = 1 / rate;
    this.backendId = options.backend;
    const backend = makeBackend(options.backend);
    this.capabilities = backend.capabilities;
    this.kernel = new Kernel({ rateHz: rate, seed: 1, preferShared: false });
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
      // shape, and that was cheap when it was written: 144 microseconds for fourteen units. At a
      // hundred and forty-eight it is 1.58 ms, which is forty per cent of the whole tick -- spent
      // on Tier V geometry that nothing reads back (M-ADR-004) and that a display showing sixty
      // frames a second discards ninety-two per cent of.
      //
      // What it was protecting is kept: `sweepRenderMesh` runs the sweep on demand, and the panel
      // calls it after a hand-stepped frame, so a stepped tick still shows its own shape. The
      // divisor only applies while the thing is running, where nobody can see the difference.
      this.muscleVolume = new MuscleVolumeModule(this.articulation, this.muscles, {
        simulationRateHz: rate,
      });
      this.kernel.register(this.muscleDrive);
      this.kernel.register(this.musclePath);
      this.kernel.register(this.muscleDynamics);
      this.kernel.register(this.muscleVolume);
    }

    this.outputFramerate = options.outputFramerate ?? DEFAULT_OUTPUT_FRAMERATE;
    this.snapshotEvery = Math.max(1, Math.round((options.snapshotEverySeconds ?? 0.1) * rate));
    this.recordEvery = options.recordEveryTicks ?? Math.round(rate / 50);
    this.recording = {
      scenario: options.scenario?.id ?? 'free-drop',
      profile: options.profileId,
      backend: options.backend,
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
      drive: (unit, level) => this.muscleDrive?.setOverride(unit, level, 'script'),
    };
    this.timeline.push({ tick: 0, snapshot: this.kernel.snapshot() });
    this.record();
  }

  get backendReport(): CompileReport | undefined {
    return this.physics.report;
  }

  /** Seconds of timeline available for scrubbing. */
  get recordedSeconds(): number {
    return this.ticks * this.dt;
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
   * Advance by exactly one output frame, unless paused.
   *
   * `elapsedSeconds` is measurement and nothing else -- it feeds `achievedRateHz` and does not
   * decide how much to run. That is the whole change: how far the simulation goes this frame is a
   * function of `stepsPerSecond` and `outputFramerate`, both of which somebody chose, and of
   * nothing the machine was doing at the time. Two runs of one scenario produce the same ticks in
   * the same frames on any machine, and the capture the export reads is the same either way.
   */
  advance(elapsedSeconds: number): FrameStepPlan {
    if (!this.started || this.paused) return { ticks: 0, alpha: 0, remainder: 0, clamped: false };
    this.owedTicks += this.ticksPerOutputFrame;
    const ticks = Math.floor(this.owedTicks);
    this.owedTicks -= ticks;
    const started = performance.now();
    for (let i = 0; i < ticks; i++) this.tick();
    if (ticks > 0) this.lastStepMs = (performance.now() - started) / ticks;
    this.measureRate(elapsedSeconds, ticks);
    return { ticks, alpha: 0, remainder: this.owedTicks, clamped: false };
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

  /** The rate the fidelity profile asks the solver to step at. */
  get declaredRateHz(): number {
    return 1 / this.dt;
  }

  /** One fixed tick: script, kernel, timeline, recording. */
  tick(): void {
    if (!this.started) return;
    if (this.scenario?.script && this.scriptApi)
      this.scenario.script(this.ticks * this.dt, this.scriptApi);
    this.kernel.step();
    this.ticks += 1;
    const bones = this.boneTransforms();
    this.capture.append(this.ticks, bones.position, bones.orientation);
    this.captureMuscleRings();
    this.keepCapturesLevel();
    if (this.ticks % this.snapshotEvery === 0) {
      if (this.timeline.length >= this.timelineCapacity) this.timeline.splice(1, 1);
      this.timeline.push({ tick: this.ticks, snapshot: this.kernel.snapshot() });
    }
    if (this.recordEvery > 0 && this.ticks % this.recordEvery === 0) this.record();
  }

  /** Jump to a time on the timeline: restore the nearest earlier snapshot and step up to it. */
  scrubTo(seconds: number): void {
    if (!this.started) return;
    const target = Math.max(0, Math.min(Math.round(seconds / this.dt), this.ticks));
    let best = this.timeline[0];
    for (const entry of this.timeline) {
      if (entry.tick <= target) best = entry;
      else break;
    }
    if (!best) return;
    this.kernel.restore(best.snapshot);
    this.ticks = best.tick;
    this.capture.truncate(best.tick);
    this.muscleCapture.truncate(best.tick);
    this.capturesStoppedBy = undefined;
    // Everything after the restored point is history no longer on the path; drop it.
    const keep = this.timeline.filter((e) => e.tick <= best.tick);
    this.timeline.splice(0, this.timeline.length, ...keep);
    this.recording.samples.splice(
      this.recording.samples.findIndex((s) => s.tick > best.tick) >>> 0,
    );
    this.grab.release();
    while (this.ticks < target) this.tick();
    this.pose.step();
    this.metrics.step();
  }

  reset(): void {
    this.scrubTo(0);
  }

  private record(): void {
    const pose = this.channel(BODY_POSE).fields;
    const joint = this.channel(BODY_JOINT_STATE).fields;
    const energy = this.channel(DIAGNOSTICS_ENERGY).fields;
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
    this.timeline.splice(0, this.timeline.length, {
      tick: ticks,
      snapshot: this.kernel.snapshot(),
    });
    this.recording.samples.length = 0;
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
    this.physics.setGravity(on ? this.articulation.gravity : { x: 0, y: 0, z: 0 });
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

  restore(snapshot: KernelSnapshot, ticks: number): void {
    this.kernel.restore(snapshot);
    this.ticks = ticks;
    this.capture.clear();
    this.muscleCapture.clear();
    this.capturesStoppedBy = undefined;
    this.timeline.splice(0, this.timeline.length, { tick: ticks, snapshot });
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
   * The swept muscle surfaces, for the renderer.
   *
   * Every unit's vertices lie end to end in one buffer, so a muscle's own begin at
   * `unit * verticesPerUnit`. The indices come from the module because they never change.
   */
  /**
   * Read each ring's frame out of the swept mesh and record it.
   *
   * Taken from the vertices rather than published by the sweep, because the sweep already put
   * everything needed there: a ring is a circle of `segments` vertices, so its centre is their
   * mean, its radius their mean distance from that centre, and its orientation the frame in which
   * the first vertex lies along X and the ring's own plane is the XY plane. Nothing is fitted --
   * these are exact for a circle, and the ring is a circle by construction.
   *
   * Allocation-free after the first tick, because this runs at the tick rate.
   */
  private captureMuscleRings(): void {
    const mesh = this.muscleMesh();
    const volume = this.muscleVolume;
    if (!mesh || !volume) return;
    const rings = volume.rings;
    const segments = volume.segments;
    const total = mesh.units * rings;
    if (this.ringRadius.length !== total) {
      this.ringPosition = new Float32Array(total * 3);
      this.ringOrientation = new Float32Array(total * 4);
      this.ringRadius = new Float32Array(total);
    }
    for (let unit = 0; unit < mesh.units; unit++) {
      for (let ring = 0; ring < rings; ring++) {
        const base = 3 * (unit * mesh.verticesPerUnit + ring * segments);
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (let v = 0; v < segments; v++) {
          cx += mesh.position[base + 3 * v] ?? 0;
          cy += mesh.position[base + 3 * v + 1] ?? 0;
          cz += mesh.position[base + 3 * v + 2] ?? 0;
        }
        cx /= segments;
        cy /= segments;
        cz /= segments;
        // X toward the first vertex, Z along the ring's normal, Y completing a right-handed set.
        let ax = (mesh.position[base] ?? 0) - cx;
        let ay = (mesh.position[base + 1] ?? 0) - cy;
        let az = (mesh.position[base + 2] ?? 0) - cz;
        const radius = Math.hypot(ax, ay, az);
        const quarter = 3 * Math.floor(segments / 4);
        let bx = (mesh.position[base + quarter] ?? 0) - cx;
        let by = (mesh.position[base + quarter + 1] ?? 0) - cy;
        let bz = (mesh.position[base + quarter + 2] ?? 0) - cz;
        if (radius > 1e-9) {
          ax /= radius;
          ay /= radius;
          az /= radius;
        }
        const bl = Math.hypot(bx, by, bz) || 1;
        bx /= bl;
        by /= bl;
        bz /= bl;
        // Z = X cross Y, then Y squared back up so the three are orthonormal whatever the mesh's
        // rounding did.
        const zx = ay * bz - az * by;
        const zy = az * bx - ax * bz;
        const zz = ax * by - ay * bx;
        const yx = zy * az - zz * ay;
        const yy = zz * ax - zx * az;
        const yz = zx * ay - zy * ax;
        const at = unit * rings + ring;
        this.ringPosition[3 * at] = cx;
        this.ringPosition[3 * at + 1] = cy;
        this.ringPosition[3 * at + 2] = cz;
        this.ringRadius[at] = radius;
        writeQuaternion(this.ringOrientation, 4 * at, ax, ay, az, yx, yy, yz, zx, zy, zz);
      }
    }
    this.muscleCapture.append(this.ticks, this.ringPosition, this.ringOrientation, this.ringRadius);
  }

  /**
   * Hold the two captures to the same length, because the exporter needs them to be.
   *
   * A belly is exported as a skin with one joint per cross-section and one keyframe per pose
   * frame, so a muscle capture shorter than the bone capture has no meaning -- and the exporter,
   * faced with that, used to drop every muscle and write the file anyway. What made it happen is
   * that the two captures hold wildly different amounts per frame on the same budget: a hundred
   * and ninety bones are five and a half kilobytes a frame, and a hundred and forty-eight units
   * at twenty-four rings apiece are a hundred and eleven. The muscle capture reaches a quarter of
   * a gigabyte after about four and three quarter seconds at five hundred hertz, the bone capture
   * after a minute and a half, and everything between the two exported a body with no muscles in
   * it and said nothing.
   *
   * So whichever fills first stops both. The export is shorter than it was and it is a real
   * export; the status line says which budget bound it.
   */
  private keepCapturesLevel(): void {
    if (!this.muscleVolume) return;
    const common = Math.min(this.capture.frameCount, this.muscleCapture.frameCount);
    if (this.capture.frameCount === common && this.muscleCapture.frameCount === common) return;
    if (common === 0) {
      this.capture.clear();
      this.muscleCapture.clear();
      return;
    }
    const stoppedBy = this.muscleCapture.full ? 'muscles' : 'bones';
    this.capture.truncate(this.capture.firstTick + common - 1);
    this.muscleCapture.truncate(this.muscleCapture.firstTick + common - 1);
    // `truncate` clears the full flag, because its usual caller is a rewind that makes room. Here
    // there is no room: the capture that filled is still full, and both must stay stopped.
    this.capture.stop();
    this.muscleCapture.stop();
    this.capturesStoppedBy = stoppedBy;
  }

  /** Which capture reached its budget first, once one has. */
  capturesStoppedBy: 'muscles' | 'bones' | undefined;

  /**
   * How many bytes each capture may hold, changeable while a run is going.
   *
   * Both get the same number rather than a split, because which of them binds depends on what is
   * loaded -- a muscle frame is twenty times a bone frame with the full set running and nothing
   * at all without it -- and a fixed split would waste whichever side was idle.
   */
  set captureBudgetBytes(bytes: number) {
    this.captureBudget = bytes;
    this.capture.setBudget(bytes);
    this.muscleCapture.setBudget(bytes);
    // Given room again, forget which one had run out: it may not be the same one next time.
    if (!this.capture.full && !this.muscleCapture.full) this.capturesStoppedBy = undefined;
  }

  get captureBudgetBytes(): number {
    return this.captureBudget;
  }

  private captureBudget: number;

  /**
   * Sweep the belly mesh now, whatever the divisor says.
   *
   * For a hand-stepped tick, which is the one case where the rate limit would be visible: step
   * once and the mesh would otherwise be up to a divisor's worth of ticks behind the bones.
   */
  sweepRenderMesh(): void {
    this.muscleVolume?.step({ tick: this.ticks, dt: this.dt, simTime: this.ticks * this.dt });
  }

  /**
   * Every belly's rings as of the last tick: centre, orientation and radius, in the order the
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

/**
 * A quaternion from three orthonormal basis vectors, written straight into a buffer.
 *
 * Shepperd's method: pick the largest of the four possible divisors so the square root is never
 * taken of something near zero, which is where the naive form loses its precision -- and a ring
 * whose orientation is out by a degree shows as a twist in the belly drawn from it.
 *
 * The arguments are the basis vectors, which are the *columns* of the rotation matrix: `xy` is the
 * X axis's y component, or m10. Getting that the wrong way round gives the conjugate -- a rotation
 * by the same angle the other way -- which is exactly what it did first, and what moved the
 * exported vertices 27 mm from where the sweep had put them.
 */
function writeQuaternion(
  out: Float32Array,
  at: number,
  xx: number,
  xy: number,
  xz: number,
  yx: number,
  yy: number,
  yz: number,
  zx: number,
  zy: number,
  zz: number,
): void {
  const trace = xx + yy + zz;
  let w: number;
  let x: number;
  let y: number;
  let z: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (yz - zy) / s;
    y = (zx - xz) / s;
    z = (xy - yx) / s;
  } else if (xx > yy && xx > zz) {
    const s = Math.sqrt(1 + xx - yy - zz) * 2;
    w = (yz - zy) / s;
    x = s / 4;
    y = (xy + yx) / s;
    z = (xz + zx) / s;
  } else if (yy > zz) {
    const s = Math.sqrt(1 + yy - xx - zz) * 2;
    w = (zx - xz) / s;
    x = (xy + yx) / s;
    y = s / 4;
    z = (yz + zy) / s;
  } else {
    const s = Math.sqrt(1 + zz - xx - yy) * 2;
    w = (xy - yx) / s;
    x = (xz + zx) / s;
    y = (yz + zy) / s;
    z = s / 4;
  }
  out[at] = x;
  out[at + 1] = y;
  out[at + 2] = z;
  out[at + 3] = w;
}
