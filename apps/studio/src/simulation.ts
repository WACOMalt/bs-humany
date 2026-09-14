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
import type { Quat, Vec3 } from '@bs-humany/frames';
import type { HsdlDocument } from '@bs-humany/hsdl';
import {
  type FrameStepPlan,
  Kernel,
  type KernelSnapshot,
  accumulateFrame,
} from '@bs-humany/kernel';
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
import { type Scenario, type ScenarioApi, placeArticulation } from '@bs-humany/scenarios';
import { BoneCapture } from './capture.js';

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
  readonly backendId: BackendId;
  readonly capabilities: BackendCapabilities;
  readonly scenario: Scenario | undefined;
  readonly staticBoxes: readonly StaticBox[];
  /** Height of the ground plane the physics runs on, metres. */
  readonly groundHeight: number;
  readonly dt: number;
  readonly recording: Recording;
  private accumulator = 0;
  private started = false;
  private readonly snapshotEvery: number;
  private readonly recordEvery: number;
  /** Timeline snapshots, one every `snapshotEvery` ticks, oldest first. */
  private readonly timeline: { tick: number; snapshot: KernelSnapshot }[] = [];
  private readonly timelineCapacity = 600;
  private scriptApi: ScenarioApi | undefined;
  /** Ticks run so far, wall-clock cost of the last frame's ticks, and whether time was dropped. */
  ticks = 0;
  paused = false;
  clamped = false;
  lastStepMs = 0;
  /** Every bone's transform at every tick, for the Blender export. */
  readonly capture = new BoneCapture();
  /** The morphology the articulation was compiled at. */
  readonly resolved: ResolvedMorphology;

  constructor(document: HsdlDocument, morphology: ResolvedMorphology, options: SimulationOptions) {
    const profile = document.segmentation.find((p) => p.id === options.profileId);
    if (!profile) throw new Error(`No profile '${options.profileId}'.`);
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
    const rate = profile.solver?.rate ?? 500;
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

  /** Advance by wall-clock elapsed seconds, in fixed ticks, unless paused. */
  advance(elapsedSeconds: number): FrameStepPlan {
    if (!this.started || this.paused) return { ticks: 0, alpha: 0, remainder: 0, clamped: false };
    const plan = accumulateFrame(this.accumulator, elapsedSeconds, this.dt);
    this.accumulator = plan.remainder;
    const started = performance.now();
    for (let i = 0; i < plan.ticks; i++) this.tick();
    this.lastStepMs = plan.ticks > 0 ? (performance.now() - started) / plan.ticks : this.lastStepMs;
    this.clamped = plan.clamped;
    return plan;
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

  /** Kernel snapshot of the present moment, for session save. */
  snapshot(): KernelSnapshot {
    return this.kernel.snapshot();
  }

  restore(snapshot: KernelSnapshot, ticks: number): void {
    this.kernel.restore(snapshot);
    this.ticks = ticks;
    this.capture.clear();
    this.timeline.splice(0, this.timeline.length, { tick: ticks, snapshot });
    this.pose.step();
    this.metrics.step();
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
