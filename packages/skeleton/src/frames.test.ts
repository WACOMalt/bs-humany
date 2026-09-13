import { resolveMorphology } from '@bs-humany/anthropometry';
import {
  type Transform,
  WORLD,
  anatomicalAxis,
  column,
  dot,
  frameAxes,
  isRotation,
  normalize,
  sub,
  vec3,
} from '@bs-humany/frames';
import { validateDocument } from '@bs-humany/hsdl';
import { describe, expect, it } from 'vitest';
import { DATASET_MANIFEST, buildDocument } from './document.js';
import {
  FRAME_SPECS,
  VIRTUAL_LANDMARKS,
  buildFrameDefs,
  computeBoneFrames,
  unframedBones,
  virtualLandmarkWorld,
} from './frames.js';
import { isbLandmarkWorld } from './landmarks.js';

const document = buildDocument();
const atDataset = resolveMorphology({
  sex: 0.5,
  stature: DATASET_MANIFEST.subjectStature,
  mass: 70,
}).context;
const frames = computeBoneFrames(document, atDataset);

const axisOf = (t: Transform, axis: 'x' | 'y' | 'z') =>
  column(frameAxes(t), axis === 'x' ? 0 : axis === 'y' ? 1 : 2);
const RIGHT = anatomicalAxis('right', WORLD);
const ANTERIOR = anatomicalAxis('anterior', WORLD);
const SUPERIOR = anatomicalAxis('superior', WORLD);

describe('frame definitions', () => {
  it('cover both sides of every ISB segment plus the sacrum and thorax', () => {
    const defs = buildFrameDefs();
    for (const id of [
      'hip_r',
      'hip_l',
      'femur_r',
      'femur_l',
      'tibia_r',
      'fibula_l',
      'calcaneus_r',
      'talus_l',
      'clavicle_r',
      'scapula_l',
      'humerus_r',
      'ulna_l',
      'radius_r',
      'sacrum',
      'sternum',
      'rib_7_l',
    ]) {
      expect(defs.has(id), id).toBe(true);
    }
    expect(defs.size).toBe(FRAME_SPECS.length);
  });

  it('reference only landmarks the document carries, so the document validates', () => {
    const result = validateDocument(document);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('leave the unframed bones honest and enumerable', () => {
    const unframed = unframedBones(document);
    expect(unframed).toContain('vertebra_l3');
    expect(unframed).toContain('capitate_r');
    expect(unframed).not.toContain('femur_r');
    // Every framed bone is a dataset bone; the ossicles are unframed.
    expect(unframed).toContain('stapes_l');
  });
});

describe('virtual landmarks', () => {
  it('sit at the midpoint of their two sources', () => {
    for (const v of VIRTUAL_LANDMARKS) {
      const a = isbLandmarkWorld(v.a[0], v.a[1]);
      const b = isbLandmarkWorld(v.b[0], v.b[1]);
      const m = virtualLandmarkWorld(v);
      for (let i = 0 as 0 | 1 | 2; i < 3; i = (i + 1) as 0 | 1 | 2) {
        expect(m[i], `${v.id}[${i}]`).toBeCloseTo((a[i] + b[i]) / 2, 12);
      }
    }
  });

  it('put the inter-malleolar point between the malleoli and below the condyles', () => {
    const im = virtualLandmarkWorld(VIRTUAL_LANDMARKS.find((v) => v.id === 'tibia_r__im') as never);
    const ic = virtualLandmarkWorld(VIRTUAL_LANDMARKS.find((v) => v.id === 'tibia_r__ic') as never);
    expect(im[1]).toBeLessThan(ic[1]);
    expect(ic[1] - im[1]).toBeGreaterThan(0.3);
  });
});

describe('ISB frames at the dataset pose', () => {
  it('are all proper rotations', () => {
    for (const [id, t] of frames) expect(isRotation(frameAxes(t), 1e-9), id).toBe(true);
  });

  it('point Z right, X anterior and Y superior on both sides -- the OQ-006 policy', () => {
    // Every axis must have a clear majority component along its nominal direction. A sign slip in
    // any landmark pair shows up here as a negative dot product.
    for (const [id, t] of frames) {
      expect(dot(axisOf(t, 'z'), RIGHT), `${id} Z should point right`).toBeGreaterThan(0.6);
      expect(dot(axisOf(t, 'x'), ANTERIOR), `${id} X should point anterior`).toBeGreaterThan(0.6);
      expect(dot(axisOf(t, 'y'), SUPERIOR), `${id} Y should point superior`).toBeGreaterThan(0.6);
    }
  });

  it('align the femur, humerus and ulna Y axes with the standing long axes', () => {
    // In the anatomical neutral pose these are close to vertical; the femur's valgus lean is the
    // largest departure.
    for (const id of ['femur_r', 'femur_l', 'humerus_r', 'humerus_l', 'ulna_r', 'ulna_l']) {
      const t = frames.get(id);
      expect(t, id).toBeDefined();
      if (!t) continue;
      expect(dot(axisOf(t, 'y'), SUPERIOR), `${id} Y is not near vertical`).toBeGreaterThan(0.95);
    }
  });

  it('tilt the tibia Y axis by the malleolar inclination, as Wu 2002 3.3 defines it', () => {
    // The ISB tibia/fibula Y is the common perpendicular to Z (the MM-LM line) and X (the normal
    // to the torsional plane), so it lies in the torsional plane, perpendicular to the malleolar
    // axis -- and the lateral malleolus sits lower than the medial one, so Y leans. It is NOT the
    // anatomical long axis, by design. The inclination measured on this subject is recorded in
    // OQ-005 as being at the high end of the published range.
    for (const s of ['r', 'l'] as const) {
      const t = frames.get(`tibia_${s}`);
      expect(t).toBeDefined();
      if (!t) continue;
      const lean = Math.acos(dot(axisOf(t, 'y'), SUPERIOR));
      const deg = ((lean * 180) / Math.PI).toFixed(1);
      expect(lean, `tibia_${s} lean ${deg} deg`).toBeGreaterThan((5 * Math.PI) / 180);
      expect(lean, `tibia_${s} lean ${deg} deg`).toBeLessThan((30 * Math.PI) / 180);
    }
  });

  it('put the femoral Y axis along the mid-epicondyle to hip-centre line, per Wu 2002 4.4', () => {
    const t = frames.get('femur_r');
    expect(t).toBeDefined();
    if (!t) return;
    const hjc = isbLandmarkWorld('femur_r', 'HJC');
    const med = isbLandmarkWorld('femur_r', 'FE_med');
    const lat = isbLandmarkWorld('femur_r', 'FE_lat');
    const mid = vec3((med[0] + lat[0]) / 2, (med[1] + lat[1]) / 2, (med[2] + lat[2]) / 2);
    const expected = normalize(sub(vec3(hjc[0], hjc[1], hjc[2]), mid));
    expect(dot(axisOf(t, 'y'), expected)).toBeCloseTo(1, 6);
    // Origin at the hip joint centre.
    expect(t.translation.x).toBeCloseTo(hjc[0], 9);
    expect(t.translation.y).toBeCloseTo(hjc[1], 9);
  });

  it('put the tibial Z axis along the malleoli, per Wu 2002 3.3', () => {
    const t = frames.get('tibia_r');
    expect(t).toBeDefined();
    if (!t) return;
    const mm = isbLandmarkWorld('tibia_r', 'MM');
    const lm = isbLandmarkWorld('fibula_r', 'LM');
    const expected = normalize(sub(vec3(lm[0], lm[1], lm[2]), vec3(mm[0], mm[1], mm[2])));
    expect(Math.abs(dot(axisOf(t, 'z'), expected))).toBeCloseTo(1, 6);
  });

  it('share one thorax frame across the sternum and every rib', () => {
    const reference = frames.get('sternum');
    expect(reference).toBeDefined();
    if (!reference) return;
    for (let r = 1; r <= 12; r++) {
      for (const s of ['l', 'r']) {
        const t = frames.get(`rib_${r}_${s}`);
        expect(t, `rib_${r}_${s}`).toBeDefined();
        if (!t) continue;
        expect(dot(axisOf(t, 'y'), axisOf(reference, 'y'))).toBeCloseTo(1, 9);
        expect(t.translation.y).toBeCloseTo(reference.translation.y, 9);
      }
    }
  });

  it('mirror left and right, with Z re-oriented to the right on both sides', () => {
    // Under the OQ-006 policy the left frame is the sagittal mirror of the right with Z flipped
    // back to point right: x_l = M x_r, y_l = M y_r, z_l = -M z_r, where M negates X. Comparing
    // axes directly would only work for frames with no medio-lateral lean, and the tibia has one.
    const mirror = (v: { x: number; y: number; z: number }) => vec3(-v.x, v.y, v.z);
    for (const base of [
      'femur',
      'tibia',
      'humerus',
      'ulna',
      'radius',
      'clavicle',
      'scapula',
      'hip',
    ]) {
      const r = frames.get(`${base}_r`);
      const l = frames.get(`${base}_l`);
      expect(r && l, base).toBeTruthy();
      if (!r || !l) continue;
      expect(dot(axisOf(l, 'x'), mirror(axisOf(r, 'x'))), `${base} X`).toBeGreaterThan(0.97);
      expect(dot(axisOf(l, 'y'), mirror(axisOf(r, 'y'))), `${base} Y`).toBeGreaterThan(0.97);
      expect(dot(axisOf(l, 'z'), mirror(axisOf(r, 'z'))), `${base} Z`).toBeLessThan(-0.97);
      expect(Math.abs(r.translation.x + l.translation.x), `${base} origin X`).toBeLessThan(0.015);
    }
  });

  it('scale with stature without changing orientation', () => {
    const tall = computeBoneFrames(
      document,
      resolveMorphology({ sex: 0.5, stature: 2.0, mass: 70 }).context,
    );
    for (const id of ['femur_r', 'tibia_l', 'humerus_r', 'sternum']) {
      const a = frames.get(id);
      const b = tall.get(id);
      if (!a || !b) throw new Error(id);
      expect(dot(axisOf(a, 'y'), axisOf(b, 'y')), id).toBeCloseTo(1, 9);
      expect(b.translation.y / a.translation.y, id).toBeCloseTo(
        2.0 / DATASET_MANIFEST.subjectStature,
        6,
      );
    }
  });
});
