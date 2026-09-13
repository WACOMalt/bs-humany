/**
 * Orbit camera controls.
 *
 * Written rather than pulled from `three/examples/jsm`, for two reasons. The examples build is not
 * covered by three.js's semver guarantees and moves between releases, and this needs one thing the
 * stock controls do not expose: `wasDragging`, so a click that ends an orbit does not also select a
 * bone underneath the cursor. That interaction bug is small and extremely irritating.
 *
 * Spherical coordinates about a target. Spec section 11 asks for orbit, pan and zoom; a
 * centre-of-mass follow mode arrives with the physics in M3.
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
   * True when the pointer moved far enough during the last press to count as a drag.
   *
   * Lets the click handler distinguish "finished orbiting" from "selected a bone", which are
   * otherwise the same event.
   */
  wasDragging(): boolean;
  target: Vector3;
}

/** Pixels of pointer travel before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;

const MIN_POLAR = 0.08;
const MAX_POLAR = Math.PI - 0.08;
const MIN_DISTANCE = 0.35;
const MAX_DISTANCE = 12;

export interface OrbitOptions {
  /**
   * Called on every primary pointer press before the orbit claims it. Return true to take the
   * pointer for something else -- grabbing a bone -- and the orbit leaves it alone.
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
  let lastX = 0;
  let lastY = 0;

  // Damped, so a flick eases out instead of stopping dead.
  let azimuthVelocity = 0;
  let polarVelocity = 0;

  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;

  element.style.touchAction = 'none';

  element.addEventListener('pointerdown', (event) => {
    if (event.button === 0 && !event.shiftKey && options.claimPointer?.(event)) return;
    element.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    dragging = true;
    panning = event.button === 2 || event.shiftKey;
    moved = 0;
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
      spherical.radius *= 1 + Math.sign(event.deltaY) * 0.09;
      spherical.radius = clamp(spherical.radius, MIN_DISTANCE, MAX_DISTANCE);
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

    wasDragging() {
      return moved > DRAG_THRESHOLD;
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
