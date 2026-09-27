/**
 * What the nerves drive and want, as scenarios see them.
 *
 * The policy's outputs are the drive groups a side -- seventy for thirty-five groups -- in a
 * fixed order, because the training rig, the studio and the headset must agree on which output
 * is which. The goal is a one-hot over the behaviours a policy can be told to produce; only the
 * first is trained yet. `NervesSetup` is the scenario's part: which policy file, how much
 * authority, and the goal.
 */

import type { DriveOutput, PolicyFile } from '@bs-humany/modules-nerves';
import { DRIVE_SIDES, MUSCLE_GROUPS, unitsOnSide } from './muscleGroups.js';
import { defaultControlDivisor } from './solverRate.js';

/** One-hot: stand, walk, flail. */
export const GOAL_SIZE = 3;
export const GOALS = ['stand', 'walk', 'flail'] as const;

/**
 * Thirty-five groups a side, right first then left, each output driving its units evenly. A side
 * is split by `unitsOnSide`, the split the cord's reflex groups use too, so an output and the
 * reflex group with its id hold the same muscles.
 */
export function driveOutputs(): DriveOutput[] {
  const outputs: DriveOutput[] = [];
  for (const side of DRIVE_SIDES) {
    for (const group of MUSCLE_GROUPS) {
      outputs.push({
        id: `${group.id}:${side}`,
        units: unitsOnSide(group, side).map((id) => ({ id, weight: 1 })),
      });
    }
  }
  return outputs;
}

/** What a scenario says when it wants the nerves in the loop. */
export interface NervesSetup {
  readonly policy: PolicyFile;
  /** The most one output may add to or take from a unit's excitation. */
  readonly authority: number;
  /** Which behaviour to ask for, by index into `GOALS`. */
  readonly goal: number;
  /**
   * Ticks between evaluations; five at 500 Hz is a hundred hertz. Left out, it is worked out from
   * the rate the run steps at and what the policy says it was trained at (`controlDivisorFor`),
   * which is what every caller should want; a number here is for a scenario that pins its own.
   */
  readonly controlDivisor?: number | undefined;
}

/**
 * Ticks between evaluations for a policy running at `stepsPerSecond`, keeping the control PERIOD
 * it was trained at rather than its tick count.
 *
 * A policy is a controller of a certain speed: it was scored on how the body answered a command
 * held for so many milliseconds, and a command held for twice as long is a different controller
 * with the same weights. So when the checkpoint recorded both its step rate and its divisor, the
 * divisor here is whatever makes the same period at this rate -- ten ticks at 1000 Hz is five at
 * 500. With either number missing there is no trained period to keep, and the policy gets the
 * default hundred hertz (`defaultControlDivisor`), which is what the training rig runs a policy at
 * when nothing says otherwise.
 */
export function controlDivisorFor(
  stepsPerSecond: number,
  trained?: { readonly stepsPerSecond?: number; readonly controlDivisor?: number } | undefined,
): number {
  const rate = trained?.stepsPerSecond;
  const divisor = trained?.controlDivisor;
  if (rate !== undefined && rate > 0 && divisor !== undefined) {
    return Math.max(1, Math.round((stepsPerSecond * divisor) / rate));
  }
  return defaultControlDivisor(stepsPerSecond);
}
