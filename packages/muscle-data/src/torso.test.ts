import type { ScalarExpr } from '@bs-humany/hsdl';
import {
  buildAttachmentSites,
  buildMuscleViaPointSites,
  buildWrappingSurfaces,
} from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { MUSCLE_SCHEMA_VERSION, type MuscleExtension, MuscleExtensionSchema } from './schema.js';
import { TORSO_MUSCLES, TORSO_UNITS } from './torso.js';
import { validateMuscleExtension } from './validate.js';

const extension: MuscleExtension = { version: MUSCLE_SCHEMA_VERSION, groups: [...TORSO_MUSCLES] };

function plain(value: ScalarExpr, what: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${what} is an expression, not a number. Has N2.6 landed?`);
  }
  return value;
}

describe('the torso muscle set', () => {
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
    expect(report.unitCount).toBe(8);
  });

  it('gives the trunk something on both sides of it', () => {
    // The set's whole point. Erector spinae behind, rectus abdominis in front, and the two
    // obliques crossing between them, so the trunk flexes, extends and rotates. Written first
    // without the first two, because each states a tendon shorter than nothing; OQ-023 is why
    // they are here.
    const ids = TORSO_UNITS.map((u) => u.id);
    for (const id of [
      'erector_spinae_r',
      'rectus_abdominis_r',
      'external_oblique_r',
      'internal_oblique_r',
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it('crosses the obliques, which is what makes them a pair', () => {
    // The external runs downward and forward from the ribs to the pubis; the internal upward and
    // forward from the iliac spine to the ribs. Drawn between the same two points they would be
    // one muscle drawn twice.
    const external = TORSO_UNITS.find((u) => u.id === 'external_oblique_r');
    const internal = TORSO_UNITS.find((u) => u.id === 'internal_oblique_r');
    expect(external?.origin).toContain('body_of_rib');
    expect(external?.insertion).toContain('pubic_tubercle');
    expect(internal?.origin).toContain('anterior_superior_iliac_spine');
    expect(internal?.insertion).toContain('body_of_rib');
  });

  it('takes rectus abdominis from the detailed model, and says which file', () => {
    // The abdomen model does not carry it. Its citation has to name the file it did come from,
    // or the number here and the number in the cited file would be different things.
    const rectus = TORSO_UNITS.find((u) => u.id === 'rectus_abdominis_r');
    expect(rectus?.parameters.source.locator).toContain('myotorso_muscle.xml');
    const oblique = TORSO_UNITS.find((u) => u.id === 'external_oblique_r');
    expect(oblique?.parameters.source.locator).toContain('myotorso_abdomen_muscle.xml');
  });

  it('gives parameters that are physiologically the right size', () => {
    const force = (id: string) => {
      const unit = TORSO_UNITS.find((u) => u.id === id);
      if (unit === undefined) throw new Error(`no unit '${id}'`);
      return plain(unit.parameters.maxIsometricForce, id);
    };
    // Erector spinae is the strongest of the four by a wide margin: it holds the trunk up against
    // gravity all day, and the abdominal wall has no such job.
    expect(force('erector_spinae_r')).toBeGreaterThan(2000);
    expect(force('erector_spinae_r')).toBeGreaterThan(force('rectus_abdominis_r'));
    expect(force('internal_oblique_r')).toBeGreaterThan(force('external_oblique_r'));
  });

  it('carries a near-mirror on both sides, which is the source and not a slip', () => {
    // Every other set in this project reads a one-sided reference and mirrors it, so its two
    // sides agree to the digit. The torso model states both sides separately and they are not
    // identical: erector spinae is 2481 N on the right and 2436 on the left, internal oblique
    // 1353 against 1255, which is eight per cent. That is what the file says, and transcribing it
    // faithfully means carrying the difference rather than averaging it away.
    const right = TORSO_UNITS.filter((u) => u.id.endsWith('_r'));
    const left = TORSO_UNITS.filter((u) => u.id.endsWith('_l'));
    expect(left).toHaveLength(right.length);
    for (const unit of right) {
      const mirror = left.find((u) => u.id === unit.id.replace(/_r$/, '_l'));
      if (!mirror) throw new Error(`${unit.id} has no left-side counterpart`);
      const ratio =
        plain(mirror.parameters.maxIsometricForce, mirror.id) /
        plain(unit.parameters.maxIsometricForce, unit.id);
      expect(Math.abs(ratio - 1), `${unit.id}: ${(ratio * 100 - 100).toFixed(1)}%`).toBeLessThan(
        0.1,
      );
    }
  });
});
