import type { ScalarExpr } from '@bs-humany/hsdl';
import {
  buildAttachmentSites,
  buildMuscleViaPointSites,
  buildWrappingSurfaces,
} from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { GIRDLE_MUSCLES, GIRDLE_UNITS } from './girdle.js';
import { MUSCLE_SCHEMA_VERSION, type MuscleExtension, MuscleExtensionSchema } from './schema.js';
import { validateMuscleExtension } from './validate.js';

const extension: MuscleExtension = {
  version: MUSCLE_SCHEMA_VERSION,
  groups: [...GIRDLE_MUSCLES],
};

function plain(value: ScalarExpr, what: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${what} is an expression, not a number. Has N2.6 landed?`);
  }
  return value;
}

describe('the shoulder girdle muscle set', () => {
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
    expect(report.unitCount).toBe(20);
  });

  it('hangs the scapula and pins it to the ribs', () => {
    // Trapezius and levator scapulae from above, the rhomboids from behind, serratus anterior
    // and pectoralis minor from the ribs in front: the scapulothoracic set the activation clips
    // had listed as missing from the model.
    const ids = GIRDLE_UNITS.map((u) => u.id);
    for (const id of [
      'trapezius_upper_r',
      'trapezius_middle_r',
      'trapezius_lower_r',
      'levator_scapulae_r',
      'rhomboid_minor_r',
      'rhomboid_major_r',
      'serratus_anterior_superior_r',
      'serratus_anterior_middle_r',
      'serratus_anterior_inferior_r',
      'pectoralis_minor_r',
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it("reads Seth 2019's table, and says which row", () => {
    for (const unit of GIRDLE_UNITS) {
      expect(unit.parameters.source.key).toBe('seth2019');
      expect(unit.parameters.source.locator).toMatch(/^Table 1, /);
    }
    // The three parts of trapezius are Seth's four, mapped by origin; the ascending part is two
    // rows together and its citation names both.
    const lower = GIRDLE_UNITS.find((u) => u.id === 'trapezius_lower_r');
    expect(lower?.parameters.source.locator).toContain(
      'Scapula middle + Trapezius, Scapula inferior',
    );
  });

  it('carries the forces the table gives', () => {
    const force = (id: string) => {
      const unit = GIRDLE_UNITS.find((u) => u.id === id);
      if (unit === undefined) throw new Error(`no unit '${id}'`);
      return plain(unit.parameters.maxIsometricForce, id);
    };
    expect(force('trapezius_middle_r')).toBe(1043);
    expect(force('levator_scapulae_r')).toBe(280);
    expect(force('serratus_anterior_middle_r')).toBe(508);
    expect(force('pectoralis_minor_r')).toBe(429.8);
    expect(force('trapezius_lower_r')).toBeCloseTo(470.4 + 414.4, 6);
  });

  it('carries a mirror on both sides', () => {
    const right = GIRDLE_UNITS.filter((u) => u.id.endsWith('_r'));
    const left = GIRDLE_UNITS.filter((u) => u.id.endsWith('_l'));
    expect(left).toHaveLength(right.length);
    for (const unit of right) {
      const mirror = left.find((u) => u.id === unit.id.replace(/_r$/, '_l'));
      if (!mirror) throw new Error(`${unit.id} has no left-side counterpart`);
      expect(mirror.parameters.maxIsometricForce).toBe(unit.parameters.maxIsometricForce);
    }
  });
});
