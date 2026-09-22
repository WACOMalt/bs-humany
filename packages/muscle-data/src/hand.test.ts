import {
  buildAttachmentSites,
  buildMuscleViaPointSites,
  buildWrappingSurfaces,
} from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { HAND_MUSCLES, HAND_UNITS } from './hand.js';
import { MUSCLE_SCHEMA_VERSION, type MuscleExtension, MuscleExtensionSchema } from './schema.js';
import { validateMuscleExtension } from './validate.js';

const extension: MuscleExtension = { version: MUSCLE_SCHEMA_VERSION, groups: [...HAND_MUSCLES] };

describe('the hand muscle set', () => {
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
    expect(report.unitCount).toBe(38);
  });

  it('gives every digital tendon a path, because a straight one does not bend a finger', () => {
    // The whole reason this set could not simply be generated beside the forearm's. A finger
    // flexor with no path runs from the medial epicondyle to a fingertip and pulls the finger off
    // its joints; what makes it a flexor is being held against the palmar side of every bone it
    // crosses. The count is one point at the wrist plus one per bone for a flexor, and plus two
    // per bone for an extensor, which needs its bases too (see `heldAt` in attachments.ts).
    for (const unit of HAND_UNITS) {
      // The two that act at the wrist rather than on a digit pass one point and need no more.
      const wristOnly = /^(extensor_carpi_ulnaris|abductor_pollicis_longus)_/.test(unit.id);
      expect(unit.path.length, unit.id).toBeGreaterThanOrEqual(wristOnly ? 1 : 3);
    }
  });

  it('stops superficialis a phalanx short of profundus, which is the difference between them', () => {
    for (const d of [2, 3, 4, 5]) {
      const fds = HAND_UNITS.find((u) => u.id === `flexor_digitorum_superficialis_${d}_r`);
      const fdp = HAND_UNITS.find((u) => u.id === `flexor_digitorum_profundus_${d}_r`);
      expect(fds?.insertion, `superficialis ${d}`).toBe(
        `flexor_digitorum_superficialis_${d}_insertion_r_flexor_side_of_shaft`,
      );
      expect(fdp?.insertion, `profundus ${d}`).toBe(
        `flexor_digitorum_profundus_${d}_insertion_r_flexor_side_of_shaft`,
      );
      // Superficialis crosses one joint fewer, so it passes one bone fewer.
      expect((fds?.path.length ?? 0) + 1, `slips of digit ${d}`).toBe(fdp?.path.length);
    }
  });

  it('ends every tendon on the side of the bone it pulls from', () => {
    // Not a nicety: a tendon ending at the centre of a base ends on the joint it is meant to move
    // and has no leverage there at all, and one ending on the base's own side still swings across
    // its own line as the bone turns. Both were measured. The shaft is where Gray puts them and
    // where they work.
    for (const unit of HAND_UNITS) {
      if (/^(extensor_carpi_ulnaris|abductor_pollicis_longus)_/.test(unit.id)) {
        expect(unit.insertion, unit.id).toMatch(/_base_of_digit_bone$/);
        continue;
      }
      const side = unit.id.startsWith('flexor') ? 'flexor' : 'extensor';
      expect(unit.insertion, unit.id).toMatch(new RegExp(`_${side}_side_of_shaft$`));
    }
  });

  it('gives every unit a citation naming the actuator it came from', () => {
    for (const unit of HAND_UNITS) {
      expect(unit.parameters.source.locator, unit.id).toMatch(/actuator name="[A-Z0-9]+"/);
    }
  });
});
