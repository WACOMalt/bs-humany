import { resolveMorphology } from '@bs-humany/anthropometry';
import { RapierBackend } from '@bs-humany/backend-rapier';
import { ROOT_NQ, compileArticulation } from '@bs-humany/compiler';
import {
  angleBetween,
  fromAxisAngle,
  multiplyQuat,
  quat,
  rotate,
  sub,
  vec3,
} from '@bs-humany/frames';
import { Kernel } from '@bs-humany/kernel';
import { buildDocument, computeWorldTransforms } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { BODY_BONE_TRANSFORMS, BODY_POSE } from './channels.js';
import { PhysicsModule } from './physicsModule.js';
import { planRedistribution, poseBones } from './redistribution.js';
import { SkeletonPoseModule } from './skeletonPoseModule.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l1_standard', morphology);
const restWorld = computeWorldTransforms(document, morphology.context);

/** body.pose arrays at the rest pose. */
function restPose() {
  const n = articulation.segments.length;
  const position = new Float64Array(3 * n);
  const orientation = new Float64Array(4 * n);
  articulation.segments.forEach((s, i) => {
    position.set(
      [s.restWorld.translation.x, s.restWorld.translation.y, s.restWorld.translation.z],
      3 * i,
    );
    orientation.set(
      [
        s.restWorld.rotation.x,
        s.restWorld.rotation.y,
        s.restWorld.rotation.z,
        s.restWorld.rotation.w,
      ],
      4 * i,
    );
  });
  return { position, orientation, q: new Float64Array(articulation.nq) };
}

describe('the redistribution plan', () => {
  const plan = planRedistribution(document.bones, articulation);

  it('covers every bone and assigns cumulative shares along the lumbar chain', () => {
    expect(plan.bones.length).toBe(document.bones.length);
    const share = (bone: string, dof: number) => {
      const b = plan.bones.indexOf(bone);
      const off = plan.shareOffset[b] ?? -1;
      return off < 0 ? 1 : (plan.shares[off + dof] ?? Number.NaN);
    };
    // L1's lumbar segment: chain L5, L4, L3 (anchor) from the L5/S1 joint.
    expect(share('vertebra_l5', 0)).toBeCloseTo(1 / 3, 12);
    expect(share('vertebra_l4', 0)).toBeCloseTo(2 / 3, 12);
    expect(share('vertebra_l3', 0)).toBe(1);
    expect(share('vertebra_l2', 0)).toBe(1);
    // Thorax: T12..T8 from the T12/L1 joint; ribs ride with their vertebra.
    expect(share('vertebra_t12', 0)).toBeCloseTo(1 / 5, 12);
    expect(share('rib_12_r', 0)).toBeCloseTo(1 / 5, 12);
    expect(share('vertebra_t8', 0)).toBe(1);
    expect(share('sternum', 0)).toBe(1);
    // Limb segments have nothing to redistribute.
    expect(share('femur_r', 0)).toBe(1);
    expect(plan.jointOf[plan.bones.indexOf('femur_r')]).toBe(-1);
  });
});

describe('poseBones', () => {
  const plan = planRedistribution(document.bones, articulation);

  it('reproduces the document rest pose for every bone when nothing has moved', () => {
    const { position, orientation, q } = restPose();
    const outP = new Float64Array(3 * plan.bones.length);
    const outO = new Float64Array(4 * plan.bones.length);
    poseBones(plan, position, orientation, q, ROOT_NQ, outP, outO);
    plan.bones.forEach((id, b) => {
      const rest = restWorld.get(id);
      if (!rest) throw new Error(id);
      expect(outP[3 * b]).toBeCloseTo(rest.translation.x, 9);
      expect(outP[3 * b + 1]).toBeCloseTo(rest.translation.y, 9);
      expect(outP[3 * b + 2]).toBeCloseTo(rest.translation.z, 9);
      expect(Math.abs(outO[4 * b + 3] ?? 0)).toBeCloseTo(1, 9);
    });
  });

  it('spreads a lumbar flexion of 0.3 rad as 0.1, 0.2, 0.3 across L5, L4, L3', () => {
    const { position, orientation, q } = restPose();
    const joint = articulation.joints.find((j) => j.id === 'lumbar_region_lower');
    const lumbar = articulation.segments.find((s) => s.id === 'lumbar');
    const pelvis = articulation.segments.find((s) => s.id === 'pelvis');
    if (!joint || !lumbar || !pelvis) throw new Error('missing');
    const angle = 0.3;
    const flexion = joint.dofs[0];
    if (!flexion) throw new Error('no dof');
    // Rotate the lumbar body about the joint centre by R(axis, angle) in the joint frame.
    const jointRot = multiplyQuat(pelvis.restWorld.rotation, joint.frameInParent.rotation);
    const centre = rotate(pelvis.restWorld.rotation, joint.frameInParent.translation);
    const c = vec3(
      centre.x + pelvis.restWorld.translation.x,
      centre.y + pelvis.restWorld.translation.y,
      centre.z + pelvis.restWorld.translation.z,
    );
    const axisWorld = rotate(jointRot, flexion.vector);
    const delta = fromAxisAngle(axisWorld, angle);
    const r = sub(lumbar.restWorld.translation, c);
    const moved = rotate(delta, r);
    position.set([moved.x + c.x, moved.y + c.y, moved.z + c.z], 3 * lumbar.index);
    const newRot = multiplyQuat(delta, lumbar.restWorld.rotation);
    orientation.set([newRot.x, newRot.y, newRot.z, newRot.w], 4 * lumbar.index);
    q[ROOT_NQ + joint.dofStart] = angle;

    const outP = new Float64Array(3 * plan.bones.length);
    const outO = new Float64Array(4 * plan.bones.length);
    poseBones(plan, position, orientation, q, ROOT_NQ, outP, outO);
    const turned = (bone: string) => {
      const b = plan.bones.indexOf(bone);
      const rest = restWorld.get(bone);
      if (!rest) throw new Error(bone);
      const o = quat(
        outO[4 * b] ?? 0,
        outO[4 * b + 1] ?? 0,
        outO[4 * b + 2] ?? 0,
        outO[4 * b + 3] ?? 1,
      );
      return angleBetween(o, rest.rotation);
    };
    expect(turned('vertebra_l5')).toBeCloseTo(0.1, 6);
    expect(turned('vertebra_l4')).toBeCloseTo(0.2, 6);
    expect(turned('vertebra_l3')).toBeCloseTo(0.3, 6);
    expect(turned('vertebra_l1')).toBeCloseTo(0.3, 6);
    // Without redistribution the whole block turns as one.
    poseBones(plan, position, orientation, q, ROOT_NQ, outP, outO, false);
    expect(turned('vertebra_l5')).toBeCloseTo(0.3, 6);
  });
});

describe('SkeletonPoseModule in a kernel', () => {
  it('publishes finite transforms for every bone with anchors matching body.pose', async () => {
    const kernel = new Kernel({ rateHz: 500, seed: 1 });
    const physics = new PhysicsModule(new RapierBackend(), articulation, { ground: { height: 0 } });
    const pose = new SkeletonPoseModule(document.bones, articulation);
    kernel.register(physics);
    kernel.register(pose);
    await kernel.init();
    kernel.run(300);
    const bones = kernel.channels.view(pose.manifest.id, BODY_BONE_TRANSFORMS, 'write');
    const body = kernel.channels.view(physics.manifest.id, BODY_POSE, 'write');
    const bp = bones.fields.position as Float64Array;
    const sp = body.fields.position as Float64Array;
    for (let i = 0; i < bp.length; i++) expect(Number.isFinite(bp[i])).toBe(true);
    for (const s of articulation.segments) {
      const b = pose.boneIndex(s.anchor);
      expect(bp[3 * b + 1]).toBeCloseTo(sp[3 * s.index + 1] ?? 0, 9);
    }
    kernel.dispose();
  });
});
