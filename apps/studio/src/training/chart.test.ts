/**
 * The training chart draws every point inside the canvas, below zero as well as above.
 *
 * It used to scale from zero to the highest point, so a population mean below zero -- a population
 * that drops and flails loses more than it earns for being up -- was drawn under the bottom edge
 * and never seen.
 */

import { describe, expect, it } from 'vitest';
import { type ChartRow, chartDescription, chartScale, chartY, generationRange } from './chart.js';

const HEIGHT = 90;

describe('chartScale', () => {
  it('goes below zero to meet a negative mean, and draws every point inside the canvas', () => {
    const series: ChartRow[] = [
      [1, -2.5, 0.4, 1.1],
      [2, -1.2, 0.9, 1.6],
      [3, -0.3, 1.8, 2.4],
    ];
    const scale = chartScale(series);
    expect(scale.floor).toBeLessThan(0);
    expect(scale.floor).toBe(-2.5);
    expect(scale.top).toBe(1.8);
    for (const [, mean, best] of series) {
      for (const value of [mean, best]) {
        const y = chartY(value, scale, HEIGHT);
        expect(y).toBeGreaterThanOrEqual(1);
        expect(y).toBeLessThanOrEqual(HEIGHT - 1);
      }
    }
    // Zero is inside the axis, so the faint line there is drawn inside the canvas too.
    const zero = chartY(0, scale, HEIGHT);
    expect(zero).toBeGreaterThan(1);
    expect(zero).toBeLessThan(HEIGHT - 1);
  });

  it('keeps zero as the floor for a series that never goes below it', () => {
    const scale = chartScale([
      [10, 0.2, 0.5, 1],
      [11, 0.3, 0.7, 1],
    ]);
    expect(scale.floor).toBe(0);
    expect(scale.top).toBe(0.7);
  });

  it('gives a flat series a span rather than dividing by nothing', () => {
    const scale = chartScale([
      [1, 0, 0, 0],
      [2, 0, 0, 0],
    ]);
    expect(scale).toEqual({ floor: 0, top: 0.1 });
    expect(Number.isFinite(chartY(0, scale, HEIGHT))).toBe(true);
  });
});

describe('what the chart says', () => {
  it('names the generations it covers, from the rows themselves', () => {
    expect(
      generationRange([
        [41, 0, 0, 0],
        [42, 0, 0, 0],
        [43, 0, 0, 0],
      ]),
    ).toBe('gen 41–43');
  });

  it('describes the last generation and the axis in words', () => {
    const text = chartDescription([
      [1, -1, 0.5, 1],
      [2, -0.5, 1.25, 1],
    ]);
    expect(text).toContain('1 to 2');
    expect(text).toContain('best of generation 1.25');
    expect(text).toContain('population mean -0.50');
    expect(text).toContain('from -1.00 to 1.25');
  });
});
