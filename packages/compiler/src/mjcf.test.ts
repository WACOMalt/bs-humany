import { resolveMorphology } from '@bs-humany/anthropometry';
import { approxEqualsTransform } from '@bs-humany/frames';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { compileArticulation } from './compile.js';
import { childRestFromMjcf, emitMjcf } from './mjcf.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l1_standard', morphology);
const result = emitMjcf(articulation, { ground: { height: 0 } });

describe('MJCF emitter', () => {
  it('emits one body per segment nested under joint-frame bodies, and one joint per DoF', () => {
    const bodies = result.xml.match(/<body /g)?.length ?? 0;
    expect(bodies).toBe(articulation.segments.length + articulation.joints.length);
    expect(result.xml.match(/<joint name="[^"]*" type=/g)?.length ?? 0).toBe(
      articulation.dofs.length,
    );
    expect(result.xml.match(/<freejoint/g)?.length).toBe(1);
    expect(result.jointNames.length).toBe(articulation.dofs.length);
    expect(result.jointNames[0]).toMatch(/^lumbar_region_lower\//);
  });

  it('is well-formed enough for a strict parser: every tag closes and quotes balance', () => {
    const opens =
      result.xml.match(/<(body|mujoco|worldbody|default|contact)\b[^/]*?>/g)?.length ?? 0;
    const closes = result.xml.match(/<\/(body|mujoco|worldbody|default|contact)>/g)?.length ?? 0;
    expect(opens).toBe(closes);
    expect((result.xml.match(/"/g)?.length ?? 0) % 2).toBe(0);
    expect(result.xml).toContain('<compiler angle="radian"');
    expect(result.xml).toContain('type="plane"');
  });

  it('reproduces every segment rest pose through the joint-frame nesting', () => {
    for (const joint of articulation.joints) {
      const parent = articulation.segments[joint.parentSegment];
      const child = articulation.segments[joint.childSegment];
      if (!parent || !child) throw new Error('missing');
      expect(
        approxEqualsTransform(childRestFromMjcf(parent.restWorld, joint), child.restWorld, 1e-9),
        joint.id,
      ).toBe(true);
    }
  });

  it('carries ranges, exclusions, inertia and contact classes', () => {
    expect(result.xml).toContain('range="0 2.0944"');
    expect(result.xml).toMatch(/<exclude body1="(hand_r|ulna_r)" body2="(ulna_r|hand_r)"\/>/);
    expect(result.xml).toContain('fullinertia=');
    expect(result.xml).toContain('class="bone_on_ground"');
    expect(result.xml).toContain('type="capsule"');
  });

  it('is deterministic and says what it could not express', () => {
    expect(emitMjcf(articulation, { ground: { height: 0 } }).xml).toBe(result.xml);
    expect(result.notes.every((n) => n.severity !== 'error')).toBe(true);
  });
});
