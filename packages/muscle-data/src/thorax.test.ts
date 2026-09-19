import type { ScalarExpr } from '@bs-humany/hsdl';
import {
  buildAttachmentSites,
  buildMuscleViaPointSites,
  buildWrappingSurfaces,
} from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { MUSCLE_SCHEMA_VERSION, type MuscleExtension, MuscleExtensionSchema } from './schema.js';
import { THORAX_MUSCLES, THORAX_UNITS } from './thorax.js';
import { validateMuscleExtension } from './validate.js';

const extension: MuscleExtension = {
  version: MUSCLE_SCHEMA_VERSION,
  groups: [...THORAX_MUSCLES],
};

function plain(value: ScalarExpr, what: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${what} is an expression, not a number. Has N2.6 landed?`);
  }
  return value;
}

describe('the thorax muscle set', () => {
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
    // An external and an internal sheet in each of eleven spaces, both sides.
    expect(report.unitCount).toBe(44);
  });

  it('fills every space between adjacent ribs, both sheets', () => {
    const ids = new Set(THORAX_UNITS.map((u) => u.id));
    for (let n = 1; n <= 11; n++) {
      for (const s of ['r', 'l']) {
        expect(ids, `space ${n} ${s}`).toContain(`external_intercostal_${n}_${s}`);
        expect(ids, `space ${n} ${s}`).toContain(`internal_intercostal_${n}_${s}`);
      }
    }
    // Each runs from the rib above's lower border to the rib below's upper border.
    const external = THORAX_UNITS.find((u) => u.id === 'external_intercostal_6_r');
    const internal = THORAX_UNITS.find((u) => u.id === 'internal_intercostal_6_r');
    expect(external?.origin).toBe('external_intercostal_6_origin_r_lower_border_at_50');
    expect(external?.insertion).toBe('external_intercostal_6_insertion_r_upper_border_at_60');
    expect(internal?.origin).toBe('internal_intercostal_6_origin_r_lower_border_at_70');
  });

  it('is sized by rib length, as Bruno 2015 sizes them, and says so', () => {
    for (const unit of THORAX_UNITS) {
      expect(unit.parameters.source.key).toBe('bruno2015');
      expect(unit.parameters.source.locator).toMatch(/mean rib length [\d.]+ mm/);
    }
    // The long middle ribs make the strongest sheets, the first and last spaces the weakest.
    const force = (id: string) => {
      const unit = THORAX_UNITS.find((u) => u.id === id);
      if (unit === undefined) throw new Error(`no unit '${id}'`);
      return plain(unit.parameters.maxIsometricForce, id);
    };
    expect(force('external_intercostal_6_r')).toBeGreaterThan(force('external_intercostal_1_r'));
    expect(force('external_intercostal_6_r')).toBeGreaterThan(force('external_intercostal_11_r'));
    // A sheet's fibres span the interspace: a few centimetres.
    for (const unit of THORAX_UNITS) {
      const fibre = plain(unit.parameters.optimalFiberLength, unit.id);
      expect(fibre, unit.id).toBeGreaterThan(0.01);
      expect(fibre, unit.id).toBeLessThan(0.08);
    }
  });

  it('carries a mirror on both sides', () => {
    const right = THORAX_UNITS.filter((u) => u.id.endsWith('_r'));
    const left = THORAX_UNITS.filter((u) => u.id.endsWith('_l'));
    expect(left).toHaveLength(right.length);
    for (const unit of right) {
      const mirror = left.find((u) => u.id === unit.id.replace(/_r$/, '_l'));
      if (!mirror) throw new Error(`${unit.id} has no left-side counterpart`);
      const ratio =
        plain(mirror.parameters.maxIsometricForce, mirror.id) /
        plain(unit.parameters.maxIsometricForce, unit.id);
      expect(Math.abs(ratio - 1), unit.id).toBeLessThan(0.02);
    }
  });
});
