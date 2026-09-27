/**
 * The page's own promises about its markup, read straight off index.html.
 *
 * Whether a panel was left open or closed is remembered under a key, and the key used to be made
 * from the panel's heading. Two panels called Recording, one on the Sim tab and one on Export,
 * then shared one memory: collapsing either collapsed the other on the next visit. Each panel now
 * names its own key in `data-memory`, and this holds the page to one key a panel, none shared.
 *
 * And every checkbox is named by a label that points at it, because a checkbox with no name is
 * announced by its value, which for every checkbox on the page is "on".
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

describe('index.html', () => {
  it('gives every panel its own memory key', () => {
    const panels = html.match(/<details class="panel"[^>]*>/g) ?? [];
    const keys = panels.map((tag) => /data-memory="([^"]*)"/.exec(tag)?.[1]);
    expect(panels.length).toBeGreaterThan(0);
    expect(keys.filter((key) => key === undefined || key === '')).toEqual([]);
    const repeated = keys.filter((key, at) => keys.indexOf(key) !== at);
    expect(repeated).toEqual([]);
    // Nothing else on the page claims a panel key.
    expect((html.match(/data-memory="/g) ?? []).length).toBe(panels.length);
  });

  it('keeps the two Recording panels apart', () => {
    expect(html).toContain('data-memory="simulation.recording"');
    expect(html).toContain('data-memory="export.recording"');
  });

  it('names every checkbox with a label that points at it', () => {
    const boxes = [...html.matchAll(/<input type="checkbox" id="([^"]+)"/g)].map((m) => m[1]);
    expect(boxes.length).toBeGreaterThan(0);
    const unnamed = boxes.filter((id) => !html.includes(`<label for="${id}"`));
    expect(unnamed).toEqual([]);
    // And no checkbox without an id, which no label could point at.
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(boxes.length);
  });
});
