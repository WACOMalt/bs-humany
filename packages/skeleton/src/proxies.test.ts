import { resolveMorphology } from '@bs-humany/anthropometry';
import { evaluate, validateDocument } from '@bs-humany/hsdl';
import { describe, expect, it } from 'vitest';
import { DATASET_MANIFEST, buildDocument } from './document.js';
import {
  CAPSULE_ASPECT,
  type ExclusionProvenance,
  PROXY_NS,
  type ProxyProvenance,
} from './proxies.js';

const document = buildDocument();
const proxies = new Map(document.collisionProxies.map((p) => [p.id, p]));
const context = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 }).context;
const provenance = (id: string) => proxies.get(id)?.ext?.[PROXY_NS] as ProxyProvenance | undefined;

describe('collision proxies', () => {
  it('validate as part of the document', () => {
    const result = validateDocument(document);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('give every segment of every profile exactly one proxy', () => {
    for (const profile of document.segmentation) {
      for (const segment of profile.segments) {
        expect(segment.proxies, `${profile.id}/${segment.id}`).toHaveLength(1);
        expect(proxies.has(segment.proxies?.[0] ?? ''), segment.id).toBe(true);
      }
    }
  });

  it('share a proxy between profiles whose segment owns the same bones, and not otherwise', () => {
    expect(proxies.has('proxy_thigh_r')).toBe(true);
    expect(provenance('proxy_thigh_r')?.profiles).toEqual(['l0_ragdoll', 'l1_standard']);
    // L2 drops the patella from the thigh, so it gets its own fit.
    expect(proxies.has('proxy_thigh_r_l2_biomechanical')).toBe(true);
    // L0's foot has the toes; L1's does not.
    expect(provenance('proxy_foot_r')?.profiles).toEqual(['l0_ragdoll']);
    expect(provenance('proxy_foot_r_l1_standard')?.profiles).toEqual(['l1_standard']);
  });

  it('fit capsules to limbs and boxes to the trunk, hands and feet', () => {
    for (const id of ['proxy_thigh_r', 'proxy_shank_l', 'proxy_upperarm_r', 'proxy_ulna_l']) {
      expect(proxies.get(id)?.shape.kind, id).toBe('capsule');
    }
    for (const id of ['proxy_pelvis', 'proxy_trunk', 'proxy_hand_r', 'proxy_foot_r']) {
      expect(proxies.get(id)?.shape.kind, id).toBe('box');
    }
    expect(provenance('proxy_thigh_r')?.rule).toMatch(`>= ${CAPSULE_ASPECT}`);
  });

  it('size the thigh capsule to the femur: roughly 40 cm long and a few cm thick', () => {
    const shape = proxies.get('proxy_thigh_r')?.shape;
    if (shape?.kind !== 'capsule') throw new Error('expected a capsule');
    const radius = evaluate(shape.radius, context);
    const length = evaluate(shape.length, context);
    expect(radius).toBeGreaterThan(0.03);
    expect(radius).toBeLessThan(0.08);
    expect(length + 2 * radius).toBeGreaterThan(0.38);
    expect(length + 2 * radius).toBeLessThan(0.5);
  });

  it('scale with stature', () => {
    const tall = resolveMorphology({ sex: 0.5, stature: 1.9, mass: 80 }).context;
    const shape = proxies.get('proxy_pelvis')?.shape;
    if (shape?.kind !== 'box') throw new Error('expected a box');
    expect(
      evaluate(shape.halfExtents.x, tall) / evaluate(shape.halfExtents.x, context),
    ).toBeCloseTo(1.9 / 1.7, 10);
    const t = proxies.get('proxy_thigh_r')?.transform.translation;
    if (!t) throw new Error('missing transform');
    expect(evaluate(t.y, tall) / evaluate(t.y, context)).toBeCloseTo(1.9 / 1.7, 10);
  });

  it('mirror left and right within a few millimetres', () => {
    for (const base of ['thigh', 'shank', 'upperarm', 'hand', 'foot']) {
      const r = provenance(`proxy_${base}_r`);
      const l = provenance(`proxy_${base}_l`);
      if (!r || !l) throw new Error(base);
      const ext = (p: ProxyProvenance, i: number) => (p.max[i] ?? 0) - (p.min[i] ?? 0);
      for (let i = 0; i < 3; i++) expect(Math.abs(ext(r, i) - ext(l, i)), base).toBeLessThan(0.006);
    }
  });

  it('record what each proxy was fitted to', () => {
    const p = provenance('proxy_shank_r');
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

  it("find the ulna's distal end inside the hand box in L1", () => {
    expect(exclude.some(([a, b]) => a === 'hand_r' && b === 'ulna_r')).toBe(true);
  });

  it('leave the two thighs free to collide', () => {
    expect(exclude.some(([a, b]) => a === 'thigh_l' && b === 'thigh_r')).toBe(false);
  });
});
