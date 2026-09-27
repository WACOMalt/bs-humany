/**
 * Whether the press that just ended was a drag, as the click handler that picks bones asks it.
 *
 * The answer has to describe the *last* press, whatever kind it was. A press that something else
 * claimed -- a gizmo handle, a grabbed bone -- is not a click on the scene either, and must not
 * leave the previous press's answer standing for the click that follows it.
 */

import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createOrbitControls } from './orbit.js';

type Listener = (event: unknown) => void;

/** Just enough of a canvas for the controls: listeners recorded by type, a style, a capture. */
function fakeElement() {
  const listeners = new Map<string, Listener[]>();
  const element = {
    style: {} as Record<string, string>,
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    setPointerCapture() {},
  };
  const fire = (type: string, event: Record<string, unknown>) => {
    for (const listener of listeners.get(type) ?? []) {
      listener({ pointerId: 1, button: 0, shiftKey: false, ctrlKey: false, ...event });
    }
  };
  return { element: element as unknown as HTMLElement, fire };
}

function controlsWith(claim: () => boolean) {
  const { element, fire } = fakeElement();
  const controls = createOrbitControls(new PerspectiveCamera(), element, new Vector3(), {
    claimPointer: claim,
  });
  return { controls, fire };
}

describe('the orbit controls', () => {
  it('count a claimed press as a drag, after a press that was a plain click', () => {
    let claiming = false;
    const { controls, fire } = controlsWith(() => claiming);
    fire('pointerdown', { clientX: 100, clientY: 100 });
    fire('pointerup', { clientX: 100, clientY: 100 });
    expect(controls.wasDragging()).toBe(false);

    claiming = true;
    fire('pointerdown', { clientX: 100, clientY: 100 });
    fire('pointerup', { clientX: 100, clientY: 100 });
    expect(controls.wasDragging()).toBe(true);
  });

  it('forget a 50 px orbit once an unclaimed press holds still', () => {
    const { controls, fire } = controlsWith(() => false);
    fire('pointerdown', { clientX: 100, clientY: 100 });
    fire('pointermove', { clientX: 150, clientY: 100 });
    fire('pointerup', { clientX: 150, clientY: 100 });
    expect(controls.wasDragging()).toBe(true);

    fire('pointerdown', { clientX: 150, clientY: 100 });
    fire('pointerup', { clientX: 150, clientY: 100 });
    expect(controls.wasDragging()).toBe(false);
  });

  it('treat an unclaimed Ctrl press as a plain click, not as the orbit before it', () => {
    const { controls, fire } = controlsWith(() => false);
    fire('pointerdown', { clientX: 100, clientY: 100 });
    fire('pointermove', { clientX: 150, clientY: 100 });
    fire('pointerup', { clientX: 150, clientY: 100 });
    expect(controls.wasDragging()).toBe(true);

    fire('pointerdown', { clientX: 150, clientY: 100, ctrlKey: true });
    fire('pointerup', { clientX: 150, clientY: 100, ctrlKey: true });
    expect(controls.wasDragging()).toBe(false);
  });
});
