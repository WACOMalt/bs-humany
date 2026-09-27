/**
 * How wide the properties editor may be in a window of a given width: never so wide that the
 * viewport goes under `MIN_VIEWPORT`, never narrower than `MIN_WIDTH`, and otherwise what was
 * asked for. Pure, so it is checked without a DOM.
 */

import { describe, expect, it } from 'vitest';
import { MAX_WIDTH, MIN_VIEWPORT, MIN_WIDTH, clampEditorWidth } from './resizer.js';

describe('clampEditorWidth', () => {
  it('leaves the viewport its minimum in a window too small for the width asked for', () => {
    expect(clampEditorWidth(900, 1100)).toBe(1100 - MIN_VIEWPORT);
    expect(clampEditorWidth(900, 800)).toBe(480);
  });

  it('never goes under the editor minimum, however narrow the window', () => {
    expect(clampEditorWidth(200, 1920)).toBe(MIN_WIDTH);
    expect(clampEditorWidth(700, 400)).toBe(MIN_WIDTH);
  });

  it('gives the width asked for when the window has room', () => {
    expect(clampEditorWidth(700, 1920)).toBe(700);
    expect(clampEditorWidth(2000, 4000)).toBe(MAX_WIDTH);
  });

  it('rounds to whole pixels', () => {
    expect(clampEditorWidth(512.6, 1920)).toBe(513);
  });
});
