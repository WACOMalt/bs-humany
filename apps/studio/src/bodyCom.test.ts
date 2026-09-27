/**
 * The points the overlay and the camera read the body's place from.
 */

import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { boundsMidpoint, segmentComs, wholeBodyCom } from './bodyCom.js';

describe('the whole-body centre of mass', () => {
  it('is the mass-weighted mean of the segments', () => {
    // 1 kg at the origin and 3 kg at x = 4: a quarter of the way from the heavy one, at x = 3.
    const out = new Vector3();
    expect(wholeBodyCom([1, 3], [0, 0, 0, 4, 2, -8], out)).toBe(true);
    expect(out.x).toBeCloseTo(3, 12);
    expect(out.y).toBeCloseTo(1.5, 12);
    expect(out.z).toBeCloseTo(-6, 12);
  });

  it('leaves the output alone for a body with no mass', () => {
    const out = new Vector3(7, 8, 9);
    expect(wholeBodyCom([0, 0], [1, 1, 1, 2, 2, 2], out)).toBe(false);
    expect(out.toArray()).toEqual([7, 8, 9]);
  });
});

describe('the segments’ centres in the world', () => {
  it('turn each local centre by its segment and carry it to where the segment is', () => {
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    const out = new Float64Array(6);
    segmentComs(
      [
        { x: 1, y: 0, z: 0 },
        { x: 0.2, y: -0.5, z: 0.3 },
      ],
      [0, 0, 0, 10, 20, 30],
      [0, 0, 0, 1, turn.x, turn.y, turn.z, turn.w],
      out,
    );
    expect(Array.from(out.subarray(0, 3))).toEqual([1, 0, 0]);
    const expected = new Vector3(0.2, -0.5, 0.3).applyQuaternion(turn).add(new Vector3(10, 20, 30));
    expect(out[3]).toBeCloseTo(expected.x, 12);
    expect(out[4]).toBeCloseTo(expected.y, 12);
    expect(out[5]).toBeCloseTo(expected.z, 12);
  });
});

describe('the middle of a set of points', () => {
  it('is the centre of their box, not their mean', () => {
    const out = new Vector3();
    expect(boundsMidpoint([0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 4, -6], out)).toBe(true);
    expect(out.toArray()).toEqual([1, 2, -3]);
  });

  it('has nothing to say about no points', () => {
    const out = new Vector3(1, 2, 3);
    expect(boundsMidpoint([], out)).toBe(false);
    expect(out.toArray()).toEqual([1, 2, 3]);
  });
});
