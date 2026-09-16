import type { ScalarExpr } from '@bs-humany/hsdl';
import {
  buildAttachmentSites,
  buildMuscleViaPointSites,
  buildWrappingSurfaces,
} from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { MUSCLE_SCHEMA_VERSION, type MuscleExtension, MuscleExtensionSchema } from './schema.js';
import { SHOULDER_MUSCLES, SHOULDER_UNITS } from './shoulder.js';
import { validateMuscleExtension } from './validate.js';

const extension: MuscleExtension = {
  version: MUSCLE_SCHEMA_VERSION,
  groups: [...SHOULDER_MUSCLES],
};

function plain(value: ScalarExpr, what: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${what} is an expression, not a number. Has N2.6 landed?`);
  }
  return value;
}

describe('the shoulder muscle set', () => {
  it('parses against its own schema', () => {
    const parsed = MuscleExtensionSchema.safeParse(extension);
    expect(parsed.success ? null : parsed.error.issues).toBe(null);
  });

  it('binds to attachment sites the skeleton actually has', () => {
    const report = validateMuscleExtension(
      {
        attachmentSites: [...buildAttachmentSites(), ...buildMuscleViaPointSites()],
        wrappingSurfaces: buildWrappingSurfaces(),
      },
      extension,
    );
    expect(report.problems).toEqual([]);
    expect(report.unitCount).toBe(18);
  });

  it('carries coracobrachialis, whose tendon the source cannot place but whose fiber it can', () => {
    // It was left out for four commits. The source's operating range and length range for that
    // actuator imply a 312 mm fiber on a tendon 45 mm shorter than nothing -- but those two come
    // from different halves of the same arithmetic, the fiber from the *width* of the two ranges
    // and the tendon from the *offset*, and only the offset is contradictory. The tendon is
    // refitted to this skeleton regardless, so the offset is now evidence rather than a fault.
    // OQ-023.
    expect(SHOULDER_UNITS.some((u) => u.id === 'coracobrachialis_r')).toBe(true);
    expect(SHOULDER_UNITS.some((u) => u.id === 'coracobrachialis_l')).toBe(true);
  });

  it('gives the deltoid three lines of action and the cuff four', () => {
    // M-ADR-005, and nowhere does it matter more than the deltoid: its three parts pull in three
    // different directions, and one line through the middle of them abducts an arm where the real
    // muscle would rotate it.
    const deltoid = SHOULDER_MUSCLES.find((g) => g.id === 'deltoid_r');
    expect(deltoid?.units.map((u) => u.id)).toEqual([
      'deltoid_anterior_r',
      'deltoid_middle_r',
      'deltoid_posterior_r',
    ]);
    const cuff = ['supraspinatus_r', 'infraspinatus_r', 'subscapularis_r', 'teres_minor_r'];
    for (const id of cuff) {
      expect(
        SHOULDER_UNITS.some((u) => u.id === id),
        id,
      ).toBe(true);
    }
  });

  it('wraps nothing, because nothing here uses a surface steadily', () => {
    // The humeral head is in the skeleton as a measured sphere and these units were run over it
    // first. Swept through twenty-four shoulder poses, half never touched it and half touched it
    // between a fifth and two fifths of the time -- and a wrap that comes and goes changes a path
    // by centimetres from one tick to the next, which a stiff tendon turns into kilonewtons. The
    // arm twitched and its rotation flipped. The cuff inserts *on* the head, at the tubercles,
    // barely outside it: those muscles lie against it and attach rather than turning over it.
    for (const unit of SHOULDER_UNITS) {
      expect(
        unit.path.filter((element) => element.kind === 'wrap'),
        unit.id,
      ).toHaveLength(0);
    }
  });

  it('runs its paths from the origin outward, whichever way the source lists them', () => {
    // The reference model lists most shoulder tendons from the humerus inward and the elbow ones
    // from the girdle outward. Carried in the reference's order, the anterior deltoid ran down to
    // a point on the humerus, back up above it and down again -- half as long again as the muscle,
    // with its fiber at twice optimal and a force that overflowed.
    for (const unit of SHOULDER_UNITS) {
      const sites = unit.path.filter((e) => e.kind === 'site');
      expect(sites.length, unit.id).toBeLessThanOrEqual(2);
    }
    const deltoid = SHOULDER_UNITS.find((u) => u.id === 'deltoid_anterior_r');
    expect(deltoid?.path.map((e) => e.kind)).toEqual(['site', 'site']);
  });

  it('gives every unit a citation naming the actuator it came from', () => {
    for (const unit of SHOULDER_UNITS) {
      expect(unit.parameters.source.key, unit.id).toBe('caggiano2022');
      expect(unit.parameters.source.locator, unit.id).toContain('myoarm_r_muscle.xml');
      expect(unit.parameters.source.locator, unit.id).toMatch(/name="[A-Za-z0-9]+"/);
    }
  });

  it('gives parameters that are physiologically the right size', () => {
    // Not a precision check: the generator guarantees the digits. This is the check that the
    // extraction mapped the right actuator to the right muscle, which no amount of arithmetic
    // would catch. The deltoid is the strongest muscle at the shoulder, supraspinatus is a small
    // one, and the cuff together does not out-pull the deltoid.
    const force = (id: string) => {
      const unit = SHOULDER_UNITS.find((u) => u.id === id);
      if (unit === undefined) throw new Error(`no unit '${id}'`);
      return plain(unit.parameters.maxIsometricForce, id);
    };
    const deltoid = ['anterior', 'middle', 'posterior'].map((part) => force(`deltoid_${part}_r`));
    expect(Math.min(...deltoid)).toBeGreaterThan(150);
    expect(deltoid.reduce((t, f) => t + f, 0)).toBeGreaterThan(1500);
    expect(force('supraspinatus_r')).toBeLessThan(force('deltoid_middle_r'));
    expect(force('teres_minor_r')).toBeLessThan(force('subscapularis_r'));
    for (const unit of SHOULDER_UNITS) {
      const optimal = plain(unit.parameters.optimalFiberLength, unit.id);
      const slack = plain(unit.parameters.tendonSlackLength, unit.id);
      // A stated slack length may be negative, and coracobrachialis's is: the source's two ranges
      // disagree about where along that muscle the fibers sit. It is carried as provenance and
      // never used -- the compiler fits every tendon to this skeleton and floors it at
      // `MINIMUM_TENDON_SLACK` -- so what this checks is that it is a number of a plausible size,
      // not that it is usable. OQ-023.
      if (unit.id.startsWith('coracobrachialis')) {
        expect(slack, unit.id).toBeGreaterThan(-0.1);
        expect(optimal, unit.id).toBeGreaterThan(0.01);
        continue;
      }
      // Nothing at the shoulder has fibers longer than the arm. The bound is loose because two
      // of these sit near it honestly: coracobrachialis derives a 312 mm fiber, which is twice
      // what a real one has, and the reason is that its source's two ranges are strained -- the
      // same strain that shows as a negative tendon. What stops it being drawn or driven as a 312
      // mm fiber is the compile cap, which allows a fiber at most `FIBER_SHARE_LIMIT` of its own
      // path. This file has no compiler, so it checks the weaker thing. OQ-023.
      expect(optimal, unit.id).toBeGreaterThan(0.01);
      expect(optimal, unit.id).toBeLessThan(0.35);
      expect(slack, unit.id).toBeGreaterThan(0);
      expect(slack, unit.id).toBeLessThan(0.3);
    }
  });

  it('carries the same muscle on both shoulders', () => {
    const right = SHOULDER_UNITS.filter((u) => u.id.endsWith('_r'));
    const left = SHOULDER_UNITS.filter((u) => u.id.endsWith('_l'));
    expect(left).toHaveLength(right.length);
    for (const unit of right) {
      const mirror = left.find((u) => u.id === unit.id.replace(/_r$/, '_l'));
      if (!mirror) throw new Error(`${unit.id} has no left-side counterpart`);
      expect(plain(mirror.parameters.maxIsometricForce, mirror.id)).toBe(
        plain(unit.parameters.maxIsometricForce, unit.id),
      );
      expect(mirror.origin, mirror.id).toBe(unit.origin.replace(/_r_/, '_l_'));
      expect(mirror.insertion, mirror.id).toBe(unit.insertion.replace(/_r_/, '_l_'));
    }
  });
});
