import type { ScalarExpr } from '@bs-humany/hsdl';
import {
  buildAttachmentSites,
  buildMuscleViaPointSites,
  buildWrappingSurfaces,
} from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { ANKLE_MUSCLES, ANKLE_UNITS } from './ankle.js';
import { MUSCLE_SCHEMA_VERSION, type MuscleExtension, MuscleExtensionSchema } from './schema.js';
import { validateMuscleExtension } from './validate.js';

const extension: MuscleExtension = { version: MUSCLE_SCHEMA_VERSION, groups: [...ANKLE_MUSCLES] };

function plain(value: ScalarExpr, what: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${what} is an expression, not a number. Has N2.6 landed?`);
  }
  return value;
}

describe('the ankle muscle set', () => {
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

  it('wraps nothing, because a retinaculum is not a pulley', () => {
    // What holds a tendon at the ankle is a band of fascia strapping it into a groove, which is a
    // via point -- a place the path passes through -- and not a surface it turns over a radius on.
    // The reference models all nine the same way.
    for (const unit of ANKLE_UNITS) {
      expect(
        unit.path.filter((e) => e.kind === 'wrap'),
        unit.id,
      ).toHaveLength(0);
    }
  });

  it('runs the anterior compartment straight, because the carried points are worse than none', () => {
    // OQ-021. Via points are carried through one frame correspondence fitted at the femur, and by
    // the ankle they are out by about 20 mm -- nothing to a tendon 50 mm behind the joint,
    // everything to one 40 mm in front. Carried, tibialis anterior had a 4 mm dorsiflexion arm.
    for (const id of [
      'tibialis_anterior_r',
      'extensor_digitorum_longus_r',
      'extensor_hallucis_longus_r',
    ]) {
      const unit = ANKLE_UNITS.find((u) => u.id === id);
      expect(unit?.path, id).toEqual([]);
    }
    // And the posterior and lateral ones keep theirs, because theirs come out right.
    const posterior = ANKLE_UNITS.find((u) => u.id === 'fibularis_longus_r');
    expect(posterior?.path.length).toBeGreaterThan(0);
  });

  it('stops the four long toe muscles at the metatarsals, and says so', () => {
    // The dataset marks no phalangeal feature at all, so these four keep their line through the
    // ankle and have no action at the toes. OQ-021.
    for (const id of [
      'extensor_digitorum_longus_r',
      'extensor_hallucis_longus_r',
      'flexor_digitorum_longus_r',
      'flexor_hallucis_longus_r',
    ]) {
      const unit = ANKLE_UNITS.find((u) => u.id === id);
      expect(unit?.insertion, id).toMatch(/_insertion_r_head_of_metatarsal_bone$/);
    }
  });

  it('gives every unit a citation naming the actuator it came from', () => {
    for (const unit of ANKLE_UNITS) {
      expect(unit.parameters.source.key, unit.id).toBe('caggiano2022');
      expect(unit.parameters.source.locator, unit.id).toContain('myolegs_muscle.xml');
    }
  });

  it('gives parameters that are physiologically the right size', () => {
    // Soleus is the strongest muscle below the knee by a wide margin -- it carries the body's
    // weight through every step -- and the long toe muscles are the weakest here.
    const force = (id: string) => {
      const unit = ANKLE_UNITS.find((u) => u.id === id);
      if (unit === undefined) throw new Error(`no unit '${id}'`);
      return plain(unit.parameters.maxIsometricForce, id);
    };
    expect(force('soleus_r')).toBeGreaterThan(3000);
    expect(force('soleus_r')).toBeGreaterThan(2 * force('tibialis_anterior_r'));
    expect(force('extensor_hallucis_longus_r')).toBeLessThan(force('tibialis_anterior_r'));
    for (const unit of ANKLE_UNITS) {
      const optimal = plain(unit.parameters.optimalFiberLength, unit.id);
      // Everything here is a short-fibred, long-tendoned muscle: nothing below the knee has
      // fibers longer than a tenth of a metre.
      expect(optimal, unit.id).toBeGreaterThan(0.01);
      expect(optimal, unit.id).toBeLessThan(0.1);
    }
  });

  it('carries the same muscle on both ankles', () => {
    const right = ANKLE_UNITS.filter((u) => u.id.endsWith('_r'));
    const left = ANKLE_UNITS.filter((u) => u.id.endsWith('_l'));
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
