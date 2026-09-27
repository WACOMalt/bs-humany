/**
 * The Align tab's files read back: every format it writes opens again, anything else is turned
 * away by name, and a file joins what is on screen by the rules the lists already follow.
 */

import { describe, expect, it } from 'vitest';
import { createMemory } from '../ui/memory.js';
import {
  ALIGN_FORMATS,
  DRAFT_KEY,
  type KnownNames,
  type StampedBonePair,
  bonePairingDocument,
  correspondenceDocument,
  describeMerge,
  mergeBonePairs,
  mergeMoves,
  mergePairs,
  overridesDocument,
  readAlignmentFile,
  readDraft,
  serialise,
  writeDraft,
} from './alignmentFiles.js';
import type { Pair } from './correspondence.js';
import type { Move } from './pointHandles.js';

/** A store the page's memory can sit on, as `ui/memory.test.ts` builds one. */
function fakeStorage(): Storage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

const BODY = { profile: 'l3_anatomical', morphology: { sex: 0.5, stature: 1.7, mass: 70 } };
const SITES = { format: 'bs-humany.source-sites/1', digest: '0123abcd' };
const PAIRS: Pair[] = [
  { theirs: 'EO1', model: 'torso', ours: 'external_oblique_r' },
  { theirs: 'EO2', model: 'torso', ours: 'external_oblique_r' },
];
const MOVE: Move = {
  id: 'l5_s1',
  kind: 'joints',
  on: 'pelvis',
  from: [0, 0.951, 0.009],
  to: [0, 0.953, 0.011],
  moved: 2.83,
  reason: 'the disc is higher',
  profile: 'l3_anatomical',
  morphology: BODY.morphology,
};
const BONES: StampedBonePair[] = [
  { theirs: 'femur_r', ours: 'thigh_r', profile: 'l3_anatomical', decidedBy: 'name' },
  { theirs: 'tibia_r', ours: 'shank_r', profile: 'l3_anatomical', decidedBy: 'eye' },
];

const KNOWN: KnownNames = {
  theirs: (model) =>
    model === 'torso'
      ? new Set(['EO1', 'EO2', 'EO3'])
      : model === 'legs'
        ? new Set(['femur_r', 'tibia_r', 'pelvis'])
        : undefined,
  ours: new Set(['external_oblique_r', 'thigh_r', 'shank_r', 'pelvis']),
};

describe('reading back', () => {
  it('round-trips each of the three documents', () => {
    const c = readAlignmentFile(
      serialise(
        correspondenceDocument({ pairs: PAIRS, sourceSites: SITES, profile: 'l3', decidedAt: 't' }),
      ),
    );
    expect(c).toEqual({ kind: 'correspondence', pairs: PAIRS });
    const o = readAlignmentFile(
      serialise(overridesDocument({ moves: [MOVE], body: BODY, decidedAt: 't' })),
    );
    expect(o).toEqual({ kind: 'overrides', moves: [MOVE] });
    const b = readAlignmentFile(
      serialise(
        bonePairingDocument({
          models: new Map([
            ['legs', BONES],
            ['arm', []],
          ]),
          body: BODY,
          sourceSites: SITES,
          decidedAt: 't',
        }),
      ),
    );
    // A model with no pairs is not written, so it does not come back.
    expect(b).toEqual({ kind: 'bones', models: { legs: BONES } });
  });

  it('writes version 2 of every format', () => {
    const formats = [
      correspondenceDocument({ pairs: [], sourceSites: SITES, profile: 'l3', decidedAt: 't' }),
      overridesDocument({ moves: [], body: BODY, decidedAt: 't' }),
      bonePairingDocument({ models: new Map(), body: BODY, sourceSites: SITES, decidedAt: 't' }),
    ].map((d) => (d as { format: string }).format);
    expect(formats).toEqual(Object.values(ALIGN_FORMATS));
    expect(formats.every((f) => f.endsWith('/2'))).toBe(true);
  });

  it('still reads version-1 files, which carry no provenance', () => {
    const v1 = JSON.stringify({
      format: 'bs-humany.point-overrides/1',
      decidedAt: 't',
      note: 'x',
      moves: [{ ...MOVE, profile: undefined, morphology: undefined }],
    });
    const read = readAlignmentFile(v1);
    expect('kind' in read && read.kind).toBe('overrides');
    if ('kind' in read && read.kind === 'overrides') {
      expect(read.moves[0]?.profile).toBeUndefined();
      expect(read.moves[0]?.to).toEqual(MOVE.to);
    }
    const pairs = readAlignmentFile(
      JSON.stringify({ format: 'bs-humany.source-correspondence/1', pairs: PAIRS }),
    );
    expect(pairs).toEqual({ kind: 'correspondence', pairs: PAIRS });
    const bones = readAlignmentFile(
      JSON.stringify({
        format: 'bs-humany.bone-pairing/1',
        models: { legs: [{ theirs: 'femur_r', ours: 'thigh_r' }] },
      }),
    );
    expect(bones).toEqual({
      kind: 'bones',
      models: { legs: [{ theirs: 'femur_r', ours: 'thigh_r' }] },
    });
  });

  it('turns away a missing or wrong format, and a session file, by name', () => {
    const cases = [
      JSON.stringify({ pairs: PAIRS }),
      JSON.stringify({ format: 'bs-humany.source-correspondence/3', pairs: PAIRS }),
      JSON.stringify({ format: 'bs-humany.session/1', settings: {} }),
      'not json',
      '[1, 2]',
    ];
    for (const text of cases) expect(readAlignmentFile(text), text).toHaveProperty('error');
    const session = readAlignmentFile(JSON.stringify({ format: 'bs-humany.session/1' }));
    expect('error' in session && session.error).toMatch(/bs-humany\.session\/1/);
  });

  it('turns away a NaN or two-element to, and an empty ours', () => {
    const overrides = (move: object) =>
      JSON.stringify({ format: ALIGN_FORMATS.overrides, moves: [move] });
    // JSON has no NaN, so a NaN arrives as null; a string is no better.
    expect(readAlignmentFile(overrides({ ...MOVE, to: [0, null, 0] }))).toHaveProperty('error');
    expect(readAlignmentFile(overrides({ ...MOVE, to: [0, '1', 0] }))).toHaveProperty('error');
    expect(readAlignmentFile(overrides({ ...MOVE, to: [0, 1] }))).toHaveProperty('error');
    expect(readAlignmentFile(overrides({ ...MOVE, reason: '' }))).toHaveProperty('error');
    expect(readAlignmentFile(overrides({ ...MOVE, kind: 'bones' }))).toHaveProperty('error');
    const pair = readAlignmentFile(
      JSON.stringify({
        format: ALIGN_FORMATS.correspondence,
        pairs: [{ theirs: 'EO1', model: 'torso', ours: '' }],
      }),
    );
    expect(pair).toHaveProperty('error');
    const bone = readAlignmentFile(
      JSON.stringify({ format: ALIGN_FORMATS.bones, models: { legs: [{ theirs: 'femur_r' }] } }),
    );
    expect(bone).toHaveProperty('error');
  });
});

describe('merging an opened file', () => {
  it('unions muscle pairs on model, theirs and ours', () => {
    const into: Pair[] = [PAIRS[0] as Pair];
    const report = mergePairs(
      into,
      [...PAIRS, { theirs: 'EO1', model: 'torso', ours: 'rectus_abdominis_r' }],
      { ...KNOWN, ours: new Set([...(KNOWN.ours ?? []), 'rectus_abdominis_r']) },
    );
    expect(report.added).toBe(2);
    expect(report.already).toBe(1);
    expect(into).toHaveLength(3);
    // The same muscle of theirs on two of ours is two pairs, not a replacement.
    expect(into.filter((p) => p.theirs === 'EO1')).toHaveLength(2);
  });

  it('replaces bone pairs on model and their bone', () => {
    const into = new Map<string, StampedBonePair[]>([
      ['legs', [{ theirs: 'femur_r', ours: 'pelvis', decidedBy: 'eye' }]],
    ]);
    const report = mergeBonePairs(into, { legs: BONES }, KNOWN);
    expect(report).toMatchObject({ added: 1, replaced: 1, already: 0 });
    expect(into.get('legs')?.find((p) => p.theirs === 'femur_r')?.ours).toBe('thigh_r');
    const again = mergeBonePairs(into, { legs: BONES }, KNOWN);
    expect(again).toMatchObject({ added: 0, replaced: 0, already: 2 });
  });

  it('replaces moves on id', () => {
    const into: Move[] = [{ ...MOVE, to: [0, 0.96, 0], reason: 'older' }];
    const report = mergeMoves(into, [MOVE, { ...MOVE, id: 'c0_c1' }]);
    expect(report).toMatchObject({ added: 1, replaced: 1 });
    expect(into.find((m) => m.id === 'l5_s1')?.reason).toBe('the disc is higher');
    expect(mergeMoves(into, [MOVE])).toMatchObject({ already: 1 });
  });

  it('drops their names the model does not have, and says which', () => {
    const into: Pair[] = [];
    const report = mergePairs(
      into,
      [
        { theirs: 'EO1', model: 'torso', ours: 'external_oblique_r' },
        { theirs: 'XX', model: 'torso', ours: 'external_oblique_r' },
        { theirs: 'YY', model: 'torso', ours: 'external_oblique_r' },
        { theirs: 'glmax1', model: 'no_such_model', ours: 'gluteus_maximus_r' },
      ],
      KNOWN,
    );
    expect(into).toHaveLength(1);
    expect(report.dropped.get('torso')).toEqual(['XX', 'YY']);
    expect(report.dropped.get('no_such_model')).toEqual(['glmax1']);
    expect(describeMerge(report, { one: 'pair', many: 'pairs' }, 'a muscle', 'a unit')).toBe(
      'Opened 1 pair; 2 name a muscle the torso model does not have, left out: XX, YY; ' +
        '1 names a muscle the no_such_model model does not have, left out: glmax1.',
    );
  });

  it('keeps our ids this body does not have, and counts them', () => {
    const into: Pair[] = [];
    const report = mergePairs(
      into,
      [
        { theirs: 'EO1', model: 'torso', ours: 'external_oblique_r' },
        { theirs: 'EO2', model: 'torso', ours: 'made_at_l3_only' },
      ],
      KNOWN,
    );
    expect(into).toHaveLength(2);
    expect(report.unknownOurs).toEqual(['made_at_l3_only']);
    expect(describeMerge(report, { one: 'pair', many: 'pairs' }, 'a muscle', 'a unit')).toMatch(
      /1 names a unit this body does not have, kept and marked \?/,
    );
    // With no body built there is nothing to check against, and the note says so.
    const unchecked = mergePairs([], PAIRS, { ...KNOWN, ours: undefined });
    expect(unchecked.oursChecked).toBe(false);
    expect(unchecked.unknownOurs).toEqual([]);
  });
});

describe('the draft', () => {
  const texts = () => ({
    correspondence: serialise(
      correspondenceDocument({ pairs: PAIRS, sourceSites: SITES, profile: 'l3', decidedAt: 't' }),
    ),
    overrides: serialise(overridesDocument({ moves: [MOVE], body: BODY, decidedAt: 't' })),
    bones: serialise(
      bonePairingDocument({
        models: new Map([['legs', BONES]]),
        body: BODY,
        sourceSites: SITES,
        decidedAt: 't',
      }),
    ),
  });

  it('keeps all three documents under one key and reads them back', () => {
    const store = fakeStorage();
    const memory = createMemory(store);
    writeDraft(memory, texts());
    expect([...store.map.keys()]).toEqual([`bs-humany.studio.${DRAFT_KEY}`]);
    expect(readDraft(memory)).toEqual({ pairs: PAIRS, moves: [MOVE], bones: { legs: BONES } });
  });

  it('has nothing to offer when empty, absent or damaged', () => {
    const memory = createMemory(fakeStorage());
    expect(readDraft(memory)).toBeUndefined();
    writeDraft(memory, {
      correspondence: serialise(
        correspondenceDocument({ pairs: [], sourceSites: SITES, profile: 'l3', decidedAt: 't' }),
      ),
      overrides: serialise(overridesDocument({ moves: [], body: BODY, decidedAt: 't' })),
      bones: serialise(
        bonePairingDocument({ models: new Map(), body: BODY, sourceSites: SITES, decidedAt: 't' }),
      ),
    });
    expect(readDraft(memory)).toBeUndefined();
    memory.set(DRAFT_KEY, '{not json');
    expect(readDraft(memory)).toBeUndefined();
  });

  it('keeps the documents that read when one does not', () => {
    const memory = createMemory(fakeStorage());
    writeDraft(memory, { ...texts(), overrides: '{"format":"bs-humany.session/1"}' });
    expect(readDraft(memory)).toEqual({ pairs: PAIRS, moves: [], bones: { legs: BONES } });
  });
});
