/**
 * What a run was built with, and which of it has been changed since.
 *
 * Most of the studio's settings reach a run only when it is built: the profile, the scenario and
 * its values, the joints, the muscles, the drop height and the step rate are all compiled into
 * the body or fixed into its clock at the start, and moving one of them afterwards changes the
 * next run and not this one. The panels used to say so in a note somewhere, or not at all, and a
 * person who unticked Passive mid-run saw a checkbox that appeared to do nothing. The Sim tab now
 * lists what differs between the running body and the one a restart would build, beside the
 * button that builds it; this is the comparison, kept free of the DOM so it can be tested.
 */

/** The settings a run is built from and cannot change while it goes. */
export interface RunSettings {
  readonly profile: string;
  /** The scenario's id, or the empty string for a free drop. */
  readonly scenario: string;
  /** The chosen scenario's parameter values, by parameter id. */
  readonly scenarioParameters: Readonly<Record<string, number>>;
  readonly passive: boolean;
  readonly redistribute: boolean;
  /** Whether the run has muscles: the box, or a scenario that drives them whatever the box says. */
  readonly muscles: boolean;
  /** Metres; used only by a free drop, because a scenario places the body itself. */
  readonly dropHeight: number;
  /**
   * The step rate somebody chose, or undefined while the slider is untouched. Untouched, every
   * profile runs at its own solver's rate, so the slider following the profile is not a change.
   */
  readonly stepsPerSecond: number | undefined;
}

/**
 * The human names of the settings that differ between the running body's and the next run's, in
 * the order the panels offer them; empty when a restart would build the same body.
 */
export function pendingChanges(compiledWith: RunSettings, now: RunSettings): string[] {
  const changed: string[] = [];
  if (compiledWith.profile !== now.profile) changed.push('Body profile');
  if (compiledWith.stepsPerSecond !== now.stepsPerSecond) changed.push('Step rate');
  if (compiledWith.scenario !== now.scenario) {
    changed.push('Scenario');
  } else if (!sameValues(compiledWith.scenarioParameters, now.scenarioParameters)) {
    // Only within one scenario: another scenario's values are that scenario's change.
    changed.push('Scenario settings');
  }
  // Only for a free drop, on both sides of the comparison: a scenario places the body itself, so
  // the slider does nothing to it, and a change of scenario is already named.
  if (
    compiledWith.scenario === '' &&
    now.scenario === '' &&
    compiledWith.dropHeight !== now.dropHeight
  ) {
    changed.push('Drop height');
  }
  if (compiledWith.passive !== now.passive) changed.push('Passive joints');
  if (compiledWith.redistribute !== now.redistribute) changed.push('Spinal redistribution');
  if (compiledWith.muscles !== now.muscles) changed.push('Muscles');
  return changed;
}

/** Whether two sets of parameter values name the same parameters at the same values. */
function sameValues(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => key in b && a[key] === b[key]);
}
