import type { ScalarExpr } from '@bs-humany/hsdl';
import { buildAttachmentSites, buildWrappingSurfaces } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { ELBOW_MUSCLES, ELBOW_UNITS } from './elbow.js';
import { MUSCLE_SCHEMA_VERSION, type MuscleExtension, MuscleExtensionSchema } from './schema.js';
import { validateMuscleExtension } from './validate.js';

const extension: MuscleExtension = { version: MUSCLE_SCHEMA_VERSION, groups: [...ELBOW_MUSCLES] };

/**
 * Reads a parameter that must be a plain number.
 *
 * HSDL scalars may be expressions, because most of the skeleton scales with stature. These do not
 * yet -- section 6.6 wants muscle parameters to scale too, which is N2.6 -- so a parameter that
 * arrived here as an expression would mean that work had landed without these tests being
 * revisited. Failing loudly beats casting past it.
 */
function plain(value: ScalarExpr, what: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${what} is an expression, not a number. Has N2.6 landed?`);
  }
  return value;
}

describe('the elbow muscle set', () => {
  it('parses against its own schema', () => {
    const parsed = MuscleExtensionSchema.safeParse(extension);
    expect(parsed.success ? null : parsed.error.issues).toBe(null);
  });

  it('binds to attachment sites the skeleton actually has', () => {
    // The test that makes the data real. Every origin and insertion names a site built in M5.3
    // from this subject's markers; if a site is ever renamed there, this fails here rather than
    // as a path-solver compile error in a package that cannot say which muscle asked for it.
    const report = validateMuscleExtension(
      { attachmentSites: buildAttachmentSites(), wrappingSurfaces: buildWrappingSurfaces() },
      extension,
    );
    expect(report.problems).toEqual([]);
    expect(report.unitCount).toBe(7);
  });

  it('covers both biceps heads and all three triceps heads as separate lines of action', () => {
    // M-ADR-005. One line through a triceps is not a simplification of a triceps, it is a
    // different muscle with a moment arm the real one does not have.
    expect(ELBOW_UNITS).toHaveLength(7);
    expect(ELBOW_MUSCLES.map((g) => g.id)).toEqual([
      'biceps_brachii_r',
      'brachialis_r',
      'brachioradialis_r',
      'triceps_brachii_r',
    ]);
    expect(ELBOW_MUSCLES.find((g) => g.id === 'triceps_brachii_r')?.units).toHaveLength(3);
  });

  it('gives every unit a citation naming the actuator it came from', () => {
    // CONTRIBUTING rule 3, checked at the level the lint cannot reach: not just that a citation
    // is present, but that its locator names the specific element, so a reviewer can find the
    // number without reading the whole file.
    for (const unit of ELBOW_UNITS) {
      expect(unit.parameters.source.key, unit.id).toBe('caggiano2022');
      expect(unit.parameters.source.locator, unit.id).toContain('myoarm_r_muscle.xml');
      expect(unit.parameters.source.locator, unit.id).toMatch(/name="[A-Za-z0-9]+"/);
    }
  });

  it('gives parameters that are physiologically the right size', () => {
    // Not a precision check -- the generator guarantees the digits. This is the check that the
    // derivation from MuJoCo's range and lengthrange produced lengths at all, rather than the
    // plausible-looking nonsense a sign error or a swapped pair would give.
    for (const unit of ELBOW_UNITS) {
      const p = unit.parameters;
      const force = plain(p.maxIsometricForce, `${unit.id} force`);
      const fiber = plain(p.optimalFiberLength, `${unit.id} fiber length`);
      const tendon = plain(p.tendonSlackLength, `${unit.id} tendon slack`);
      expect(force, unit.id).toBeGreaterThan(50);
      expect(force, unit.id).toBeLessThan(2000);
      // A human elbow muscle's fibers are centimetres, not millimetres or metres.
      expect(fiber, unit.id).toBeGreaterThan(0.02);
      expect(fiber, unit.id).toBeLessThan(0.25);
      expect(tendon, unit.id).toBeGreaterThan(0.01);
      expect(tendon, unit.id).toBeLessThan(0.4);
    }
  });

  it('makes the elbow stronger in flexion than the brachialis alone, and stronger still in extension', () => {
    // A statement about the set rather than about any unit, and one an error in a single number
    // would break: brachialis is the largest single flexor, the three triceps heads together are
    // the strongest group, and the flexors do not out-pull the extensors.
    const force = (id: string) => {
      const unit = ELBOW_UNITS.find((u) => u.id === id);
      if (unit === undefined) throw new Error(`no unit '${id}'`);
      return plain(unit.parameters.maxIsometricForce, id);
    };
    const flexors = [
      'biceps_brachii_long_r',
      'biceps_brachii_short_r',
      'brachialis_r',
      'brachioradialis_r',
    ];
    const extensors = [
      'triceps_brachii_long_r',
      'triceps_brachii_lateral_r',
      'triceps_brachii_medial_r',
    ];
    const sum = (ids: string[]) => ids.reduce((t, id) => t + force(id), 0);

    expect(force('brachialis_r')).toBeGreaterThan(force('biceps_brachii_long_r'));
    expect(sum(flexors)).toBeGreaterThan(force('brachialis_r'));
    expect(sum(extensors)).toBeGreaterThan(1500);
    expect(sum(extensors)).toBeGreaterThan(sum(flexors) * 0.8);
  });

  it('agrees with the muscle model about the maximum contraction velocity', () => {
    // The source states 10 optimal fiber lengths per second for every unit, which is the value
    // muscle-model carries as its cited default. Two independent sources landing on the same
    // number is worth asserting, because if one ever moves this says so.
    for (const unit of ELBOW_UNITS) {
      expect(unit.parameters.maxContractionVelocity, unit.id).toBe(10);
    }
  });

  it('lays every unit against the bone, on the side its anatomy puts it', () => {
    // The three heads of triceps run behind the joint axis and the four flexors in front of it.
    // Declaring the side is what stops a path falling to the other side of the bone as the joint
    // moves, which would reverse the muscle's moment arm for a tick (muscle spec 4.3). In this
    // dataset's bone frame +Z is posterior: the olecranon fossa sits behind the coronoid one.
    const extensors = [
      'triceps_brachii_long_r',
      'triceps_brachii_lateral_r',
      'triceps_brachii_medial_r',
    ];
    for (const unit of ELBOW_UNITS) {
      expect(unit.path, unit.id).toHaveLength(1);
      const wrap = unit.path[0];
      if (wrap?.kind !== 'wrap') throw new Error(`${unit.id} does not wrap`);
      const behind = extensors.includes(unit.id);
      // The extensors turn over the trochlea, coaxial with the elbow, which is what holds their
      // moment arm at its radius through the range. The flexors never reach it -- their paths
      // pass in front and clear it at every angle -- so theirs is the shaft, which they lie
      // along rather than pass through.
      expect(wrap.surface, unit.id).toBe(behind ? 'elbow_trochlea_r' : 'humerus_shaft_r');
      expect(Math.sign(wrap.preferredSide.z as number), unit.id).toBe(behind ? 1 : -1);
    }
  });
});
