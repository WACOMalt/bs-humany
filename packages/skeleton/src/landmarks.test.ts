import { resolveMorphology } from '@bs-humany/anthropometry';
import { evaluate, validateDocument } from '@bs-humany/hsdl';
import { describe, expect, it } from 'vitest';
import { DATASET_MANIFEST, buildDocument } from './document.js';
import {
  ISB_LANDMARKS,
  PROVENANCE_NS,
  buildLandmarks,
  isbLandmarkWorld,
  landmarkId,
} from './landmarks.js';
import { getBone } from './taxonomy.js';

const landmarks = buildLandmarks();
const context = resolveMorphology({
  sex: 0.5,
  stature: DATASET_MANIFEST.subjectStature,
  mass: 70,
}).context;

describe('the landmark table', () => {
  it('carries the whole pack: every marker and every derived point', () => {
    expect(landmarks.length).toBeGreaterThan(800);
  });

  it('has unique, well-formed ids on existing bones', () => {
    const ids = new Set<string>();
    for (const l of landmarks) {
      expect(l.id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(ids.has(l.id), `duplicate ${l.id}`).toBe(false);
      ids.add(l.id);
      expect(getBone(l.bone), `${l.id} on unknown bone ${l.bone}`).toBeDefined();
    }
  });

  it('places every landmark within half a metre of its bone centroid', () => {
    // A marker far from its bone means the wrong node was picked up during traversal.
    for (const l of landmarks) {
      const d = Math.hypot(
        evaluate(l.position.x, context),
        evaluate(l.position.y, context),
        evaluate(l.position.z, context),
      );
      expect(Number.isFinite(d), l.id).toBe(true);
      expect(d, `${l.id} is ${d.toFixed(3)} m from its bone`).toBeLessThan(0.5);
    }
  });

  it('records where each landmark was located, per ADR-011', () => {
    for (const l of landmarks) {
      const provenance = l.ext?.[PROVENANCE_NS] as
        | { locatedBy?: string; sourceSha256?: string }
        | undefined;
      expect(provenance?.locatedBy, l.id).toMatch(/^(marker|rule): /);
      expect(provenance?.sourceSha256).toBe(DATASET_MANIFEST.dataset.sourceSha256);
    }
  });

  it('scales with stature like the bones do', () => {
    const tall = resolveMorphology({ sex: 0.5, stature: 2.0, mass: 70 }).context;
    const gt = landmarks.find((l) => l.id === landmarkId('femur_r', 'Greater_trochanter'));
    expect(gt).toBeDefined();
    if (!gt) return;
    const ratio = evaluate(gt.position.y, tall) / evaluate(gt.position.y, context);
    expect(ratio).toBeCloseTo(2.0 / DATASET_MANIFEST.subjectStature, 6);
  });
});

describe('ISB landmarks', () => {
  it('all resolve to a feature the pack actually carries', () => {
    for (const isb of ISB_LANDMARKS) {
      expect(
        () => isbLandmarkWorld(isb.bone, isb.abbreviation),
        `${isb.abbreviation} on ${isb.bone}`,
      ).not.toThrow();
    }
  });

  it('cite the ISB definition, not just the dataset', () => {
    for (const isb of ISB_LANDMARKS) {
      const def = landmarks.find((l) => l.id === landmarkId(isb.bone, isb.feature));
      expect(def, `${isb.abbreviation}`).toBeDefined();
      expect(def?.source.key, isb.abbreviation).toMatch(/^wu200[25]$/);
      expect(def?.displayName, isb.abbreviation).toContain(`(${isb.abbreviation})`);
    }
  });

  it('are mirrored left and right', () => {
    const rights = ISB_LANDMARKS.filter((l) => l.bone.endsWith('_r'));
    for (const r of rights) {
      const left = isbLandmarkWorld(`${r.bone.slice(0, -2)}_l`, r.abbreviation);
      const right = isbLandmarkWorld(r.bone, r.abbreviation);
      expect(Math.abs(right[0] + left[0]), `${r.abbreviation} X`).toBeLessThan(0.012);
      expect(Math.abs(right[1] - left[1]), `${r.abbreviation} Y`).toBeLessThan(0.012);
      expect(Math.abs(right[2] - left[2]), `${r.abbreviation} Z`).toBeLessThan(0.012);
    }
  });

  it('sit where anatomy puts them', () => {
    // A handful of relations that hold for any standing adult, as a check that the right marker
    // was mapped to the right ISB name.
    const w = (bone: string, abbr: string) => isbLandmarkWorld(bone, abbr);
    // Malleoli below the tibial condyles; medial malleolus medial of the lateral one (right leg).
    expect(w('tibia_r', 'MM')[1]).toBeLessThan(w('tibia_r', 'MC')[1]);
    expect(w('tibia_r', 'MM')[0]).toBeLessThan(w('fibula_r', 'LM')[0]);
    // Femoral epicondyles below the hip centre and above the tibial condyles.
    expect(w('femur_r', 'FE_med')[1]).toBeLessThan(w('femur_r', 'HJC')[1]);
    expect(w('femur_r', 'FE_med')[1]).toBeGreaterThan(w('tibia_r', 'MC')[1] - 0.02);
    // ASIS anterior of PSIS (anterior is -Z).
    expect(w('hip_r', 'ASIS')[2]).toBeLessThan(w('hip_r', 'PSIS')[2]);
    // Jugular notch above the xiphoid, both anterior of the spinous processes.
    expect(w('sternum', 'IJ')[1]).toBeGreaterThan(w('sternum', 'PX')[1]);
    expect(w('sternum', 'IJ')[2]).toBeLessThan(w('vertebra_c7', 'C7')[2]);
    expect(w('vertebra_c7', 'C7')[1]).toBeGreaterThan(w('vertebra_t8', 'T8')[1]);
    // Humeral epicondyles below the glenohumeral centre; styloids below the epicondyles.
    expect(w('humerus_r', 'EL')[1]).toBeLessThan(w('humerus_r', 'GH')[1]);
    expect(w('radius_r', 'RS')[1]).toBeLessThan(w('humerus_r', 'EL')[1]);
    // Acromial angle lateral of the trigonum spinae; inferior angle below both.
    expect(w('scapula_r', 'AA')[0]).toBeGreaterThan(w('scapula_r', 'TS')[0]);
    expect(w('scapula_r', 'AI')[1]).toBeLessThan(w('scapula_r', 'TS')[1]);
  });
});

describe('the document with landmarks', () => {
  it('still validates', () => {
    const result = validateDocument(buildDocument());
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(buildDocument().landmarks.length).toBe(landmarks.length);
  });
});
