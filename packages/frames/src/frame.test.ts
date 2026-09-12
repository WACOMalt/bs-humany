import { describe, expect, it } from 'vitest';
import { frameAxes, frameFromLandmarkPoints, frameFromLandmarks } from './frame.js';
import { column, isRotation } from './mat3.js';
import { makeTestRandom, randomVec3 } from './testing.js';
import { invert, transformDirection, transformPoint } from './transform.js';
import {
  UNIT_X,
  UNIT_Y,
  UNIT_Z,
  approxEquals,
  cross,
  dot,
  length as len,
  negate,
  normalize,
  sub,
  vec3,
} from './vec3.js';

describe('frameFromLandmarks', () => {
  it('places the primary direction on the requested axis', () => {
    const frame = frameFromLandmarks({
      origin: vec3(0, 0, 0),
      primaryDirection: UNIT_Y,
      primaryAxis: 'y',
      secondaryDirection: UNIT_X,
      secondaryAxis: 'x',
    });
    const axes = frameAxes(frame);
    expect(approxEquals(column(axes, 1), UNIT_Y, 1e-12)).toBe(true);
    expect(approxEquals(column(axes, 0), UNIT_X, 1e-12)).toBe(true);
    expect(approxEquals(column(axes, 2), UNIT_Z, 1e-12)).toBe(true);
  });

  it('orthogonalizes a secondary direction that is not perpendicular', () => {
    // Real bony landmark pairs are never exactly perpendicular. Gram-Schmidt is the point.
    const frame = frameFromLandmarks({
      origin: vec3(0, 0, 0),
      primaryDirection: UNIT_Y,
      primaryAxis: 'y',
      secondaryDirection: normalize(vec3(1, 0.5, 0)),
      secondaryAxis: 'x',
    });
    const axes = frameAxes(frame);
    expect(approxEquals(column(axes, 0), UNIT_X, 1e-12)).toBe(true);
    expect(Math.abs(dot(column(axes, 0), column(axes, 1)))).toBeLessThan(1e-12);
  });

  it('always produces a right-handed orthonormal frame', () => {
    const next = makeTestRandom(2929);
    let built = 0;
    for (let i = 0; i < 500; i++) {
      const primary = randomVec3(next, 2);
      const secondary = randomVec3(next, 2);
      if (len(primary) < 0.2 || len(secondary) < 0.2) continue;
      if (len(cross(normalize(primary), normalize(secondary))) < 0.1) continue;

      const frame = frameFromLandmarks({
        origin: randomVec3(next, 3),
        primaryDirection: primary,
        primaryAxis: 'y',
        secondaryDirection: secondary,
        secondaryAxis: 'z',
      });
      const axes = frameAxes(frame);
      expect(isRotation(axes, 1e-9)).toBe(true);
      // Right-handed: x cross y must equal z, not negate it.
      expect(approxEquals(cross(column(axes, 0), column(axes, 1)), column(axes, 2), 1e-9)).toBe(
        true,
      );
      built++;
    }
    expect(built).toBeGreaterThan(100);
  });

  it('gets the third-axis sign right for both cyclic and anti-cyclic assignments', () => {
    const cyclic = frameFromLandmarks({
      origin: vec3(0, 0, 0),
      primaryDirection: UNIT_X,
      primaryAxis: 'x',
      secondaryDirection: UNIT_Y,
      secondaryAxis: 'y',
    });
    expect(approxEquals(column(frameAxes(cyclic), 2), UNIT_Z, 1e-12)).toBe(true);

    // Anti-cyclic assignment: primary on y, secondary on x. The derived z must still complete a
    // right-handed frame, which means it points along -Z here.
    const antiCyclic = frameFromLandmarks({
      origin: vec3(0, 0, 0),
      primaryDirection: UNIT_Y,
      primaryAxis: 'y',
      secondaryDirection: UNIT_Z,
      secondaryAxis: 'z',
    });
    const axes = frameAxes(antiCyclic);
    expect(isRotation(axes, 1e-12)).toBe(true);
    expect(approxEquals(column(axes, 0), UNIT_X, 1e-12)).toBe(true);
  });

  it('carries the origin through', () => {
    const origin = vec3(0.1, -0.2, 0.35);
    const frame = frameFromLandmarks({
      origin,
      primaryDirection: UNIT_Y,
      primaryAxis: 'y',
      secondaryDirection: UNIT_X,
      secondaryAxis: 'x',
    });
    expect(frame.translation).toEqual(origin);
    expect(approxEquals(transformPoint(frame, vec3(0, 0, 0)), origin, 1e-15)).toBe(true);
  });
});

describe('frameFromLandmarks guards', () => {
  it('refuses the same axis twice', () => {
    expect(() =>
      frameFromLandmarks({
        origin: vec3(0, 0, 0),
        primaryDirection: UNIT_Y,
        primaryAxis: 'y',
        secondaryDirection: UNIT_X,
        secondaryAxis: 'y',
      }),
    ).toThrow(/must be different axes/);
  });

  it('refuses parallel directions, naming the likely cause', () => {
    // A bone frame silently collapsing to an arbitrary roll is exactly the kind of plausible
    // wrongness this project exists to avoid, so this throws rather than picking something.
    expect(() =>
      frameFromLandmarks({
        origin: vec3(0, 0, 0),
        primaryDirection: UNIT_Y,
        primaryAxis: 'y',
        secondaryDirection: UNIT_Y,
        secondaryAxis: 'x',
      }),
    ).toThrow(/parallel to the primary direction/);
  });

  it('refuses antiparallel directions too', () => {
    expect(() =>
      frameFromLandmarks({
        origin: vec3(0, 0, 0),
        primaryDirection: UNIT_Y,
        primaryAxis: 'y',
        secondaryDirection: negate(UNIT_Y),
        secondaryAxis: 'x',
      }),
    ).toThrow(/parallel to the primary direction/);
  });

  it('refuses coincident landmarks', () => {
    expect(() =>
      frameFromLandmarkPoints({
        origin: vec3(0, 0, 0),
        primaryFrom: vec3(1, 1, 1),
        primaryTo: vec3(1, 1, 1),
        primaryAxis: 'y',
        secondaryFrom: vec3(0, 0, 0),
        secondaryTo: vec3(1, 0, 0),
        secondaryAxis: 'x',
      }),
    ).toThrow(/coincident|Cannot normalize/);
  });
});

describe('frameFromLandmarkPoints', () => {
  it('matches the direction form', () => {
    const proximal = vec3(0, 0.9, 0);
    const distal = vec3(0, 0.45, 0);
    const medial = vec3(-0.04, 0.45, 0);
    const lateral = vec3(0.04, 0.45, 0);

    const fromPoints = frameFromLandmarkPoints({
      origin: distal,
      primaryFrom: distal,
      primaryTo: proximal,
      primaryAxis: 'y',
      secondaryFrom: medial,
      secondaryTo: lateral,
      secondaryAxis: 'x',
    });

    const fromDirections = frameFromLandmarks({
      origin: distal,
      primaryDirection: sub(proximal, distal),
      primaryAxis: 'y',
      secondaryDirection: sub(lateral, medial),
      secondaryAxis: 'x',
    });

    expect(approxEquals(fromPoints.translation, fromDirections.translation)).toBe(true);
    expect(
      approxEquals(column(frameAxes(fromPoints), 1), column(frameAxes(fromDirections), 1), 1e-12),
    ).toBe(true);
  });

  it('builds a plausible long-bone frame with the long axis superior', () => {
    // Shaped like an ISB long-bone frame: Y along the shaft pointing proximally, X medio-lateral.
    // Values are illustrative geometry for a unit test, not anthropometric data.
    const kneeCentre = vec3(0.09, 0.48, 0);
    const hipCentre = vec3(0.09, 0.92, 0);
    const medialEpicondyle = vec3(0.05, 0.48, 0);
    const lateralEpicondyle = vec3(0.13, 0.48, 0);

    const frame = frameFromLandmarkPoints({
      origin: kneeCentre,
      primaryFrom: kneeCentre,
      primaryTo: hipCentre,
      primaryAxis: 'y',
      secondaryFrom: medialEpicondyle,
      secondaryTo: lateralEpicondyle,
      secondaryAxis: 'x',
    });

    const axes = frameAxes(frame);
    expect(isRotation(axes, 1e-12)).toBe(true);
    // Long axis points superiorly in the world frame.
    expect(approxEquals(column(axes, 1), UNIT_Y, 1e-12)).toBe(true);
    // Medio-lateral axis points to the subject's right, which is +X in the world frame.
    expect(approxEquals(column(axes, 0), UNIT_X, 1e-12)).toBe(true);

    // A point one unit up the local Y axis lands one metre above the knee centre.
    expect(approxEquals(transformPoint(frame, vec3(0, 1, 0)), vec3(0.09, 1.48, 0), 1e-12)).toBe(
      true,
    );
    // And a local direction converts back through the inverse unchanged.
    expect(
      approxEquals(
        transformDirection(invert(frame), transformDirection(frame, UNIT_Z)),
        UNIT_Z,
        1e-12,
      ),
    ).toBe(true);
  });
});
