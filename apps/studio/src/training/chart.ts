/**
 * The training chart's arithmetic: where its axis runs, where a point lands, and what it says.
 *
 * Pure, so a test can hold it to the one promise that matters -- every point is drawn inside the
 * canvas -- without a canvas. The chart used to scale from zero to the highest point, which is
 * right for a run that scores above zero and wrong for every one that does not: a control step
 * loses more for a pelvis dropping or a head thrown about than it gains for being up (the rig's
 * `standReward` and `balanceReward`), so a thrashing population's mean goes below zero, and it
 * was drawn under the bottom edge, where nobody could see it. It
 * also said nothing but 'top 1.23', so a line going up could not be told from a line going down.
 */

/** One generation as the chart takes it: generation, population mean, best of generation, seconds up. */
export type ChartRow = readonly [number, number, number, number];

/**
 * The two lines' colours, used for the strokes and for the key under the chart alike, so the key
 * cannot say one colour while the line is drawn in another.
 */
export const BEST_COLOUR = '#e0a44a';
export const MEAN_COLOUR = '#6aa9ff';

/** The smallest span the axis is given, so a flat line at zero is drawn across the middle of nothing. */
const LEAST_SPAN = 0.1;

export interface ChartScale {
  /** The bottom of the axis: zero, or the lowest point when one is below zero. */
  readonly floor: number;
  /** The top of the axis: the highest point, and never less than a tenth above the floor. */
  readonly top: number;
}

/**
 * The axis for a series. Zero stays the bottom while nothing goes under it, because a chart whose
 * floor followed the lowest point would magnify a run's first wobbles into cliffs; once something
 * does go under, the floor goes down to meet it, so it is drawn rather than cut off.
 */
export function chartScale(series: readonly ChartRow[]): ChartScale {
  let lowest = 0;
  let highest = 0;
  for (const [, mean, best] of series) {
    if (Number.isFinite(mean)) {
      lowest = Math.min(lowest, mean);
      highest = Math.max(highest, mean);
    }
    if (Number.isFinite(best)) {
      lowest = Math.min(lowest, best);
      highest = Math.max(highest, best);
    }
  }
  const floor = Math.min(0, lowest);
  return { floor, top: Math.max(highest, floor + LEAST_SPAN) };
}

/**
 * Where a value lands on a canvas `height` pixels tall: the floor two pixels from the bottom, the
 * top two from the top, so a line at either is drawn whole rather than split by the edge.
 */
export function chartY(value: number, scale: ChartScale, height: number): number {
  const span = scale.top - scale.floor;
  return height - 2 - ((value - scale.floor) / span) * (height - 4);
}

/** Where the `i`th of `count` generations lands across a canvas `width` pixels wide. */
export function chartX(i: number, count: number, width: number): number {
  return (i / Math.max(1, count - 1)) * (width - 2) + 1;
}

/** The generations the series covers, as the label under the chart puts them. */
export function generationRange(series: readonly ChartRow[]): string {
  const first = series[0]?.[0];
  const last = series[series.length - 1]?.[0];
  if (first === undefined || last === undefined) return '';
  return first === last ? `gen ${first}` : `gen ${first}–${last}`;
}

/**
 * What the chart shows, in words, for a screen reader: the canvas is a picture, and a picture
 * with no text is nothing at all to somebody who cannot see it.
 */
export function chartDescription(series: readonly ChartRow[]): string {
  const last = series[series.length - 1];
  if (!last) return 'Training chart: nothing trained yet.';
  const scale = chartScale(series);
  const first = series[0] as ChartRow;
  return (
    `Fitness by generation, ${first[0]} to ${last[0]}: best of generation ${last[2].toFixed(2)} ` +
    `and population mean ${last[1].toFixed(2)} at the last, ` +
    `on an axis from ${scale.floor.toFixed(2)} to ${scale.top.toFixed(2)}.`
  );
}
