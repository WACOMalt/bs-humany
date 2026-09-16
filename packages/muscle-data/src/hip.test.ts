import type { ScalarExpr } from '@bs-humany/hsdl';
import {
  buildAttachmentSites,
  buildMuscleViaPointSites,
  buildWrappingSurfaces,
} from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { HIP_MUSCLES, HIP_UNITS } from './hip.js';
import { MUSCLE_SCHEMA_VERSION, type MuscleExtension, MuscleExtensionSchema } from './schema.js';
import { validateMuscleExtension } from './validate.js';

const extension: MuscleExtension = { version: MUSCLE_SCHEMA_VERSION, groups: [...HIP_MUSCLES] };

function plain(value: ScalarExpr, what: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${what} is an expression, not a number. Has N2.6 landed?`);
  }
  return value;
}

describe('the hip muscle set', () => {
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
    expect(report.unitCount).toBe(40);
  });

  it('gives each gluteal its own stretch of ilium to pull from', () => {
    // M-ADR-005, and gluteus medius is the plainest case in the body: its front fibres flex and
    // internally rotate the femur, its back fibres extend and externally rotate it. One line down
    // the middle does neither, and a model with one has no abductor that works through a stride.
    const medius = HIP_MUSCLES.find((g) => g.id === 'gluteus_medius_r');
    expect(medius?.units.map((u) => u.id)).toEqual([
      'gluteus_medius_anterior_r',
      'gluteus_medius_middle_r',
      'gluteus_medius_posterior_r',
    ]);
    const origins = medius?.units.map((u) => u.origin) ?? [];
    expect(new Set(origins).size, origins.join(', ')).toBe(3);
  });

  it('leaves out the part of gluteus maximus the source cannot describe', () => {
    // `glmax3_r` states an operating range and a length range that imply a 408 mm fiber on a
    // tendon 260 mm shorter than nothing -- coracobrachialis again. Two parts, not three.
    const maximus = HIP_MUSCLES.find((g) => g.id === 'gluteus_maximus_r');
    expect(maximus?.units).toHaveLength(2);
    expect(HIP_UNITS.some((u) => u.id.includes('maximus_inferior'))).toBe(false);
  });

  it('carries the three that pass the knee to the bones below it', () => {
    // Tensor fasciae latae ends in the iliotibial tract and gracilis and sartorius in the pes
    // anserinus, so all three reach the tibia. They are hip muscles a knee feels.
    for (const id of ['tensor_fasciae_latae_r', 'gracilis_r', 'sartorius_r']) {
      const unit = HIP_UNITS.find((u) => u.id === id);
      expect(unit?.insertion, id).toMatch(
        /_insertion_r_(medial_surface_of_tibia|tubercle_of_iliotibial_tract)$/,
      );
    }
  });

  it('wraps nothing, for the reason the knee set records', () => {
    // The reference wraps eleven of these. A wrap that engages at some poses and not others moves
    // a path by centimetres between ticks and a stiff tendon turns that into kilonewtons, which
    // is what made the shoulder twitch. What holds these paths is their via points.
    for (const unit of HIP_UNITS) {
      expect(
        unit.path.filter((e) => e.kind === 'wrap'),
        unit.id,
      ).toHaveLength(0);
    }
  });

  it('gives every unit a citation naming the actuator it came from', () => {
    for (const unit of HIP_UNITS) {
      expect(unit.parameters.source.key, unit.id).toBe('caggiano2022');
      expect(unit.parameters.source.locator, unit.id).toContain('myolegs_muscle.xml');
      expect(unit.parameters.source.locator, unit.id).toMatch(/name="[A-Za-z0-9_]+"/);
    }
  });

  it('gives parameters that are physiologically the right size', () => {
    // The check that the extraction mapped the right actuator to the right muscle, which no
    // amount of arithmetic would catch. Gluteus maximus is the largest muscle in the body and
    // out-pulls the whole of gluteus minimus several times over; sartorius and gracilis are
    // straps and pull less than any gluteal.
    const force = (id: string) => {
      const unit = HIP_UNITS.find((u) => u.id === id);
      if (unit === undefined) throw new Error(`no unit '${id}'`);
      return plain(unit.parameters.maxIsometricForce, id);
    };
    const maximus = ['superior', 'middle'].map((p) => force(`gluteus_maximus_${p}_r`));
    const minimus = ['anterior', 'middle', 'posterior'].map((p) => force(`gluteus_minimus_${p}_r`));
    const sum = (f: number[]) => f.reduce((t, v) => t + v, 0);
    expect(sum(maximus)).toBeGreaterThan(2 * sum(minimus));
    expect(force('sartorius_r')).toBeLessThan(Math.min(...minimus));
    expect(force('gracilis_r')).toBeLessThan(Math.min(...minimus));
    for (const unit of HIP_UNITS) {
      const optimal = plain(unit.parameters.optimalFiberLength, unit.id);
      // Nothing at the hip has fibers shorter than a centimetre or longer than sartorius, which
      // is the longest muscle in the body.
      expect(optimal, unit.id).toBeGreaterThan(0.01);
      expect(optimal, unit.id).toBeLessThan(0.45);
    }
  });

  it('carries the same muscle on both hips', () => {
    const right = HIP_UNITS.filter((u) => u.id.endsWith('_r'));
    const left = HIP_UNITS.filter((u) => u.id.endsWith('_l'));
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
