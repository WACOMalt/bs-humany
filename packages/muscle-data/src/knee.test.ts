import type { ScalarExpr } from '@bs-humany/hsdl';
import {
  buildAttachmentSites,
  buildMuscleViaPointSites,
  buildWrappingSurfaces,
} from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { KNEE_MUSCLES, KNEE_UNITS } from './knee.js';
import { MUSCLE_SCHEMA_VERSION, type MuscleExtension, MuscleExtensionSchema } from './schema.js';
import { validateMuscleExtension } from './validate.js';

const extension: MuscleExtension = { version: MUSCLE_SCHEMA_VERSION, groups: [...KNEE_MUSCLES] };

function plain(value: ScalarExpr, what: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${what} is an expression, not a number. Has N2.6 landed?`);
  }
  return value;
}

describe('the knee muscle set', () => {
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

  it('gives the quadriceps four lines of action and the flexors six', () => {
    // M-ADR-005 again, and the quadriceps are the clearest case for it: vastus medialis and
    // lateralis pull the patella in opposite directions across the joint, and a single line down
    // the middle of the thigh has neither effect.
    const quadriceps = KNEE_MUSCLES.find((g) => g.id === 'quadriceps_femoris_r');
    expect(quadriceps?.units.map((u) => u.id)).toEqual([
      'rectus_femoris_r',
      'vastus_lateralis_r',
      'vastus_medialis_r',
      'vastus_intermedius_r',
    ]);
    const flexors = [
      'biceps_femoris_long_r',
      'biceps_femoris_short_r',
      'semitendinosus_r',
      'semimembranosus_r',
      'gastrocnemius_lateral_r',
      'gastrocnemius_medial_r',
    ];
    for (const id of flexors) {
      expect(
        KNEE_UNITS.some((u) => u.id === id),
        id,
      ).toBe(true);
    }
  });

  it('runs every quadriceps over the patella, which is what the bone is for', () => {
    // Two points apiece, on the patella, measured from this skeleton's own mesh: its most
    // superior and most inferior vertices, which come out about 40 mm in front of the knee's
    // axis. That stand-off is the entire reason a knee has a patella, and without it the
    // extensors had a three millimetre moment arm where they should have forty.
    for (const unit of KNEE_UNITS) {
      if (!/rectus_femoris|vastus/.test(unit.id)) continue;
      const sites = unit.path.filter((element) => element.kind === 'site');
      expect(sites, unit.id).toHaveLength(2);
      for (const site of sites) {
        if (site.kind !== 'site') throw new Error('not a site');
        expect(site.site, unit.id).toContain('__via_');
      }
    }
  });

  it('reaches the tibia through the patellar ligament rather than pretending otherwise', () => {
    // The quadriceps do not attach to the tibia. They converge on the patella and pull through
    // its ligament, and the tuberosity is where that force arrives.
    for (const unit of KNEE_UNITS) {
      if (!/rectus_femoris|vastus/.test(unit.id)) continue;
      expect(unit.insertion, unit.id).toMatch(/_insertion_[rl]_tibial_tuberosity$/);
    }
  });

  it('wraps nothing, because the sweep said no surface here is used steadily', () => {
    // The femoral condyles were given to the hamstrings first, on the reasoning that a path from
    // the ischium to the tibia cuts the corner as the knee closes. Swept from 0 to 120 degrees it
    // turned out not to: six units never touched the surface and two touched it at two poses out
    // of seven, which is the flicker that made the shoulder twitch.
    for (const unit of KNEE_UNITS) {
      expect(
        unit.path.filter((element) => element.kind === 'wrap'),
        unit.id,
      ).toHaveLength(0);
    }
  });

  it('gives every unit a citation naming the actuator it came from', () => {
    for (const unit of KNEE_UNITS) {
      expect(unit.parameters.source.key, unit.id).toBe('caggiano2022');
      expect(unit.parameters.source.locator, unit.id).toContain('myolegs_muscle.xml');
      expect(unit.parameters.source.locator, unit.id).toMatch(/name="[A-Za-z0-9_]+"/);
    }
  });

  it('gives parameters that are physiologically the right size', () => {
    // The check that the extraction mapped the right actuator to the right muscle, which no
    // amount of arithmetic would catch. The knee's muscles are the strongest in the body: vastus
    // lateralis alone out-pulls every muscle in the arm put together, and the quadriceps as a
    // group out-pull the hamstrings, which is why a person can stand up.
    const force = (id: string) => {
      const unit = KNEE_UNITS.find((u) => u.id === id);
      if (unit === undefined) throw new Error(`no unit '${id}'`);
      return plain(unit.parameters.maxIsometricForce, id);
    };
    const quadriceps = [
      'rectus_femoris_r',
      'vastus_lateralis_r',
      'vastus_medialis_r',
      'vastus_intermedius_r',
    ].map(force);
    const hamstrings = [
      'biceps_femoris_long_r',
      'biceps_femoris_short_r',
      'semitendinosus_r',
      'semimembranosus_r',
    ].map(force);
    const sum = (f: number[]) => f.reduce((t, v) => t + v, 0);
    expect(force('vastus_lateralis_r')).toBeGreaterThan(3000);
    expect(sum(quadriceps)).toBeGreaterThan(sum(hamstrings));
    expect(sum(quadriceps)).toBeGreaterThan(8000);
    for (const unit of KNEE_UNITS) {
      const optimal = plain(unit.parameters.optimalFiberLength, unit.id);
      // Nothing at the knee has fibers shorter than a centimetre or longer than the thigh.
      expect(optimal, unit.id).toBeGreaterThan(0.01);
      expect(optimal, unit.id).toBeLessThan(0.4);
    }
  });

  it('carries the same muscle on both knees', () => {
    const right = KNEE_UNITS.filter((u) => u.id.endsWith('_r'));
    const left = KNEE_UNITS.filter((u) => u.id.endsWith('_l'));
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
