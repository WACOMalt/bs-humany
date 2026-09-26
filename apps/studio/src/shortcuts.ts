/**
 * Which keys belong to the control that has focus, and which are the studio's shortcuts.
 *
 * The studio used to refuse every shortcut while any button or input had focus, and a mouse
 * click leaves focus on whatever was clicked. So one click on a checkbox or a view button and
 * Space, the arrows and the view numbers were dead until somebody clicked the empty canvas --
 * and Space, with the Start button focused after a click on it, pressed Start again, which on a
 * live run is Restart and throws the run away.
 *
 * The rule now is the one the platform already has: a control owns the keys it acts on, and no
 * others. A checkbox owns Space and Enter because Space toggles it; it has no use for the arrows,
 * so they stay the timeline's. A range slider or a text box owns everything, because the arrows
 * move it and every printable key types.
 */

const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const ACTIVATE = new Set([' ', 'Enter']);

/**
 * Whether a key pressed on this control is the control's own, from what it is.
 *
 * Pure, so the rule can be checked without a DOM: `tag` is the element's lower-case tag name,
 * `type` an input's type, `role` its ARIA role and `editable` whether it is contenteditable.
 */
export function keyOwnedByControl(
  tag: string,
  type: string | undefined,
  role: string | null,
  editable: boolean,
  key: string,
): boolean {
  if (editable || tag === 'textarea' || tag === 'select') return true;
  // A splitter and a tab strip move by arrow, and jump to their ends by Home and End. Checked
  // before the tag, because a tab is usually a button: it keeps a button's Space and Enter too.
  if (role === 'separator' || role === 'tab') {
    if (ARROWS.has(key) || key === 'Home' || key === 'End') return true;
    return (tag === 'button' || tag === 'summary') && ACTIVATE.has(key);
  }
  if (tag === 'input') {
    switch ((type ?? 'text').toLowerCase()) {
      case 'checkbox':
      case 'button':
      case 'submit':
      case 'reset':
        return ACTIVATE.has(key);
      case 'radio':
        // Space checks a radio button and the arrows move the choice within its group.
        return key === ' ' || ARROWS.has(key);
      default:
        // Text, number, search, range and the rest: the arrows move them and anything types.
        return true;
    }
  }
  if (tag === 'button' || tag === 'summary') return ACTIVATE.has(key);
  return false;
}

/** `keyOwnedByControl`, read off whatever a keyboard event was aimed at. */
export function keyOwnedByTarget(target: EventTarget | null, key: string): boolean {
  if (!target || typeof (target as Element).tagName !== 'string') return false;
  const element = target as HTMLElement;
  return keyOwnedByControl(
    element.tagName.toLowerCase(),
    element.tagName.toLowerCase() === 'input' ? (element as HTMLInputElement).type : undefined,
    element.getAttribute('role'),
    element.isContentEditable === true,
    key,
  );
}
