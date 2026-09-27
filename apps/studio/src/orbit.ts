/**
 * Orbit camera controls.
 *
 * Written rather than pulled from `three/examples/jsm`, for two reasons. The examples build is not
 * covered by three.js's semver guarantees and moves between releases, and this needs one thing the
 * stock controls do not expose: `wasDragging`, so a click that ends an orbit does not also select a
 * bone underneath the cursor. That interaction bug is small and extremely irritating.
 *
 * Spherical coordinates about a target. Spec section 11 asks for orbit, pan and zoom. The spec's
 * centre-of-mass follow mode (spec section 11) is not built yet; the view buttons and F aim at the
 * body when pressed, which is the nearest thing to it.
 */

import type { PerspectiveCamera } from 'three';
import { Spherical, Vector3 } from 'three';

export interface OrbitControls {
  update(): void;
  /** Rotate the azimuth by `delta` radians. Drives the turntable toggle. */
  orbit(delta: number): void;
  /** Jump to a view: azimuth and polar angle in radians, distance in metres. */
  setView(theta: number, phi: number, radius: number): void;
  /**
   * Stand off at this distance from the target, keeping the angle the camera looks from.
   *
   * What F does: the body is put back in the middle of the picture without turning the view
   * somebody chose.
   */
  setDistance(radius: number): void;
  /**
   * True when the pointer moved far enough during the last press to count as a drag, or the press
   * was taken by something else.
   *
   * Lets the click handler distinguish "finished orbiting" from "selected a bone", which are
   * otherwise the same event. A claimed press -- a gizmo dragged and let go over empty space, a
   * bone grabbed and dropped -- ends in a click on the canvas too, and that click is the end of
   * the claim, not a pick.
   */
  wasDragging(): boolean;
  target: Vector3;
}

/**
 * Pixels of pointer travel before a press counts as a drag rather than a click.
 *
 * Exported so anything else that has to tell a click from a drag on the same canvas -- the Align
 * tab's point picking -- draws the line in the same place.
 */
export const DRAG_THRESHOLD = 4;

const MIN_POLAR = 0.08;
const MAX_POLAR = Math.PI - 0.08;
const MIN_DISTANCE = 0.35;
const MAX_DISTANCE = 12;

/**
 * Pixels one line of a line-mode wheel event stands for. Firefox reports a notch as three lines;
 * 33 px a line puts its notch at the 100 px Chrome reports for one, so the two zoom alike.
 */
export const LINE_PIXELS = 33;
/**
 * Zoom per pixel of wheel travel, as a fraction of the distance: 0.001 makes a 100 px notch about
 * 10%, which is the step the old fixed 9% per event was tuned to feel like.
 */
export const WHEEL_ZOOM_PER_PIXEL = 0.001;
/**
 * Zoom per pixel of a trackpad pinch, which browsers report as a wheel event with Ctrl held and
 * deltas of a few pixels at a time: ten times the wheel's, so a pinch covers a useful range in
 * one gesture.
 */
export const PINCH_ZOOM_PER_PIXEL = 0.01;
/**
 * The most one event may zoom, as a logarithm: exp(0.25) is about 28%. A page-mode event, or a
 * driver that reports a whole fling in one delta, would otherwise throw the camera to a limit.
 */
export const MAX_WHEEL_STEP = 0.25;

/**
 * How much one wheel event scales the camera's distance.
 *
 * Proportional to the travel the event reports. The old handler took only its sign and zoomed 9%
 * whatever the size, which is right for a notched wheel's one event a notch and wrong for a
 * trackpad, which sends dozens of events of a few pixels each: a gentle swipe flew the camera from
 * one end of its range to the other. An exponential of the travel, so an out and an in of the same
 * size cancel exactly, and so the zoom is the same however the travel is split into events.
 *
 * `deltaMode` is the event's unit: 0 pixels, 1 lines, 2 pages (`pageHeight` pixels each). Ctrl
 * held marks a pinch.
 */
export function wheelZoomFactor(
  deltaY: number,
  deltaMode: number,
  ctrlKey: boolean,
  pageHeight: number,
): number {
  const pixels =
    deltaMode === 1 ? deltaY * LINE_PIXELS : deltaMode === 2 ? deltaY * pageHeight : deltaY;
  const step = pixels * (ctrlKey ? PINCH_ZOOM_PER_PIXEL : WHEEL_ZOOM_PER_PIXEL);
  return Math.exp(clamp(step, -MAX_WHEEL_STEP, MAX_WHEEL_STEP));
}

export interface OrbitOptions {
  /**
   * Offered every left-press. Returning true means something else has taken the pointer and the
   * camera should not move.
   */
  readonly claimPointer?: (event: PointerEvent) => boolean;
}

export function createOrbitControls(
  camera: PerspectiveCamera,
  element: HTMLElement,
  target: Vector3,
  options: OrbitOptions = {},
): OrbitControls {
  const spherical = new Spherical();
  const offset = new Vector3().copy(camera.position).sub(target);
  spherical.setFromVector3(offset);

  let dragging = false;
  let panning = false;
  let moved = 0;
  /** Whether the last press was taken by `claimPointer`, which makes it a drag whatever it did. */
  let claimed = false;
  let lastX = 0;
  let lastY = 0;

  // Damped, so a flick eases out instead of stopping dead.
  let azimuthVelocity = 0;
  let polarVelocity = 0;

  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;

  element.style.touchAction = 'none';

  element.addEventListener('pointerdown', (event) => {
    // Reset before anything can return, so `wasDragging` always describes this press. It used to
    // reset only once the orbit took the press, and a claimed or Ctrl press answered with whatever
    // the press before it had been.
    moved = 0;
    claimed = false;
    if (event.button === 0 && !event.shiftKey && options.claimPointer?.(event)) {
      claimed = true;
      return;
    }
    // Ctrl is the modifier for reaching into the scene rather than moving around it. The camera
    // holds still for the whole press even when the reach missed, so a near miss does not swing
    // the view out from under the next attempt.
    if (event.ctrlKey) return;
    element.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    dragging = true;
    panning = event.button === 2 || event.shiftKey;
    lastX = event.clientX;
    lastY = event.clientY;
  });

  element.addEventListener('pointermove', (event) => {
    if (pointers.has(event.pointerId)) {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    // Two fingers: pinch to zoom.
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      if (a && b) {
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDistance > 0) {
          spherical.radius *= pinchDistance / distance;
          spherical.radius = clamp(spherical.radius, MIN_DISTANCE, MAX_DISTANCE);
        }
        pinchDistance = distance;
      }
      return;
    }

    if (!dragging) return;

    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    moved += Math.abs(dx) + Math.abs(dy);

    if (panning) {
      // Pan in the camera's own plane, scaled by distance so it feels the same at any zoom.
      const scale = spherical.radius * 0.0016;
      const right = new Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new Vector3().setFromMatrixColumn(camera.matrix, 1);
      target.addScaledVector(right, -dx * scale);
      target.addScaledVector(up, dy * scale);
    } else {
      azimuthVelocity -= dx * 0.0052;
      polarVelocity -= dy * 0.0052;
    }
  });

  const endPointer = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
    if (pointers.size === 0) {
      dragging = false;
      panning = false;
    }
  };

  element.addEventListener('pointerup', endPointer);
  element.addEventListener('pointercancel', endPointer);
  element.addEventListener('contextmenu', (event) => event.preventDefault());

  element.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      // A page is the canvas's height; before it is laid out, any plausible height does, because
      // MAX_WHEEL_STEP caps a page-mode event long before the height matters.
      const factor = wheelZoomFactor(
        event.deltaY,
        event.deltaMode,
        event.ctrlKey,
        element.clientHeight || 800,
      );
      spherical.radius = clamp(spherical.radius * factor, MIN_DISTANCE, MAX_DISTANCE);
    },
    { passive: false },
  );

  return {
    target,

    orbit(delta: number) {
      spherical.theta += delta;
    },

    setView(theta: number, phi: number, radius: number) {
      spherical.theta = theta;
      spherical.phi = clamp(phi, MIN_POLAR, MAX_POLAR);
      spherical.radius = clamp(radius, MIN_DISTANCE, MAX_DISTANCE);
      azimuthVelocity = 0;
      polarVelocity = 0;
    },

    setDistance(radius: number) {
      spherical.radius = clamp(radius, MIN_DISTANCE, MAX_DISTANCE);
    },

    wasDragging() {
      return claimed || moved > DRAG_THRESHOLD;
    },

    update() {
      spherical.theta += azimuthVelocity;
      spherical.phi = clamp(spherical.phi + polarVelocity, MIN_POLAR, MAX_POLAR);

      azimuthVelocity *= 0.82;
      polarVelocity *= 0.82;

      camera.position.setFromSpherical(spherical).add(target);
      camera.lookAt(target);
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
