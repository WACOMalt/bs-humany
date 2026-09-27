/**
 * What an Align file says it was made against: a digest of the reference data, and the body.
 */

import { describe, expect, it } from 'vitest';
import {
  bonePairingDocument,
  correspondenceDocument,
  overridesDocument,
} from './alignmentFiles.js';
import {
  bonePairingProvenance,
  correspondenceProvenance,
  fnv1a32,
  overridesProvenance,
} from './provenance.js';

const BODY = {
  profile: 'l3_anatomical',
  morphology: { sex: 0.5, stature: 1.7, mass: 70 },
} as const;
const SITES = { format: 'bs-humany.source-sites/1', digest: 'deadbeef' } as const;

describe('the digest', () => {
  it('is the published FNV-1a for known text', () => {
    // The 32-bit FNV-1a test vectors from the reference implementation.
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32('a')).toBe('e40c292c');
    expect(fnv1a32('foobar')).toBe('bf9cf968');
  });

  it('is stable for identical text and changes with one byte', () => {
    const text = '{"format":"bs-humany.source-sites/1","models":{}}\n';
    expect(fnv1a32(text)).toBe(fnv1a32(`${text}`));
    expect(fnv1a32(text.replace('1', '2'))).not.toBe(fnv1a32(text));
    expect(fnv1a32(`${text} `)).not.toBe(fnv1a32(text));
    expect(fnv1a32(text)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is taken over the UTF-8 bytes, so text beyond ASCII is hashed as a file would be', () => {
    // U+00E9 is the two bytes C3 A9 in UTF-8 and the one code unit E9 in UTF-16. Over the bytes
    // the digest is 1e9de8c1; over the code unit it would be 6c0b6c44.
    expect(fnv1a32('é')).toBe('1e9de8c1');
  });
});

describe('the headers', () => {
  it('put the body on point overrides, and nothing of theirs', () => {
    expect(overridesProvenance(BODY)).toEqual({ body: BODY });
    expect(overridesProvenance(undefined)).toEqual({ body: null });
    const doc = overridesDocument({ moves: [], body: BODY, decidedAt: 'now' }) as Record<
      string,
      unknown
    >;
    expect(doc.body).toEqual(BODY);
    expect('sourceSites' in doc).toBe(false);
  });

  it('put both the body and the reference data on a bone pairing', () => {
    expect(bonePairingProvenance(BODY, SITES)).toEqual({ body: BODY, sourceSites: SITES });
    const doc = bonePairingDocument({
      models: new Map(),
      body: BODY,
      sourceSites: SITES,
      decidedAt: 'now',
    }) as Record<string, unknown>;
    expect(doc.body).toEqual(BODY);
    expect(doc.sourceSites).toEqual(SITES);
  });

  it('put the reference data and the profile, not the morphology, on a correspondence', () => {
    expect(correspondenceProvenance(SITES, 'l3_anatomical')).toEqual({
      sourceSites: SITES,
      profile: 'l3_anatomical',
    });
    const doc = correspondenceDocument({
      pairs: [],
      sourceSites: SITES,
      profile: 'l3_anatomical',
      decidedAt: 'now',
    }) as Record<string, unknown>;
    expect(doc.sourceSites).toEqual(SITES);
    expect(doc.profile).toBe('l3_anatomical');
    expect('body' in doc).toBe(false);
  });
});
