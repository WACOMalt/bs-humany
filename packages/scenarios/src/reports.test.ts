/**
 * The inertia audit's one comparison, and the grouping the studio lists the compile report by.
 *
 * The audit's segment masses are de Leva's parts shared among the profile's segments, so the one
 * thing it can find wrong is mass lost or invented in the sharing: the whole body must weigh what
 * the morphology asked for. The anatomical profile is the one that shares the most parts among the
 * most segments, a vertebra and a rib at a time, so it is the one checked.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { compileArticulation } from '@bs-humany/compiler';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { type ReportNote, groupReportNotes, inertiaAudit } from './reports.js';

describe('inertiaAudit', () => {
  it('finds the whole-body mass the morphology asked for at L3', () => {
    const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
    const { articulation } = compileArticulation(buildDocument(), 'l3_anatomical', morphology);
    const audit = inertiaAudit(articulation, morphology);
    expect(audit.targetMass).toBe(70);
    // The sharing is by fractions that sum to one, so what is left is de Leva's own rounding: the
    // published relative masses are given to a few figures and their sum misses one by a few
    // parts in a hundred thousand (3.5 g at this body). A de Leva part dropped or counted twice
    // is a hand's worth at the least, the smallest in the table and close to 400 g here, so a
    // tenth of a per cent (70 g) separates the two with room on both sides.
    expect(Math.abs(audit.totalMass - audit.targetMass)).toBeLessThan(1e-3 * audit.targetMass);
    expect(audit.rows.length).toBe(articulation.segments.length);
    for (const row of audit.rows) {
      expect(row.bones).toBeGreaterThan(0);
      expect(row.diagonal.every((value) => value > 0)).toBe(true);
    }
  });
});

describe('groupReportNotes', () => {
  const note = (feature: string, message: string, from = 'compiler'): ReportNote => ({
    severity: 'warning',
    feature,
    from,
    message,
  });

  it('gathers a kind said three times or more into one group, in first-seen order', () => {
    const notes = [
      note('massProperties', 'a'),
      note('joint', 'x'),
      note('massProperties', 'b'),
      note('massProperties', 'c'),
    ];
    const groups = groupReportNotes(notes);
    expect(groups.map((g) => [g.feature, g.notes.length])).toEqual([
      ['massProperties', 3],
      ['joint', 1],
    ]);
  });

  it('lists a kind said fewer times note by note, and keeps sources and severities apart', () => {
    const notes = [
      note('joint', 'x'),
      note('joint', 'y'),
      note('joint', 'z', 'mujoco'),
      { ...note('joint', 'w'), severity: 'error' as const },
    ];
    const groups = groupReportNotes(notes);
    expect(groups.map((g) => g.notes.length)).toEqual([1, 1, 1, 1]);
    expect(groups.map((g) => g.notes[0]?.message)).toEqual(['x', 'y', 'z', 'w']);
  });
});
