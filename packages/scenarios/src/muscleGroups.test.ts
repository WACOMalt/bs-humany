import { createHash } from 'node:crypto';
import { ALL_MUSCLES } from '@bs-humany/muscle-data';
import { describe, expect, it } from 'vitest';
import { ANTAGONISTS, MUSCLE_GROUPS, reflexGroups, unitsOnSide } from './muscleGroups.js';
import { driveOutputs } from './nerves.js';

describe('the drive groups', () => {
  it('cover every unit in the muscle data exactly once', () => {
    const inData = new Set<string>();
    for (const group of ALL_MUSCLES) for (const unit of group.units) inData.add(unit.id);
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

  it('split into a right half and a left half, with nothing left over', () => {
    // Everything that works a side at a time -- the policy's outputs, the cord's reflex groups --
    // splits a group by the `_r` / `_l` at the end of its unit ids. A unit named without one would
    // belong to neither side and drop silently out of both, so every unit is held to having one,
    // and the two halves are held to being the whole group between them.
    for (const group of MUSCLE_GROUPS) {
      for (const unit of group.units) {
        expect(/_[rl]$/.test(unit), `${unit} in ${group.id} names no side`).toBe(true);
      }
      const right = unitsOnSide(group, 'r');
      const left = unitsOnSide(group, 'l');
      expect(right.length, `${group.id} has nothing on the right`).toBeGreaterThan(0);
      expect(left.length, `${group.id} has nothing on the left`).toBeGreaterThan(0);
      expect([...right, ...left].sort()).toEqual([...group.units].sort());
      expect(right.every((u) => u.endsWith('_r'))).toBe(true);
      expect(left.every((u) => u.endsWith('_l'))).toBe(true);
    }
  });
});

describe('the reflex groups', () => {
  const groups = reflexGroups();

  it('are one-sided, and a group is opposed by its antagonist on the same side', () => {
    // A reflex group holding both legs let a stretched right soleus excite the left one, and
    // inhibit the left shin as much as the right. A real cord does neither: the stretch reflex and
    // the Ia interneuron that inhibits the antagonist are segmental, on the side the spindle is on.
    // So each reflex group is one side of a drive group, and what it inhibits is the same side of
    // that drive group's antagonist.
    expect(groups.length).toBe(2 * MUSCLE_GROUPS.length);
    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.size, 'reflex group ids are unique').toBe(groups.length);
    for (const group of groups) {
      const side = group.id.slice(-1);
      expect(side === 'r' || side === 'l', `${group.id} names no side`).toBe(true);
      expect(group.id.endsWith(`:${side}`)).toBe(true);
      expect(group.units.length).toBeGreaterThan(0);
      for (const unit of group.units) {
        expect(unit.endsWith(`_${side}`), `${unit} is in ${group.id}`).toBe(true);
      }
      const opposite = ANTAGONISTS.get(group.id.slice(0, -2));
      if (opposite === undefined) {
        expect(group.antagonist).toBeUndefined();
        continue;
      }
      expect(group.antagonist).toBe(`${opposite}:${side}`);
      const antagonist = byId.get(group.antagonist as string);
      expect(antagonist, `${group.id} is opposed by a group that is not there`).toBeDefined();
      expect(antagonist?.units.every((u) => u.endsWith(`_${side}`))).toBe(true);
      // And the pairing is symmetric, side for side.
      expect(antagonist?.antagonist).toBe(group.id);
    }
  });

  it('share their ids and units with the policy outputs, in the same order', () => {
    // One id for one side of one group, whichever layer drives it, so a panel can set the brain's
    // output and the cord's answer for the same muscles side by side without a table between them.
    const outputs = driveOutputs();
    expect(groups.map((g) => g.id)).toEqual(outputs.map((o) => o.id));
    expect(groups.map((g) => g.units)).toEqual(outputs.map((o) => o.units.map((u) => u.id)));
  });
});

describe('the policy outputs', () => {
  it('are exactly what they were before the side split moved into muscleGroups', () => {
    // The outputs are a checkpoint's ABI: a policy's last layer is read by output index, so an
    // output that moved, gained a unit or lost one would hand every trained policy the wrong
    // muscles without an error anywhere. The side split `driveOutputs` did inline is now the shared
    // `unitsOnSide`, and this holds the result to a hash of the ids, units and weights taken from
    // the inline version before it was replaced (at 8cc1e95): seventy outputs, 272 units.
    const outputs = driveOutputs();
    expect(outputs.length).toBe(70);
    expect(outputs.reduce((n, o) => n + o.units.length, 0)).toBe(272);
    const hash = createHash('sha256').update(JSON.stringify(outputs)).digest('hex');
    expect(hash).toBe('c7de50b42f685100b86087096d8e02c278be678e6f3a1c9d58a993427b1ec78e');
  });
});
