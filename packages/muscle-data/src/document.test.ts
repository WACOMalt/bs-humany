import { HsdlDocumentSchema, moduleNamespace, writeExtension } from '@bs-humany/hsdl';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { readMuscles, withMuscles } from './document.js';
import { ELBOW_MUSCLES } from './elbow.js';
import { MUSCLE_NAMESPACE } from './schema.js';
import { validateMuscleExtension } from './validate.js';
import { ALL_MUSCLES } from './wholeBody.js';

const unitCount = (groups: readonly { units: readonly unknown[] }[]) =>
  groups.reduce((n, g) => n + g.units.length, 0);

describe('a document that carries its muscles', () => {
  const plain = buildDocument();
  const document = withMuscles(plain);

  it('holds the whole-body set under the muscle namespace, and gives it back', () => {
    expect(Object.keys(document.ext ?? {})).toContain(MUSCLE_NAMESPACE);
    const read = readMuscles(document);
    expect(read?.groups.map((g) => g.id)).toEqual(ALL_MUSCLES.map((g) => g.id));
    expect(unitCount(read?.groups ?? [])).toBe(unitCount(ALL_MUSCLES));
    // Equal as values, not only as ids: the schema parse must not round, default or drop
    // anything on the way through, or the set a run compiles would not be the set written.
    expect(read?.groups).toEqual(ALL_MUSCLES);
  });

  it('every site and surface the set names is one the document carries', () => {
    const read = readMuscles(document);
    if (!read) throw new Error('no muscle set');
    expect(validateMuscleExtension(document, read).problems).toEqual([]);
  });

  it('survives a round trip through HSDL alone, which knows nothing of muscles', () => {
    // Obligation 3's load-bearing promise: a build without the muscle module reads, validates and
    // re-serialises a document carrying muscles without losing them. HSDL's own schema is all
    // that stands between the two serialisations here.
    const reloaded = HsdlDocumentSchema.parse(JSON.parse(JSON.stringify(document)));
    expect(readMuscles(reloaded)?.groups).toEqual(ALL_MUSCLES);
  });

  it('leaves every other module’s annotations where they were', () => {
    const nerve = moduleNamespace('nerve');
    const annotated = { ...plain, ext: writeExtension(plain.ext, nerve, { rootLevel: 'C5' }) };
    const both = withMuscles(annotated, ELBOW_MUSCLES);
    expect(both.ext?.[nerve]).toEqual({ rootLevel: 'C5' });
    expect(readMuscles(both)?.groups.map((g) => g.id)).toEqual(ELBOW_MUSCLES.map((g) => g.id));
  });

  it('replaces a set already there, and does not touch the document it was given', () => {
    const smaller = withMuscles(document, ELBOW_MUSCLES);
    expect(unitCount(readMuscles(smaller)?.groups ?? [])).toBe(unitCount(ELBOW_MUSCLES));
    expect(unitCount(readMuscles(document)?.groups ?? [])).toBe(unitCount(ALL_MUSCLES));
    expect(readMuscles(plain)).toBeUndefined();
  });

  it('tells a document with no muscles from one whose muscles are broken', () => {
    // No muscles is a choice; broken muscles are a fault, and the fault must name the namespace
    // rather than surface later as a missing unit somewhere in the path solver.
    expect(readMuscles(plain)).toBeUndefined();
    const broken = { ...plain, ext: writeExtension(plain.ext, MUSCLE_NAMESPACE, { groups: 7 }) };
    expect(() => readMuscles(broken)).toThrow(MUSCLE_NAMESPACE);
  });
});
