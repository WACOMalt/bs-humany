/**
 * The fit of one bone from matched joints, on inputs whose answer is known.
 *
 * Every case builds their points, carries them through a rotation, a scale and a translation
 * chosen here, and asks the fit to find that transform again. Nothing is random: a fit that is
 * right for a seed and wrong for another is a fit these tests have to be able to reproduce.
 */

import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { FIT_KIND_NOTE, type FitKind, type Fitted, describeFits, fitOne } from './fit.js';
import type { BodyFit } from './retarget.js';

const turn = (axis: [number, number, number], degrees: number): Quaternion =>
  new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), (degrees * Math.PI) / 180);

/** Their points carried into ours by a known transform: rotate the scaled point, then move it. */
const carry = (
  theirs: readonly Vector3[],
  rotation: Quaternion,
  scale: number,
  shift: Vector3,
): Vector3[] =>
  theirs.map((p) => p.clone().multiplyScalar(scale).applyQuaternion(rotation).add(shift));

/** Where a fit puts a point of theirs. */
const through = (fit: Fitted, p: Vector3): Vector3 =>
  p.clone().multiplyScalar(fit.scale).applyQuaternion(fit.rotation).add(fit.position);

/** The angle between two rotations, in degrees, whichever hemisphere each quaternion is in. */
const apart = (a: Quaternion, b: Quaternion): number => (a.angleTo(b) * 180) / Math.PI;

const ROTATION = turn([0.3, -0.8, 0.5], 67);
const SCALE = 1.12;
const SHIFT = new Vector3(0.4, -0.25, 1.1);

/** Joints spread well past the reliable span, and not all in one plane. */
const CLOUD = [
  new Vector3(0, 0, 0),
  new Vector3(0.05, -0.42, 0.01),
  new Vector3(0.21, -0.18, 0.06),
  new Vector3(-0.12, -0.3, 0.19),
  new Vector3(0.08, 0.14, -0.22),
];

const PARENT: Fitted = {
  rotation: turn([0, 0, 1], 30),
  position: new Vector3(0.1, 0.2, 0.3),
  scale: 0.95,
  kind: 'kabsch',
  matched: 4,
  residual: 0.5,
};

describe('fitOne', () => {
  for (const n of [4, 5]) {
    it(`recovers a known transform from ${n} points`, () => {
      const theirs = CLOUD.slice(0, n);
      const fit = fitOne(theirs, carry(theirs, ROTATION, SCALE, SHIFT), undefined, 1);
      expect(fit.kind).toBe('kabsch');
      expect(fit.matched).toBe(n);
      expect(fit.residual).not.toBeNull();
      expect(fit.residual as number).toBeLessThan(0.01);
      expect(apart(fit.rotation, ROTATION)).toBeLessThan(1e-4);
      expect(fit.scale).toBeCloseTo(SCALE, 9);
      expect(fit.position.distanceTo(SHIFT)).toBeLessThan(1e-9);
    });
  }

  it('recovers a known transform from exactly three points', () => {
    // Three points are always in one plane, so their cross-covariance has rank two and has no
    // inverse; a fit that needs one gives up on the commonest case there is.
    const theirs = [CLOUD[0], CLOUD[1], CLOUD[3]] as Vector3[];
    const fit = fitOne(theirs, carry(theirs, ROTATION, SCALE, SHIFT), undefined, 1);
    expect(fit.kind).toBe('kabsch');
    expect(fit.matched).toBe(3);
    expect(fit.residual as number).toBeLessThan(0.01);
    expect(apart(fit.rotation, ROTATION)).toBeLessThan(1e-4);
    expect(fit.scale).toBeCloseTo(SCALE, 9);
    expect(fit.position.distanceTo(SHIFT)).toBeLessThan(1e-9);
  });

  it('recovers four points in one plane, which is the same rank-two problem', () => {
    const theirs = [
      new Vector3(0, 0, 0),
      new Vector3(0.4, 0, 0),
      new Vector3(0, 0.35, 0),
      new Vector3(0.3, 0.3, 0),
    ];
    const fit = fitOne(theirs, carry(theirs, ROTATION, SCALE, SHIFT), undefined, 1);
    expect(fit.kind).toBe('kabsch');
    expect(apart(fit.rotation, ROTATION)).toBeLessThan(1e-4);
  });

  for (const axis of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ] as [number, number, number][]) {
    it(`finds a half turn about (${axis.join(', ')})`, () => {
      // A half turn is where a rotation read off a matrix's trace changes branch, and where a
      // quaternion has no scalar part at all.
      const half = turn(axis, 180);
      const fit = fitOne(CLOUD, carry(CLOUD, half, 1, new Vector3()), undefined, 1);
      expect(fit.kind).toBe('kabsch');
      expect(apart(fit.rotation, half)).toBeLessThan(1e-4);
      expect(fit.residual as number).toBeLessThan(0.01);
    });
  }

  it('fits a collinear triple as a long bone, from its two furthest points', () => {
    // A hip, a patella a hair off the line, and a knee: the roll about the line is noise.
    const theirs = [new Vector3(0, 0, 0), new Vector3(0.0005, -0.2, 0), new Vector3(0, -0.4, 0)];
    const fit = fitOne(theirs, carry(theirs, ROTATION, SCALE, SHIFT), PARENT, 1);
    expect(fit.kind).toBe('axis and inherited roll');
    expect(fit.matched).toBe(2);
    expect(fit.scale).toBeCloseTo(SCALE, 9);
    // Both ends land where they should.
    const ours = carry(theirs, ROTATION, SCALE, SHIFT);
    expect(through(fit, theirs[0] as Vector3).distanceTo(ours[0] as Vector3)).toBeLessThan(1e-9);
    expect(through(fit, theirs[2] as Vector3).distanceTo(ours[2] as Vector3)).toBeLessThan(1e-9);
  });

  it('takes the roll from the bone above for two points', () => {
    const theirs = [new Vector3(0, 0, 0), new Vector3(0, -0.4, 0)];
    // Ours is theirs turned by the parent's rotation, so the parent's roll is already right and
    // the least turn onto the axis is none at all.
    const ours = carry(theirs, PARENT.rotation, 1.1, SHIFT);
    const fit = fitOne(theirs, ours, PARENT, 1);
    expect(fit.kind).toBe('axis and inherited roll');
    expect(apart(fit.rotation, PARENT.rotation)).toBeLessThan(1e-4);
    expect(fit.scale).toBeCloseTo(1.1, 9);
  });

  it('sizes a bone shorter than the reliable span from the bone above', () => {
    const theirs = [new Vector3(0, 0, 0), new Vector3(0, -0.06, 0)];
    const ours = carry(theirs, ROTATION, 1.4, SHIFT);
    const fit = fitOne(theirs, ours, PARENT, 1);
    expect(fit.kind).toBe('axis and inherited scale');
    expect(fit.scale).toBe(PARENT.scale);
    // The axis is still fitted: the far end lies along ours, if short of it.
    const along = through(fit, theirs[1] as Vector3)
      .sub(through(fit, theirs[0] as Vector3))
      .normalize();
    const want = (ours[1] as Vector3)
      .clone()
      .sub(ours[0] as Vector3)
      .normalize();
    expect(along.dot(want)).toBeGreaterThan(1 - 1e-9);
  });

  it('inherits the bone above whole with no point, and at one point is moved onto it', () => {
    const none = fitOne([], [], PARENT, 1);
    expect(none.kind).toBe('model');
    expect(apart(none.rotation, PARENT.rotation)).toBeLessThan(1e-9);
    expect(none.position.distanceTo(PARENT.position)).toBeLessThan(1e-12);
    expect(none.scale).toBe(PARENT.scale);

    const theirs = new Vector3(0.1, -0.3, 0.2);
    const ours = new Vector3(-0.2, 0.5, 0.05);
    const one = fitOne([theirs], [ours], PARENT, 1);
    expect(one.kind).toBe('inherited');
    expect(one.matched).toBe(1);
    expect(apart(one.rotation, PARENT.rotation)).toBeLessThan(1e-9);
    expect(one.scale).toBe(PARENT.scale);
    expect(through(one, theirs).distanceTo(ours)).toBeLessThan(1e-12);
  });

  it('falls back to the given scale when there is no bone above', () => {
    const fit = fitOne([], [], undefined, 0.8);
    expect(fit.kind).toBe('model');
    expect(fit.scale).toBe(0.8);
  });
});

describe('describeFits', () => {
  const fitOf = (theirs: string, ours: string, kind: FitKind, residual: number | null = null) =>
    [
      theirs,
      {
        theirs,
        ours,
        kind,
        residual,
        matched: kind === 'model' ? 0 : 2,
        position: new Vector3(),
        rotation: new Quaternion(),
        scale: 1,
      } satisfies BodyFit,
    ] as const;
  const bodies = [
    { name: 'root', parent: null },
    { name: 'a', parent: 'root' },
    { name: 'b', parent: 'a' },
    { name: 'c', parent: 'b' },
    { name: 'd', parent: 'c' },
    { name: 'e', parent: 'd' },
    { name: 'loose', parent: null },
  ];

  it("prints every kind's own words, and never talks about hinges", () => {
    const fits = new Map([
      fitOf('root', 'pelvis', 'kabsch', 3.2),
      fitOf('a', 'thigh_r', 'axis and inherited roll'),
      fitOf('b', 'shank_r', 'axis and inherited scale'),
      fitOf('c', 'talus_r', 'inherited'),
      fitOf('d', 'toes_r', 'model'),
      fitOf('loose', 'head', 'model'),
    ]);
    const note = describeFits({ fits, overallScale: 1.04, overallMeasured: true }, bodies);
    for (const text of Object.values(FIT_KIND_NOTE)) expect(note).toContain(text);
    expect(note).toContain('worst 3.2 mm out');
    expect(note).toContain('d → toes_r');
    expect(note).toContain('loose → head left in their own frame; pair a neighbouring bone');
    expect(note).toContain('1.04x');
    expect(note).not.toMatch(/hinge/);
  });

  it('leaves out the kinds that did not happen and says when the scale was not measured', () => {
    const fits = new Map([fitOf('a', 'thigh_r', 'axis and inherited roll')]);
    const note = describeFits({ fits, overallScale: 1, overallMeasured: false }, bodies);
    expect(note).toContain(FIT_KIND_NOTE['axis and inherited roll']);
    expect(note).not.toContain(FIT_KIND_NOTE.kabsch);
    expect(note).not.toContain(FIT_KIND_NOTE.model);
    expect(note).not.toContain(' 0 ');
    expect(note).toContain('at 1x, no span long enough');
  });
});
