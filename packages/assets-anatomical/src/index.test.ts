import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  attributionText,
  loadSkeletonAssetsFromDisk,
  packFiles,
  parseSkeletonAssets,
} from './index.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '../data');
const assets = await loadSkeletonAssetsFromDisk(DATA);

describe('the packed skeleton', () => {
  it('carries every bone except the six ossicles held back on OQ-004', () => {
    expect(assets.bones.size).toBe(200);
    for (const id of ['malleus_l', 'incus_r', 'stapes_l']) expect(assets.bones.has(id)).toBe(false);
    for (const id of ['femur_r', 'vertebra_c1', 'sternum', 'phalanx_pedis_distal_5_l', 'hyoid']) {
      expect(assets.bones.has(id), id).toBe(true);
    }
  });

  it('describes a subject of plausible stature standing on y = 0', () => {
    expect(assets.manifest.subjectStature).toBeGreaterThan(1.55);
    expect(assets.manifest.subjectStature).toBeLessThan(1.85);
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const b of assets.bones.values()) {
      minY = Math.min(minY, b.min[1]);
      maxY = Math.max(maxY, b.max[1]);
    }
    expect(minY).toBeCloseTo(0, 6);
    expect(maxY).toBeCloseTo(assets.manifest.subjectStature, 6);
  });

  it('has finite positions and in-range indices for every bone', () => {
    for (const b of assets.bones.values()) {
      for (const v of b.positions) expect(Number.isFinite(v), b.id).toBe(true);
      const count = b.positions.length / 3;
      for (const i of b.indices) expect(i, b.id).toBeLessThan(count);
      expect(b.indices.length % 3, b.id).toBe(0);
    }
  });

  it('places right-side bones at +X and left-side at -X, in the canonical frame', () => {
    // The FBX has +X left and +Z anterior. If the frame conversion were dropped, this would fail.
    expect(assets.bones.get('femur_r')?.centroid[0] ?? 0).toBeGreaterThan(0);
    expect(assets.bones.get('femur_l')?.centroid[0] ?? 0).toBeLessThan(0);
    // Sternum anterior of the sacrum: anterior is -Z in world.
    expect(assets.bones.get('sternum')?.centroid[2] ?? 0).toBeLessThan(
      assets.bones.get('sacrum')?.centroid[2] ?? 0,
    );
  });

  it('stacks the joint centres in anatomical order', () => {
    const y = (id: string) => assets.bones.get(id)?.centroid[1] ?? Number.NaN;
    expect(y('talus_r')).toBeLessThan(y('tibia_r'));
    expect(y('tibia_r')).toBeLessThan(y('femur_r'));
    expect(y('femur_r')).toBeLessThan(y('hip_r'));
    expect(y('sacrum')).toBeLessThan(y('vertebra_t1'));
    expect(y('vertebra_t1')).toBeLessThan(y('vertebra_c1'));
    expect(y('vertebra_c1')).toBeLessThan(y('frontal'));
  });

  it('carries named landmarks, including the ISB knee and hip landmarks on the femur', () => {
    const femur = assets.landmarks.femur_r ?? {};
    for (const name of [
      'Medial_epicondyle_of_femur',
      'Lateral_epicondyle_of_femur',
      'Greater_trochanter',
      'Head_of_femur',
    ]) {
      expect(femur[name], name).toBeDefined();
    }
    // Landmarks sit near their bone, not at the origin.
    const c = assets.bones.get('femur_r')?.centroid ?? [0, 0, 0];
    const gt = femur.Greater_trochanter ?? [0, 0, 0];
    expect(Math.hypot(gt[0] - c[0], gt[1] - c[1], gt[2] - c[2])).toBeLessThan(0.4);
  });

  it('exposes the attribution the licence requires', () => {
    const text = attributionText(assets.manifest);
    expect(text).toMatch(/BodyParts3D/);
    expect(text).toMatch(/Z-Anatomy/);
    expect(text).toMatch(/CC-BY-SA/);
  });

  it('refuses a buffer that does not match its manifest', () => {
    expect(() => parseSkeletonAssets(assets.manifest, new ArrayBuffer(16))).toThrow(
      /different ingestion runs/,
    );
  });
});

describe('the hull table', () => {
  const hulls = JSON.parse(readFileSync(join(DATA, 'hulls.json'), 'utf8')) as {
    format: string;
    dataset: unknown;
    parameters: { maxVertices: number; hullsPerBone: number; maxHullsPerGroup: number };
    subjectStature: number;
    groups: {
      key: string;
      anchor: string;
      bones: string[];
      segments: string[];
      maxHulls: number;
      hulls: number[][];
    }[];
  };

  it('is the format the skeleton package reads, at the pack stature, with the licence', () => {
    expect(hulls.format).toBe('bs-humany.skeleton-hulls/1');
    expect(hulls.dataset).toEqual(assets.manifest.dataset);
    expect(hulls.subjectStature).toBe(assets.manifest.subjectStature);
    expect(hulls.groups.length).toBeGreaterThan(100);
  });

  it('names only packed bones and keys each group by anchor and sorted bone set', () => {
    for (const g of hulls.groups) {
      expect(assets.bones.has(g.anchor), g.key).toBe(true);
      for (const b of g.bones) expect(assets.bones.has(b), b).toBe(true);
      expect(g.key).toBe(`${g.anchor}|${[...g.bones].sort().join(',')}`);
      expect(g.segments.length).toBeGreaterThan(0);
    }
  });

  it("keeps every piece within budget and every vertex inside the bones' bounds", () => {
    const { maxVertices, hullsPerBone, maxHullsPerGroup } = hulls.parameters;
    for (const g of hulls.groups) {
      expect(g.hulls.length, g.key).toBeGreaterThan(0);
      expect(g.hulls.length, g.key).toBeLessThanOrEqual(g.maxHulls);
      expect(g.maxHulls, g.key).toBeLessThanOrEqual(
        Math.min(maxHullsPerGroup, hullsPerBone * g.bones.length),
      );
      const anchor = assets.bones.get(g.anchor);
      if (!anchor) throw new Error(g.anchor);
      const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
      const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
      for (const b of g.bones) {
        const bone = assets.bones.get(b);
        if (!bone) throw new Error(b);
        for (let i = 0; i < 3; i++) {
          min[i] = Math.min(min[i] ?? 0, bone.min[i] ?? 0);
          max[i] = Math.max(max[i] ?? 0, bone.max[i] ?? 0);
        }
      }
      // A hull of a mesh cannot leave the mesh's box; the slack is the rounding of the table
      // plus the voxel grid CoACD's manifold preprocessing works on (a hundredth of the
      // group's extent, so about a millimetre on a rib cage).
      const slack = 0.003;
      for (const hull of g.hulls) {
        expect(hull.length % 3, g.key).toBe(0);
        expect(hull.length / 3, g.key).toBeGreaterThanOrEqual(4);
        expect(hull.length / 3, g.key).toBeLessThanOrEqual(maxVertices);
        for (let i = 0; i < hull.length; i += 3) {
          for (let a = 0; a < 3; a++) {
            const w = (hull[i + a] ?? 0) + (anchor.centroid[a] ?? 0);
            expect(w, `${g.key} axis ${a}`).toBeGreaterThan((min[a] ?? 0) - slack);
            expect(w, `${g.key} axis ${a}`).toBeLessThan((max[a] ?? 0) + slack);
          }
        }
      }
    }
  });
});

describe('the decimated level of detail', () => {
  it('is the same pack with a quarter of the triangles and the same placement', async () => {
    const lod = await loadSkeletonAssetsFromDisk(DATA, 'lod1');
    expect(packFiles('lod1')).toEqual({ manifest: 'manifest-lod1.json', bin: 'skeleton-lod1.bin' });
    expect(lod.manifest.lod?.name).toBe('lod1');
    expect(lod.manifest.subjectStature).toBe(assets.manifest.subjectStature);
    expect(lod.bones.size).toBe(assets.bones.size);
    const ratio = lod.manifest.totals.triangles / assets.manifest.totals.triangles;
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.3);
    for (const [id, full] of assets.bones) {
      const small = lod.bones.get(id);
      if (!small) throw new Error(id);
      expect(small.centroid).toEqual(full.centroid);
      expect(small.min).toEqual(full.min);
      expect(small.indices.length).toBeLessThanOrEqual(full.indices.length);
      const count = small.positions.length / 3;
      for (const i of small.indices) expect(i, id).toBeLessThan(count);
    }
  });
});
