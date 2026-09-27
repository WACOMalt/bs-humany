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
 *
 * The strip is a WAI-ARIA tab list, so a screen reader says which tab is chosen and how many there
 * are, and the keyboard moves through it the way it moves through any other: one Tab stop for the
 * whole strip (the chosen tab carries tabindex 0, the rest -1), the up and down arrows to the next
 * and previous tab, Home and End to the first and last. Choosing follows focus, because showing a
 * panel costs nothing and a tab strip that makes you press Enter as well is one more step for no
 * gain. The studio's own shortcuts leave those keys alone on a tab (`shortcuts.ts`).
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
  strip.setAttribute('role', 'tablist');
  for (const b of buttons) {
    const name = b.dataset.tab ?? '';
    b.id ||= `tab-${name}`;
    b.setAttribute('role', 'tab');
    const section = sections.find((s) => s.dataset.panel === name);
    if (section) {
      section.id ||= `tabpanel-${name}`;
      section.setAttribute('role', 'tabpanel');
      section.setAttribute('aria-labelledby', b.id);
      b.setAttribute('aria-controls', section.id);
    }
  }
  let active = fallback;
  let announced = false;
  const show = (name: string) => {
    if (!buttons.some((b) => b.dataset.tab === name)) return;
    const changed = !announced || active !== name;
    active = name;
    for (const b of buttons) {
      const chosen = b.dataset.tab === name;
      b.classList.toggle('active', chosen);
      b.setAttribute('aria-selected', String(chosen));
      b.tabIndex = chosen ? 0 : -1;
    }
    for (const s of sections) s.hidden = s.dataset.panel !== name;
    memory.set('tab', name);
    if (!changed) return;
    announced = true;
    onChange?.(name);
    strip.dispatchEvent(new CustomEvent(TAB_CHANGE, { bubbles: true, detail: name }));
  };
  for (const b of buttons) b.addEventListener('click', () => show(b.dataset.tab ?? fallback));
  strip.addEventListener('keydown', (event) => {
    const at = buttons.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    const to = tabKeyTarget(event.key, at, buttons.length);
    if (to === undefined) return;
    // Kept from the window's shortcuts as well as the page's scrolling: on a tab, the arrows and
    // Home are the strip's, not the timeline's.
    event.preventDefault();
    event.stopPropagation();
    const button = buttons[to] as HTMLButtonElement;
    button.focus();
    show(button.dataset.tab ?? fallback);
  });
  show(memory.get('tab') ?? fallback);
  return {
    get active() {
      return active;
    },
    show,
  };
}

/**
 * Which tab a key moves focus to in a vertical strip of `count`, from the one at `at`, or
 * undefined when the key is not the strip's. The arrows wrap at the ends, as a tab list's do.
 */
export function tabKeyTarget(key: string, at: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  switch (key) {
    case 'ArrowDown':
      return (at + 1) % count;
    case 'ArrowUp':
      return (at - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}
