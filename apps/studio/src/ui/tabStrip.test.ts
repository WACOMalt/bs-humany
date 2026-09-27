/**
 * The tab strip as the page and the headset draw it, read straight off their sources.
 *
 * The owner's layout of 2026-09-26: the cord's Spine panel lives on the Muscles tab, beside the
 * muscles it acts on; training has a tab of its own rather than the foot of the Brain tab; and the
 * two tabs for working on the model rather than with it, Align and Health, sit under a Developer
 * divider at the bottom of the strip. Their ids did not change, so a remembered tab, a session and
 * the smoke test still find them. The headset's properties panel draws the same strip in the same
 * order, less Align, which opens and saves files a headset cannot; this holds the two to each
 * other, the way the headset's controls guide is held to its README.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const panelRs = readFileSync(new URL('../../../xr-viewer/src/panel.rs', import.meta.url), 'utf8');

/**
 * The strip's markup, from its opening tag to its own closing one: the first `</div>` at the
 * strip's indent, since the divider inside it closes on its own line.
 */
const strip = (() => {
  const start = html.indexOf('<div id="tabs"');
  return start < 0 ? '' : html.slice(start, html.indexOf('\n        </div>', start));
})();

/** The tab names in the strip, in order, with the divider as `|`. */
const stripOrder = [...strip.matchAll(/data-tab="([^"]+)"|class="tab-divider"/g)].map(
  (m) => m[1] ?? '|',
);

/** One section's markup, from its opening tag to its closing one. */
function section(name: string): string {
  const start = html.indexOf(`<section data-panel="${name}"`);
  expect(start, `a ${name} section`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
}

/** The headset's tab names from a `[(Tab::X, "X"), ...]` table in panel.rs. */
function headsetTable(name: string): string[] {
  const start = panelRs.indexOf(`const ${name}:`);
  expect(start, name).toBeGreaterThan(-1);
  const table = panelRs.slice(start, panelRs.indexOf('];', start));
  return [...table.matchAll(/\(Tab::\w+, "([^"]+)"\)/g)].map((m) => (m[1] as string).toLowerCase());
}

describe('the tab strip', () => {
  it('puts Training after Brain, and Align and Health under the Developer divider', () => {
    expect(stripOrder).toEqual([
      'body',
      'world',
      'simulation',
      'scenario',
      'muscles',
      'brain',
      'training',
      'export',
      '|',
      'align',
      'health',
    ]);
  });

  it('gives every tab a section, and every section a tab', () => {
    const tabs = stripOrder.filter((name) => name !== '|');
    const sections = [...html.matchAll(/<section data-panel="([^"]+)"/g)].map((m) => m[1]);
    expect([...sections].sort()).toEqual([...tabs].sort());
  });

  it('keeps the divider out of the keyboard and the screen reader', () => {
    // Not a button, so the strip's arrows pass over it; hidden from assistive technology, so a
    // tab list is announced with tabs in it and nothing else.
    expect(strip).toMatch(/<div class="tab-divider" aria-hidden="true">Developer<\/div>/);
  });

  it('has the Spine on the Muscles tab, outside what muscles-off hides', () => {
    const muscles = section('muscles');
    expect(muscles).toContain('data-memory="spine"');
    expect(section('brain')).not.toContain('id="spine-');
    // #muscle-control's own panels are what muscles-off hides; the Spine comes after it closes.
    const control = muscles.indexOf('<div id="muscle-control">');
    const spine = muscles.indexOf('data-memory="spine"');
    const controlEnd = muscles.indexOf('\n            </div>\n', control);
    expect(control).toBeGreaterThan(-1);
    expect(spine).toBeGreaterThan(controlEnd);
  });

  it('has training on a tab of its own', () => {
    const training = section('training');
    for (const id of ['train-name', 'train-start', 'train-stop', 'follow-bridge', 'train-chart']) {
      expect(training, id).toContain(`id="${id}"`);
    }
    expect(section('brain')).not.toContain('id="train-');
  });

  it('is the strip the headset draws, less the Align tab', () => {
    // The desktop's short names for two tabs are its labels; the headset names them by label.
    const label = (name: string) => ({ simulation: 'sim', scenario: 'scene' })[name] ?? name;
    const [above, below] = [
      stripOrder.slice(0, stripOrder.indexOf('|')),
      stripOrder.slice(stripOrder.indexOf('|') + 1),
    ];
    expect(headsetTable('TABS')).toEqual(above.map(label));
    expect(headsetTable('DEVELOPER_TABS')).toEqual(below.filter((name) => name !== 'align'));
  });
});
