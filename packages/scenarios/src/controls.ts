/**
 * The bounds and step of every slider the studio and the headset both offer, said once.
 *
 * These used to be written three times: as the `min`, `max` and `step` attributes in the studio's
 * index.html, as range literals in the headset's panel (apps/xr-viewer/src/panel.rs), and, for
 * the steps, as hand-written snaps there that rounded a released slider to a twentieth or a
 * quarter. A range widened on the desktop stayed narrow in the headset, and a slider whose snap
 * was forgotten sent 1.7342 where the desktop could only ever say 1.735, then jumped when the
 * publisher's answer came back. Now the studio and `pnpm publish:pose` send this table in their
 * status (`controls`), the headset draws each slider from it and steps it by its `step` while it
 * is dragged, and apps/studio/src/controls.test.ts holds index.html's attributes to it.
 *
 * The numbers are the desktop's, as they stood when the table was made. They are the reach of a
 * control, not claims about bodies: stature and mass span the ANSUR II population the percentile
 * slider is drawn from with room either side, and the rest are as wide as each setting is useful
 * to turn. The labels, the notes and what each key does stay with each panel.
 *
 * The fields are `min`, `max` and `step`, never `range`, which cite-lint reads as a physical
 * parameter wanting a source.
 */

/** One slider's reach and the smallest move it makes. */
export interface ControlRange {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/**
 * A slider by the key its command is sent with: a `PanelSettings` name, `grabStrength`, or the
 * Brain tab's `brain.`, `spine.` and `train.` sliders.
 *
 * The limb proportions (crural, brachial, leg length) are not here: nothing measured follows them
 * yet, so neither panel offers a slider for them any more.
 */
export type ControlKey =
  | 'sex'
  | 'stature'
  | 'mass'
  | 'percentile'
  | 'dropHeight'
  | 'grabStrength'
  | 'stepsPerSecond'
  | 'fps'
  | 'brain.authority'
  | 'spine.stretch'
  | 'spine.velocity'
  | 'spine.setPoint'
  | 'spine.inhibition'
  | 'spine.delay'
  | 'train.memory';

export const CONTROL_RANGES: Readonly<Record<ControlKey, ControlRange>> = Object.freeze({
  /** 0 female-typical to 1 male-typical skeletal proportions. */
  sex: { min: 0, max: 1, step: 0.01 },
  /** Metres. */
  stature: { min: 1.4, max: 2.05, step: 0.005 },
  /** Kilograms. */
  mass: { min: 35, max: 150, step: 0.5 },
  /** The ANSUR II percentile, as a fraction. */
  percentile: { min: 0.01, max: 0.99, step: 0.01 },
  /** Metres, for a free drop. */
  dropHeight: { min: 0, max: 1.5, step: 0.05 },
  /** A multiple of the hold that carries a good fraction of the body's weight. */
  grabStrength: { min: 0.1, max: 5, step: 0.1 },
  stepsPerSecond: { min: 60, max: 2000, step: 20 },
  /** Output frames a second. */
  fps: { min: 1, max: 240, step: 1 },
  /** The most one policy output may add to or take from a group's excitation. */
  'brain.authority': { min: 0, max: 1, step: 0.05 },
  'spine.stretch': { min: 0, max: 8, step: 0.1 },
  'spine.velocity': { min: 0, max: 2, step: 0.05 },
  /** A strain: 0.1 is a fibre a tenth longer than optimal. */
  'spine.setPoint': { min: -0.2, max: 0.2, step: 0.01 },
  'spine.inhibition': { min: 0, max: 1, step: 0.05 },
  /** Seconds. */
  'spine.delay': { min: 0, max: 0.12, step: 0.005 },
  /** Context units a policy carries, in fours. */
  'train.memory': { min: 0, max: 32, step: 4 },
});

/** Whether `key` names a slider in the table. */
export function isControlKey(key: string): key is ControlKey {
  return Object.hasOwn(CONTROL_RANGES, key);
}

/** Decimal places in a number as written, so a snapped value can be written as the slider would. */
function decimalsOf(value: number): number {
  for (let places = 0; places < 10; places++) {
    const scaled = value * 10 ** places;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, Math.abs(scaled))) {
      return places;
    }
  }
  return 10;
}

/**
 * `value` as the slider can hold it: on a whole number of steps from its minimum, inside its
 * bounds, and written to no more places than the bounds and the step are -- so a stature of
 * 1.7342 comes back 1.735 rather than 1.7350000000000001, which is what an HTML range input
 * would have made of it too. A value that is not a finite number is the minimum.
 */
export function snapToControl(range: ControlRange, value: number): number {
  if (!Number.isFinite(value)) return range.min;
  const steps = Math.round((value - range.min) / range.step);
  const snapped = Math.min(range.max, Math.max(range.min, range.min + steps * range.step));
  const places = Math.max(decimalsOf(range.min), decimalsOf(range.step));
  return Number(snapped.toFixed(places));
}
