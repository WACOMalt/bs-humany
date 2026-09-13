/**
 * `SkeletonPoseModule` -- milestone M3.8.
 *
 * Turns the dynamic truth (`body.pose`, N segments) into the anatomical presentation
 * (`body.boneTransforms`, every bone), by posing followers rigidly with their anchor and then
 * redistributing each lumped region's joint deflection across its chain (spec section 4.3). It
 * runs in the `post` phase, after the solve, and writes nothing the solver reads.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import { ROOT_NQ } from '@bs-humany/compiler';
import type { BoneDef } from '@bs-humany/hsdl';
import type {
  ModuleInitContext,
  ModuleManifest,
  ModuleStepContext,
  SimModule,
} from '@bs-humany/kernel';
import {
  BODY_BONE_TRANSFORMS,
  BODY_JOINT_STATE,
  BODY_POSE,
  CHANNEL_VERSION,
  boneTransformsSpec,
} from './channels.js';
import { type RedistributionPlan, planRedistribution, poseBones } from './redistribution.js';

export const SKELETON_POSE_MODULE_ID = 'bsums.xyz.bs-humany.skeleton-pose';

export interface SkeletonPoseOptions {
  /** Switch redistribution off to see the raw segment rigidity. Defaults to on. */
  readonly redistribute?: boolean | undefined;
}

export class SkeletonPoseModule implements SimModule {
  readonly manifest: ModuleManifest;
  readonly plan: RedistributionPlan;
  private position: Float64Array | undefined;
  private orientation: Float64Array | undefined;
  private q: Float64Array | undefined;
  private outPosition: Float64Array | undefined;
  private outOrientation: Float64Array | undefined;

  constructor(
    bones: readonly BoneDef[],
    readonly articulation: CompiledArticulation,
    private readonly options: SkeletonPoseOptions = {},
  ) {
    this.plan = planRedistribution(bones, articulation);
    this.manifest = {
      id: SKELETON_POSE_MODULE_ID,
      version: '1.0.0',
      phase: 'post',
      dependsOn: [],
      reads: [
        { id: BODY_POSE, version: CHANNEL_VERSION },
        { id: BODY_JOINT_STATE, version: CHANNEL_VERSION },
      ],
      writes: [{ id: BODY_BONE_TRANSFORMS, version: CHANNEL_VERSION }],
      accumulates: [],
      gives: [boneTransformsSpec(bones.length)],
    };
  }

  /** Index of a bone in `body.boneTransforms`, or -1. */
  boneIndex(id: string): number {
    return this.plan.bones.indexOf(id);
  }

  init(ctx: ModuleInitContext): void {
    const pose = ctx.read(BODY_POSE);
    this.position = pose.fields.position as Float64Array;
    this.orientation = pose.fields.orientation as Float64Array;
    this.q = ctx.read(BODY_JOINT_STATE).fields.q as Float64Array;
    const out = ctx.write(BODY_BONE_TRANSFORMS);
    this.outPosition = out.fields.position as Float64Array;
    this.outOrientation = out.fields.orientation as Float64Array;
    this.step();
  }

  reset(ctx: ModuleInitContext): void {
    this.init(ctx);
  }

  step(_ctx?: ModuleStepContext): void {
    if (!this.position || !this.orientation || !this.q || !this.outPosition || !this.outOrientation)
      return;
    poseBones(
      this.plan,
      this.position,
      this.orientation,
      this.q,
      ROOT_NQ,
      this.outPosition,
      this.outOrientation,
      this.options.redistribute ?? true,
    );
  }
}
