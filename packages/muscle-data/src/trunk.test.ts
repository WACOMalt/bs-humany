import type { ScalarExpr } from '@bs-humany/hsdl';
import {
  buildAttachmentSites,
  buildMuscleViaPointSites,
  buildWrappingSurfaces,
} from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { MUSCLE_SCHEMA_VERSION, type MuscleExtension, MuscleExtensionSchema } from './schema.js';
import { TRUNK_MUSCLES, TRUNK_UNITS } from './trunk.js';
import { validateMuscleExtension } from './validate.js';

const extension: MuscleExtension = { version: MUSCLE_SCHEMA_VERSION, groups: [...TRUNK_MUSCLES] };

function plain(value: ScalarExpr, what: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${what} is an expression, not a number. Has N2.6 landed?`);
  }
  return value;
}

describe('the back and chest muscle set', () => {
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
    expect(report.unitCount).toBe(12);
  });

  it('starts on the trunk and ends on the humerus, which is what these two are for', () => {
    // Nothing in the shoulder set pulls the arm down and across: the deltoid and the cuff lift it
    // and turn it. These are what brings it back.
    for (const unit of TRUNK_UNITS) {
      expect(unit.insertion, unit.id).toMatch(
        /_insertion_[rl]_(intertubercular_sulcus|crest_of_greater_tubercle)$/,
      );
      expect(unit.origin, unit.id).toMatch(
        /_origin_[rl]_(spinous_process_tip|median_sacral_crest|iliac_crest|sternal_end|manubrium_of_sternum|body_of_rib)$/,
      );
    }
  });

  it('carries all three parts of each, including the head that flexes the arm', () => {
    // Two were left out while the guard refused any actuator whose tendon came out negative, and
    // one of them was the clavicular head -- the part that flexes. The guard refuses only an
    // impossible fiber now, the tendon being refitted here regardless. OQ-023.
    expect(TRUNK_UNITS).toHaveLength(12);
    expect(TRUNK_UNITS.some((u) => u.id === 'pectoralis_major_clavicular_r')).toBe(true);
    const latissimus = TRUNK_MUSCLES.find((g) => g.id === 'latissimus_dorsi_r');
    expect(latissimus?.units.map((u) => u.id)).toEqual([
      'latissimus_dorsi_thoracic_r',
      'latissimus_dorsi_lumbar_r',
      'latissimus_dorsi_iliac_r',
    ]);
  });

  it('routes latissimus around the back rather than through the chest', () => {
    // The reference holds it off the trunk with a thorax ellipsoid and a humeral head cylinder,
    // and neither is carried -- the ellipsoid this project refuses outright (OQ-016) and the
    // humeral head was measured and dropped from the shoulder set for flickering. What holds it
    // instead is its own via point on the scapula.
    for (const id of ['latissimus_dorsi_thoracic_r', 'latissimus_dorsi_iliac_r']) {
      const unit = TRUNK_UNITS.find((u) => u.id === id);
      expect(
        unit?.path.filter((e) => e.kind === 'wrap'),
        id,
      ).toHaveLength(0);
      expect(unit?.path.filter((e) => e.kind === 'site').length, id).toBeGreaterThan(0);
    }
  });

  it('gives every unit a citation naming the actuator it came from', () => {
    for (const unit of TRUNK_UNITS) {
      expect(unit.parameters.source.key, unit.id).toBe('caggiano2022');
      expect(unit.parameters.source.locator, unit.id).toContain('myoarm_r_muscle.xml');
    }
  });

  it('gives parameters that are physiologically the right size', () => {
    // Pectoralis major is the stronger of the two across the chest and latissimus the longer
    // reach; both are large muscles and neither has short fibers.
    const force = (id: string) => {
      const unit = TRUNK_UNITS.find((u) => u.id === id);
      if (unit === undefined) throw new Error(`no unit '${id}'`);
      return plain(unit.parameters.maxIsometricForce, id);
    };
    expect(force('pectoralis_major_sternal_r')).toBeGreaterThan(400);
    expect(force('latissimus_dorsi_thoracic_r')).toBeGreaterThan(200);
    for (const unit of TRUNK_UNITS) {
      const optimal = plain(unit.parameters.optimalFiberLength, unit.id);
      // Loose at the top for the same reason the shoulder's is: the lumbar part of latissimus
      // derives a 395 mm fiber because its source's two ranges are strained, and the compile cap
      // -- a fiber at most `FIBER_SHARE_LIMIT` of its own path -- is what holds it. OQ-023.
      expect(optimal, unit.id).toBeGreaterThan(0.02);
      expect(optimal, unit.id).toBeLessThan(0.42);
    }
  });

  it('carries the same muscle on both sides', () => {
    const right = TRUNK_UNITS.filter((u) => u.id.endsWith('_r'));
    const left = TRUNK_UNITS.filter((u) => u.id.endsWith('_l'));
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
