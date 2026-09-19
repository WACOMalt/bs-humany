/**
 * The properties editor's tabs: a strip of buttons, one panel shown at a time.
 *
 * Buttons carry `data-tab`, panels `data-panel`, and the two match by name. The active tab is
 * remembered through `memory` so the editor opens where it was left.
 */

import type { Memory } from './memory.js';

export interface Tabs {
  /** The active tab's name. */
  readonly active: string;
  show(name: string): void;
}

export function createTabs(
  strip: HTMLElement,
  panels: HTMLElement,
  memory: Memory,
  fallback: string,
): Tabs {
  const buttons = Array.from(strip.querySelectorAll<HTMLButtonElement>('button[data-tab]'));
  const sections = Array.from(panels.querySelectorAll<HTMLElement>('[data-panel]'));
  let active = fallback;
  const show = (name: string) => {
    if (!buttons.some((b) => b.dataset.tab === name)) return;
    active = name;
    for (const b of buttons) b.classList.toggle('active', b.dataset.tab === name);
    for (const s of sections) s.hidden = s.dataset.panel !== name;
    memory.set('tab', name);
  };
  for (const b of buttons) b.addEventListener('click', () => show(b.dataset.tab ?? fallback));
  show(memory.get('tab') ?? fallback);
  return {
    get active() {
      return active;
    },
    show,
  };
}
