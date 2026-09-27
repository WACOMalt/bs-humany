/**
 * The Sim tab's list of what a restart would change: only what reaches a run when it is built,
 * named the way the panels name it.
 */

import { describe, expect, it } from 'vitest';
import { type RunSettings, pendingChanges } from './pending.js';

const BUILT: RunSettings = {
  profile: 'l3_anatomical',
  scenario: 'quiet-standing',
  scenarioParameters: { height: 0.2 },
  passive: true,
  redistribute: true,
  muscles: true,
  dropHeight: 0.3,
  stepsPerSecond: undefined,
};

describe('pendingChanges', () => {
  it('lists nothing when the settings are the ones the run was built with', () => {
    expect(pendingChanges(BUILT, { ...BUILT, scenarioParameters: { height: 0.2 } })).toEqual([]);
  });

  it('names a change of profile', () => {
    expect(pendingChanges(BUILT, { ...BUILT, profile: 'l1_standard' })).toEqual(['Body profile']);
  });

  it('says nothing of the step rate while the slider is untouched', () => {
    // Untouched on both sides, whatever the slider reads: it follows the profile, and the profile
    // is what changed if anything did.
    expect(pendingChanges(BUILT, { ...BUILT, stepsPerSecond: undefined })).toEqual([]);
    expect(pendingChanges(BUILT, { ...BUILT, stepsPerSecond: 760 })).toEqual(['Step rate']);
    expect(
      pendingChanges({ ...BUILT, stepsPerSecond: 760 }, { ...BUILT, stepsPerSecond: 760 }),
    ).toEqual([]);
  });

  it('names the joints, the muscles and several changes at once, in the panels’ order', () => {
    expect(
      pendingChanges(BUILT, { ...BUILT, passive: false, muscles: false, redistribute: false }),
    ).toEqual(['Passive joints', 'Spinal redistribution', 'Muscles']);
  });

  it('names a scenario change once, and its values only within the same scenario', () => {
    expect(
      pendingChanges(BUILT, { ...BUILT, scenario: 'free-hang', scenarioParameters: {} }),
    ).toEqual(['Scenario']);
    expect(pendingChanges(BUILT, { ...BUILT, scenarioParameters: { height: 0.4 } })).toEqual([
      'Scenario settings',
    ]);
  });

  it('names the drop height only for a free drop, which is the only thing it moves', () => {
    expect(pendingChanges(BUILT, { ...BUILT, dropHeight: 0.8 })).toEqual([]);
    const drop = { ...BUILT, scenario: '', scenarioParameters: {} };
    expect(pendingChanges(drop, { ...drop, dropHeight: 0.8 })).toEqual(['Drop height']);
  });
});
