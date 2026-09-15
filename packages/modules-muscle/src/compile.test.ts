import { resolveMorphology } from '@bs-humany/anthropometry';
import { compileArticulation } from '@bs-humany/compiler';
import { cite } from '@bs-humany/hsdl';
import type { WrappingSurfaceDef } from '@bs-humany/hsdl';
import { ELBOW_MUSCLES } from '@bs-humany/muscle-data';
import type { MuscleGroup } from '@bs-humany/muscle-data';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { articulationBoneResolver, compileMuscleSet, wrapSurfaceId } from './compile.js';

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

  it('builds no wrap surfaces for a set that declares none', () => {
    expect(set().surfaces).toEqual([]);
  });
});

/**
 * The elbow set has no wrap surfaces yet (OQ-015), so these exercise the compile step against a
 * pair of muscles authored here. They are not anatomy and are not claimed to be -- what is being
 * tested is that a shared surface becomes one copy per muscle, carrying that muscle's own side.
 */
describe('compiling wrap surfaces', () => {
  const source = cite('caggiano2022', 'test fixture');

  const TROCHLEA: WrappingSurfaceDef = {
    id: 'trochlea_r',
    bone: 'humerus_r',
    displayName: 'Distal humerus, trochlea',
    transform: {
      translation: { x: 0, y: -0.28, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    },
    shape: { kind: 'cylinder', radius: 0.018, length: 0.05 },
    source,
  };

  const BALL: WrappingSurfaceDef = {
    ...TROCHLEA,
    id: 'capitulum_r',
    shape: { kind: 'sphere', radius: 0.011 },
  };

  /** Two muscles over one surface, on opposite sides of it. */
  const GROUP: MuscleGroup = {
    id: 'pair_r',
    displayName: 'A flexor and an extensor',
    source,
    units: [
      {
        id: 'flexor_r',
        displayName: 'Flexor',
        origin: 'biceps_brachii_origin_r_supraglenoid_tubercle',
        insertion: 'biceps_brachii_insertion_r_radial_tuberosity',
        path: [
          {
            kind: 'wrap',
            surface: 'trochlea_r',
            preferredSide: { x: 0, y: 0, z: 1 },
            source,
          },
        ],
        parameters: {
          maxIsometricForce: 400,
          optimalFiberLength: 0.12,
          tendonSlackLength: 0.2,
          pennationAngle: 0,
          source,
        },
      },
      {
        id: 'extensor_r',
        displayName: 'Extensor',
        origin: 'triceps_brachii_origin_r_infraglenoid_tubercle',
        insertion: 'triceps_brachii_insertion_r_olecranon',
        path: [
          {
            kind: 'wrap',
            surface: 'trochlea_r',
            preferredSide: { x: 0, y: 0, z: -1 },
            source,
          },
        ],
        parameters: {
          maxIsometricForce: 600,
          optimalFiberLength: 0.1,
          tendonSlackLength: 0.15,
          pennationAngle: 0,
          source,
        },
      },
    ],
  };

  const compiled = () =>
    compileMuscleSet([GROUP], document.attachmentSites, L3, morphology.context, [TROCHLEA, BALL]);

  it('gives each muscle its own copy of a shared surface', () => {
    // One surface in the document, two muscles using it, two solver surfaces out. Sharing one
    // would mean the two muscles shared a side as well, and a flexor and an extensor crossing the
    // same bone are on opposite sides of it by definition.
    const set = compiled();
    expect(set.surfaces).toHaveLength(2);
    expect(set.surfaces.map((s) => s.id)).toEqual([
      wrapSurfaceId('flexor_r', 'trochlea_r'),
      wrapSurfaceId('extensor_r', 'trochlea_r'),
    ]);
    expect(set.surfaces[0]?.preferredSide.z).toBe(1);
    expect(set.surfaces[1]?.preferredSide.z).toBe(-1);
  });

  it('points each path at its own copy, not at the shared id', () => {
    const set = compiled();
    for (const path of set.paths) {
      const wrap = path.elements.find((e) => e.kind === 'wrap');
      expect(wrap?.kind === 'wrap' && wrap.surface, path.id).toBe(
        wrapSurfaceId(path.id, 'trochlea_r'),
      );
    }
  });

  it('builds nothing for a surface no muscle uses', () => {
    // The sphere is declared and unused. A solver handed surfaces nobody wraps would be carrying
    // geometry it never touches.
    const set = compiled();
    expect(set.surfaces.some((s) => s.id.includes('capitulum'))).toBe(false);
  });

  it('halves a cylinder’s length, because the two sides measure it differently', () => {
    // HSDL states the full length, which is how anyone measures a cylinder; the geodesic maths
    // compares against the half-length. Converting in one place keeps both honest.
    const set = compiled();
    expect(set.surfaces[0]?.type).toBe('cylinder');
    expect(set.surfaces[0]?.halfLength).toBeCloseTo(0.025, 12);
    expect(set.surfaces[0]?.radius).toBeCloseTo(0.018, 12);
  });

  it('carries a sphere across with its radius', () => {
    const onlyBall: MuscleGroup = {
      ...GROUP,
      units: [
        {
          ...(GROUP.units[0] as MuscleGroup['units'][number]),
          path: [
            { kind: 'wrap', surface: 'capitulum_r', preferredSide: { x: 0, y: 1, z: 0 }, source },
          ],
        },
      ],
    };
    const set = compileMuscleSet([onlyBall], document.attachmentSites, L3, morphology.context, [
      TROCHLEA,
      BALL,
    ]);
    expect(set.surfaces[0]?.type).toBe('sphere');
    expect(set.surfaces[0]?.radius).toBeCloseTo(0.011, 12);
    expect(set.surfaces[0]?.halfLength).toBeUndefined();
  });

  it('names the muscle when it wraps a surface the document does not define', () => {
    expect(() =>
      compileMuscleSet([GROUP], document.attachmentSites, L3, morphology.context, []),
    ).toThrow(/flexor_r/);
  });

  it('resolves the surface onto the body its bone belongs to', () => {
    const set = compiled();
    for (const surface of set.surfaces) {
      expect(set.resolver.bodyOf(surface.bone), surface.id).toBeGreaterThanOrEqual(0);
    }
  });
});
