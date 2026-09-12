import { describe, expect, it } from 'vitest';
import { provisional } from './citation.js';
import type { HsdlDocument } from './document.js';
import { makeMinimalDocument } from './fixtures.js';
import { assertValidDocument, validateDocument } from './validate.js';

/** Deep clone so each test mutates its own copy. */
function doc(): HsdlDocument {
  return structuredClone(makeMinimalDocument());
}

function errorsOf(d: unknown): string[] {
  return validateDocument(d)
    .issues.filter((i) => i.severity === 'error')
    .map((i) => i.message);
}

describe('the minimal fixture', () => {
  it('validates', () => {
    const result = validateDocument(doc());
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.document).toBeDefined();
  });

  it('survives a JSON round-trip, since HSDL is a wire format', () => {
    const original = doc();
    const roundTripped = JSON.parse(JSON.stringify(original));
    expect(validateDocument(roundTripped).ok).toBe(true);
    expect(roundTripped).toEqual(original);
  });

  it('assertValidDocument returns the parsed document', () => {
    expect(assertValidDocument(doc()).id).toBe('test.minimal');
  });
});

describe('shape validation', () => {
  it('rejects an unknown top-level key rather than ignoring it', () => {
    // Strict objects throughout: a typo'd key that is silently dropped is a setting that looks
    // applied and is not.
    const d = { ...doc(), collisionProxys: [] };
    expect(validateDocument(d).ok).toBe(false);
  });

  it('rejects a wrong hsdlVersion', () => {
    expect(validateDocument({ ...doc(), hsdlVersion: '0.2' }).ok).toBe(false);
  });

  it('rejects a non-SI unit', () => {
    const d = doc();
    (d.units as { angle: string }).angle = 'deg';
    expect(validateDocument(d).ok).toBe(false);
  });

  it('rejects a non-unit quaternion', () => {
    const d = doc();
    d.bones[0]!.restTransform.rotation = { x: 0, y: 0, z: 0, w: 0.5 };
    expect(errorsOf(d).join(' ')).toMatch(/unit length/);
  });

  it('rejects a non-unit DoF axis vector', () => {
    const d = doc();
    d.joints[0]!.dofs[0]!.vector = { x: 2, y: 0, z: 0 };
    expect(errorsOf(d).join(' ')).toMatch(/unit length/);
  });

  it('rejects an ID that is not snake_case', () => {
    const d = doc();
    d.bones[1]!.id = 'FemurR';
    expect(validateDocument(d).ok).toBe(false);
  });

  it('rejects a DoF whose neutral lies outside its range', () => {
    const d = doc();
    d.joints[0]!.dofs[0]!.neutral = 1.5;
    expect(errorsOf(d).join(' ')).toMatch(/neutral value must lie within its range/);
  });

  it('rejects an inverted DoF range', () => {
    const d = doc();
    d.joints[0]!.dofs[0]!.range = [0, -2];
    expect(errorsOf(d).join(' ')).toMatch(/ordered \[min, max\]/);
  });

  it('rejects a revolute joint with more than one DoF', () => {
    const d = doc();
    const dof = d.joints[0]!.dofs[0]!;
    d.joints[0]!.dofs = [dof, { ...dof, axis: 'rotation' }];
    expect(errorsOf(d).join(' ')).toMatch(/'revolute' must have exactly one DoF/);
  });

  it('requires a citation on every DoF range', () => {
    // Spec section 5.3: a range of motion without a source is a bug. This is the specific
    // mechanism that keeps research accuracy from eroding into plausible-looking invention.
    const d = doc();
    const { romSource: _omitted, ...withoutSource } = d.joints[0]!.dofs[0]!;
    d.joints[0]!.dofs = [withoutSource as (typeof d.joints)[0]['dofs'][0]];
    expect(validateDocument(d).ok).toBe(false);
  });

  it('rejects a malformed citation key', () => {
    const d = doc();
    d.joints[0]!.dofs[0]!.romSource = { key: 'Wu et al 2002' };
    expect(validateDocument(d).ok).toBe(false);
  });
});

describe('bone tree coherence', () => {
  it('rejects a dangling parent, suggesting the likely cause', () => {
    const d = doc();
    d.bones[1]!.parent = 'pelvic';
    const message = errorsOf(d).join(' ');
    expect(message).toMatch(/names parent 'pelvic', which does not exist/);
    expect(message).toMatch(/side suffix/);
  });

  it('rejects a duplicate bone ID', () => {
    const d = doc();
    d.bones[2]!.id = 'femur_r';
    expect(errorsOf(d).join(' ')).toMatch(/Duplicate bone ID 'femur_r'/);
  });

  it('rejects more than one root', () => {
    const d = doc();
    d.bones[1]!.parent = null;
    expect(errorsOf(d).join(' ')).toMatch(/has 2 roots/);
  });

  it('rejects no root at all', () => {
    const d = doc();
    d.bones[0]!.parent = 'tibia_r';
    const message = errorsOf(d).join(' ');
    expect(message).toMatch(/cycle|No root bone/);
  });

  it('detects a cycle and prints the path', () => {
    const d = doc();
    d.bones[0]!.parent = 'tibia_r';
    const message = errorsOf(d).join(' ');
    expect(message).toMatch(/cycle: /);
    expect(message).toMatch(/pelvis/);
  });
});

const frameSource = provisional(
  'wu2002',
  'OQ-000',
  'Test fixture only. Not a real frame definition.',
);

describe('landmark and frame coherence', () => {
  it('rejects a landmark on a bone that does not exist', () => {
    const d = doc();
    d.landmarks[0]!.bone = 'fibula_r';
    expect(errorsOf(d).join(' ')).toMatch(/sits on bone 'fibula_r', which does not exist/);
  });

  it('rejects a frame referencing a missing landmark', () => {
    const d = doc();
    d.bones[1]!.frame = {
      origin: 'femur_r__hip_centre',
      primaryFrom: 'femur_r__knee_centre',
      primaryTo: 'femur_r__hip_centre',
      primaryAxis: 'y',
      secondaryFrom: 'femur_r__epicondyle_medial',
      secondaryTo: 'femur_r__nonexistent',
      secondaryAxis: 'x',
      source: frameSource,
    };
    expect(errorsOf(d).join(' ')).toMatch(/frame from landmark 'femur_r__nonexistent'/);
  });

  it('accepts a well-formed frame', () => {
    const d = doc();
    d.bones[1]!.frame = {
      origin: 'femur_r__knee_centre',
      primaryFrom: 'femur_r__knee_centre',
      primaryTo: 'femur_r__hip_centre',
      primaryAxis: 'y',
      secondaryFrom: 'femur_r__epicondyle_medial',
      secondaryTo: 'femur_r__epicondyle_lateral',
      secondaryAxis: 'x',
      source: frameSource,
    };
    expect(validateDocument(d).ok).toBe(true);
  });

  it('rejects a frame whose primary axis has coincident endpoints', () => {
    const d = doc();
    d.bones[1]!.frame = {
      origin: 'femur_r__knee_centre',
      primaryFrom: 'femur_r__knee_centre',
      primaryTo: 'femur_r__knee_centre',
      primaryAxis: 'y',
      secondaryFrom: 'femur_r__epicondyle_medial',
      secondaryTo: 'femur_r__epicondyle_lateral',
      secondaryAxis: 'x',
      source: frameSource,
    };
    expect(errorsOf(d).join(' ')).toMatch(/same landmark for both ends of its primary axis/);
  });

  it('warns, without failing, on a landmark with no cited source', () => {
    // Provisional landmarks are legal and tracked -- the fixture is entirely provisional -- but
    // they must be visible, because landmarks propagate into every joint definition.
    const result = validateDocument(doc());
    expect(result.ok).toBe(true);
    expect(
      result.issues.some((i) => i.severity === 'warning' && /open question/.test(i.message)),
    ).toBe(true);
  });
});

describe('segmentation coherence', () => {
  it('requires every bone to be assigned in every profile', () => {
    // This is the check that enforces ADR-001: anatomy is complete at every fidelity level.
    const d = doc();
    d.segmentation[1]!.segments.splice(2, 1);
    const message = errorsOf(d).join(' ');
    expect(message).toMatch(/does not assign 1 bone\(s\)/);
    expect(message).toMatch(/tibia_r/);
    expect(message).toMatch(/anatomical layer is always complete/);
  });

  it('rejects a bone owned by two segments', () => {
    const d = doc();
    d.segmentation[1]!.segments[1]!.bones = ['femur_r', 'tibia_r'];
    expect(errorsOf(d).join(' ')).toMatch(/is owned by both 'thigh_r' and 'shank_r'/);
  });

  it('rejects an anchor that the segment does not own', () => {
    const d = doc();
    d.segmentation[0]!.segments[0]!.anchor = 'femur_r';
    expect(errorsOf(d).join(' ')).toMatch(/not in its bone list/);
  });

  it('rejects a segment listing the same bone twice', () => {
    const d = doc();
    d.segmentation[0]!.segments[1]!.bones = ['femur_r', 'femur_r', 'tibia_r'];
    expect(errorsOf(d).join(' ')).toMatch(/lists the same bone more than once/);
  });

  it('rejects activating a joint that does not exist', () => {
    const d = doc();
    d.segmentation[1]!.joints = ['hip_r'];
    expect(errorsOf(d).join(' ')).toMatch(/activates joint 'hip_r', which does not exist/);
  });

  it('requires every profile to state its limitations', () => {
    // Spec section 12: a fidelity control that only shows a quality label lets a user believe
    // they are measuring something they are not.
    const d = doc();
    d.segmentation[0]!.limitations = [];
    expect(validateDocument(d).ok).toBe(false);
  });
});

describe('constraint coherence', () => {
  it('rejects a reference to a missing joint', () => {
    const d = doc();
    d.constraints = [
      {
        id: 'coupling',
        kind: {
          type: 'jointCoupling',
          dependent: { joint: 'l4_l5', dof: 0 },
          drivers: [{ dof: { joint: 'knee_r', dof: 0 }, coefficient: 0.5 }],
        },
      },
    ];
    expect(errorsOf(d).join(' ')).toMatch(/references joint 'l4_l5', which does not exist/);
  });

  it('rejects an out-of-range DoF index, noting indices are zero-based', () => {
    const d = doc();
    d.constraints = [
      {
        id: 'coupling',
        kind: {
          type: 'jointCoupling',
          dependent: { joint: 'knee_r', dof: 3 },
          drivers: [{ dof: { joint: 'knee_r', dof: 0 }, coefficient: 0.5 }],
        },
      },
    ];
    const message = errorsOf(d).join(' ');
    expect(message).toMatch(/DoF index 3 of joint 'knee_r', which has only 1 DoF/);
    expect(message).toMatch(/zero-based/);
  });
});

describe('contact rule coherence', () => {
  it('rejects an assignment naming an undefined class', () => {
    const d = doc();
    d.contactRules.assign = [{ pair: ['pelvis', 'leg_r'], class: 'bone_on_bone' }];
    const message = errorsOf(d).join(' ');
    expect(message).toMatch(/names class 'bone_on_bone', which is not defined/);
    expect(message).toMatch(/Defined classes: bone_on_ground/);
  });

  it('rejects an undefined default class', () => {
    const d = doc();
    d.contactRules.defaultClass = 'nonexistent';
    expect(errorsOf(d).join(' ')).toMatch(/Default contact class 'nonexistent' is not defined/);
  });
});

describe('assertValidDocument', () => {
  it('throws an aggregate error listing every problem with its path', () => {
    const d = doc();
    d.bones[1]!.parent = 'nope';
    d.landmarks[0]!.bone = 'also_nope';
    expect(() => assertValidDocument(d)).toThrow(/HSDL document is invalid/);
    expect(() => assertValidDocument(d)).toThrow(/nope/);
    expect(() => assertValidDocument(d)).toThrow(/also_nope/);
  });
});
