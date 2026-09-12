import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  EXTENSION_NAMESPACE_PATTERN,
  moduleNamespace,
  readExtension,
  writeExtension,
} from './extensions.js';
import { makeMinimalDocument } from './fixtures.js';
import { PROJECT_NAMESPACE } from './namespace.js';
import { validateDocument } from './validate.js';

describe('namespace validation', () => {
  it('accepts reverse-DNS names with at least two segments', () => {
    for (const name of [
      'bsums.xyz.bs-humany.nerve',
      'example.com.muscles',
      'a.b',
      'some-org.some-module',
    ]) {
      expect(EXTENSION_NAMESPACE_PATTERN.test(name), name).toBe(true);
    }
  });

  it('rejects unqualified names, which are the ones that collide', () => {
    for (const name of ['nerve', 'muscles', '', '.leading', 'trailing.', 'Has.Capitals', 'a..b']) {
      expect(EXTENSION_NAMESPACE_PATTERN.test(name), name).toBe(false);
    }
  });

  it('builds first-party namespaces under the project prefix', () => {
    expect(moduleNamespace('nerve')).toBe(`${PROJECT_NAMESPACE}.nerve`);
    expect(EXTENSION_NAMESPACE_PATTERN.test(moduleNamespace('nerve'))).toBe(true);
  });
});

describe('read and write', () => {
  const ns = moduleNamespace('nerve');
  const schema = z.object({ rootLevel: z.string(), conductionVelocity: z.number() });

  it('round-trips a value', () => {
    const ext = writeExtension(undefined, ns, { rootLevel: 'L4', conductionVelocity: 60 });
    expect(readExtension(ext, ns, schema)).toEqual({ rootLevel: 'L4', conductionVelocity: 60 });
  });

  it('does not mutate the input map', () => {
    const original = { 'a.b': 1 };
    const updated = writeExtension(original, ns, { rootLevel: 'L4', conductionVelocity: 60 });
    expect(original).toEqual({ 'a.b': 1 });
    expect(updated['a.b']).toBe(1);
  });

  it('returns undefined for an absent namespace', () => {
    expect(readExtension(undefined, ns, schema)).toBeUndefined();
    expect(readExtension({ 'other.module': {} }, ns, schema)).toBeUndefined();
  });

  it('distinguishes absent from malformed', () => {
    // Absent means "this module never annotated this node". Malformed means "this module wrote
    // something it cannot read back". Conflating them hides the second.
    expect(() => readExtension({ [ns]: { rootLevel: 4 } }, ns, schema)).toThrow(
      /present but does not match its schema/,
    );
  });

  it('refuses to write an unqualified namespace', () => {
    expect(() => writeExtension(undefined, 'nerve', {})).toThrow(/reverse-DNS/);
  });
});

describe('documents carry extensions through validation', () => {
  const ns = moduleNamespace('nerve');

  it('accepts extensions on bones, joints and the document', () => {
    const doc = structuredClone(makeMinimalDocument());
    doc.ext = writeExtension(undefined, ns, { version: 1 });
    doc.bones[1]!.ext = writeExtension(undefined, ns, { innervation: ['femoral'] });
    doc.joints[0]!.ext = writeExtension(undefined, ns, { reflex: 'patellar' });
    expect(validateDocument(doc).ok).toBe(true);
  });

  it('preserves unknown extension data verbatim through a JSON round-trip', () => {
    // Spec section 14.5 obligation 3. A loader that silently dropped unknown extension data would
    // destroy annotations belonging to a module that merely was not loaded at the time -- data
    // loss that surfaces long after the code causing it.
    const doc = structuredClone(makeMinimalDocument());
    const payload = { nested: { deeply: [1, 2, { three: true }] }, unicode: 'nervus femoralis' };
    doc.bones[1]!.ext = writeExtension(undefined, 'someone-else.org.unknown-module', payload);

    const result = validateDocument(JSON.parse(JSON.stringify(doc)));
    expect(result.ok).toBe(true);
    expect(result.document?.bones[1]?.ext?.['someone-else.org.unknown-module']).toEqual(payload);
  });

  it('rejects an unqualified extension key on a bone', () => {
    const doc = structuredClone(makeMinimalDocument());
    doc.bones[1]!.ext = { nerve: { innervation: ['femoral'] } };
    expect(validateDocument(doc).ok).toBe(false);
  });
});
