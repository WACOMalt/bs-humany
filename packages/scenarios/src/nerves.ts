/**
 * What the nerves drive and want, as scenarios see them.
 *
 * The policy's outputs are the drive groups a side -- forty-six for twenty-three groups -- in a
 * fixed order, because the training rig, the studio and the headset must agree on which output
 * is which. The goal is a one-hot over the behaviours a policy can be told to produce; only the
 * first is trained yet. `NervesSetup` is the scenario's part: which policy file, how much
 * authority, and the goal.
 */

import type { DriveOutput, PolicyFile } from '@bs-humany/modules-nerves';
import { MUSCLE_GROUPS } from './muscleGroups.js';

/** One-hot: stand, walk, flail. */
export const GOAL_SIZE = 3;
export const GOALS = ['stand', 'walk', 'flail'] as const;

/** Which segments are feet, for the sole's sense of contact. */
export const FEET = {
  left: ['foot_l', 'toes_l'],
  right: ['foot_r', 'toes_r'],
} as const;

/** Twenty-three groups a side, right first then left, each output driving its units evenly. */
export function driveOutputs(): DriveOutput[] {
  const outputs: DriveOutput[] = [];
  for (const side of ['r', 'l'] as const) {
    for (const group of MUSCLE_GROUPS) {
      outputs.push({
        id: `${group.id}:${side}`,
        units: group.units.filter((u) => u.endsWith(`_${side}`)).map((id) => ({ id, weight: 1 })),
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
  /** Ticks between evaluations; five at 500 Hz is a hundred hertz. */
  readonly controlDivisor: number;
}
