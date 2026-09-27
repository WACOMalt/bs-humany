/**
 * Picking a point of ours off the screen: what counts as under the cursor, and which of two wins.
 *
 * The pick is measured in CSS pixels because the dots are drawn in CSS pixels -- nine across at
 * any distance -- so a tolerance in world metres would be a different size on screen at every
 * zoom: most of the viewport close up, and less than a pixel from across the room.
 */

import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { type Handle, PointHandles } from './pointHandles.js';

const RECT = { left: 30, top: 40, width: 800, height: 600 } as const;
/** The screen position of the world origin, which the camera below always looks at. */
const CENTRE_X = RECT.left + RECT.width / 2;
const CENTRE_Y = RECT.top + RECT.height / 2;

function cameraAt(distance: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, RECT.width / RECT.height, 0.01, 100);
  camera.position.set(0, 0, distance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

function handle(id: string, x: number, y: number, z: number): Handle {
  const world = new Vector3(x, y, z);
  return { id, kind: 'joints', on: 'pelvis', world, original: world.clone() };
}

function handlesOf(...list: Handle[]): PointHandles {
  const handles = new PointHandles();
  handles.show(list);
  return handles;
}

describe('the point handles', () => {
  it('can be asked whether they are showing, not only told', () => {
    const handles = new PointHandles();
    expect(handles.visible).toBe(false);
    handles.visible = true;
    expect(handles.visible).toBe(true);
    handles.visible = false;
    expect(handles.visible).toBe(false);
  });

  for (const distance of [0.5, 12]) {
    it(`pick a dot 6 px from the cursor and not one 12 px away, from ${distance} m`, () => {
      const camera = cameraAt(distance);
      const handles = handlesOf(handle('hip_r', 0, 0, 0));
      // Along a diagonal, so neither screen axis is the only one being measured.
      const d6 = 6 / Math.SQRT2;
      const d12 = 12 / Math.SQRT2;
      expect(handles.nearestOnScreen(camera, RECT, CENTRE_X, CENTRE_Y)).toBe(0);
      expect(handles.nearestOnScreen(camera, RECT, CENTRE_X + d6, CENTRE_Y - d6)).toBe(0);
      expect(handles.nearestOnScreen(camera, RECT, CENTRE_X + d12, CENTRE_Y - d12)).toBe(-1);
    });
  }

  it('give a shared pixel to the dot nearer the camera, whichever is listed first', () => {
    const camera = cameraAt(2);
    // Both on the camera's axis, so both land on the centre pixel; the second is 30 cm nearer.
    const far = handle('far', 0, 0, 0);
    const near = handle('near', 0, 0, 0.3);
    expect(handlesOf(far, near).nearestOnScreen(camera, RECT, CENTRE_X, CENTRE_Y)).toBe(1);
    expect(handlesOf(near, far).nearestOnScreen(camera, RECT, CENTRE_X, CENTRE_Y)).toBe(0);
  });

  it('never pick a dot behind the camera, though it projects onto the cursor', () => {
    const camera = cameraAt(2);
    // A metre behind the eye on the same axis: the perspective divide puts it on the centre pixel
    // with a depth past the far side of the view volume.
    const handles = handlesOf(handle('behind', 0, 0, 3));
    expect(handles.nearestOnScreen(camera, RECT, CENTRE_X, CENTRE_Y)).toBe(-1);
  });
});
