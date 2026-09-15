import { describe, expect, it } from 'vitest';
import { momentArm, momentArmByDifference, pathLengthDerivative } from './momentArm.js';
import { ViaPointPathSolver } from './solver.js';
import {
  HINGE_AXIS,
  HINGE_CENTRE,
  createHinge,
  hingeMovesWith,
  hingeResolver,
  setHinge,
} from './testHinge.js';
import {
  type MusclePath,
  type WrapSurface,
  createPathContactBuffer,
  createPathTerminalBuffer,
} from './types.js';

/** A surface that exists, so that "cannot represent it" and "never heard of it" stay distinct. */
const HUMERAL_HEAD: WrapSurface = {
  id: 'humeral-head',
  bone: 'parent',
  type: 'sphere',
  position: { x: 0, y: 0, z: 0 },
  radius: 0.025,
  preferredSide: { x: 0, y: 1, z: 0 },
};

const ORIGIN_POINT = { x: -0.3, y: 0.05, z: 0 };
const INSERTION_POINT = { x: 0.2, y: 0, z: 0 };

/** One straight segment spanning the hinge: parent at the far end, child at the near one. */
const SPANNING: MusclePath = {
  id: 'spanning',
  origin: { bone: 'parent', point: ORIGIN_POINT },
  elements: [],
  insertion: { bone: 'child', point: INSERTION_POINT },
};

function solved(
  paths: readonly MusclePath[],
  angle: number,
  rate = 0,
  surfaces: readonly WrapSurface[] = [],
) {
  const solver = new ViaPointPathSolver(hingeResolver);
  const report = solver.compile(paths, surfaces);
  const state = createHinge();
  setHinge(state, angle, rate);
  const length = new Float64Array(paths.length);
  const velocity = new Float64Array(paths.length);
  const contacts = createPathContactBuffer(8);
  const terminals = createPathTerminalBuffer(paths.length);
  solver.solve(state.pose, state.velocity, length, velocity, contacts, terminals);
  return { solver, report, state, length, velocity, contacts, terminals };
}

describe('the via-point solver', () => {
  it('gives the straight-line distance when there is nothing in the way', () => {
    // Muscle spec 13.1, the first unit test it asks for. A path with no via points and no wrap is
    // the distance between its ends, and if that is wrong nothing above it can be right.
    const { length } = solved([SPANNING], 0);
    const expected = Math.hypot(
      INSERTION_POINT.x - ORIGIN_POINT.x,
      INSERTION_POINT.y - ORIGIN_POINT.y,
      INSERTION_POINT.z - ORIGIN_POINT.z,
    );
    expect(length[0]).toBeCloseTo(expected, 12);
  });

  it('adds up the segments when there are via points', () => {
    const path: MusclePath = {
      id: 'kinked',
      origin: { bone: 'parent', point: { x: 0, y: 0, z: 0 } },
      elements: [
        { kind: 'viaPoint', site: { bone: 'parent', point: { x: 0.3, y: 0, z: 0 } } },
        { kind: 'viaPoint', site: { bone: 'parent', point: { x: 0.3, y: 0.4, z: 0 } } },
      ],
      insertion: { bone: 'parent', point: { x: 0.3, y: 0.4, z: 1.2 } },
    };
    const { length } = solved([path], 0);
    expect(length[0]).toBeCloseTo(0.3 + 0.4 + 1.2, 12);
  });

  it('moves the path with the pose, because the points are bone-local', () => {
    const straight = Math.hypot(0.5, 0.05);
    const { length: atZero } = solved([SPANNING], 0);
    const { length: atQuarter } = solved([SPANNING], Math.PI / 2);
    expect(atZero[0]).toBeCloseTo(straight, 12);
    // The insertion has swung from (0.2, 0, 0) to (0, 0.2, 0).
    expect(atQuarter[0]).toBeCloseTo(Math.hypot(0.3, 0.15), 12);
  });

  it('solves several paths in one pass, each into its own slot', () => {
    const second: MusclePath = {
      ...SPANNING,
      id: 'second',
      insertion: { bone: 'child', point: { x: 0.4, y: 0, z: 0 } },
    };
    const { length, solver } = solved([SPANNING, second], 0);
    expect(solver.order).toEqual(['spanning', 'second']);
    expect(length[0]).toBeCloseTo(Math.hypot(0.5, 0.05), 12);
    expect(length[1]).toBeCloseTo(Math.hypot(0.7, 0.05), 12);
  });

  it('reports a wrap surface it cannot represent instead of quietly leaving it out', () => {
    // The failure mode this guards against is the worst kind: a path that ignores its wrap
    // surface still returns a plausible length, just a shorter one, with the moment arm wrong in
    // exactly the region the surface was placed to correct.
    const path: MusclePath = {
      ...SPANNING,
      id: 'wrapped',
      elements: [{ kind: 'wrap', surface: 'humeral-head' }],
    };
    const { report } = solved([path], 0, 0, [HUMERAL_HEAD]);
    const problem = report.problems.find((p) => p.severity === 'error');
    expect(problem?.message).toContain('cannot be represented');
    expect(problem?.path).toBe('wrapped');
  });

  it('reports a wrap element that names a surface nobody declared', () => {
    const path: MusclePath = {
      ...SPANNING,
      id: 'typo',
      elements: [{ kind: 'wrap', surface: 'nope' }],
    };
    const { report } = solved([path], 0);
    expect(report.problems[0]?.message).toContain('not declared');
  });

  it('reports an attachment on a bone the articulation does not have', () => {
    const path: MusclePath = {
      ...SPANNING,
      id: 'orphan',
      origin: { bone: 'tail', point: ORIGIN_POINT },
    };
    const { report } = solved([path], 0);
    expect(report.problems.some((p) => p.message.includes("bone 'tail'"))).toBe(true);
  });

  it('warns that it is treating a conditional via point as unconditional', () => {
    const path: MusclePath = {
      ...SPANNING,
      id: 'conditional',
      elements: [
        {
          kind: 'conditionalViaPoint',
          site: { bone: 'parent', point: { x: 0, y: 0.1, z: 0 } },
          coordinate: 'elbow_flexion',
          range: [0.5, 2],
          blend: 0.1,
        },
      ],
    };
    const { report } = solved([path], 0);
    expect(report.problems[0]?.severity).toBe('warning');
    expect(report.problems[0]?.message).toContain('N1.3');
  });

  it('says it reports no contacts, rather than leaving a stale count behind', () => {
    const contacts = createPathContactBuffer(8);
    contacts.count = 5;
    const solver = new ViaPointPathSolver(hingeResolver);
    solver.compile([SPANNING], []);
    const state = createHinge();
    setHinge(state, 0);
    solver.solve(
      state.pose,
      state.velocity,
      new Float64Array(1),
      new Float64Array(1),
      contacts,
      createPathTerminalBuffer(1),
    );
    expect(contacts.count).toBe(0);
  });
});

describe('where each end pulls', () => {
  it('reports the two world points and the bodies they are fixed to', () => {
    const { terminals } = solved([SPANNING], 0);
    expect(terminals.originBody[0]).toBe(0);
    expect(terminals.insertionBody[0]).toBe(1);
    expect([...terminals.originPoint]).toEqual([ORIGIN_POINT.x, ORIGIN_POINT.y, ORIGIN_POINT.z]);
    expect(terminals.insertionPoint[0]).toBeCloseTo(INSERTION_POINT.x, 12);
  });

  it('points each end at the other, for a unit with nothing in between', () => {
    // Section 8.2: the origin is pulled along the first segment and the insertion along the last.
    // On a straight unit those are the same segment traversed both ways, so the two directions
    // must be exact opposites -- which is also the statement that the pair of forces is balanced.
    const { terminals } = solved([SPANNING], 0.3);
    const o = [...terminals.originDirection];
    const i = [...terminals.insertionDirection];
    for (let axis = 0; axis < 3; axis++) {
      expect(i[axis], `axis ${axis}`).toBeCloseTo(-(o[axis] as number), 12);
    }
    expect(Math.hypot(...o)).toBeCloseTo(1, 12);
  });

  it('points at the neighbouring via point, not at the far end, once there is one', () => {
    // The distinction that matters for the wrench: a muscle rounding a via point pulls its origin
    // toward that point, not toward its insertion. Getting this wrong puts the force along a line
    // the tendon does not occupy, and the error is invisible until the moment arm is measured.
    const path: MusclePath = {
      id: 'kinked',
      origin: { bone: 'parent', point: { x: 0, y: 0, z: 0 } },
      elements: [{ kind: 'viaPoint', site: { bone: 'parent', point: { x: 0, y: 1, z: 0 } } }],
      insertion: { bone: 'parent', point: { x: 1, y: 1, z: 0 } },
    };
    const { terminals } = solved([path], 0);
    expect([...terminals.originDirection].map((v) => Math.round(v * 1e12) / 1e12)).toEqual([
      0, 1, 0,
    ]);
    expect([...terminals.insertionDirection].map((v) => Math.round(v * 1e12) / 1e12)).toEqual([
      -1, 0, 0,
    ]);
  });

  it('writes zeros rather than NaNs for a degenerate segment', () => {
    // Two coincident via points have no direction. A zero vector applies no force, which is the
    // right answer; a NaN would reach the solver and take the simulation with it.
    const path: MusclePath = {
      id: 'degenerate',
      origin: { bone: 'parent', point: { x: 0.1, y: 0.2, z: 0.3 } },
      elements: [],
      insertion: { bone: 'parent', point: { x: 0.1, y: 0.2, z: 0.3 } },
    };
    const { terminals, length } = solved([path], 0);
    expect(length[0]).toBe(0);
    expect([...terminals.originDirection]).toEqual([0, 0, 0]);
    expect([...terminals.insertionDirection]).toEqual([0, 0, 0]);
  });

  it('keeps the directions consistent with the length as the pose changes', () => {
    // The origin direction times the path length must land on the insertion, for a straight unit.
    // It ties the two outputs together: they are derived from the same world points or they are
    // not talking about the same path.
    for (const angle of [-0.9, 0, 0.5, 1.4]) {
      const { terminals, length } = solved([SPANNING], angle);
      for (let axis = 0; axis < 3; axis++) {
        const walked =
          (terminals.originPoint[axis] as number) +
          (terminals.originDirection[axis] as number) * (length[0] as number);
        expect(walked, `axis ${axis} at ${angle}`).toBeCloseTo(
          terminals.insertionPoint[axis] as number,
          12,
        );
      }
    }
  });
});

describe('path velocity', () => {
  it('matches the rate the length is actually changing at', () => {
    // The spec forbids differencing length to get velocity (section 5.3), so the analytic result
    // has to be checked against a difference taken here, in a test, where a tick of lag costs
    // nothing. A central difference of the solved length at a known joint rate is the ground
    // truth the tick loop is not allowed to compute for itself.
    const rate = 1.7;
    for (const angle of [-1, -0.3, 0, 0.4, 1.2]) {
      const { velocity } = solved([SPANNING], angle, rate);
      const h = 1e-6;
      const ahead = solved([SPANNING], angle + rate * h).length[0] as number;
      const behind = solved([SPANNING], angle - rate * h).length[0] as number;
      expect(velocity[0], `at ${angle} rad`).toBeCloseTo((ahead - behind) / (2 * h), 6);
    }
  });

  it('is zero when nothing is moving, at every pose', () => {
    for (const angle of [-1, 0, 0.7, 2]) {
      expect(solved([SPANNING], angle, 0).velocity[0], `at ${angle}`).toBe(0);
    }
  });

  it('is proportional to the joint rate, because the geometry does not care how fast', () => {
    const slow = solved([SPANNING], 0.4, 1).velocity[0] as number;
    const fast = solved([SPANNING], 0.4, 3).velocity[0] as number;
    expect(fast).toBeCloseTo(slow * 3, 12);
    expect(solved([SPANNING], 0.4, -1).velocity[0]).toBeCloseTo(-slow, 12);
  });

  it('is unaffected by a rigid motion of the whole rig', () => {
    // A muscle's length does not change when the body it is in walks across the room, and neither
    // does its rate of change. This catches the classic error of using the body-local offset as
    // the lever arm instead of the rotated one, which only shows up once something translates.
    const solver = new ViaPointPathSolver(hingeResolver);
    solver.compile([SPANNING], []);
    const state = createHinge();
    setHinge(state, 0.4, 1.3);
    const reference = new Float64Array(1);
    solver.solve(
      state.pose,
      state.velocity,
      new Float64Array(1),
      reference,
      createPathContactBuffer(4),
      createPathTerminalBuffer(1),
    );

    for (let body = 0; body < 2; body++) {
      state.velocity.linear[3 * body] = 2.5;
      state.velocity.linear[3 * body + 1] = -1.25;
      state.velocity.linear[3 * body + 2] = 0.75;
    }
    const moving = new Float64Array(1);
    solver.solve(
      state.pose,
      state.velocity,
      new Float64Array(1),
      moving,
      createPathContactBuffer(4),
      createPathTerminalBuffer(1),
    );
    expect(moving[0]).toBeCloseTo(reference[0] as number, 12);
  });
});

describe('the moment arm', () => {
  it('is the perpendicular distance from the axis to the line of action, for a single segment', () => {
    // The one case with a closed form. A straight muscle spanning a hinge has a moment arm equal
    // to the perpendicular distance from the joint centre to its line, which for two points either
    // side of the origin is the cross product over the length.
    const { solver, state } = solved([SPANNING], 0);
    const points = solver.worldPoints(0, state.pose);
    const bodies = solver.bodiesOf(0);
    const arm = momentArm(points, bodies, {
      axis: HINGE_AXIS,
      centre: HINGE_CENTRE,
      movesWith: hingeMovesWith,
    });

    const cross = ORIGIN_POINT.x * INSERTION_POINT.y - ORIGIN_POINT.y * INSERTION_POINT.x;
    const expected = Math.abs(cross) / Math.hypot(0.5, 0.05);
    expect(arm).toBeCloseTo(expected, 12);
    expect(arm).toBeCloseTo(0.0199007, 6);
  });

  it('is positive when the muscle shortens as the coordinate increases', () => {
    // The sign convention, checked against what it means rather than restated. r = -dL/dq, so a
    // positive arm and a shortening path are the same statement.
    const { solver, state } = solved([SPANNING], 0);
    const points = solver.worldPoints(0, state.pose);
    const bodies = solver.bodiesOf(0);
    const coordinate = { axis: HINGE_AXIS, centre: HINGE_CENTRE, movesWith: hingeMovesWith };
    expect(momentArm(points, bodies, coordinate)).toBeGreaterThan(0);
    expect(pathLengthDerivative(points, bodies, coordinate)).toBeLessThan(0);

    const shorter = solved([SPANNING], 0.01).length[0] as number;
    const longer = solved([SPANNING], -0.01).length[0] as number;
    expect(shorter).toBeLessThan(longer);
  });

  it('agrees with a central difference that shares none of its assumptions', () => {
    // The analytic form and the differenced one are derived differently: one sums axis x lever
    // projections, the other re-solves the path at two displaced poses and subtracts. Agreement
    // across the range is the evidence that the closed form is the derivative of this path and
    // not of some other one.
    const coordinate = { axis: HINGE_AXIS, centre: HINGE_CENTRE, movesWith: hingeMovesWith };
    for (const angle of [-1.2, -0.5, 0, 0.5, 1.2, 2]) {
      const { solver, state } = solved([SPANNING], angle);
      const analytic = momentArm(solver.worldPoints(0, state.pose), solver.bodiesOf(0), coordinate);
      const differenced = momentArmByDifference(
        (delta) => solved([SPANNING], angle + delta).length[0] as number,
      );
      expect(analytic, `at ${angle} rad`).toBeCloseTo(differenced, 8);
    }
  });

  it('ties the path velocity to the joint rate through the same derivative', () => {
    // The relation that has to hold if N1.2 and N1.8 are talking about the same path:
    // dL/dt = (dL/dq) * qdot. Two independently computed quantities and one identity between
    // them, which neither one alone could have got wrong without this showing it.
    const coordinate = { axis: HINGE_AXIS, centre: HINGE_CENTRE, movesWith: hingeMovesWith };
    for (const angle of [-0.8, 0, 0.6, 1.5]) {
      for (const rate of [-2, 0.5, 3]) {
        const { solver, state, velocity } = solved([SPANNING], angle, rate);
        const derivative = pathLengthDerivative(
          solver.worldPoints(0, state.pose),
          solver.bodiesOf(0),
          coordinate,
        );
        expect(velocity[0], `at ${angle} rad, ${rate} rad/s`).toBeCloseTo(derivative * rate, 10);
      }
    }
  });

  it('is zero for a muscle that does not cross the joint', () => {
    // Both ends on the parent: the coordinate moves neither of them, so it has no leverage. A
    // non-zero answer here would mean the distal test was wrong and every arm in the model with
    // it.
    const inert: MusclePath = {
      id: 'inert',
      origin: { bone: 'parent', point: ORIGIN_POINT },
      elements: [],
      insertion: { bone: 'parent', point: { x: -0.1, y: 0.3, z: 0 } },
    };
    const { solver, state } = solved([inert], 0.7);
    const arm = momentArm(solver.worldPoints(0, state.pose), solver.bodiesOf(0), {
      axis: HINGE_AXIS,
      centre: HINGE_CENTRE,
      movesWith: hingeMovesWith,
    });
    expect(Math.abs(arm)).toBe(0);
  });

  it('changes sign when the muscle runs to the other side of the joint', () => {
    // A flexor and an extensor differ by which side of the axis they pass, and nothing else. If
    // the sign did not follow the geometry here, the validation harness could not use a sign
    // change as a hard failure (section 13.2).
    const flipped: MusclePath = {
      ...SPANNING,
      id: 'flipped',
      origin: { bone: 'parent', point: { x: -0.3, y: -0.05, z: 0 } },
    };
    const coordinate = { axis: HINGE_AXIS, centre: HINGE_CENTRE, movesWith: hingeMovesWith };
    const a = solved([SPANNING], 0);
    const b = solved([flipped], 0);
    const first = momentArm(
      a.solver.worldPoints(0, a.state.pose),
      a.solver.bodiesOf(0),
      coordinate,
    );
    const second = momentArm(
      b.solver.worldPoints(0, b.state.pose),
      b.solver.bodiesOf(0),
      coordinate,
    );
    expect(first).toBeGreaterThan(0);
    expect(second).toBeLessThan(0);
    expect(second).toBeCloseTo(-first, 12);
  });

  it('grows with the distance the insertion sits from the axis', () => {
    const coordinate = { axis: HINGE_AXIS, centre: HINGE_CENTRE, movesWith: hingeMovesWith };
    let previous = 0;
    for (const x of [0.1, 0.2, 0.4, 0.8]) {
      const path: MusclePath = {
        ...SPANNING,
        insertion: { bone: 'child', point: { x, y: 0, z: 0 } },
      };
      const { solver, state } = solved([path], 0);
      const arm = momentArm(solver.worldPoints(0, state.pose), solver.bodiesOf(0), coordinate);
      expect(arm, `insertion at ${x}`).toBeGreaterThan(previous);
      previous = arm;
    }
  });
});
