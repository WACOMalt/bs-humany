/**
 * The properties editor's tabs: a strip of buttons, one panel shown at a time.
 *
 * Buttons carry `data-tab`, panels `data-panel`, and the two match by name. The active tab is
 * remembered through `memory` so the editor opens where it was left.
 *
 * A tab is also a scope. Some editors draw into the shared viewport -- the Align tab's gizmo,
 * handles and reference overlay -- and those belong to their tab: left on after the user has gone
 * elsewhere, they catch clicks meant for the body and clutter a view that no longer explains them.
 * So a change of tab is announced two ways. `onChange` is for whoever builds the tabs, and is
 * called on the first `show` as well, so a studio that reopens on a tab is told which. The
 * `TAB_CHANGE` event is for a panel built without a line to the tabs: it bubbles from the strip
 * with the new name in `detail`, and such a panel reads its own section's `hidden` for the tab it
 * started on, because the first event may have gone out before it was listening.
 */

import type { Memory } from './memory.js';

/** Dispatched on the strip, bubbling, whenever the active tab changes; `detail` is its name. */
export const TAB_CHANGE = 'studio:tabchange';

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
  onChange?: (name: string) => void,
): Tabs {
  const buttons = Array.from(strip.querySelectorAll<HTMLButtonElement>('button[data-tab]'));
  const sections = Array.from(panels.querySelectorAll<HTMLElement>('[data-panel]'));
  let active = fallback;
  let announced = false;
  const show = (name: string) => {
    if (!buttons.some((b) => b.dataset.tab === name)) return;
    const changed = !announced || active !== name;
    active = name;
    for (const b of buttons) b.classList.toggle('active', b.dataset.tab === name);
    for (const s of sections) s.hidden = s.dataset.panel !== name;
    memory.set('tab', name);
    if (!changed) return;
    announced = true;
    onChange?.(name);
    strip.dispatchEvent(new CustomEvent(TAB_CHANGE, { bubbles: true, detail: name }));
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
