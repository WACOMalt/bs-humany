import { resolveMorphology } from '@bs-humany/anthropometry';
import { compileArticulation } from '@bs-humany/compiler';
import { ELBOW_MUSCLES } from '@bs-humany/muscle-data';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { articulationBoneResolver, compileMuscleSet } from './compile.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const L3 = compileArticulation(document, 'l3_anatomical', morphology).articulation;
const L1 = compileArticulation(document, 'l1_standard', morphology).articulation;

const set = (articulation = L3) =>
  compileMuscleSet(ELBOW_MUSCLES, document.attachmentSites, articulation, morphology.context);

describe('the bone resolver', () => {
  it('maps every bone a segment owns to that segment', () => {
    const resolver = articulationBoneResolver(L3);
    for (const segment of L3.segments) {
      for (const bone of segment.bones) {
        expect(resolver.bodyOf(bone), bone).toBe(segment.index);
      }
    }
  });

  it('says so rather than guessing when it has never heard of a bone', () => {
    expect(articulationBoneResolver(L3).bodyOf('fibula_of_the_third_leg')).toBe(-1);
  });

  it('leaves an anchor bone’s points alone, because the anchor is the segment frame', () => {
    const resolver = articulationBoneResolver(L3);
    const anchor = L3.segments[1]?.anchor as string;
    const point = { x: 0.11, y: -0.22, z: 0.33 };
    expect(resolver.toBodyLocal(anchor, point)).toEqual(point);
  });

  it('carries a follower bone’s points through its owning segment’s transform', () => {
    // The whole reason bone ids are the stable interface: at a coarse profile a bone is not its
    // own body, and a muscle authored against that bone still has to land somewhere sensible.
    const segment = L1.segments.find((s) => s.followers.length > 0);
    const follower = segment?.followers[0];
    if (!segment || !follower) throw new Error('no follower bone at l1_standard to test with');
    const resolver = articulationBoneResolver(L1);
    expect(resolver.bodyOf(follower.bone)).toBe(segment.index);
    // The bone's own origin lands at the follower's translation within the segment.
    const origin = resolver.toBodyLocal(follower.bone, { x: 0, y: 0, z: 0 });
    expect(origin.x).toBeCloseTo(follower.local.translation.x, 12);
    expect(origin.y).toBeCloseTo(follower.local.translation.y, 12);
    expect(origin.z).toBeCloseTo(follower.local.translation.z, 12);
  });

  it('preserves distance, because a follower transform is a rigid motion', () => {
    const segment = L1.segments.find((s) => s.followers.length > 0);
    const follower = segment?.followers[0];
    if (!segment || !follower) throw new Error('no follower bone at l1_standard to test with');
    const resolver = articulationBoneResolver(L1);
    const a = resolver.toBodyLocal(follower.bone, { x: 0.05, y: 0, z: 0 });
    const b = resolver.toBodyLocal(follower.bone, { x: 0, y: 0.05, z: 0 });
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeCloseTo(Math.hypot(0.05, 0.05), 12);
  });
});

describe('compiling a muscle set', () => {
  it('resolves every elbow unit against the L3 skeleton', () => {
    const compiled = set();
    expect(compiled.units).toHaveLength(7);
    expect(compiled.paths).toHaveLength(7);
    expect(compiled.units.map((u) => u.id)).toEqual(compiled.paths.map((p) => p.id));
  });

  it('turns the site expressions into metres at this morphology', () => {
    // Attachment site coordinates are expressions in stature, because the skeleton is parametric.
    // Evaluating them here is what makes a muscle scale with the body for free.
    const compiled = set();
    for (const path of compiled.paths) {
      for (const point of [path.origin.point, path.insertion.point]) {
        expect(Number.isFinite(point.x), path.id).toBe(true);
        // A point on a 1.7 m skeleton, in its own bone's frame, is within arm's reach of it.
        expect(Math.hypot(point.x, point.y, point.z), path.id).toBeLessThan(1);
      }
    }
  });

  it('scales with stature, which is the point of keeping the expressions', () => {
    const tall = resolveMorphology({ sex: 0.5, stature: 2.0, mass: 90 });
    const short = resolveMorphology({ sex: 0.5, stature: 1.5, mass: 55 });
    const reach = (context: typeof morphology.context) => {
      const compiled = compileMuscleSet(ELBOW_MUSCLES, document.attachmentSites, L3, context);
      const p = compiled.paths[0]?.origin.point;
      if (!p) throw new Error('no path');
      return Math.hypot(p.x, p.y, p.z);
    };
    expect(reach(tall.context)).toBeGreaterThan(reach(short.context));
    // Linearly, since the sites are a fraction of stature.
    expect(reach(tall.context) / reach(short.context)).toBeCloseTo(2.0 / 1.5, 6);
  });

  it('falls back to the module’s cited defaults where a unit states none', () => {
    const compiled = set();
    for (const unit of compiled.units) {
      expect(unit.parameters.damping, unit.id).toBe(0.1);
      expect(unit.activationTime, unit.id).toBe(0.01);
      expect(unit.deactivationTime, unit.id).toBe(0.04);
      // This one the data does state, and it agrees with the default.
      expect(unit.parameters.maxContractionVelocity, unit.id).toBe(10);
    }
  });

  it('works at a coarse profile too, where the bones are not their own bodies', () => {
    // The same muscle data, a different fidelity profile, no re-authoring. At l1_standard the
    // forearm bones are followers of one segment, so both biceps heads now insert on a body that
    // also owns the ulna -- which is exactly what a coarse profile means.
    const compiled = set(L1);
    expect(compiled.units).toHaveLength(7);
    const resolver = compiled.resolver;
    for (const path of compiled.paths) {
      expect(resolver.bodyOf(path.origin.bone), path.id).toBeGreaterThanOrEqual(0);
      expect(resolver.bodyOf(path.insertion.bone), path.id).toBeGreaterThanOrEqual(0);
    }
  });

  it('names the muscle when a site is missing, rather than failing somewhere downstream', () => {
    expect(() => compileMuscleSet(ELBOW_MUSCLES, [], L3, morphology.context)).toThrow(
      /biceps_brachii_long_r/,
    );
  });
});
