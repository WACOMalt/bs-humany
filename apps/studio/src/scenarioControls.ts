/**
 * How a scenario's own parameters are shown and read back: which control each gets, whether it
 * has been moved off the value the committed scenario uses, and a typed value held to what the
 * control allows.
 *
 * Pure, so the rules are tested without a page. `refreshScenarioParameters` in main.ts draws the
 * controls from them.
 */

import { type ControlRange, snapToControl } from '@bs-humany/scenarios';

/** What these rules need of a parameter: its reach, its step and the committed value. */
export interface ScenarioControl extends ControlRange {
  /** The value the committed scenario uses, which the goldens were recorded at. */
  readonly value: number;
}

/**
 * Whether `v` differs from the committed value by more than rounding: half a step either way is
 * the same notch of the slider, and a value read back through a string (a saved session, a range
 * input) may be off in its last digit.
 */
export function isChanged(p: ScenarioControl, v: number): boolean {
  return Math.abs(v - p.value) > p.step / 2;
}

/**
 * A slider for a parameter with a few hundred notches or fewer, a number box past a thousand.
 * The tilting floor's seed runs 1 to 9999 in ones: as a slider, one pixel was a dozen seeds, and
 * a particular seed -- the one a result was reported at -- could not be set at all.
 */
export function controlKind(p: ScenarioControl): 'number' | 'slider' {
  return (p.max - p.min) / p.step > 1000 ? 'number' : 'slider';
}

/**
 * A typed value as the parameter can take it: on its step, inside its bounds. Not a number at
 * all is the committed value, which is what the scenario would have used had nothing been typed.
 */
export function clampToStep(p: ScenarioControl, v: number): number {
  return Number.isFinite(v) ? snapToControl(p, v) : p.value;
}
