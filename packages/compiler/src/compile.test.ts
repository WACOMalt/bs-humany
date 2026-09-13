import { resolveMorphology, validateInertia } from '@bs-humany/anthropometry';
import { approxEqualsTransform, compose } from '@bs-humany/frames';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { ROOT_NQ, ROOT_NV } from './articulation.js';
import { CompileError, compileArticulation, morphologyKey } from './compile.js';
import { DE_LEVA_MAPPINGS } from './massMapping.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const l0 = compileArticulation(document, 'l0_ragdoll', morphology);
const l1 = compileArticulation(document, 'l1_standard', morphology);

describe('compiled articulation', () => {
  it('has one segment per profile segment, in profile order', () => {
    expect(l0.articulation.segments.map((s) => s.id)).toEqual(
      document.segmentation[0]?.segments.map((s) => s.id),
    );
    expect(l1.articulation.segments.length).toBe(23);
    l1.articulation.segments.forEach((s, i) => expect(s.index).toBe(i));
  });

  it('roots the tree at the pelvis and gives every other segment one parent', () => {
    for (const { articulation } of [l0, l1]) {
      expect(articulation.segments[articulation.root]?.id).toBe('pelvis');
      const orphans = articulation.segments.filter(
        (s) => s.parent === -1 && s.index !== articulation.root,
      );
      expect(orphans).toEqual([]);
    }
  });

  it('keeps joints in document order with contiguous DoF indices', () => {
    const ids = l1.articulation.joints.map((j) => j.id);
    const documentOrder = document.joints.map((j) => j.id).filter((id) => ids.includes(id));
    expect(ids).toEqual(documentOrder);
    expect(l1.articulation.joints.length).toBe(22);
    let next = 0;
    for (const joint of l1.articulation.joints) {
      expect(joint.dofStart).toBe(next);
      joint.dofs.forEach((d, i) => {
        expect(d.index).toBe(next + i);
        expect(d.joint).toBe(joint.index);
      });
      next += joint.dofs.length;
    }
    expect(l1.articulation.dofs.length).toBe(next);
    expect(l1.articulation.nv).toBe(ROOT_NV + next);
    expect(l1.articulation.nq).toBe(ROOT_NQ + next);
  });

  it('drops joints that fall inside a segment, and says so', () => {
    const dropped = l0.report.notes.filter((n) => n.feature === 'joint');
    expect(dropped.length).toBe(0);
    expect(l0.articulation.joints.length).toBe(14);
    // L0's joint list omits the intra-segment joints outright; activate L1's list on it to see
    // the drop reported.
    const everything = {
      ...document,
      segmentation: document.segmentation.map((p) =>
        p.id === 'l0_ragdoll' ? { ...p, joints: document.segmentation[1]?.joints ?? [] } : p,
      ),
    };
    const all = compileArticulation(everything, 'l0_ragdoll', morphology);
    expect(all.articulation.joints.length).toBe(14);
    expect(
      all.report.notes.some((n) => n.feature === 'joint' && n.element === 'radioulnar_r'),
    ).toBe(true);
  });

  it('places each joint frame identically from the parent and the child side at rest', () => {
    for (const joint of l1.articulation.joints) {
      const parent = l1.articulation.segments[joint.parentSegment];
      const child = l1.articulation.segments[joint.childSegment];
      if (!parent || !child) throw new Error('missing segment');
      const fromParent = compose(parent.restWorld, joint.frameInParent);
      const fromChild = compose(child.restWorld, joint.frameInChild);
      expect(approxEqualsTransform(fromParent, fromChild, 1e-9), joint.id).toBe(true);
    }
  });

  it('excludes every parent/child pair and the document pairs that exist in the profile', () => {
    const pairs = new Set(l1.articulation.excludedPairs.map(([a, b]) => `${a}|${b}`));
    for (const s of l1.articulation.segments) {
      if (s.parent === -1) continue;
      const [a, b] = s.parent < s.index ? [s.parent, s.index] : [s.index, s.parent];
      expect(pairs.has(`${a}|${b}`), s.id).toBe(true);
    }
    const index = (id: string) => l1.articulation.segments.findIndex((s) => s.id === id);
    const [lo, hi] = [index('hand_r'), index('ulna_r')].sort((x, y) => x - y);
    expect(pairs.has(`${lo}|${hi}`)).toBe(true);
    for (const [a, b] of l1.articulation.excludedPairs) expect(a).toBeLessThan(b);
  });

  it('carries one evaluated proxy per segment, owned by that segment', () => {
    for (const { articulation } of [l0, l1]) {
      expect(articulation.proxies.length).toBe(articulation.segments.length);
      for (const s of articulation.segments) {
        expect(s.proxyIndices.length).toBe(1);
        const p = articulation.proxies[s.proxyIndices[0] ?? -1];
        expect(p?.segment).toBe(s.index);
        if (p?.shape.kind === 'capsule') expect(p.shape.radius).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic', () => {
    const again = compileArticulation(document, 'l1_standard', morphology);
    expect(JSON.stringify(again.articulation)).toBe(JSON.stringify(l1.articulation));
    expect(again.articulation.morphologyKey).toBe(morphologyKey(morphology));
  });
});

describe('mass properties', () => {
  it('map every bone to exactly one de Leva segment', () => {
    for (const bone of document.bones) {
      const owners = DE_LEVA_MAPPINGS.filter((m) => m.bones(bone));
      expect(owners.length, bone.id).toBe(1);
    }
  });

  it('sum to the body mass and validate every inertia tensor', () => {
    for (const { articulation } of [l0, l1]) {
      expect(articulation.totalMass).toBeCloseTo(70, 1);
      for (const s of articulation.segments) {
        expect(s.mass, s.id).toBeGreaterThan(0);
        expect(validateInertia(s.inertia).valid, s.id).toBe(true);
      }
    }
  });

  it('give the thigh de Leva’s thigh mass and a centre of mass below the hip on the femur', () => {
    const thigh = l1.articulation.segments.find((s) => s.id === 'thigh_r');
    if (!thigh) throw new Error('no thigh');
    const expected = morphology.inertialTable.thigh.relativeMass * 70;
    expect(thigh.mass).toBeCloseTo(expected, 6);
    // The segment frame is the femur's centroid frame, world-aligned; the CoM sits within a few
    // centimetres of the femur's centroid along the bone.
    expect(Math.abs(thigh.com.x)).toBeLessThan(0.03);
    expect(Math.abs(thigh.com.y)).toBeLessThan(0.08);
  });

  it('report where a de Leva segment had to be split between profile segments', () => {
    // L1's lumbar segment shares de Leva's mid and lower trunk with the thorax and pelvis.
    const splits = l1.report.notes.filter((n) => n.feature === 'massProperties');
    expect(splits.some((n) => n.element === 'lumbar')).toBe(true);
    expect(l1.report.hasWarnings).toBe(true);
    // L0 lumps the whole trunk but still splits the head from the neck's cervical share.
    expect(l0.report.notes.some((n) => n.feature === 'massProperties')).toBe(true);
  });

  it('scale with morphology', () => {
    const heavy = compileArticulation(
      document,
      'l1_standard',
      resolveMorphology({ sex: 0.5, stature: 1.7, mass: 90 }),
    );
    expect(heavy.articulation.totalMass).toBeCloseTo(90, 1);
    const a = l1.articulation.segments.find((s) => s.id === 'shank_l');
    const b = heavy.articulation.segments.find((s) => s.id === 'shank_l');
    expect((b?.mass ?? 0) / (a?.mass ?? 1)).toBeCloseTo(90 / 70, 9);
  });
});

describe('failure modes', () => {
  it('refuses a profile whose segments are not all connected, naming them', () => {
    expect(() => compileArticulation(document, 'l2_biomechanical', morphology)).toThrow(
      CompileError,
    );
    try {
      compileArticulation(document, 'l2_biomechanical', morphology);
    } catch (e) {
      const err = e as CompileError;
      expect(err.message).toMatch(/no parent joint/);
      expect(err.message).toMatch(/finger_1_r/);
      expect(err.report.notes.some((n) => n.severity === 'error')).toBe(true);
    }
  });

  it('names an unknown profile', () => {
    expect(() => compileArticulation(document, 'l9', morphology)).toThrow(/no profile 'l9'/);
  });
});
