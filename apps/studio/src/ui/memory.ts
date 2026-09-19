/**
 * What the page remembers between visits: the layout, not the run.
 *
 * Which tab was open, which overlays were on, whether the grid and the notes were shown, which
 * panels were collapsed. A run's settings belong to a session file; these belong to the page,
 * the way an application remembers its window. Backed by `localStorage` when there is one and
 * silent when there is not -- a private window or a blocked store just forgets.
 */

export interface Memory {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  /** Bind a checkbox: restore its state now, remember every change. */
  checkbox(input: HTMLInputElement, key: string): void;
  /** Bind a `<details>`: restore whether it was open, remember every toggle. */
  details(element: HTMLDetailsElement, key: string): void;
}

const PREFIX = 'bs-humany.studio.';

export function createMemory(store: Storage | undefined = safeLocalStorage()): Memory {
  const get = (key: string): string | undefined => {
    try {
      return store?.getItem(PREFIX + key) ?? undefined;
    } catch {
      return undefined;
    }
  };
  const set = (key: string, value: string): void => {
    try {
      store?.setItem(PREFIX + key, value);
    } catch {
      // A full or forbidden store forgets; the page still works.
    }
  };
  return {
    get,
    set,
    checkbox(input, key) {
      const remembered = get(key);
      if (remembered !== undefined) {
        const checked = remembered === '1';
        if (input.checked !== checked) {
          input.checked = checked;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      input.addEventListener('change', () => set(key, input.checked ? '1' : '0'));
    },
    details(element, key) {
      const remembered = get(key);
      if (remembered !== undefined) element.open = remembered === '1';
      element.addEventListener('toggle', () => set(key, element.open ? '1' : '0'));
    },
  };
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
