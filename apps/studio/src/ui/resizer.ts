/**
 * A drag handle on the properties editor's inner edge, so the editor is as wide as the work
 * wants -- a table of joints wants more than a column of sliders. The width is a CSS variable
 * on the root, so the grid and the viewport follow it, and it is remembered.
 */

import type { Memory } from './memory.js';

export const MIN_WIDTH = 280;
export const MAX_WIDTH = 900;

export function createResizer(
  handle: HTMLElement,
  memory: Memory,
  variable = '--properties',
  key = 'properties.width',
): void {
  const root = document.documentElement;
  const apply = (width: number) => {
    const clamped = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)));
    root.style.setProperty(variable, `${clamped}px`);
    return clamped;
  };
  const remembered = Number(memory.get(key));
  if (Number.isFinite(remembered) && remembered > 0) apply(remembered);

  let dragging = false;
  handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
    event.preventDefault();
  });
  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    // The editor's width is the distance from the pointer to the window's right edge.
    apply(window.innerWidth - event.clientX);
  });
  const stop = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    handle.releasePointerCapture(event.pointerId);
    memory.set(key, String(apply(window.innerWidth - event.clientX)));
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
  handle.addEventListener('dblclick', () => {
    root.style.removeProperty(variable);
    memory.set(key, '');
  });
}
