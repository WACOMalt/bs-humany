/**
 * What "Set up as trained" would change: the part of the studio a checkpoint's recipe sets, as
 * the tabs hold it now against the way the checkpoint was trained, in words, and whether the change
 * restarts a running body.
 *
 * Choosing a checkpoint used to apply its recipe on the spot: a running body was restarted in the
 * checkpoint's scene, body and step rate, the muscle sliders went to zero and the training form
 * changed, with no way back -- and the headset's list did the same. Choosing one now only shows
 * it, with this list of how it differs, and the change is made by a button that says so and can be
 * undone. Hand over makes the same change first when there is one, because a policy only makes
 * sense in the body it was trained in.
 *
 * No DOM here. The host reads both sides off the page -- the recipe side as the controls would
 * hold it, rounded to each slider's step, so a stature of 1.7532 m set on a slider that holds
 * 1.755 is not a difference forever after -- and this compares them.
 */

import type { SpinalRegion } from '@bs-humany/modules-nerves';
import { REFLEX_REGIONS } from '@bs-humany/train/recipe';

/**
 * The spinal cord's five gains, as the Spine sliders have them, and its stretch by region: a
 * region's own where it has one, the base stretch's where it does not.
 */
export interface SetUpCord {
  readonly stretch: number;
  readonly velocity: number;
  readonly setPoint: number;
  readonly inhibition: number;
  readonly delaySeconds: number;
  readonly regionStretch?: Readonly<Partial<Record<SpinalRegion, number>>> | undefined;
}

/** A region's stretch under a cord: its own when the cord gives one, else the base. */
function stretchIn(cord: SetUpCord, region: SpinalRegion): number {
  const own = cord.regionStretch?.[region];
  return own !== undefined && Number.isFinite(own) ? own : cord.stretch;
}

/**
 * Whether two cords are one cord to the body: the five gains the same, and every region's stretch
 * the same as the body answers with it. A cord with only a stretch is that stretch everywhere, so
 * it is the same as one that names the stretch in every region.
 */
export function sameCord(a: SetUpCord, b: SetUpCord): boolean {
  return (
    CORD.every(([key]) => same(a[key], b[key])) &&
    REFLEX_REGIONS.every((r) => same(stretchIn(a, r), stretchIn(b, r)))
  );
}

/** The studio as far as a checkpoint's recipe reaches into it. */
export interface StudioSetUp {
  /** The scenario's id; empty for the free drop from the rest pose. */
  readonly scenario: string;
  /**
   * The scenario's own values. On the recipe side, only the ones the recipe names: a value the
   * studio has and the recipe does not say is the scenario's default, and is not a difference.
   */
  readonly parameters: Readonly<Record<string, number>>;
  readonly profile: string;
  readonly sex: number;
  readonly stature: number;
  readonly mass: number;
  readonly passive: boolean;
  readonly redistribute: boolean;
  /** The step rate the next run would step at; undefined on the recipe side when it does not say. */
  readonly stepsPerSecond: number | undefined;
  /** The cord; undefined on the recipe side when the recipe does not carry one. */
  readonly cord: SetUpCord | undefined;
  readonly authority: number;
  /**
   * Whether any muscle drive slider is off zero. On the recipe side, false for a checkpoint that
   * learnt with nothing under it (its sliders are put to zero) and undefined otherwise, when the
   * sliders are left as they are.
   */
  readonly driving: boolean | undefined;
}

/** One thing Set up as trained would change, and whether it needs the body rebuilt. */
export interface SetUpDifference {
  /** In words: `scene Standing quietly (here Drop and collapse)`. */
  readonly text: string;
  /**
   * Whether it reaches a run only when the run is built -- the scene, the body, the joints, the
   * step rate -- so that a running body is restarted for it and its recording discarded. The
   * cord, the authority and the muscle sliders reach a running body live.
   */
  readonly restarts: boolean;
}

/** How the scene and the profile are named in the list. */
export interface SetUpNames {
  scenario(id: string): string;
  profile(id: string): string;
}

/** Numbers nearer than this are one setting: a JSON round trip, not a change. */
const TOLERANCE = 1e-9;
const same = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCE;
const onOff = (on: boolean): string => (on ? 'on' : 'off');

/** The cord's gains in the order the Spine panel lists them, with the words it uses. */
const CORD: readonly [Exclude<keyof SetUpCord, 'regionStretch'>, string, (v: number) => string][] =
  [
    ['stretch', 'stretch', (v) => v.toFixed(2)],
    ['velocity', 'damping', (v) => v.toFixed(2)],
    ['setPoint', 'set point', (v) => v.toFixed(2)],
    ['inhibition', 'reciprocal', (v) => v.toFixed(2)],
    ['delaySeconds', 'conduction', (v) => `${Math.round(v * 1000)} ms`],
  ];

/**
 * Everything Set up as trained would change, in the order the tabs offer it: what restarts a run
 * first, then what reaches a running body live. Empty when the tabs are already as it was trained.
 */
export function setUpDifferences(
  here: StudioSetUp,
  trained: StudioSetUp,
  names: SetUpNames,
): SetUpDifference[] {
  const out: SetUpDifference[] = [];
  const add = (text: string, restarts: boolean): void => {
    out.push({ text, restarts });
  };
  if (trained.scenario !== here.scenario) {
    add(`scene ${names.scenario(trained.scenario)} (here ${names.scenario(here.scenario)})`, true);
  } else {
    // Only within one scene: another scene's values are part of that scene's change.
    const changed = Object.entries(trained.parameters).filter(
      ([key, value]) => here.parameters[key] === undefined || !same(here.parameters[key], value),
    );
    if (changed.length > 0) {
      add(
        `${names.scenario(trained.scenario)}'s ${changed
          .map(([key, value]) => `${key} ${value} (here ${here.parameters[key] ?? 'unset'})`)
          .join(', ')}`,
        true,
      );
    }
  }
  if (trained.profile !== here.profile) {
    add(`body ${names.profile(trained.profile)} (here ${names.profile(here.profile)})`, true);
  }
  if (!same(trained.stature, here.stature)) {
    add(`stature ${trained.stature.toFixed(3)} m (here ${here.stature.toFixed(3)} m)`, true);
  }
  if (!same(trained.mass, here.mass)) {
    add(`mass ${trained.mass.toFixed(1)} kg (here ${here.mass.toFixed(1)} kg)`, true);
  }
  if (!same(trained.sex, here.sex)) {
    add(`sex blend ${trained.sex.toFixed(2)} (here ${here.sex.toFixed(2)})`, true);
  }
  if (trained.passive !== here.passive) {
    add(`passive joints ${onOff(trained.passive)} (here ${onOff(here.passive)})`, true);
  }
  if (trained.redistribute !== here.redistribute) {
    add(
      `spinal redistribution ${onOff(trained.redistribute)} (here ${onOff(here.redistribute)})`,
      true,
    );
  }
  if (
    trained.stepsPerSecond !== undefined &&
    here.stepsPerSecond !== undefined &&
    !same(trained.stepsPerSecond, here.stepsPerSecond)
  ) {
    add(`${trained.stepsPerSecond} steps a second (here ${here.stepsPerSecond})`, true);
  }
  if (trained.cord && here.cord) {
    const [a, b] = [trained.cord, here.cord];
    for (const [key, label, show] of CORD) {
      if (key === 'stretch') {
        addStretch(a, b, add);
        continue;
      }
      if (!same(a[key], b[key])) {
        add(`cord ${label} ${show(a[key])} (here ${show(b[key])})`, false);
      }
    }
  }
  if (!same(trained.authority, here.authority)) {
    add(`authority ${trained.authority.toFixed(2)} (here ${here.authority.toFixed(2)})`, false);
  }
  if (trained.driving === false && here.driving === true) {
    add('the muscle sliders at zero (here some are up)', false);
  }
  return out;
}

/**
 * The stretch, compared as the body answers with it. Two cords with one stretch everywhere differ
 * in one line, as they always did; otherwise each region that differs is a line of its own, and a
 * base stretch that no region follows is no difference at all.
 */
function addStretch(
  a: SetUpCord,
  b: SetUpCord,
  add: (text: string, restarts: boolean) => void,
): void {
  const uniform = (c: SetUpCord) => REFLEX_REGIONS.every((r) => same(stretchIn(c, r), c.stretch));
  if (uniform(a) && uniform(b)) {
    if (!same(a.stretch, b.stretch)) {
      add(`cord stretch ${a.stretch.toFixed(2)} (here ${b.stretch.toFixed(2)})`, false);
    }
    return;
  }
  for (const r of REFLEX_REGIONS) {
    const [then, now] = [stretchIn(a, r), stretchIn(b, r)];
    if (!same(then, now)) {
      add(`cord ${r.toLowerCase()} stretch ${then.toFixed(2)} (here ${now.toFixed(2)})`, false);
    }
  }
}

/** The differences as one line for a note: `scene A (here B), authority 0.30 (here 1.00)`. */
export function describeSetUpDifferences(list: readonly SetUpDifference[]): string {
  return list.map((d) => d.text).join(', ');
}

/** Whether making these changes restarts a running body, and so discards its recording. */
export function setUpRestarts(list: readonly SetUpDifference[]): boolean {
  return list.some((d) => d.restarts);
}
