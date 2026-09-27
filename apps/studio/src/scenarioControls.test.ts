/**
 * The scenario parameters' controls: which kind each gets, when one reads as changed, and what a
 * typed value becomes. Checked against the committed tilting floor, whose seed is the parameter
 * that needed a number box.
 */

import { SCENARIO_DEFINITIONS } from '@bs-humany/scenarios';
import { describe, expect, it } from 'vitest';
import { clampToStep, controlKind, isChanged } from './scenarioControls.js';

const tilting = SCENARIO_DEFINITIONS.find((d) => d.id === 'tilting-floor');
const parameter = (id: string) => {
  const p = tilting?.parameters.find((q) => q.id === id);
  if (!p) throw new Error(`the tilting floor has no ${id}`);
  return p;
};

describe('scenario controls', () => {
  it('gives the seed a number box and the tilt a slider', () => {
    const seed = parameter('seed');
    expect([seed.min, seed.max, seed.step]).toEqual([1, 9999, 1]);
    expect(controlKind(seed)).toBe('number');
    const tilt = parameter('tilt');
    expect([tilt.min, tilt.max, tilt.step]).toEqual([0, 15, 0.5]);
    expect(controlKind(tilt)).toBe('slider');
    // Every other committed parameter is a slider: none of them has a thousand notches.
    for (const definition of SCENARIO_DEFINITIONS) {
      for (const p of definition.parameters) {
        if (p !== seed) expect(controlKind(p), `${definition.id} ${p.id}`).toBe('slider');
      }
    }
  });

  it('reads a value within half a step of the committed one as unchanged', () => {
    const tilt = parameter('tilt');
    expect(tilt.value).toBe(4);
    expect(isChanged(tilt, 4)).toBe(false);
    expect(isChanged(tilt, 4.25)).toBe(false);
    expect(isChanged(tilt, 3.75)).toBe(false);
    expect(isChanged(tilt, 4.26)).toBe(true);
    expect(isChanged(tilt, 4.5)).toBe(true);
    expect(isChanged(tilt, 3.5)).toBe(true);
    // A value read back through a string, off in its last digit, is still the same notch.
    expect(isChanged(parameter('every'), 0.8000000000000002)).toBe(false);
  });

  it('holds a typed value to the step and the bounds', () => {
    const seed = parameter('seed');
    expect(clampToStep(seed, 4242)).toBe(4242);
    expect(clampToStep(seed, 4242.4)).toBe(4242);
    expect(clampToStep(seed, 4242.6)).toBe(4243);
    expect(clampToStep(seed, 0)).toBe(1);
    expect(clampToStep(seed, -50)).toBe(1);
    expect(clampToStep(seed, 123456)).toBe(9999);
    expect(clampToStep(seed, Number.NaN)).toBe(seed.value);
    const tilt = parameter('tilt');
    expect(clampToStep(tilt, 4.3)).toBe(4.5);
    expect(clampToStep(tilt, 4.2)).toBe(4);
    expect(clampToStep(tilt, 99)).toBe(15);
    // Written to the step's places, not a float's: 0.3 in steps of 0.05 is 0.3, not 0.30000000000000004.
    expect(clampToStep(parameter('hold'), 0.29)).toBe(0.3);
  });
});
