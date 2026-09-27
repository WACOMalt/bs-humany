/**
 * Picking a point of ours off the screen: what counts as under the cursor, and which of two wins.
 *
 * The pick is measured in CSS pixels because the dots are drawn in CSS pixels -- nine across at
 * any distance -- so a tolerance in world metres would be a different size on screen at every
 * zoom: most of the viewport close up, and less than a pixel from across the room.
 */

import { type Color, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { HANDLE_COLOURS, type Handle, type Move, PointHandles } from './pointHandles.js';

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

describe('moves across a redraw', () => {
  /** Fresh handles, as a rebuild or a switch of kind makes them: every one at its original. */
  const fresh = () => [handle('hip_r', 0.08, 0.85, 0), handle('knee_r', 0.07, 0.45, 0.03)];
  const keptOf = (...moves: Move[]) => new Map(moves.map((m) => [m.id, m]));
  /** The colour attribute is single precision, so a colour is read back to within a float. */
  const same = (drawn: Color | undefined, want: Color) => {
    expect(drawn).toBeDefined();
    for (const channel of ['r', 'g', 'b'] as const) {
      expect(drawn?.[channel]).toBeCloseTo(want[channel], 6);
    }
  };

  it('keeps a kept move on fresh handles, in the kept colour, and puts it back on revert', () => {
    const first = new PointHandles();
    first.show(fresh());
    first.pick(0);
    first.moveTo(new Vector3(0.085, 0.85, 0));
    const move = first.keep('the marker is a label anchor');
    if (!move) throw new Error('a 5 mm move was not kept');
    expect(move.moved).toBeCloseTo(5, 6);

    const again = new PointHandles();
    const { stale } = again.show(fresh(), keptOf(move), new Map());
    expect(stale).toEqual([]);
    const hip = again.all[0];
    expect(hip?.world.x).toBeCloseTo(0.085, 9);
    same(again.colourAt(0), HANDLE_COLOURS.kept);
    same(again.colourAt(1), HANDLE_COLOURS.rest);

    again.pick(0);
    const back = again.revert();
    expect(back?.world.distanceTo(back.original)).toBe(0);
  });

  it('reports a kept move whose from is a millimetre off as stale, and does not apply it', () => {
    const move: Move = {
      id: 'hip_r',
      kind: 'joints',
      on: 'pelvis',
      from: [0.081, 0.85, 0],
      to: [0.09, 0.85, 0],
      moved: 9,
      reason: 'made on another body',
    };
    const handles = new PointHandles();
    const { stale } = handles.show(fresh(), keptOf(move), new Map());
    expect(stale).toEqual(['hip_r']);
    expect(handles.all[0]?.world.x).toBeCloseTo(0.08, 12);
    same(handles.colourAt(0), HANDLE_COLOURS.rest);
  });

  it('draws a move not kept yet where it was dragged, in the pending colour', () => {
    const handles = new PointHandles();
    handles.show(fresh(), new Map(), new Map([['knee_r', new Vector3(0.07, 0.46, 0.03)]]));
    expect(handles.all[1]?.world.y).toBeCloseTo(0.46, 12);
    same(handles.colourAt(1), HANDLE_COLOURS.pending);
    expect(HANDLE_COLOURS.pending.equals(HANDLE_COLOURS.lit)).toBe(false);
  });

  it('finds a handle by id, and says -1 for one it does not draw', () => {
    const handles = new PointHandles();
    handles.show(fresh());
    expect(handles.indexOf('knee_r')).toBe(1);
    expect(handles.indexOf('ankle_r')).toBe(-1);
  });
});
