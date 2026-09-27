/**
 * Whether the press that just ended was a drag, as the click handler that picks bones asks it.
 *
 * The answer has to describe the *last* press, whatever kind it was. A press that something else
 * claimed -- a gizmo handle, a grabbed bone -- is not a click on the scene either, and must not
 * leave the previous press's answer standing for the click that follows it.
 */

import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { MAX_WHEEL_STEP, createOrbitControls, wheelZoomFactor } from './orbit.js';

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

/**
 * Wheel zoom in proportion to the travel an event reports, so a trackpad's stream of small
 * deltas zooms as gently as the finger moves and a notched wheel feels as it always did.
 */
describe('the wheel zoom', () => {
  it('zooms one notch about ten percent, from Chrome’s pixels or Firefox’s lines', () => {
    for (const factor of [wheelZoomFactor(100, 0, false, 800), wheelZoomFactor(3, 1, false, 800)]) {
      expect(factor).toBeGreaterThanOrEqual(1.08);
      expect(factor).toBeLessThanOrEqual(1.12);
    }
  });

  it('keeps a trackpad swipe of forty small events under a quarter', () => {
    let product = 1;
    for (let i = 0; i < 40; i++) product *= wheelZoomFactor(4, 0, false, 800);
    expect(product).toBeLessThan(1.25);
  });

  it('undoes an out with an in of the same size', () => {
    for (const [delta, mode, pinch] of [
      [100, 0, false],
      [3, 1, false],
      [7, 0, true],
      [0.4, 2, false],
    ] as const) {
      expect(
        wheelZoomFactor(delta, mode, pinch, 800) * wheelZoomFactor(-delta, mode, pinch, 800),
      ).toBeCloseTo(1, 12);
    }
  });

  it('caps one huge event', () => {
    expect(wheelZoomFactor(1e6, 0, false, 800)).toBeCloseTo(Math.exp(MAX_WHEEL_STEP), 12);
    expect(wheelZoomFactor(-50, 2, false, 800)).toBeCloseTo(Math.exp(-MAX_WHEEL_STEP), 12);
    expect(wheelZoomFactor(1e6, 0, true, 800)).toBeCloseTo(Math.exp(MAX_WHEEL_STEP), 12);
  });

  it('zooms a pinch harder per pixel than a wheel', () => {
    expect(wheelZoomFactor(5, 0, true, 800)).toBeGreaterThan(wheelZoomFactor(5, 0, false, 800));
  });
});
