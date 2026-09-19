import type { ScalarExpr } from '@bs-humany/hsdl';
import {
  buildAttachmentSites,
  buildMuscleViaPointSites,
  buildWrappingSurfaces,
} from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { NECK_MUSCLES, NECK_UNITS } from './neck.js';
import { MUSCLE_SCHEMA_VERSION, type MuscleExtension, MuscleExtensionSchema } from './schema.js';
import { validateMuscleExtension } from './validate.js';

const extension: MuscleExtension = { version: MUSCLE_SCHEMA_VERSION, groups: [...NECK_MUSCLES] };

function plain(value: ScalarExpr, what: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${what} is an expression, not a number. Has N2.6 landed?`);
  }
  return value;
}

describe('the neck muscle set', () => {
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
    expect(report.unitCount).toBe(22);
  });

  it('holds the head from in front, behind and the side', () => {
    // The set's whole point: before it the cervical chain had nothing but an end-stop, and the
    // head lolled. Sternocleidomastoid and the longus muscles in front, splenius and
    // semispinalis and longissimus behind, the scalenes to the side.
    const ids = NECK_UNITS.map((u) => u.id);
    for (const id of [
      'sternocleidomastoid_r',
      'longus_colli_r',
      'longus_capitis_r',
      'splenius_capitis_r',
      'splenius_cervicis_r',
      'semispinalis_capitis_r',
      'longissimus_capitis_r',
      'longissimus_cervicis_r',
      'scalenus_anterior_r',
      'scalenus_medius_r',
      'scalenus_posterior_r',
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it('is derived from measured volumes and this skeleton, and says so', () => {
    // No vendored actuator exists for the neck. Every unit's citation names the volume share it
    // follows from and the distance it was measured over, so the number can be re-derived.
    for (const unit of NECK_UNITS) {
      expect(unit.parameters.source.key).toBe('zheng2013');
      expect(unit.parameters.source.locator).toMatch(/of the total neck muscle volume/);
      expect(unit.parameters.source.locator).toMatch(/mm between attachments/);
    }
  });

  it('gives parameters that are physiologically the right size', () => {
    const force = (id: string) => {
      const unit = NECK_UNITS.find((u) => u.id === id);
      if (unit === undefined) throw new Error(`no unit '${id}'`);
      return plain(unit.parameters.maxIsometricForce, id);
    };
    const fibre = (id: string) => {
      const unit = NECK_UNITS.find((u) => u.id === id);
      if (unit === undefined) throw new Error(`no unit '${id}'`);
      return plain(unit.parameters.optimalFiberLength, id);
    };
    // Sternocleidomastoid and semispinalis capitis are the two big ones by volume, and come out
    // at around a hundred newtons a side; the deep longus muscles at a few tens.
    expect(force('sternocleidomastoid_r')).toBeGreaterThan(80);
    expect(force('semispinalis_capitis_r')).toBeGreaterThan(80);
    expect(force('sternocleidomastoid_r')).toBeGreaterThan(force('longus_colli_r'));
    expect(force('longus_colli_r')).toBeGreaterThan(5);
    // Fibre lengths are fractions of real distances: a hand's breadth for the long muscles,
    // less for the scalenes.
    expect(fibre('sternocleidomastoid_r')).toBeGreaterThan(0.08);
    expect(fibre('sternocleidomastoid_r')).toBeLessThan(0.2);
    expect(fibre('scalenus_anterior_r')).toBeLessThan(fibre('sternocleidomastoid_r'));
    for (const unit of NECK_UNITS) {
      expect(plain(unit.parameters.tendonSlackLength, unit.id)).toBeGreaterThan(0);
    }
  });

  it('carries a mirror on both sides', () => {
    const right = NECK_UNITS.filter((u) => u.id.endsWith('_r'));
    const left = NECK_UNITS.filter((u) => u.id.endsWith('_l'));
    expect(left).toHaveLength(right.length);
    for (const unit of right) {
      const mirror = left.find((u) => u.id === unit.id.replace(/_r$/, '_l'));
      if (!mirror) throw new Error(`${unit.id} has no left-side counterpart`);
      const ratio =
        plain(mirror.parameters.maxIsometricForce, mirror.id) /
        plain(unit.parameters.maxIsometricForce, unit.id);
      // The two sides are measured on a symmetric skeleton; only rounding separates them.
      expect(Math.abs(ratio - 1), unit.id).toBeLessThan(0.02);
    }
  });
});
