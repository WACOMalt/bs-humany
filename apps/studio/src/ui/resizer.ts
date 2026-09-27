/**
 * A drag handle on the properties editor's inner edge, so the editor is as wide as the work
 * wants -- a table of joints wants more than a column of sliders. The width is a CSS variable
 * on the root, so the grid and the viewport follow it, and it is remembered.
 *
 * Two widths are kept apart: the one somebody asked for, which is what is remembered, and the one
 * applied, which is that request fitted to the window. The editor used to be allowed its full
 * maximum however narrow the window was, so on a small window a wide editor squeezed the viewport
 * down to nothing, and nothing brought it back when the window grew. Now the viewport always keeps
 * `MIN_VIEWPORT`, and a window that shrinks and grows again gives the editor back the width that
 * was asked for rather than the width it was squeezed to.
 *
 * The handle is a focusable separator as well, for a keyboard: the arrows move it, Shift makes the
 * step bigger, and Home and End go to the narrowest and widest the window allows.
 */

import type { Memory } from './memory.js';

export const MIN_WIDTH = 280;
export const MAX_WIDTH = 900;
/** The least the viewport is left when the editor widens, px. */
export const MIN_VIEWPORT = 320;
/** How far one arrow press moves the edge, and one with Shift held, px. */
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/**
 * The editor width that fits: the width asked for, held between `MIN_WIDTH` and the most the
 * window can give while leaving the viewport `MIN_VIEWPORT` -- but never under `MIN_WIDTH`, even
 * on a window too narrow for both, because an editor too narrow to use is no better than a
 * viewport too narrow to see.
 */
export function clampEditorWidth(width: number, innerWidth: number): number {
  const most = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, innerWidth - MIN_VIEWPORT));
  return Math.round(Math.min(most, Math.max(MIN_WIDTH, width)));
}

export function createResizer(
  handle: HTMLElement,
  memory: Memory,
  variable = '--properties',
  key = 'properties.width',
): void {
  const root = document.documentElement;
  /** The width asked for, by a drag, a key or the memory; undefined is the stylesheet's own. */
  let preferred: number | undefined;
  const defaultWidth = () =>
    Number.parseFloat(getComputedStyle(root).getPropertyValue(variable)) || MIN_WIDTH;
  const apply = () => {
    if (preferred === undefined) {
      root.style.removeProperty(variable);
    } else {
      root.style.setProperty(variable, `${clampEditorWidth(preferred, window.innerWidth)}px`);
    }
    // What the handle reports is the width in use, whichever of the two set it.
    const shown = clampEditorWidth(preferred ?? defaultWidth(), window.innerWidth);
    handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
    handle.setAttribute('aria-valuemax', String(clampEditorWidth(MAX_WIDTH, window.innerWidth)));
    handle.setAttribute('aria-valuenow', String(shown));
  };
  const remember = () => memory.set(key, preferred === undefined ? '' : String(preferred));

  const remembered = Number(memory.get(key));
  if (Number.isFinite(remembered) && remembered > 0) preferred = remembered;
  apply();
  window.addEventListener('resize', apply);

  let dragging = false;
  handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
    event.preventDefault();
  });
  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    // The editor's width is the distance from the pointer to the window's right edge, held to
    // what fits: dragged past the viewport's minimum, the edge stays there rather than asking
    // for a width the window will never give it.
    preferred = clampEditorWidth(window.innerWidth - event.clientX, window.innerWidth);
    apply();
  });
  // A cancelled pointer has no position worth reading, so what is kept is the width the drag had
  // reached, never one worked out again from the event.
  const stop = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    remember();
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
  handle.addEventListener('dblclick', () => {
    preferred = undefined;
    apply();
    remember();
  });
  handle.addEventListener('keydown', (event) => {
    const now = clampEditorWidth(preferred ?? defaultWidth(), window.innerWidth);
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let next: number;
    switch (event.key) {
      // The handle is the editor's left edge: moving it left widens the editor.
      case 'ArrowLeft':
        next = now + step;
        break;
      case 'ArrowRight':
        next = now - step;
        break;
      case 'Home':
        next = MIN_WIDTH;
        break;
      case 'End':
        next = MAX_WIDTH;
        break;
      default:
        return;
    }
    // The arrows are the edge's, not the timeline's: without this they stepped the playhead too.
    event.preventDefault();
    event.stopPropagation();
    preferred = clampEditorWidth(next, window.innerWidth);
    apply();
    remember();
  });
}
