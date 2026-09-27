/**
 * The one table of slider bounds (`CONTROL_RANGES` in packages/scenarios/src/controls.ts) against
 * the studio's own sliders, attribute for attribute.
 *
 * The headset draws its sliders from that table, which the studio sends it; the desktop's are
 * written in index.html. Edit either alone and this fails, so the two panels cannot drift apart
 * again the way the headset's range literals once had.
 */

import { readFileSync } from 'node:fs';
import {
  CONTROL_RANGES,
  type ControlKey,
  MUSCLE_GROUPS,
  applyDriveSliders,
  driveForSlider,
  isControlKey,
  snapToControl,
} from '@bs-humany/scenarios';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/** Each key's input in index.html, where the id is not the key itself. */
const INPUT_ID: Readonly<Record<ControlKey, string>> = {
  sex: 'sex',
  stature: 'stature',
  mass: 'mass',
  percentile: 'percentile',
  dropHeight: 'dropHeight',
  grabStrength: 'grabStrength',
  stepsPerSecond: 'stepsPerSecond',
  fps: 'outputFramerate',
  'brain.authority': 'brain-authority',
  'spine.stretch': 'spine-stretch',
  'spine.velocity': 'spine-velocity',
  'spine.setPoint': 'spine-setpoint',
  'spine.inhibition': 'spine-inhibition',
  'spine.delay': 'spine-delay',
  'train.memory': 'train-memory',
};

/** The attributes of the one `<input>` with this id, as written. */
function inputAttributes(id: string): Record<string, string> {
  const tags = [...html.matchAll(/<input\b[^>]*>/g)].filter((m) =>
    new RegExp(`\\bid="${id}"`).test(m[0]),
  );
  expect(tags, `one input with id ${id}`).toHaveLength(1);
  const attributes: Record<string, string> = {};
  for (const [, name, value] of (tags[0]?.[0] ?? '').matchAll(/([\w-]+)="([^"]*)"/g)) {
    if (name !== undefined && value !== undefined) attributes[name] = value;
  }
  return attributes;
}

describe('CONTROL_RANGES', () => {
  it.each(Object.entries(INPUT_ID))('matches the studio slider for %s', (key, id) => {
    expect(isControlKey(key)).toBe(true);
    const range = CONTROL_RANGES[key as ControlKey];
    const attributes = inputAttributes(id);
    expect(attributes.type).toBe('range');
    expect(Number(attributes.min), `${id} min`).toBe(range.min);
    expect(Number(attributes.max), `${id} max`).toBe(range.max);
    expect(Number(attributes.step), `${id} step`).toBe(range.step);
  });

  it('has a slider in the studio for every key, and every bound on a step', () => {
    expect(Object.keys(CONTROL_RANGES).sort()).toEqual(Object.keys(INPUT_ID).sort());
    for (const [key, range] of Object.entries(CONTROL_RANGES)) {
      const notches = (range.max - range.min) / range.step;
      expect(Math.abs(notches - Math.round(notches)), key).toBeLessThan(1e-9);
      expect(range.min, key).toBeLessThan(range.max);
    }
    expect(isControlKey('crural')).toBe(false);
    expect(isControlKey('toString')).toBe(false);
  });

  it('snaps a value onto the step, inside the bounds, written as the slider writes it', () => {
    const { stature, stepsPerSecond } = CONTROL_RANGES;
    expect(snapToControl(stature, 1.7342)).toBe(1.735);
    expect(snapToControl(stature, 1.7)).toBe(1.7);
    expect(snapToControl(stature, 9)).toBe(2.05);
    expect(snapToControl(stature, 0)).toBe(1.4);
    expect(snapToControl(stature, Number.NaN)).toBe(1.4);
    // Counted from the minimum, as a range input counts: 60, 80, 100 ...
    expect(snapToControl(stepsPerSecond, 1009)).toBe(1000);
    expect(snapToControl(stepsPerSecond, 71)).toBe(80);
    expect(snapToControl(CONTROL_RANGES['spine.setPoint'], -0.123)).toBe(-0.12);
    expect(snapToControl(CONTROL_RANGES['train.memory'], 7)).toBe(8);
  });
});

describe('applyDriveSliders', () => {
  it('holds every unit of every group at the excitation its slider asks for', () => {
    const set = new Map<string, number>();
    const drive = { setOverride: (unit: string, level: number) => set.set(unit, level) };
    applyDriveSliders(drive, (_group, index) => (index === 0 ? 50 : 0));
    const units = MUSCLE_GROUPS.flatMap((g) => g.units);
    expect(set.size).toBe(new Set(units).size);
    for (const unit of MUSCLE_GROUPS[0]?.units ?? [])
      expect(set.get(unit)).toBe(driveForSlider(50));
    for (const unit of MUSCLE_GROUPS[1]?.units ?? []) expect(set.get(unit)).toBe(0);
  });
});
