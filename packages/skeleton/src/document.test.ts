import { resolveMorphology } from '@bs-humany/anthropometry';
import { evaluate, validateDocument } from '@bs-humany/hsdl';
import { describe, expect, it } from 'vitest';
import { buildBones, buildDocument, modelLimitations, unmodelledBones } from './document.js';
import { HEIGHT, VERTEBRA_COUNT, VERTEBRA_HEIGHT, columnSpan } from './geometry/layout.js';
import { L0_RAGDOLL, L1_STANDARD, SEGMENTATION_PROFILES } from './segmentation.js';
import { BONES, EXPECTED_BONE_COUNT, getBone } from './taxonomy.js';

const context = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 }).context;

describe('the assembled document', () => {
  it('validates, which proves every cross-reference resolves', () => {
    const document = buildDocument();
    const result = validateDocument(document);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('carries all 206 bones', () => {
    expect(buildDocument().bones.length).toBe(EXPECTED_BONE_COUNT);
  });

  it('survives a JSON round-trip, since HSDL is a wire format', () => {
    const document = buildDocument();
    expect(validateDocument(JSON.parse(JSON.stringify(document))).ok).toBe(true);
  });

  it('cites every source it draws on', () => {
    const keys = buildDocument().meta.sources.map((s) => s.key);
    for (const key of ['deleva1996', 'gordon2014', 'drillis1966', 'wu2002']) {
      expect(keys).toContain(key);
    }
  });

  it('states its population limitations rather than implying a universal norm', () => {
    const populations = buildDocument().morphology.populations;
    expect(populations.length).toBeGreaterThanOrEqual(3);
    const text = populations.map((p) => p.limitation).join(' ');
    expect(text).toMatch(/college-aged/);
    expect(text).toMatch(/US Army/);
    expect(text).toMatch(/not sex-separated/i);
  });

  it('lists its own limitations, including the fallback-shaped bones', () => {
    const limitations = modelLimitations().join(' ');
    expect(limitations).toMatch(/Joint definitions are not yet present/);
    expect(limitations).toMatch(/OQ-00/);
    if (unmodelledBones().length > 0) {
      expect(limitations).toMatch(/generic fallback shape/);
    }
  });

  it('models everything except the auditory ossicles', () => {
    // The ossicles are millimetre-scale; a simple form meets the Phase 1 quality bar there.
    expect(unmodelledBones().sort()).toEqual(
      ['incus_l', 'incus_r', 'malleus_l', 'malleus_r', 'stapes_l', 'stapes_r'].sort(),
    );
  });
});

describe('bone definitions', () => {
  const bones = buildBones();

  it('gives every bone a geometry recipe and a rest transform', () => {
    for (const bone of bones) {
      expect(bone.geometry, bone.id).toBeDefined();
      expect(bone.restTransform, bone.id).toBeDefined();
    }
  });

  it('evaluates every rest transform without a missing parameter', () => {
    // A missing morphology parameter throws deep inside geometry generation, where the message is
    // least useful. Catching it here names the bone.
    for (const bone of bones) {
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(
          () => evaluate(bone.restTransform.translation[axis], context),
          `${bone.id}.restTransform.${axis}`,
        ).not.toThrow();
      }
    }
  });

  it('keeps every rest translation finite and of plausible magnitude', () => {
    for (const bone of bones) {
      for (const axis of ['x', 'y', 'z'] as const) {
        const value = evaluate(bone.restTransform.translation[axis], context);
        expect(Number.isFinite(value), `${bone.id}.${axis}`).toBe(true);
        // No single parent-relative offset should exceed a metre on a 1.7 m body.
        expect(Math.abs(value), `${bone.id}.${axis}`).toBeLessThan(1);
      }
    }
  });

  it('carries a unit rotation quaternion on every rest transform', () => {
    for (const bone of bones) {
      const q = bone.restTransform.rotation;
      expect(Math.hypot(q.x, q.y, q.z, q.w), bone.id).toBeCloseTo(1, 6);
    }
  });

  it('mirrors paired bones across the midline', () => {
    // Left/right sign errors are the likeliest data-entry bug across 206 entries, so the mirror is
    // asserted rather than assumed.
    const byId = new Map(bones.map((b) => [b.id, b]));
    for (const bone of bones) {
      if (bone.side !== 'right') continue;
      const mirror = byId.get(`${bone.id.slice(0, -2)}_l`);
      expect(mirror, `${bone.id} has no mirror`).toBeDefined();
      if (!mirror) continue;

      const right = evaluate(bone.restTransform.translation.x, context);
      const left = evaluate(mirror.restTransform.translation.x, context);
      // Either mirrored, or both on the midline.
      expect(Math.abs(right + left), `${bone.id} X mirror`).toBeLessThan(1e-9);

      for (const axis of ['y', 'z'] as const) {
        expect(
          evaluate(bone.restTransform.translation[axis], context),
          `${bone.id} ${axis} should match its mirror`,
        ).toBeCloseTo(evaluate(mirror.restTransform.translation[axis], context), 9);
      }
    }
  });

  it('responds to stature: every dimension scales', () => {
    // The whole point of ADR-005. A bone whose size did not change with stature would be a
    // constant masquerading as a parameter.
    const short = resolveMorphology({ sex: 0.5, stature: 1.5, mass: 70 }).context;
    const tall = resolveMorphology({ sex: 0.5, stature: 2.0, mass: 70 }).context;

    const femur = bones.find((b) => b.id === 'femur_r');
    expect(femur).toBeDefined();
    const shortLength = evaluate(femur?.dimensions.length ?? 0, short);
    const tallLength = evaluate(femur?.dimensions.length ?? 0, tall);
    expect(tallLength / shortLength).toBeCloseTo(2.0 / 1.5, 6);
  });

  it('responds to the sex blend where the feature is dimorphic', () => {
    // Pelvic width drives the hip joint centre separation, which is the most consequential
    // skeletal dimorphism for gait and for the Q-angle.
    const female = resolveMorphology({ sex: 0, stature: 1.7, mass: 70 }).context;
    const male = resolveMorphology({ sex: 1, stature: 1.7, mass: 70 }).context;
    const hip = bones.find((b) => b.id === 'hip_r');
    expect(hip).toBeDefined();
    const femaleOffset = evaluate(hip?.restTransform.translation.x ?? 0, female);
    const maleOffset = evaluate(hip?.restTransform.translation.x ?? 0, male);
    expect(femaleOffset).toBeGreaterThan(maleOffset);
  });
});

describe('skeletal layout', () => {
  it('spans the column from the sacral promontory to the atlas', () => {
    // If any per-level body height is edited, this fails rather than silently detaching the skull.
    const span = columnSpan();
    expect(span).toBeCloseTo(HEIGHT.atlas - HEIGHT.sacralPromontory, 10);
    expect(
      VERTEBRA_COUNT.lumbar * VERTEBRA_HEIGHT.lumbar +
        VERTEBRA_COUNT.thoracic * VERTEBRA_HEIGHT.thoracic +
        VERTEBRA_COUNT.cervical * VERTEBRA_HEIGHT.cervical,
    ).toBeCloseTo(span, 12);
  });

  it('orders vertebral body heights lumbar > thoracic > cervical', () => {
    expect(VERTEBRA_HEIGHT.lumbar).toBeGreaterThan(VERTEBRA_HEIGHT.thoracic);
    expect(VERTEBRA_HEIGHT.thoracic).toBeGreaterThan(VERTEBRA_HEIGHT.cervical);
  });

  it('keeps the standing joint-centre heights in anatomical order', () => {
    expect(HEIGHT.ankle).toBeLessThan(HEIGHT.knee);
    expect(HEIGHT.knee).toBeLessThan(HEIGHT.hip);
    expect(HEIGHT.hip).toBeLessThan(HEIGHT.sacralPromontory);
    expect(HEIGHT.sacralPromontory).toBeLessThan(HEIGHT.shoulder);
    expect(HEIGHT.shoulder).toBeLessThan(HEIGHT.atlas);
    expect(HEIGHT.atlas).toBeLessThan(HEIGHT.vertex);
  });
});

describe('segmentation profiles', () => {
  it('partition all 206 bones in every profile', () => {
    // This is what enforces ADR-001: anatomy is complete at every fidelity level.
    for (const profile of SEGMENTATION_PROFILES) {
      const assigned = profile.segments.flatMap((s) => s.bones);
      expect(new Set(assigned).size, `${profile.id} duplicates a bone`).toBe(assigned.length);
      expect(assigned.length, `${profile.id} bone count`).toBe(EXPECTED_BONE_COUNT);
      for (const bone of BONES) {
        expect(assigned, `${profile.id} is missing ${bone.id}`).toContain(bone.id);
      }
    }
  });

  it('name an anchor the segment actually owns', () => {
    for (const profile of SEGMENTATION_PROFILES) {
      for (const segment of profile.segments) {
        expect(segment.bones, `${profile.id}/${segment.id}`).toContain(segment.anchor);
        expect(getBone(segment.anchor), `${profile.id}/${segment.id} anchor exists`).toBeDefined();
      }
    }
  });

  it('give L0 fifteen segments and L1 twenty-three', () => {
    expect(L0_RAGDOLL.segments.length).toBe(15);
    expect(L1_STANDARD.segments.length).toBe(23);
  });

  it('make L1 strictly finer than L0', () => {
    expect(L1_STANDARD.segments.length).toBeGreaterThan(L0_RAGDOLL.segments.length);
    expect(L1_STANDARD.solver?.rate ?? 0).toBeGreaterThan(L0_RAGDOLL.solver?.rate ?? 0);
  });

  it('state plainly what each profile gives up', () => {
    // Spec section 12: a fidelity control that only shows a quality label lets a user believe they
    // are measuring something they are not.
    expect(L0_RAGDOLL.limitations.join(' ')).toMatch(/[Ss]pinal kinematics are cosmetic/);
    expect(L0_RAGDOLL.limitations.join(' ')).toMatch(/[Nn]ot suitable for any measurement run/);
    for (const profile of SEGMENTATION_PROFILES) {
      expect(profile.limitations.length, profile.id).toBeGreaterThan(0);
    }
  });
});
