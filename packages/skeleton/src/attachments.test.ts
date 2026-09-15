import { validateDocument } from '@bs-humany/hsdl';
import { describe, expect, it } from 'vitest';
import { attachmentGaps, buildAttachmentSites, buildMuscleViaPointSites } from './attachments.js';
import { buildDocument } from './document.js';

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
