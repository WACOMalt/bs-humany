import { resolveMorphology } from '@bs-humany/anthropometry';
import { evaluate, validateDocument } from '@bs-humany/hsdl';
import { describe, expect, it } from 'vitest';
import { DATASET_MANIFEST, buildDocument } from './document.js';
import { type ExclusionProvenance, PROXY_NS, type ProxyProvenance } from './proxies.js';

const document = buildDocument();
const proxies = new Map(document.collisionProxies.map((p) => [p.id, p]));
const context = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 }).context;
const provenance = (id: string) => proxies.get(id)?.ext?.[PROXY_NS] as ProxyProvenance | undefined;

describe('collision proxies', () => {
  it('validate as part of the document', () => {
    const result = validateDocument(document);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('give every segment of every profile at least one proxy, all of them hull pieces', () => {
    for (const profile of document.segmentation) {
      for (const segment of profile.segments) {
        const ids = segment.proxies ?? [];
        expect(ids.length, `${profile.id}/${segment.id}`).toBeGreaterThan(0);
        for (const id of ids) {
          const p = proxies.get(id);
          expect(p?.shape.kind, id).toBe('convexHull');
          expect(provenance(id)?.hull?.count, id).toBe(ids.length);
          expect(provenance(id)?.rule, id).not.toMatch(/fallback/);
        }
      }
    }
  });

  it('share proxies between profiles whose segment owns the same bones, and not otherwise', () => {
    expect(proxies.has('proxy_thigh_r_hull1')).toBe(true);
    expect(provenance('proxy_thigh_r_hull1')?.profiles).toEqual(['l0_ragdoll', 'l1_standard']);
    // L2 drops the patella from the thigh, so it gets its own decomposition.
    expect(proxies.has('proxy_thigh_r_l2_biomechanical_hull1')).toBe(true);
    // L0's foot has the toes; L1's does not.
    expect(provenance('proxy_foot_r_hull1')?.profiles).toEqual(['l0_ragdoll']);
    expect(provenance('proxy_foot_r_l1_standard_hull1')?.profiles).toEqual(['l1_standard']);
  });

  it('keep every piece within budget: at most three per bone, twelve per segment', () => {
    for (const profile of document.segmentation) {
      for (const segment of profile.segments) {
        const count = segment.proxies?.length ?? 0;
        expect(count, segment.id).toBeLessThanOrEqual(Math.min(12, 3 * segment.bones.length));
        for (const id of segment.proxies ?? []) {
          const shape = proxies.get(id)?.shape;
          if (shape?.kind !== 'convexHull') throw new Error(id);
          expect(shape.vertices.length, id).toBeGreaterThanOrEqual(4);
          expect(shape.vertices.length, id).toBeLessThanOrEqual(48);
        }
      }
    }
  });

  it('cover the femur: the thigh pieces together span roughly 40 cm', () => {
    const ids = document.segmentation
      .find((p) => p.id === 'l1_standard')
      ?.segments.find((s) => s.id === 'thigh_r')?.proxies;
    if (!ids) throw new Error('no thigh proxies');
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const id of ids) {
      const shape = proxies.get(id)?.shape;
      if (shape?.kind !== 'convexHull') throw new Error(id);
      const s = evaluate(shape.scale ?? 1, context);
      for (const v of shape.vertices) {
        lo = Math.min(lo, v.y * s);
        hi = Math.max(hi, v.y * s);
      }
    }
    expect(hi - lo).toBeGreaterThan(0.38);
    expect(hi - lo).toBeLessThan(0.5);
  });

  it('scale with stature', () => {
    const tall = resolveMorphology({ sex: 0.5, stature: 1.9, mass: 80 }).context;
    const shape = proxies.get('proxy_pelvis_hull1')?.shape;
    if (shape?.kind !== 'convexHull') throw new Error('expected a hull');
    expect(evaluate(shape.scale ?? 1, tall) / evaluate(shape.scale ?? 1, context)).toBeCloseTo(
      1.9 / 1.7,
      10,
    );
  });

  it('mirror left and right within a few millimetres', () => {
    for (const base of ['thigh', 'shank', 'upperarm', 'hand', 'foot']) {
      const r = provenance(`proxy_${base}_r_hull1`);
      const l = provenance(`proxy_${base}_l_hull1`);
      if (!r || !l) throw new Error(base);
      const ext = (p: ProxyProvenance, i: number) => (p.max[i] ?? 0) - (p.min[i] ?? 0);
      for (let i = 0; i < 3; i++) expect(Math.abs(ext(r, i) - ext(l, i)), base).toBeLessThan(0.006);
    }
  });

  it('record what each proxy was fitted to', () => {
    const p = provenance('proxy_shank_r_hull1');
    expect(p?.bones).toEqual(['tibia_r', 'fibula_r']);
    expect(p?.segment).toBe('shank_r');
    expect(p?.max[1]).toBeGreaterThan(p?.min[1] ?? 0);
    expect(p?.min[1]).toBeLessThan(DATASET_MANIFEST.subjectStature / 2);
  });
});

describe('default exclusion pairs', () => {
  const exclude = document.contactRules.exclude ?? [];
  const exclusions = (
    document.contactRules.ext?.[PROXY_NS] as { exclusions: ExclusionProvenance[] }
  ).exclusions;

  it('are recorded with the profiles and overlap that produced them', () => {
    expect(exclusions.length).toBe(exclude.length);
    for (const e of exclusions) {
      expect(e.overlap).toBeGreaterThan(0);
      expect(e.profiles.length).toBeGreaterThan(0);
    }
  });

  it('never name a joined pair, which the compiler excludes on its own', () => {
    const joints = new Map(document.joints.map((j) => [j.id, j]));
    for (const profile of document.segmentation) {
      const segmentOf = new Map<string, string>();
      for (const s of profile.segments) for (const b of s.bones) segmentOf.set(b, s.id);
      const joined = new Set<string>();
      for (const id of profile.joints ?? []) {
        const j = joints.get(id);
        if (!j) throw new Error(id);
        joined.add([segmentOf.get(j.parentBone), segmentOf.get(j.childBone)].sort().join('|'));
      }
      for (const e of exclusions.filter((x) => x.profiles.includes(profile.id))) {
        expect(joined.has([...e.pair].sort().join('|')), e.pair.join('/')).toBe(false);
      }
    }
  });

  it("find the ulna's distal end inside the hand's bounds in L1", () => {
    expect(exclude.some(([a, b]) => a === 'hand_r' && b === 'ulna_r')).toBe(true);
  });

  it('leave the two thighs free to collide', () => {
    expect(exclude.some(([a, b]) => a === 'thigh_l' && b === 'thigh_r')).toBe(false);
  });
});
