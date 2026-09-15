import { describe, expect, it } from 'vitest';
import { GeodesicPathSolver } from './geodesicSolver.js';
import { momentArm, momentArmByDifference } from './momentArm.js';
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
  createPathPolylineBuffer,
  createPathTerminalBuffer,
} from './types.js';
import { createWrapResult, wrapSphere } from './wrap.js';

const ORIGIN_POINT = { x: -0.3, y: 0.01, z: 0 };
const INSERTION_POINT = { x: 0.2, y: 0, z: 0 };

/** A sphere on the parent, centred on the hinge axis, big enough to be in the way. */
const KNUCKLE: WrapSurface = {
  id: 'knuckle',
  bone: 'parent',
  type: 'sphere',
  position: { x: 0, y: 0, z: 0 },
  radius: 0.05,
  preferredSide: { x: 0, y: 1, z: 0 },
};

/** The same sphere, too small for the path to reach. */
const PEBBLE: WrapSurface = { ...KNUCKLE, id: 'pebble', radius: 0.002 };

/** A cylinder along the hinge axis, which is the usual anatomy: a tendon over a bone end. */
const TROCHLEA: WrapSurface = {
  id: 'trochlea',
  bone: 'parent',
  type: 'cylinder',
  position: { x: 0, y: 0, z: 0 },
  radius: 0.05,
  halfLength: 0.1,
  preferredSide: { x: 0, y: 1, z: 0 },
};

function wrappingPath(surface: string): MusclePath {
  return {
    id: 'wrapped',
    origin: { bone: 'parent', point: ORIGIN_POINT },
    elements: [{ kind: 'wrap', surface }],
    insertion: { bone: 'child', point: INSERTION_POINT },
  };
}

const STRAIGHT: MusclePath = {
  id: 'straight',
  origin: { bone: 'parent', point: ORIGIN_POINT },
  elements: [],
  insertion: { bone: 'child', point: INSERTION_POINT },
};

/**
 * A tendon crossing a hinge the way anatomy actually arranges one.
 *
 * The surface sits on the joint axis and the insertion is close in, the way the triceps tendon
 * runs over the trochlea to the olecranon. Flexing the joint presses the tendon onto the surface
 * rather than lifting it off, and the straight line stays on one side of the centre throughout,
 * so the declared side is never asked to do anything strange.
 *
 * That last part is the difference between this rig and `wrappingPath`, where the surface sits
 * squarely on the line of action. A surface placed there is a data defect -- see the test that
 * says so -- and it is not the case to measure continuity on.
 */
const TENDON: MusclePath = {
  id: 'tendon',
  origin: { bone: 'parent', point: { x: -0.3, y: 0, z: 0 } },
  elements: [{ kind: 'wrap', surface: 'trochlea_sphere' }],
  insertion: { bone: 'child', point: { x: 0.07, y: 0, z: 0 } },
};

/** The side the tendon is pressed onto as this joint flexes. */
const TROCHLEA_SPHERE: WrapSurface = {
  id: 'trochlea_sphere',
  bone: 'parent',
  type: 'sphere',
  position: { x: 0, y: 0, z: 0 },
  radius: 0.05,
  preferredSide: { x: 0, y: -1, z: 0 },
};

/** Angles at which the tendon rig is in contact with its surface. */
const FLEXED = [-0.15, -0.4, -0.65, -0.9];

function solved(
  paths: readonly MusclePath[],
  surfaces: readonly WrapSurface[],
  angle: number,
  rate = 0,
) {
  const solver = new GeodesicPathSolver(hingeResolver);
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

/** The same rig through the via-point solver, for the equivalence checks. */
function viaSolved(paths: readonly MusclePath[], angle: number, rate = 0) {
  const solver = new ViaPointPathSolver(hingeResolver);
  solver.compile(paths, []);
  const state = createHinge();
  setHinge(state, angle, rate);
  const length = new Float64Array(paths.length);
  const velocity = new Float64Array(paths.length);
  solver.solve(
    state.pose,
    state.velocity,
    length,
    velocity,
    createPathContactBuffer(8),
    createPathTerminalBuffer(paths.length),
  );
  return { length, velocity };
}

describe('the geodesic solver, where nothing is in the way', () => {
  it('agrees with the via-point solver exactly, on length and on velocity', () => {
    // The wrapping solver has to be a strict extension of the simple one, or every muscle in the
    // model changes the day a surface is added to any of them. Bit-for-bit is the right standard
    // here: both compute the same sum of the same segment lengths.
    for (const angle of [-1, -0.2, 0, 0.6, 1.4]) {
      for (const rate of [0, 1.3, -2]) {
        const geodesic = solved([STRAIGHT], [], angle, rate);
        const via = viaSolved([STRAIGHT], angle, rate);
        expect(geodesic.length[0], `length at ${angle}`).toBe(via.length[0]);
        expect(geodesic.velocity[0], `velocity at ${angle}`).toBe(via.velocity[0]);
      }
    }
  });

  it('leaves a declared surface out of it when the path misses it', () => {
    // A surface is a constraint the path may or may not meet. Most muscles clear most of their
    // wrap surfaces over most of their range, and that has to cost nothing and change nothing.
    const wrapped = solved([wrappingPath('pebble')], [PEBBLE], 0);
    const straight = solved([STRAIGHT], [], 0);
    expect(wrapped.length[0]).toBe(straight.length[0]);
    expect(wrapped.contacts.count).toBe(0);
  });

  it('handles via points as the simple solver does', () => {
    const kinked: MusclePath = {
      id: 'kinked',
      origin: { bone: 'parent', point: { x: 0, y: 0, z: 0 } },
      elements: [{ kind: 'viaPoint', site: { bone: 'parent', point: { x: 0.3, y: 0, z: 0 } } }],
      insertion: { bone: 'parent', point: { x: 0.3, y: 0.4, z: 0 } },
    };
    expect(solved([kinked], [], 0).length[0]).toBeCloseTo(0.7, 12);
  });
});

describe('the geodesic solver, wrapping', () => {
  it('routes the path around the surface, and reports it longer than the straight line', () => {
    const wrapped = solved([wrappingPath('knuckle')], [KNUCKLE], 0);
    const straight = solved([STRAIGHT], [], 0);
    expect(wrapped.contacts.count).toBe(1);
    expect(wrapped.length[0]).toBeGreaterThan(straight.length[0] as number);
  });

  it('gives the same answer the wrap geometry does, once the frames are accounted for', () => {
    // The solver's job over and above the geometry is entirely frames: get the two ends into the
    // surface's coordinates and the answer back out. At the neutral pose those frames are the
    // identity, so the two must agree to the last digit -- and any disagreement is a frame bug
    // rather than a geometry one.
    const wrapped = solved([wrappingPath('knuckle')], [KNUCKLE], 0);
    const direct = createWrapResult();
    wrapSphere(
      ORIGIN_POINT.x,
      ORIGIN_POINT.y,
      ORIGIN_POINT.z,
      INSERTION_POINT.x,
      INSERTION_POINT.y,
      INSERTION_POINT.z,
      KNUCKLE.radius as number,
      0,
      1,
      0,
      direct,
    );
    expect(direct.status).toBe('wrapped');
    expect(wrapped.length[0]).toBeCloseTo(direct.length, 12);
  });

  it('wraps a cylinder too, and agrees with the sphere for a path square to its axis', () => {
    // The hinge rig is planar and the cylinder runs along the hinge axis, so the path meets it
    // square on. Two different closed forms, one answer.
    const sphere = solved([wrappingPath('knuckle')], [KNUCKLE], 0);
    const cylinder = solved([wrappingPath('trochlea')], [TROCHLEA], 0);
    expect(cylinder.contacts.count).toBe(1);
    expect(cylinder.length[0]).toBeCloseTo(sphere.length[0] as number, 12);
  });

  it('points the origin at its tangent point, not at the far attachment', () => {
    // What section 8.2 applies the force along. A wrapped muscle pulls its origin toward where it
    // first touches the bone; using the line to the insertion instead would put the force along a
    // line the tendon does not occupy.
    const { terminals } = solved([wrappingPath('knuckle')], [KNUCKLE], 0);
    const toInsertion = [
      (terminals.insertionPoint[0] as number) - (terminals.originPoint[0] as number),
      (terminals.insertionPoint[1] as number) - (terminals.originPoint[1] as number),
      (terminals.insertionPoint[2] as number) - (terminals.originPoint[2] as number),
    ];
    const norm = Math.hypot(...toInsertion);
    const alignment =
      ((terminals.originDirection[0] as number) * (toInsertion[0] as number) +
        (terminals.originDirection[1] as number) * (toInsertion[1] as number) +
        (terminals.originDirection[2] as number) * (toInsertion[2] as number)) /
      norm;
    // Close to the straight line, because the surface is small, but measurably off it.
    expect(alignment).toBeGreaterThan(0.9);
    expect(alignment).toBeLessThan(0.9999);
    expect(
      Math.hypot(
        terminals.originDirection[0] as number,
        terminals.originDirection[1] as number,
        terminals.originDirection[2] as number,
      ),
    ).toBeCloseTo(1, 12);
  });

  it('stays continuous as the path comes onto the surface and leaves it', () => {
    // The property that makes a wrapping solver usable. A discontinuity in length is a step in
    // path velocity, which the force-velocity curve turns into a force spike, every time a muscle
    // touches a bone. Sweeping the joint right through the angle where contact begins has to show
    // none -- and the way to tell a smooth change from a jump is that halving the step halves it.
    const worstJump = (steps: number) => {
      let previous = solved([TENDON], [TROCHLEA_SPHERE], -1.6).length[0] as number;
      let worst = 0;
      for (let i = 1; i <= steps; i++) {
        const angle = -1.6 + (1.6 * i) / steps;
        const current = solved([TENDON], [TROCHLEA_SPHERE], angle).length[0] as number;
        worst = Math.max(worst, Math.abs(current - previous));
        previous = current;
      }
      return worst;
    };
    const coarse = worstJump(200);
    const fine = worstJump(400);
    expect(coarse).toBeLessThan(0.002);
    // Halving the step halves the largest change; across a discontinuity it would not move.
    expect(coarse / fine).toBeGreaterThan(1.8);
  });

  it('crosses on and off the surface during that sweep, so the test is not vacuous', () => {
    const contacts = [-1.6, -0.9, -0.4, -0.15].map(
      (angle) => solved([TENDON], [TROCHLEA_SPHERE], angle).contacts.count,
    );
    expect(contacts).toContain(0);
    expect(contacts).toContain(1);
  });

  it('reports one contact per wrap, on the body the surface belongs to', () => {
    const { contacts } = solved([wrappingPath('knuckle')], [KNUCKLE], 0);
    expect(contacts.count).toBe(1);
    expect(contacts.path[0]).toBe(0);
    expect(contacts.body[0]).toBe(0);
    // The sphere's centre, which is where its reaction acts: the parent's origin here.
    expect(contacts.point[0]).toBeCloseTo(0, 12);
    expect(contacts.point[1]).toBeCloseTo(0, 12);
  });

  it('presses on the bone in the direction the tendon is turned away from', () => {
    // The tendon lies on the far side of the sphere from where it is pushed. With a preferred
    // side of +y the path rides over the top, so it presses the sphere downward.
    const { contacts } = solved([wrappingPath('knuckle')], [KNUCKLE], 0);
    expect(contacts.direction[1]).toBeLessThan(0);
    // And lightly, because this tendon barely turns: the resultant is well under one tension.
    const magnitude = Math.hypot(
      contacts.direction[0] as number,
      contacts.direction[1] as number,
      contacts.direction[2] as number,
    );
    expect(magnitude).toBeGreaterThan(0);
    expect(magnitude).toBeLessThan(0.5);
  });

  it('presses harder the further the tendon is turned', () => {
    const shallow = solved([wrappingPath('knuckle')], [KNUCKLE], 0);
    const steep = solved([wrappingPath('knuckle')], [{ ...KNUCKLE, radius: 0.12 }], 0);
    const size = (c: (typeof shallow)['contacts']) =>
      Math.hypot(c.direction[0] as number, c.direction[1] as number, c.direction[2] as number);
    expect(size(steep.contacts)).toBeGreaterThan(size(shallow.contacts));
  });
});

describe('path velocity through a wrap', () => {
  it('matches the rate the wrapped length is actually changing at', () => {
    // The test that matters most in this file. The analytic derivative leans on the envelope
    // property -- that the tangent points contribute nothing because the path length is
    // stationary in them -- and a central difference of the solved length knows nothing about
    // that argument. If the property were being used wrongly, these would disagree.
    const path = wrappingPath('knuckle');
    const rate = 1.7;
    for (const angle of [-0.8, -0.2, 0, 0.3, 0.9]) {
      const { velocity } = solved([path], [KNUCKLE], angle, rate);
      const h = 1e-6;
      const ahead = solved([path], [KNUCKLE], angle + rate * h).length[0] as number;
      const behind = solved([path], [KNUCKLE], angle - rate * h).length[0] as number;
      expect(velocity[0], `at ${angle} rad`).toBeCloseTo((ahead - behind) / (2 * h), 6);
    }
  });

  it('matches it for a cylinder as well', () => {
    const path = wrappingPath('trochlea');
    const rate = -1.1;
    for (const angle of [-0.6, 0, 0.5]) {
      const { velocity } = solved([path], [TROCHLEA], angle, rate);
      const h = 1e-6;
      const ahead = solved([path], [TROCHLEA], angle + rate * h).length[0] as number;
      const behind = solved([path], [TROCHLEA], angle - rate * h).length[0] as number;
      expect(velocity[0], `at ${angle} rad`).toBeCloseTo((ahead - behind) / (2 * h), 6);
    }
  });

  it('accounts for the surface moving, not just the attachments', () => {
    // The surface here rides on the child, so the joint turns the bone the tendon lies against as
    // well as the bone it inserts on. Getting this wrong is invisible while the surface is on the
    // fixed body, which is exactly why it is worth a case of its own.
    const moving: WrapSurface = { ...KNUCKLE, id: 'moving', bone: 'child' };
    const path = wrappingPath('moving');
    const rate = 0.9;
    // Angles at which this rig genuinely wraps: past about 0.3 rad the insertion has swung clear
    // of the sphere, and a test of wrapped velocity that is not wrapping proves nothing.
    for (const angle of [-0.4, -0.2, 0, 0.2]) {
      const { velocity, contacts } = solved([path], [moving], angle, rate);
      expect(contacts.count, `at ${angle}`).toBe(1);
      expect(contacts.body[0]).toBe(1);
      const h = 1e-6;
      const ahead = solved([path], [moving], angle + rate * h).length[0] as number;
      const behind = solved([path], [moving], angle - rate * h).length[0] as number;
      expect(velocity[0], `at ${angle} rad`).toBeCloseTo((ahead - behind) / (2 * h), 6);
    }
  });

  it('is zero when nothing is moving, even though the path is wrapped', () => {
    for (const angle of [-0.5, 0, 0.7]) {
      expect(solved([wrappingPath('knuckle')], [KNUCKLE], angle, 0).velocity[0]).toBe(0);
    }
  });

  it('is unaffected by carrying the whole rig across the room', () => {
    // A muscle's length does not change when the body walks, and neither does its rate -- wrap
    // surface included. This is where a lever arm taken in the wrong frame would show up.
    const solver = new GeodesicPathSolver(hingeResolver);
    solver.compile([wrappingPath('knuckle')], [KNUCKLE]);
    const state = createHinge();
    setHinge(state, 0.3, 1.1);
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

describe('the moment arm of a wrapped muscle', () => {
  it('is what the wrapping says it is, not what the straight line would say', () => {
    // The reason wrapping exists. A straight path holds the muscle against the joint axis; the
    // surface pushes it away, and the moment arm grows by roughly the surface's radius. This is
    // the quantity the whole module is validated on (section 13.2).
    const wrapped = momentArmByDifference(
      (delta) => solved([wrappingPath('knuckle')], [KNUCKLE], delta).length[0] as number,
    );
    const straight = momentArmByDifference(
      (delta) => solved([STRAIGHT], [], delta).length[0] as number,
    );
    expect(Math.abs(wrapped)).toBeGreaterThan(Math.abs(straight) * 2);
    // A tendon riding over a sphere on the axis has a moment arm of about its radius.
    expect(Math.abs(wrapped)).toBeCloseTo(KNUCKLE.radius as number, 2);
  });

  it('keeps its sign across the range, which a side-swap would not', () => {
    // A moment arm that changes sign where published data shows none is a hard failure of the
    // validation harness. The usual cause is a path falling to the other side of a surface, and
    // the declared side is what prevents it -- checked here right through the angle where the
    // tendon leaves the surface, which is where a swap would happen if one were going to.
    const arms: number[] = [];
    for (let i = 0; i <= 80; i++) {
      const angle = -1.6 + (1.6 * i) / 80;
      arms.push(
        momentArmByDifference(
          (delta) => solved([TENDON], [TROCHLEA_SPHERE], angle + delta).length[0] as number,
        ),
      );
    }
    expect(arms.every((a) => a < 0)).toBe(true);
  });

  it('holds at about the surface radius while the tendon is on it', () => {
    // A tendon riding over a surface centred on the joint axis has a moment arm of exactly that
    // radius, whatever the angle: that is what a pulley is, and it is the cleanest closed-form
    // check the wrapping solver has.
    for (const angle of FLEXED) {
      const arm = momentArmByDifference(
        (delta) => solved([TENDON], [TROCHLEA_SPHERE], angle + delta).length[0] as number,
      );
      expect(Math.abs(arm), `at ${angle} rad`).toBeCloseTo(TROCHLEA_SPHERE.radius as number, 5);
    }
  });

  it('varies smoothly, with no step where the wrap begins', () => {
    let previous: number | null = null;
    let worst = 0;
    for (let i = 0; i <= 200; i++) {
      const angle = -1.6 + (1.6 * i) / 200;
      const arm = momentArmByDifference(
        (delta) => solved([TENDON], [TROCHLEA_SPHERE], angle + delta).length[0] as number,
      );
      if (previous !== null) worst = Math.max(worst, Math.abs(arm - previous));
      previous = arm;
    }
    expect(worst).toBeLessThan(0.005);
  });

  it('is continuous through the pose where the two ways round are equal', () => {
    // Worth pinning down because the obvious worry turns out to be unfounded. When the straight
    // line passes exactly through the centre the path could go either way, and one might expect a
    // jump there -- but at that pose the two arcs have the *same* length, so switching between
    // them costs nothing. Honouring the declared side is what makes the path pass through that
    // configuration smoothly; taking the shorter arc would have flipped sides at it.
    let previous = solved([wrappingPath('knuckle')], [KNUCKLE], -0.1).length[0] as number;
    let worst = 0;
    for (let i = 1; i <= 200; i++) {
      const angle = -0.1 + (0.2 * i) / 200;
      const current = solved([wrappingPath('knuckle')], [KNUCKLE], angle).length[0] as number;
      worst = Math.max(worst, Math.abs(current - previous));
      previous = current;
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it('jumps when the declared side is the wrong one, rather than hiding it', () => {
    // The limit of what a declared side can do, measured. If it names the side the straight line
    // does *not* pass, the solver takes the long way round while the surface is in the way and
    // the straight line the moment it is not, and those two differ by most of a circumference.
    //
    // That is a badly placed surface, and the jump is the data's fault rather than the solver's.
    // The alternative -- quietly taking whichever arc is shorter -- would hide it behind a moment
    // arm that flips sign instead, which is the failure muscle spec 4.3 names. This records that
    // the solver makes the honest choice, so nobody 'fixes' it back.
    const wrongSide: WrapSurface = {
      ...TROCHLEA_SPHERE,
      preferredSide: { x: 0, y: 1, z: 0 },
    };
    let previous = solved([TENDON], [wrongSide], -1.6).length[0] as number;
    let worst = 0;
    for (let i = 1; i <= 200; i++) {
      const angle = -1.6 + (1.6 * i) / 200;
      const current = solved([TENDON], [wrongSide], angle).length[0] as number;
      worst = Math.max(worst, Math.abs(current - previous));
      previous = current;
    }
    expect(worst).toBeGreaterThan(0.05);
  });

  it('agrees with the analytic arm on the spans it does not wrap', () => {
    // Where the surface is out of the way the two solvers describe the same path, so the closed
    // form from N1.8 still applies and must still match.
    const coordinate = { axis: HINGE_AXIS, centre: HINGE_CENTRE, movesWith: hingeMovesWith };
    const { solver, state } = solved([wrappingPath('pebble')], [PEBBLE], 0.4);
    const analytic = momentArm(solver.worldPoints(0, state.pose), [0, 1], coordinate);
    const differenced = momentArmByDifference(
      (delta) => solved([wrappingPath('pebble')], [PEBBLE], 0.4 + delta).length[0] as number,
    );
    expect(analytic).toBeCloseTo(differenced, 8);
  });
});

describe('what the geodesic solver refuses', () => {
  it('reports two wrap surfaces sharing a span', () => {
    // Solving them together is N1.5's problem. Routing round each in turn would give a path that
    // is not the shortest one and jumps as the surfaces pass each other, so it is refused rather
    // than approximated.
    const path: MusclePath = {
      ...STRAIGHT,
      id: 'greedy',
      elements: [
        { kind: 'wrap', surface: 'knuckle' },
        { kind: 'wrap', surface: 'trochlea' },
      ],
    };
    const { report } = solved([path], [KNUCKLE, TROCHLEA], 0);
    expect(report.problems[0]?.severity).toBe('error');
    expect(report.problems[0]?.message).toContain('N1.5');
  });

  it('accepts two wrap surfaces with an attachment point between them', () => {
    // The same two surfaces, one span each: that this solver can do, and it is how a published
    // model usually expresses a long muscle anyway.
    const path: MusclePath = {
      ...STRAIGHT,
      id: 'sequenced',
      elements: [
        { kind: 'wrap', surface: 'knuckle' },
        { kind: 'viaPoint', site: { bone: 'parent', point: { x: 0, y: 0.09, z: 0 } } },
        { kind: 'wrap', surface: 'trochlea' },
      ],
    };
    const { report, length } = solved([path], [KNUCKLE, TROCHLEA], 0);
    expect(report.problems).toEqual([]);
    expect(length[0]).toBeGreaterThan(0);
  });

  it('reports a surface shape it cannot represent', () => {
    const ellipsoid: WrapSurface = {
      ...KNUCKLE,
      id: 'ellipsoid',
      type: 'ellipsoid',
      semiAxes: { x: 0.05, y: 0.03, z: 0.04 },
    };
    const { report } = solved([wrappingPath('ellipsoid')], [ellipsoid], 0);
    expect(report.problems.some((p) => p.message.includes('OQ-016'))).toBe(true);
  });

  it('reports a surface with no radius, rather than dividing by it', () => {
    const flat: WrapSurface = { ...KNUCKLE, id: 'flat', radius: 0 };
    const { report } = solved([wrappingPath('flat')], [flat], 0);
    expect(report.problems.some((p) => p.message.includes('positive radius'))).toBe(true);
  });

  it('reports a wrap element naming a surface nobody declared', () => {
    const { report } = solved([wrappingPath('imaginary')], [], 0);
    expect(report.problems[0]?.message).toContain('not declared');
  });

  it('says in its capabilities what it can and cannot do', () => {
    const solver = new GeodesicPathSolver(hingeResolver);
    expect(solver.capabilities.surfaceTypes).toEqual(['sphere', 'cylinder']);
    expect(solver.capabilities.finiteCylinders).toBe(true);
    expect(solver.capabilities.requiresSiteBetweenWraps).toBe(true);
    expect(solver.capabilities.continuousMomentArm).toBe(true);
  });
});

describe('the polyline a solver draws', () => {
  function polyline(paths: readonly MusclePath[], surfaces: readonly WrapSurface[], angle: number) {
    const solver = new GeodesicPathSolver(hingeResolver);
    const report = solver.compile(paths, surfaces);
    const state = createHinge();
    setHinge(state, angle, 0);
    const length = new Float64Array(paths.length);
    const out = createPathPolylineBuffer(paths.length, report.polylineCapacity);
    solver.solve(
      state.pose,
      state.velocity,
      length,
      new Float64Array(paths.length),
      createPathContactBuffer(8),
      createPathTerminalBuffer(paths.length),
      out,
    );
    const points: number[][] = [];
    const bodies: number[] = [];
    const from = out.start[0] as number;
    for (let i = 0; i < (out.count[0] as number); i++) {
      points.push([
        out.point[3 * (from + i)] as number,
        out.point[3 * (from + i) + 1] as number,
        out.point[3 * (from + i) + 2] as number,
      ]);
      bodies.push(out.body[from + i] as number);
    }
    return { report, points, bodies, length: length[0] as number };
  }

  const walked = (points: number[][]) => {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1] as number[];
      const b = points[i] as number[];
      total += Math.hypot(
        (b[0] as number) - (a[0] as number),
        (b[1] as number) - (a[1] as number),
        (b[2] as number) - (a[2] as number),
      );
    }
    return total;
  };

  it('is just the attachment points when nothing is in the way', () => {
    const { points, length } = polyline([STRAIGHT], [], 0);
    expect(points).toHaveLength(2);
    expect(walked(points)).toBeCloseTo(length, 12);
  });

  it('measures the length the fiber model is being given', () => {
    // The check that makes a drawing worth looking at. If the picture and the number came apart,
    // the muscle on screen would not be the muscle being simulated, and every judgement made by
    // eye from here on would be about the wrong thing.
    const { points, length } = polyline([wrappingPath('knuckle')], [KNUCKLE], 0);
    expect(points.length).toBeGreaterThan(2);
    // Chords cut the corner slightly, so the walk is a touch short of the exact arc.
    expect(walked(points)).toBeCloseTo(length, 4);
    expect(walked(points)).toBeLessThanOrEqual(length + 1e-12);
  });

  it('runs from the origin to the insertion, with the surface in between', () => {
    const { points } = polyline([wrappingPath('knuckle')], [KNUCKLE], 0);
    const first = points[0] as number[];
    const last = points[points.length - 1] as number[];
    expect(first[0]).toBeCloseTo(ORIGIN_POINT.x, 12);
    expect(first[1]).toBeCloseTo(ORIGIN_POINT.y, 12);
    expect(last[0]).toBeCloseTo(INSERTION_POINT.x, 12);
    // Everything between the tangent points sits on the sphere.
    const onSurface = points.filter(
      (p) => Math.abs(Math.hypot(p[0] as number, p[1] as number, p[2] as number) - 0.05) < 1e-9,
    );
    expect(onSurface.length).toBeGreaterThan(5);
  });

  it('draws a cylinder wrap too', () => {
    const { points, length } = polyline([wrappingPath('trochlea')], [TROCHLEA], 0);
    expect(points.length).toBeGreaterThan(2);
    expect(walked(points)).toBeCloseTo(length, 4);
  });

  it('fits the capacity the compile report asked for', () => {
    // The caller should never have to guess a buffer size, and a solver that overran one would
    // silently draw a shorter muscle than it is simulating.
    const path: MusclePath = {
      ...STRAIGHT,
      id: 'two-spans',
      elements: [
        { kind: 'wrap', surface: 'knuckle' },
        { kind: 'viaPoint', site: { bone: 'parent', point: { x: 0, y: 0.09, z: 0 } } },
        { kind: 'wrap', surface: 'trochlea' },
      ],
    };
    const { report, points } = polyline([path], [KNUCKLE, TROCHLEA], 0);
    expect(points.length).toBeLessThanOrEqual(report.polylineCapacity);
    expect(report.polylineCapacity).toBe(3 + 2 * 13);
  });

  it('says which body carries each point, arc included', () => {
    // A moment arm is entirely a question of which points a coordinate carries, so a polyline
    // without this is a shape with no mechanics attached. An arc point belongs to the bone whose
    // surface it lies on -- not to either attachment, which is the case worth pinning down.
    const { points, bodies } = polyline([wrappingPath('knuckle')], [KNUCKLE], 0);
    expect(bodies).toHaveLength(points.length);
    expect(bodies[0]).toBe(0);
    expect(bodies[bodies.length - 1]).toBe(1);
    // The sphere is on the parent, so every point between the two attachments rides the parent.
    expect(bodies.slice(1, -1).every((b) => b === 0)).toBe(true);
  });

  it('attributes arc points to the moving bone when the surface is on it', () => {
    const moving: WrapSurface = { ...KNUCKLE, id: 'moving', bone: 'child' };
    const { bodies } = polyline([wrappingPath('moving')], [moving], 0);
    expect(bodies[0]).toBe(0);
    expect(bodies[bodies.length - 1]).toBe(1);
    expect(bodies.slice(1, -1).every((b) => b === 1)).toBe(true);
  });

  it('falls back to the straight run when the surface is not in the way', () => {
    const { points, length } = polyline([wrappingPath('pebble')], [PEBBLE], 0);
    expect(points).toHaveLength(2);
    expect(walked(points)).toBeCloseTo(length, 12);
  });

  it('costs nothing when nobody asks for it', () => {
    // No buffer, no sampling. A headless run integrating fibers has no use for these points.
    const solver = new GeodesicPathSolver(hingeResolver);
    solver.compile([wrappingPath('knuckle')], [KNUCKLE]);
    const state = createHinge();
    setHinge(state, 0, 0);
    const length = new Float64Array(1);
    expect(() =>
      solver.solve(
        state.pose,
        state.velocity,
        length,
        new Float64Array(1),
        createPathContactBuffer(4),
        createPathTerminalBuffer(1),
      ),
    ).not.toThrow();
    expect(length[0]).toBeGreaterThan(0);
  });
});
