import { resolveMorphology } from '@bs-humany/anthropometry';
import {
  type Transform,
  WORLD,
  anatomicalAxis,
  column,
  compose,
  dot,
  frameAxes,
  isUnitQuat,
  rotate,
  vec3,
} from '@bs-humany/frames';
import { evaluate, isSourced, validateDocument } from '@bs-humany/hsdl';
import { describe, expect, it } from 'vitest';
import { DATASET_MANIFEST, buildDocument } from './document.js';
import { VIRTUAL_LANDMARKS, virtualLandmarkWorld } from './frames.js';
import {
  JOINT_NS,
  JOINT_SPECS,
  type JointProvenance,
  L0_JOINTS,
  L1_JOINTS,
  L2_JOINTS,
  mirrorVector,
} from './joints.js';
import { isbLandmarkWorld, markerWorld } from './landmarks.js';
import { computeWorldTransforms } from './pose.js';
import { L0_RAGDOLL, L1_STANDARD, L2_BIOMECHANICAL } from './segmentation.js';

const document = buildDocument();
const joints = new Map(document.joints.map((j) => [j.id, j]));
const atDataset = resolveMorphology({
  sex: 0.5,
  stature: DATASET_MANIFEST.subjectStature,
  mass: 70,
}).context;

/** World transform of a joint frame at a morphology. */
function jointWorld(id: string, context = atDataset): Transform {
  const joint = joints.get(id);
  if (!joint) throw new Error(`no joint ${id}`);
  const world = computeWorldTransforms(document, context);
  const parent = world.get(joint.parentBone);
  if (!parent) throw new Error(`no parent pose for ${id}`);
  return compose(parent, {
    translation: vec3(
      evaluate(joint.frame.translation.x, context),
      evaluate(joint.frame.translation.y, context),
      evaluate(joint.frame.translation.z, context),
    ),
    rotation: joint.frame.rotation,
  });
}

const near = (a: readonly number[], b: readonly number[], tol = 1e-9) => {
  for (let i = 0; i < 3; i++) expect(Math.abs((a[i] ?? 0) - (b[i] ?? 0))).toBeLessThan(tol);
};

describe('joint definitions', () => {
  it('validate as part of the document', () => {
    const result = validateDocument(document);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('are built for every spec, with unique ids', () => {
    expect(document.joints.length).toBe(JOINT_SPECS.length);
    expect(joints.size).toBe(JOINT_SPECS.length);
  });

  it('cover both sides of every limb joint', () => {
    for (const base of [
      'hip',
      'knee',
      'ankle',
      'mtp',
      'sternoclavicular',
      'glenohumeral',
      'elbow',
      'radioulnar',
      'wrist',
    ]) {
      expect(joints.has(`${base}_r`), base).toBe(true);
      expect(joints.has(`${base}_l`), base).toBe(true);
    }
  });

  it('cite MyoSuite on every range, or record the open question a provisional range belongs to', () => {
    const provisionalQuestions = new Set<string>();
    for (const joint of document.joints) {
      for (const dof of joint.dofs) {
        if (isSourced(dof.romSource)) {
          expect(dof.romSource.key, `${joint.id}.${dof.axis}`).toBe('caggiano2022');
        } else {
          const question = dof.romSource.provisional?.openQuestion ?? '';
          expect(['OQ-007', 'OQ-010', 'OQ-011'], `${joint.id}.${dof.axis}`).toContain(question);
          provisionalQuestions.add(`${joint.id}:${question}`);
        }
      }
    }
    // The L1 set is fully sourced; only the L2/L3 extra levels and rigid-ish joints are not.
    for (const id of L1_JOINTS) {
      const joint = joints.get(id);
      expect(
        joint?.dofs.every((d) => isSourced(d.romSource)),
        id,
      ).toBe(true);
    }
    expect(provisionalQuestions.has('l5_s1:OQ-007')).toBe(true);
    expect(provisionalQuestions.has('t3_t4:OQ-010')).toBe(true);
    expect(provisionalQuestions.has('costovertebral_5_l:OQ-011')).toBe(true);
  });

  it('have unit-quaternion frames and unit DoF vectors', () => {
    for (const joint of document.joints) {
      expect(isUnitQuat(joint.frame.rotation), joint.id).toBe(true);
      for (const dof of joint.dofs) {
        expect(Math.abs(Math.hypot(dof.vector.x, dof.vector.y, dof.vector.z) - 1)).toBeLessThan(
          1e-9,
        );
      }
    }
  });

  it('record how each centre was located and which frame oriented it', () => {
    const hip = joints.get('hip_r');
    const p = hip?.ext?.[JOINT_NS] as JointProvenance | undefined;
    // The fitted centre of the femoral head, not the surface marker of the same name.
    expect(p?.centre).toBe('landmark femur_r__head_of_femur__articular_centre');
    expect(p?.orientation).toBe('isb-frame:hip_r');
    expect(p?.mirrored).toBe(false);
    // The sacrum carries the ISB pelvis frame; a lumbar vertebra has no frame yet.
    const l5 = joints.get('lumbar_region_lower')?.ext?.[JOINT_NS] as JointProvenance | undefined;
    expect(l5?.orientation).toBe('isb-frame:sacrum');
    const t12 = joints.get('lumbar_region_upper')?.ext?.[JOINT_NS] as JointProvenance | undefined;
    expect(t12?.orientation).toBe('isb-canonical');
  });
});

describe('joint centres', () => {
  it('sit on the ISB landmark or midpoint that defines them, at the dataset stature', () => {
    const t = (id: string) => {
      const w = jointWorld(id).translation;
      return [w.x, w.y, w.z];
    };
    near(t('hip_r'), isbLandmarkWorld('femur_r', 'HJC'));
    near(t('hip_l'), isbLandmarkWorld('femur_l', 'HJC'));
    near(t('glenohumeral_r'), isbLandmarkWorld('humerus_r', 'GH'));
    near(t('sternoclavicular_l'), isbLandmarkWorld('clavicle_l', 'SC'));
    near(t('radioulnar_r'), markerWorld('radius_r', 'Head_of_radius'));
    near(t('neck_region_upper'), markerWorld('occipital', 'Occipital_condyle'));
    const midFe = VIRTUAL_LANDMARKS.find((v) => v.id === 'femur_r__mid_fe');
    if (!midFe) throw new Error('missing virtual landmark');
    near(t('knee_r'), virtualLandmarkWorld(midFe));
  });

  it('scale with stature, so a taller body keeps its joints on its bones', () => {
    const tall = resolveMorphology({ sex: 0.5, stature: 1.9, mass: 80 }).context;
    const ratio = 1.9 / DATASET_MANIFEST.subjectStature;
    for (const id of ['hip_r', 'knee_l', 'wrist_r', 'lumbar_region_lower']) {
      const a = jointWorld(id).translation;
      const b = jointWorld(id, tall).translation;
      near([b.x, b.y, b.z], [a.x * ratio, a.y * ratio, a.z * ratio], 1e-9);
    }
  });

  it('put the knee between the hip and the ankle on the same side', () => {
    for (const s of ['r', 'l'] as const) {
      const hip = jointWorld(`hip_${s}`).translation;
      const knee = jointWorld(`knee_${s}`).translation;
      const ankle = jointWorld(`ankle_${s}`).translation;
      expect(hip.y).toBeGreaterThan(knee.y);
      expect(knee.y).toBeGreaterThan(ankle.y);
      expect(Math.sign(hip.x)).toBe(s === 'r' ? 1 : -1);
      expect(Math.sign(knee.x)).toBe(Math.sign(hip.x));
    }
  });

  it('stack the spine joints in order from sacrum to skull', () => {
    const ys = [
      'lumbar_region_lower',
      'lumbar_region_upper',
      'neck_region_lower',
      'neck_region_upper',
    ].map((id) => jointWorld(id).translation.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1] ?? 0);
    const perLevel = ['l5_s1', 'l4_l5', 'l3_l4', 'l2_l3', 'l1_l2', 't12_l1'].map(
      (id) => jointWorld(id).translation.y,
    );
    for (let i = 1; i < perLevel.length; i++)
      expect(perLevel[i]).toBeGreaterThan(perLevel[i - 1] ?? 0);
  });
});

describe('joint axes', () => {
  const RIGHT = anatomicalAxis('right', WORLD);
  const ANTERIOR = anatomicalAxis('anterior', WORLD);
  const SUPERIOR = anatomicalAxis('superior', WORLD);

  it('orient every joint frame X anterior, Y superior, Z right at neutral', () => {
    for (const joint of document.joints) {
      const axes = frameAxes(jointWorld(joint.id));
      // The acromioclavicular joint takes the clavicle's ISB frame, whose Z runs along the
      // clavicle itself, some 35 degrees from the transverse axis.
      const slack = joint.id.startsWith('acromioclavicular') ? 0.7 : 0.85;
      expect(dot(column(axes, 0), ANTERIOR), `${joint.id} x`).toBeGreaterThan(slack);
      expect(dot(column(axes, 1), SUPERIOR), `${joint.id} y`).toBeGreaterThan(slack);
      expect(dot(column(axes, 2), RIGHT), `${joint.id} z`).toBeGreaterThan(slack);
    }
  });

  it('make hip flexion carry the femur forward on both sides', () => {
    for (const s of ['r', 'l'] as const) {
      const joint = joints.get(`hip_${s}`);
      const flexion = joint?.dofs[0];
      if (!joint || !flexion) throw new Error('missing hip flexion');
      expect(flexion.axis).toBe('flexion');
      const frame = jointWorld(joint.id);
      // A point one unit distal along the femur, rotated a quarter turn about the flexion axis.
      const axisWorld = rotate(frame.rotation, flexion.vector);
      const distal = vec3(0, -1, 0);
      const cross = vec3(
        axisWorld.y * distal.z - axisWorld.z * distal.y,
        axisWorld.z * distal.x - axisWorld.x * distal.z,
        axisWorld.x * distal.y - axisWorld.y * distal.x,
      );
      expect(dot(cross, ANTERIOR)).toBeGreaterThan(0.9);
    }
  });

  it('make positive adduction and internal rotation medial on both sides', () => {
    for (const s of ['r', 'l'] as const) {
      const joint = joints.get(`hip_${s}`);
      const [, adduction, rotation] = joint?.dofs ?? [];
      if (!joint || !adduction || !rotation) throw new Error('missing hip dofs');
      const frame = jointWorld(joint.id);
      const medial = s === 'r' ? vec3(-1, 0, 0) : vec3(1, 0, 0);
      // Adduction: the distal femur moves medially.
      const a = rotate(frame.rotation, adduction.vector);
      const distal = vec3(0, -1, 0);
      const swing = vec3(a.y * distal.z - a.z * distal.y, a.z * distal.x - a.x * distal.z, 0);
      expect(dot(swing, medial), `${s} adduction`).toBeGreaterThan(0.9);
      // Internal rotation: a point on the anterior femur moves medially.
      const r = rotate(frame.rotation, rotation.vector);
      const anterior = ANTERIOR;
      const turn = vec3(
        r.y * anterior.z - r.z * anterior.y,
        r.z * anterior.x - r.x * anterior.z,
        r.x * anterior.y - r.y * anterior.x,
      );
      expect(dot(turn, medial), `${s} rotation`).toBeGreaterThan(0.9);
    }
  });

  it('mirror only the X and Y components between sides', () => {
    for (const spec of JOINT_SPECS.filter((j) => j.side === 'r')) {
      const right = joints.get(spec.id);
      const left = joints.get(spec.id.replace(/_r$/, '_l'));
      if (!right || !left) throw new Error(`unpaired ${spec.id}`);
      expect(left.dofs.length).toBe(right.dofs.length);
      right.dofs.forEach((dof, i) => {
        const l = left.dofs[i];
        if (!l) throw new Error('missing dof');
        expect(l.axis).toBe(dof.axis);
        expect(l.range).toEqual(dof.range);
        const m = mirrorVector(vec3(dof.vector.x, dof.vector.y, dof.vector.z));
        near([l.vector.x, l.vector.y, l.vector.z], [m.x, m.y, m.z]);
      });
    }
  });

  it('keep flexion-positive lumbar ranges, with flexion the larger of the two', () => {
    // The neck is the other way round in the source (50 degrees flexion, 60 extension).
    for (const id of ['lumbar_region_lower', 'l4_l5', 'l1_l2']) {
      const flexion = joints.get(id)?.dofs[0];
      if (!flexion) throw new Error(`missing ${id}`);
      expect(flexion.axis).toBe('flexion');
      expect(flexion.range[1]).toBeGreaterThan(-flexion.range[0]);
    }
  });

  it('give the L1 region joints exactly half of the lumped source ranges', () => {
    const lower = joints.get('lumbar_region_lower');
    const upper = joints.get('lumbar_region_upper');
    if (!lower || !upper) throw new Error('missing region joints');
    lower.dofs.forEach((dof, i) => {
      const u = upper.dofs[i];
      if (!u) throw new Error('missing dof');
      expect(u.range).toEqual(dof.range);
    });
    expect(lower.dofs[0]?.range).toEqual([-0.7538 / 2, 1.35 / 2]);
  });
});

describe('profile joint lists', () => {
  it('activate only joints that exist', () => {
    for (const id of [...L0_JOINTS, ...L1_JOINTS, ...L2_JOINTS]) {
      expect(joints.has(id), id).toBe(true);
    }
    expect(L0_RAGDOLL.joints).toEqual([...L0_JOINTS]);
    expect(L1_STANDARD.joints).toEqual([...L1_JOINTS]);
    expect(L2_BIOMECHANICAL.joints).toEqual([...L2_JOINTS]);
  });

  it('connect every pair of adjacent L1 segments with one joint', () => {
    const segmentOf = new Map<string, string>();
    for (const seg of L1_STANDARD.segments) for (const b of seg.bones) segmentOf.set(b, seg.id);
    const pairs = new Set<string>();
    for (const id of L1_JOINTS) {
      const joint = joints.get(id);
      if (!joint) throw new Error(id);
      const a = segmentOf.get(joint.parentBone);
      const b = segmentOf.get(joint.childBone);
      expect(a, id).not.toBe(b);
      pairs.add(`${a}->${b}`);
    }
    // A tree over the 23 segments has 22 edges.
    expect(pairs.size).toBe(L1_STANDARD.segments.length - 1);
    expect(L1_JOINTS.length).toBe(L1_STANDARD.segments.length - 1);
  });

  it('never activate a joint that falls inside a segment', () => {
    for (const [profile, list] of [
      [L0_RAGDOLL, L0_JOINTS],
      [L2_BIOMECHANICAL, L2_JOINTS],
    ] as const) {
      const segmentOf = new Map<string, string>();
      for (const seg of profile.segments) for (const b of seg.bones) segmentOf.set(b, seg.id);
      for (const id of list) {
        const joint = joints.get(id);
        if (!joint) throw new Error(id);
        expect(segmentOf.get(joint.parentBone), `${profile.id} ${id}`).not.toBe(
          segmentOf.get(joint.childBone),
        );
      }
    }
  });
});
