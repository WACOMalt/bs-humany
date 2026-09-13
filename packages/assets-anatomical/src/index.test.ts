import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { attributionText, loadSkeletonAssetsFromDisk, parseSkeletonAssets } from './index.js';

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
