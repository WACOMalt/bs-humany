import {
  ANKLE_MUSCLES,
  ELBOW_MUSCLES,
  FOREARM_MUSCLES,
  HIP_MUSCLES,
  KNEE_MUSCLES,
  SHOULDER_MUSCLES,
  TORSO_MUSCLES,
  TRUNK_MUSCLES,
} from '@bs-humany/muscle-data';
import { describe, expect, it } from 'vitest';
import { MUSCLE_GROUPS } from './muscleGroups.js';

describe('the drive groups', () => {
  it('cover every unit in the muscle data exactly once', () => {
    const inData = new Set<string>();
    for (const region of [
      ELBOW_MUSCLES,
      SHOULDER_MUSCLES,
      FOREARM_MUSCLES,
      TORSO_MUSCLES,
      KNEE_MUSCLES,
      HIP_MUSCLES,
      ANKLE_MUSCLES,
      TRUNK_MUSCLES,
    ]) {
      for (const group of region) for (const unit of group.units) inData.add(unit.id);
    }
    const seen = new Map<string, string>();
    for (const group of MUSCLE_GROUPS) {
      for (const unit of group.units) {
        expect(seen.get(unit), `${unit} is in ${seen.get(unit)} and ${group.id}`).toBeUndefined();
        seen.set(unit, group.id);
        expect(inData.has(unit), `${unit} in ${group.id} is not a unit in the data`).toBe(true);
      }
    }
    const uncovered = [...inData].filter((id) => !seen.has(id));
    expect(uncovered, 'units no slider reaches').toEqual([]);
    expect(inData.size).toBeGreaterThan(100);
    // And the ids are unique, since they become element ids.
    expect(new Set(MUSCLE_GROUPS.map((g) => g.id)).size).toBe(MUSCLE_GROUPS.length);
  });
});
