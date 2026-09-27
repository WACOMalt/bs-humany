import { validateDocument } from '@bs-humany/hsdl';
import { describe, expect, it } from 'vitest';
import { attachmentGaps, buildAttachmentSites, buildMuscleViaPointSites } from './attachments.js';
import { buildDocument } from './document.js';
import { ARM, LEG } from './jointHelpers.js';
import { PROVENANCE_NS } from './landmarks.js';
import { MUSCLE_VIA_POINTS } from './muscleViaPoints.js';

describe('attachment sites', () => {
  const sites = buildAttachmentSites();

  it('validate as part of the document and cover both sides of the major muscles', () => {
    const document = buildDocument();
    expect(validateDocument(document).issues.filter((i) => i.severity === 'error')).toEqual([]);
    // The document carries the muscle attachments and the via points a muscle passes through.
    // They are built separately because they come from different places: an attachment is Gray's
    // anatomical statement located on this subject's markers, a via point is the reference
    // model's own path carried into our frames.
    const via = buildMuscleViaPointSites();
    expect(document.attachmentSites.length).toBe(sites.length + via.length);
    expect(sites.length).toBeGreaterThan(100);
    expect(via.length).toBeGreaterThan(0);
    expect(via.every((v) => v.kind === 'tendon_via_point')).toBe(true);
    const structures = new Set(sites.map((s) => s.structure));
    for (const name of [
      'Deltoideus',
      'Gluteus maximus',
      'Gastrocnemius',
      'Biceps brachii',
      'Psoas major',
    ]) {
      expect(structures.has(name), name).toBe(true);
    }
    expect(sites.filter((s) => s.id.endsWith('_r') || s.id.includes('_r_')).length).toBeGreaterThan(
      40,
    );
    expect(sites.filter((s) => s.id.includes('_l_')).length).toBeGreaterThan(40);
  });

  it('places every site on its bone with a Gray citation and dataset provenance', () => {
    for (const site of sites) {
      expect(site.source.key).toBe('gray1918');
      expect(site.source.locator).toMatch(/^Part IV, Myology/);
      expect(site.ext?.['bsums.xyz.bs-humany.provenance']).toBeDefined();
    }
    const deltoid = sites.find((s) => s.id.startsWith('deltoid_insertion_r'));
    expect(deltoid?.bone).toBe('humerus_r');
    expect(deltoid?.kind).toBe('muscle_insertion');
  });

  it('names what the dataset cannot locate rather than skipping silently', () => {
    // Every listed feature exists in the pack; a rename in the dataset shows up here.
    expect(attachmentGaps()).toEqual([]);
  });
});

describe('via point sites', () => {
  const via = buildMuscleViaPointSites();
  const pointOf = new Map(MUSCLE_VIA_POINTS.map((point) => [point.id, point]));
  /** Everything a site says about where it came from, citation and provenance alike. */
  const said = (site: (typeof via)[number]): string => {
    const provenance = site.ext?.[PROVENANCE_NS] as { locatedBy?: string } | undefined;
    return `${site.source.locator ?? ''} | ${provenance?.locatedBy ?? ''}`;
  };

  it('cite the leg model or the dataset for every point below the hip', () => {
    // Every via point used to cite the arm's chain and the humerus frame, the leg's included.
    const leg =
      /^(femur|patella|tibia|fibula|calcaneus|talus|navicular|cuboid|cuneiform_\w+|metatarsal_\d)_[rl]$/;
    const below = via.filter((site) => leg.test(site.bone));
    expect(below.length).toBeGreaterThan(0);
    const miscited = below
      .filter(
        (site) =>
          !(site.source.key === 'caggiano2022' && site.source.locator?.includes(LEG)) &&
          site.source.key !== 'kervyn2021',
      )
      .map((site) => `${site.id}: ${site.source.key} ${site.source.locator}`);
    expect(miscited).toEqual([]);
  });

  it('name the humerus only for a point the upper arm frame carried', () => {
    const wrong = via
      .filter((site) => /humer/.test(said(site)) && pointOf.get(site.id)?.frame !== 'upper arm')
      .map((site) => `${site.id}: ${said(site)}`);
    expect(wrong).toEqual([]);
  });

  it('do not cite the reference for the patella poles, which are measured on our own bone', () => {
    const poles = via.filter((site) => site.bone.startsWith('patella_'));
    expect(poles.length).toBeGreaterThan(0);
    for (const site of poles) {
      expect(site.source.key, site.id).not.toBe('caggiano2022');
      expect(pointOf.get(site.id)?.method, site.id).toBe('measured');
    }
  });

  it('say how each point was obtained, and cite the file it was carried from', () => {
    for (const site of via) {
      const point = pointOf.get(site.id);
      expect(point, site.id).toBeDefined();
      if (point?.method === 'measured') {
        expect(site.source.key, site.id).toBe('kervyn2021');
        continue;
      }
      expect(site.source.key, site.id).toBe('caggiano2022');
      expect([ARM, LEG], site.id).toContain(point?.referenceModel);
      expect(site.source.locator, site.id).toContain(`${point?.referenceModel}, site `);
      expect(site.source.locator, site.id).toContain(`the ${point?.frame} frame`);
      if (point?.method === 'drawn-in') {
        expect(site.source.locator, site.id).toContain(`mm from ${site.bone}`);
      }
    }
  });
});
