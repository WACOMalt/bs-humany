/**
 * The studio's simulation session: one compiled articulation, one kernel, three modules.
 *
 * Runs on the main thread for M3.10. The worker host (M2.6) exists and is where this moves once
 * the ragdoll is proven; keeping it here first means the demo milestone is about the model, not
 * the transport.
 */

import type { ResolvedMorphology } from '@bs-humany/anthropometry';
import { RapierBackend } from '@bs-humany/backend-rapier';
import {
  type CompileReport,
  type CompiledArticulation,
  compileArticulation,
} from '@bs-humany/compiler';
import type { Vec3 } from '@bs-humany/frames';
import type { HsdlDocument } from '@bs-humany/hsdl';
import { type FrameStepPlan, Kernel, accumulateFrame } from '@bs-humany/kernel';
import {
  BODY_BONE_TRANSFORMS,
  BODY_POSE,
  GrabModule,
  MetricsModule,
  PassiveJointModule,
  PhysicsModule,
  SkeletonPoseModule,
} from '@bs-humany/modules-mechanics';

export interface SimulationOptions {
  readonly profileId: string;
  readonly passiveJoints: boolean;
  readonly redistribute: boolean;
  /** Metres the rest pose is lifted before release. */
  readonly dropHeight: number;
  /** Ground plane height in metres. */
  readonly groundHeight: number;
}

export interface BoneTransformsView {
  readonly position: Float64Array;
  readonly orientation: Float64Array;
}

/** A copy of the articulation with every segment lifted, so the body can be dropped. */
function lifted(model: CompiledArticulation, height: number): CompiledArticulation {
  if (height === 0) return model;
  return {
    ...model,
    segments: model.segments.map((s) => ({
      ...s,
      restWorld: {
        translation: {
          x: s.restWorld.translation.x,
          y: s.restWorld.translation.y + height,
          z: s.restWorld.translation.z,
        },
        rotation: s.restWorld.rotation,
      },
    })),
  };
}

export class Simulation {
  readonly articulation: CompiledArticulation;
  /** The compiler's notes: splits, drops, approximations. */
  readonly compileReport: CompileReport;
  readonly kernel: Kernel;
  readonly physics: PhysicsModule;
  readonly pose: SkeletonPoseModule;
  readonly passive: PassiveJointModule | undefined;
  readonly grab: GrabModule;
  readonly metrics: MetricsModule;
  readonly dt: number;
  private accumulator = 0;
  private started = false;
  /** Ticks run so far and whether the last frame had to discard time. */
  ticks = 0;
  clamped = false;

  constructor(document: HsdlDocument, morphology: ResolvedMorphology, options: SimulationOptions) {
    const profile = document.segmentation.find((p) => p.id === options.profileId);
    if (!profile) throw new Error(`No profile '${options.profileId}'.`);
    const compiled = compileArticulation(document, options.profileId, morphology);
    this.compileReport = compiled.report;
    this.articulation = lifted(compiled.articulation, options.dropHeight);
    const rate = profile.solver?.rate ?? 500;
    this.dt = 1 / rate;
    this.kernel = new Kernel({ rateHz: rate, seed: 1, preferShared: false });
    this.physics = new PhysicsModule(new RapierBackend(), this.articulation, {
      ground: { height: options.groundHeight },
      iterations: profile.solver?.iterations,
    });
    this.pose = new SkeletonPoseModule(document.bones, this.articulation, {
      redistribute: options.redistribute,
    });
    this.grab = new GrabModule(this.physics.backend, this.articulation);
    this.metrics = new MetricsModule(this.articulation);
    this.kernel.register(this.physics);
    this.kernel.register(this.pose);
    this.kernel.register(this.grab);
    this.kernel.register(this.metrics);
    if (options.passiveJoints) {
      this.passive = new PassiveJointModule(this.articulation);
      this.kernel.register(this.passive);
    }
  }

  async start(): Promise<void> {
    await this.kernel.init();
    this.started = true;
  }

  /** The backend's report, after `start`. */
  get backendReport(): CompileReport | undefined {
    return this.physics.report;
  }

  /** Advance by wall-clock elapsed seconds, in fixed ticks. */
  advance(elapsedSeconds: number): FrameStepPlan {
    if (!this.started) return { ticks: 0, alpha: 0, remainder: 0, clamped: false };
    const plan = accumulateFrame(this.accumulator, elapsedSeconds, this.dt);
    this.accumulator = plan.remainder;
    if (plan.ticks > 0) this.kernel.run(plan.ticks);
    this.ticks += plan.ticks;
    this.clamped = plan.clamped;
    return plan;
  }

  boneTransforms(): BoneTransformsView {
    const storage = this.kernel.channels.storage(BODY_BONE_TRANSFORMS);
    return {
      position: storage.fields.position as Float64Array,
      orientation: storage.fields.orientation as Float64Array,
    };
  }

  /** A channel's fields, for readouts and overlays. */
  channel(id: string): {
    readonly fields: Readonly<Record<string, ArrayLike<number>>>;
    readonly count: number;
  } {
    const storage = this.kernel.channels.storage(id);
    return { fields: storage.fields, count: storage.count };
  }

  boneOrder(): readonly string[] {
    return this.pose.plan.bones;
  }

  /** Segment index owning a bone, or -1. */
  segmentOfBone(boneId: string): number {
    const b = this.pose.plan.bones.indexOf(boneId);
    return b < 0 ? -1 : (this.pose.plan.segmentOf[b] ?? -1);
  }

  /** Current world pose of a segment, from `body.pose`. */
  segmentPose(index: number): {
    position: Vec3;
    rotation: { x: number; y: number; z: number; w: number };
  } {
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
