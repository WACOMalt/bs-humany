import type { ScalarExpr } from '@bs-humany/hsdl';
import {
  buildAttachmentSites,
  buildMuscleViaPointSites,
  buildWrappingSurfaces,
} from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { FOREARM_MUSCLES, FOREARM_UNITS } from './forearm.js';
import { MUSCLE_SCHEMA_VERSION, type MuscleExtension, MuscleExtensionSchema } from './schema.js';
import { validateMuscleExtension } from './validate.js';

const extension: MuscleExtension = { version: MUSCLE_SCHEMA_VERSION, groups: [...FOREARM_MUSCLES] };

function plain(value: ScalarExpr, what: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${what} is an expression, not a number. Has N2.6 landed?`);
  }
  return value;
}

describe('the forearm and wrist muscle set', () => {
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
    expect(report.unitCount).toBe(16);
  });

  it('lands on fiber lengths a real forearm has', () => {
    // The point of OQ-022's stand-in, and the check that it is a good one. Six of these eight
    // actuators state no operating range, so their fiber length is the length range the source
    // *does* state over the travel a muscle typically has. Against published architecture:
    const published: Record<string, number> = {
      pronator_teres_r: 36,
      pronator_quadratus_r: 23,
      supinator_r: 33,
      anconeus_r: 27,
      flexor_carpi_radialis_r: 52,
      flexor_carpi_ulnaris_r: 51,
      extensor_carpi_radialis_brevis_r: 59,
    };
    for (const [id, mm] of Object.entries(published)) {
      const unit = FOREARM_UNITS.find((u) => u.id === id);
      if (!unit) throw new Error(`no unit '${id}'`);
      const optimal = plain(unit.parameters.optimalFiberLength, id) * 1000;
      expect(
        Math.abs(optimal / mm - 1),
        `${id}: ${optimal.toFixed(0)} mm against ${mm}`,
      ).toBeLessThan(0.3);
    }
    // Extensor carpi radialis longus is the one that does not: 42 mm against a published 81. It is
    // a stand-in and this is what a stand-in being wrong looks like.
    const ecrl = FOREARM_UNITS.find((u) => u.id === 'extensor_carpi_radialis_longus_r');
    expect(plain(ecrl?.parameters.optimalFiberLength as ScalarExpr, 'ecrl') * 1000).toBeLessThan(
      60,
    );
  });

  it('leaves out the two the hand gives nowhere to put', () => {
    // Extensor carpi ulnaris ends on the base of the fifth metacarpal and palmaris longus in the
    // middle of the palm; the dataset marks neither, and the marked points nearby all belong to a
    // muscle already here. The wrist gets two flexors, one radial and one ulnar, and two
    // extensors, both radial.
    expect(FOREARM_UNITS).toHaveLength(16);
    expect(FOREARM_UNITS.some((u) => u.id.startsWith('extensor_carpi_ulnaris'))).toBe(false);
    expect(FOREARM_UNITS.some((u) => u.id.startsWith('palmaris'))).toBe(false);
  });

  it('takes the two ends of one ridge for two different muscles', () => {
    // Extensor carpi radialis longus arises from the lower third of the lateral supracondylar
    // ridge and brachioradialis from the upper two-thirds. The dataset marks that ridge once, near
    // its bottom; `ridgeAttachments.ts` measures both portions, 14 mm above the elbow and 65.
    const ecrl = FOREARM_UNITS.find((u) => u.id === 'extensor_carpi_radialis_longus_r');
    expect(ecrl?.origin).toBe(
      'extensor_carpi_radialis_longus_origin_r_lateral_supracondylar_ridge',
    );
  });

  it('gives every unit a citation naming the actuator it came from', () => {
    for (const unit of FOREARM_UNITS) {
      expect(unit.parameters.source.key, unit.id).toBe('caggiano2022');
      expect(unit.parameters.source.locator, unit.id).toContain('myoarm_r_muscle.xml');
    }
  });

  it('carries the same muscle on both forearms', () => {
    const right = FOREARM_UNITS.filter((u) => u.id.endsWith('_r'));
    const left = FOREARM_UNITS.filter((u) => u.id.endsWith('_l'));
    expect(left).toHaveLength(right.length);
    for (const unit of right) {
      const mirror = left.find((u) => u.id === unit.id.replace(/_r$/, '_l'));
      if (!mirror) throw new Error(`${unit.id} has no left-side counterpart`);
      expect(plain(mirror.parameters.maxIsometricForce, mirror.id)).toBe(
        plain(unit.parameters.maxIsometricForce, unit.id),
      );
    }
  });
});
