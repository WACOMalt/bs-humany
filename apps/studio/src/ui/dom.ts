/**
 * The handful of page helpers every part of the studio uses: finding an element that must be
 * there, writing text only when it changes, and putting a value on a control as a person would.
 *
 * One copy, because the studio's panels were one file until they were split, and each of them
 * would otherwise have grown its own. Nothing here runs when the module loads, so the run
 * controller can import `messageOf` and still be tested without a page.
 */

/** The element the page must have, or an error that names the selector it was looked for by. */
export function must<T extends Element>(selector: string): T {
  const element = window.document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

/** An error's message, or whatever was thrown as a string. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/**
 * Write an element's text only when it has changed.
 *
 * The frame loop writes its readouts sixty times a second, and most frames they say what they
 * said the frame before. A write of the same string still replaces the text node, which a screen
 * reader may announce again and which throws away a selection somebody was making in it.
 */
export function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/**
 * Put a value on a slider as though somebody had moved it there, so whatever it drives -- its
 * readout, the running body, the Brain panel's comparison -- follows. The one way the settings,
 * a checkpoint's recipe and the cord are put on the panels.
 */
export function setControl(input: HTMLInputElement, value: number): void {
  input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * A slider, select or checkbox set from the headset, told about it the way the mouse would tell
 * it: an `input` and then a `change`, because some controls act on one and some on the other.
 */
export function setFromPanel(input: HTMLInputElement | HTMLSelectElement, value: unknown): void {
  if (input instanceof HTMLInputElement && input.type === 'checkbox') {
    input.checked = Boolean(value);
  } else {
    input.value = String(value);
  }
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('change'));
}

/**
 * Give focus back to the page after a mouse click on a transport or view button.
 *
 * A clicked button keeps focus, and a focused button owns Space and Enter; left there, the next
 * Space would press the button again rather than reach the transport. A keyboard activation has a
 * `detail` of zero and keeps its focus, so somebody tabbing through the buttons stays where they
 * are.
 */
export function blurAfterMouse(event: MouseEvent): void {
  if (event.detail > 0) (event.currentTarget as HTMLElement | null)?.blur();
}

/**
 * Wait until the busy Start has been painted, then a little more.
 *
 * Building the body freezes the page for as long as it takes, and a freeze that begins before
 * the button has turned grey looks like a click that did nothing. One animation frame is not
 * enough -- the callback runs before that frame paints -- so the wait is a frame and then a task.
 * The timeout is for a page that is not painting at all, hidden or minimised, which would
 * otherwise never start.
 */
export function paintYield(): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      setTimeout(resolve, 0);
    };
    requestAnimationFrame(go);
    setTimeout(go, 100);
  });
}
