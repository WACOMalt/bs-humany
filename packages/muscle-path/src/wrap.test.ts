import { describe, expect, it } from 'vitest';
import {
  type WrapResult,
  createWrapResult,
  sampleWrapArc,
  wrapCylinder,
  wrapSphere,
} from './wrap.js';

const R = 1;

function sphere(
  p: readonly number[],
  q: readonly number[],
  radius = R,
  side = [0, 0, 1],
): WrapResult {
  const out = createWrapResult();
  wrapSphere(
    p[0] as number,
    p[1] as number,
    p[2] as number,
    q[0] as number,
    q[1] as number,
    q[2] as number,
    radius,
    side[0] as number,
    side[1] as number,
    side[2] as number,
    out,
  );
  return out;
}

function cylinder(
  p: readonly number[],
  q: readonly number[],
  radius = R,
  halfLength = 10,
  side = [0, 1],
): WrapResult {
  const out = createWrapResult();
  wrapCylinder(
    p[0] as number,
    p[1] as number,
    p[2] as number,
    q[0] as number,
    q[1] as number,
    q[2] as number,
    radius,
    halfLength,
    side[0] as number,
    side[1] as number,
    out,
  );
  return out;
}

const magnitude = (r: WrapResult, which: 'a' | 'b') =>
  which === 'a' ? Math.hypot(r.ax, r.ay, r.az) : Math.hypot(r.bx, r.by, r.bz);

describe('wrapping a sphere', () => {
  it('leaves a path that misses the sphere alone', () => {
    const r = sphere([-3, 2, 0], [3, 2, 0]);
    expect(r.status).toBe('clear');
    expect(r.length).toBeCloseTo(6, 12);
    expect(r.arcLength).toBe(0);
  });

  it('does not wrap around a sphere that is behind both ends', () => {
    // The segment's *line* passes through the origin, but the segment itself does not: both
    // points sit on the same side. A solver that tested the line rather than the segment would
    // route a muscle around a bone it never reaches.
    const r = sphere([2, 0, 0], [5, 0, 0]);
    expect(r.status).toBe('clear');
    expect(r.length).toBeCloseTo(3, 12);
  });

  it('gives the textbook answer for two points diametrically opposite', () => {
    // P and Q at distance d on opposite sides. Each tangent is sqrt(d^2 - r^2) long and consumes
    // acos(r/d) of the half turn, so the arc is pi - 2 acos(r/d). Everything here is checkable by
    // hand, which is the point of this case.
    const d = 2;
    const r = sphere([-d, 0, 0], [d, 0, 0], R, [0, 0, 1]);
    expect(r.status).toBe('wrapped');
    const tangent = Math.sqrt(d * d - R * R);
    const arc = Math.PI - 2 * Math.acos(R / d);
    expect(r.arcLength).toBeCloseTo(R * arc, 12);
    expect(r.length).toBeCloseTo(2 * tangent + R * arc, 12);
  });

  it('puts the tangent points on the sphere, at right angles to the straight runs', () => {
    // The two conditions that define a tangent point, checked rather than assumed: it lies on the
    // surface, and the straight segment reaching it is perpendicular to the radius there.
    const p = [-2, 0.4, 0];
    const q = [2.5, -0.3, 0.2];
    const r = sphere(p, q);
    expect(r.status).toBe('wrapped');
    expect(magnitude(r, 'a')).toBeCloseTo(R, 12);
    expect(magnitude(r, 'b')).toBeCloseTo(R, 12);

    const toP = [(p[0] as number) - r.ax, (p[1] as number) - r.ay, (p[2] as number) - r.az];
    expect(
      r.ax * (toP[0] as number) + r.ay * (toP[1] as number) + r.az * (toP[2] as number),
    ).toBeCloseTo(0, 12);
    const toQ = [(q[0] as number) - r.bx, (q[1] as number) - r.by, (q[2] as number) - r.bz];
    expect(
      r.bx * (toQ[0] as number) + r.by * (toQ[1] as number) + r.bz * (toQ[2] as number),
    ).toBeCloseTo(0, 12);
  });

  it('adds up: the reported length is the three pieces measured separately', () => {
    const p = [-2, 0.4, 0.1];
    const q = [2.5, -0.3, 0.2];
    const r = sphere(p, q);
    const first = Math.hypot(
      (p[0] as number) - r.ax,
      (p[1] as number) - r.ay,
      (p[2] as number) - r.az,
    );
    const last = Math.hypot(
      (q[0] as number) - r.bx,
      (q[1] as number) - r.by,
      (q[2] as number) - r.bz,
    );
    // The arc, measured as the angle between the two tangent points times the radius.
    const cosine = (r.ax * r.bx + r.ay * r.by + r.az * r.bz) / (R * R);
    expect(r.arcLength).toBeCloseTo(R * Math.acos(cosine), 9);
    expect(r.length).toBeCloseTo(first + r.arcLength + last, 12);
  });

  it('is always longer than the straight line it replaces, and not by much', () => {
    for (const height of [0.05, 0.3, 0.7, 0.95]) {
      const p = [-2, height, 0];
      const q = [2, height, 0];
      const r = sphere(p, q);
      expect(r.status, `at ${height}`).toBe('wrapped');
      expect(r.length, `at ${height}`).toBeGreaterThan(4);
      expect(r.length, `at ${height}`).toBeLessThan(4 * 1.3);
    }
  });

  it('approaches the straight line as the path grazes the surface', () => {
    // Continuity at the moment of contact. A jump here would be a force discontinuity every time
    // a muscle touched a bone, which is the defect that makes a wrapping solver unusable.
    const just = sphere([-2, 1 + 1e-9, 0], [2, 1 + 1e-9, 0]);
    const barely = sphere([-2, 1 - 1e-9, 0], [2, 1 - 1e-9, 0]);
    expect(just.status).toBe('clear');
    expect(barely.status).toBe('wrapped');
    expect(barely.length).toBeCloseTo(just.length, 6);
  });

  it('says so when an endpoint is inside the surface', () => {
    // Not an answer this geometry has. Returning a plausible length would hide an attachment site
    // authored inside a bone, which is a data defect worth seeing.
    expect(sphere([0.5, 0, 0], [3, 0, 0]).status).toBe('inside');
    expect(sphere([3, 0, 0], [0, 0, 0]).status).toBe('inside');
  });

  it('uses the declared side when the geometry alone cannot choose', () => {
    // Three collinear points: the path could fall anywhere around the sphere. Without a declared
    // side the solver would pick differently as the bones moved, flipping the moment arm's sign.
    const up = sphere([-2, 0, 0], [2, 0, 0], R, [0, 1, 0]);
    const out = sphere([-2, 0, 0], [2, 0, 0], R, [0, 0, 1]);
    expect(up.status).toBe('wrapped');
    expect(out.status).toBe('wrapped');
    // Same length either way, by symmetry -- but different places, which is what matters.
    expect(up.length).toBeCloseTo(out.length, 12);
    expect(Math.abs(up.az)).toBeLessThan(1e-9);
    expect(Math.abs(out.ay)).toBeLessThan(1e-9);
  });

  it('refuses rather than guessing when the declared side is useless too', () => {
    // A side parallel to the line leaves nothing to decide with. Guessing is exactly the silent
    // flip the parameter exists to prevent.
    expect(sphere([-2, 0, 0], [2, 0, 0], R, [1, 0, 0]).status).toBe('inside');
  });

  it('scales with the sphere', () => {
    const small = sphere([-2, 0.2, 0], [2, 0.2, 0], 0.5);
    const large = sphere([-2, 0.2, 0], [2, 0.2, 0], 0.9);
    expect(large.length).toBeGreaterThan(small.length);
  });
});

describe('wrapping a cylinder', () => {
  it('leaves a path that misses it alone', () => {
    const r = cylinder([-3, 2, 0], [3, 2, 0]);
    expect(r.status).toBe('clear');
    expect(r.length).toBeCloseTo(6, 12);
  });

  it('matches the sphere answer for a path square to the axis', () => {
    // A cylinder seen down its axis is a circle, and a path at constant height round it is the
    // same two-dimensional problem a sphere poses in its own plane. Two independent derivations
    // landing on the same number is worth more than either one checked against itself.
    const flat = cylinder([-2, 0, 0.5], [2, 0, 0.5], R, 10, [0, 1]);
    const asSphere = sphere([-2, 0, 0], [2, 0, 0], R, [0, 1, 0]);
    expect(flat.status).toBe('wrapped');
    expect(flat.length).toBeCloseTo(asSphere.length, 12);
  });

  it('puts the tangent points on the surface, square to the straight runs', () => {
    const p = [-2, 0.3, -0.4];
    const q = [2.2, -0.2, 0.6];
    const r = cylinder(p, q);
    expect(r.status).toBe('wrapped');
    expect(Math.hypot(r.ax, r.ay)).toBeCloseTo(R, 12);
    expect(Math.hypot(r.bx, r.by)).toBeCloseTo(R, 12);
    // Tangency is a condition in the plane square to the axis: the radial direction has no height,
    // so the segment's rise plays no part in it.
    const toP = [(p[0] as number) - r.ax, (p[1] as number) - r.ay];
    expect(r.ax * (toP[0] as number) + r.ay * (toP[1] as number)).toBeCloseTo(0, 12);
    const toQ = [(q[0] as number) - r.bx, (q[1] as number) - r.by];
    expect(r.bx * (toQ[0] as number) + r.by * (toQ[1] as number)).toBeCloseTo(0, 12);
  });

  it('adds up, in three dimensions', () => {
    const p = [-2, 0.3, -0.4];
    const q = [2.2, -0.2, 0.6];
    const r = cylinder(p, q);
    const first = Math.hypot(
      (p[0] as number) - r.ax,
      (p[1] as number) - r.ay,
      (p[2] as number) - r.az,
    );
    const last = Math.hypot(
      (q[0] as number) - r.bx,
      (q[1] as number) - r.by,
      (q[2] as number) - r.bz,
    );
    expect(r.length).toBeCloseTo(first + r.arcLength + last, 9);
  });

  it('climbs at one constant pitch, which is what makes the arc a geodesic', () => {
    // Unrolled, the whole path is a straight line, so every piece of it rises at the same rate.
    // A path that put all its climbing into the arc would be shorter on the flat and longer
    // overall -- and would not be the shortest path, which is the only thing a tendon lies along.
    const p = [-2, 0.3, 0];
    const q = [2.2, -0.2, 1.5];
    const r = cylinder(p, q);
    expect(r.status).toBe('wrapped');

    const flatFirst = Math.hypot((p[0] as number) - r.ax, (p[1] as number) - r.ay);
    const flatArc = Math.hypot(r.ax - r.bx, r.ay - r.by); // chord, only for a sanity bound
    const flatLast = Math.hypot((q[0] as number) - r.bx, (q[1] as number) - r.by);
    expect(flatArc).toBeLessThanOrEqual(2 * R + 1e-12);

    const riseFirst = r.az - (p[2] as number);
    const riseLast = (q[2] as number) - r.bz;
    expect(riseFirst / flatFirst).toBeCloseTo(riseLast / flatLast, 9);
  });

  it('gives up the wrap when the tendon would slide off the end', () => {
    // A finite cylinder, which the native MuJoCo solver cannot represent. A tangent point past
    // the rim means the tendon has left the surface, and a surface it has left constrains nothing.
    // The path has to climb for the rim to matter: a wrap at constant height never leaves a
    // cylinder however short it is, which is itself worth pinning down.
    const climbing = [-2, 0.3, -1.2] as const;
    const to = [2.2, -0.2, 1.2] as const;
    const long = cylinder(climbing, to, R, 10);
    const short = cylinder(climbing, to, R, 0.2);
    expect(long.status).toBe('wrapped');
    expect(Math.abs(long.az)).toBeGreaterThan(0.2);
    expect(short.status).toBe('offEnd');
    expect(short.arcLength).toBe(0);
    expect(short.length).toBeCloseTo(Math.hypot(4.2, 0.5, 2.4), 12);

    const level = cylinder([-2, 0.3, 0], [2.2, -0.2, 0], R, 0.001);
    expect(level.status).toBe('wrapped');
  });

  it('keeps both ways round available, and takes the declared one', () => {
    // The whole point of a preferred side. The two arcs differ, and which is shorter changes as
    // the attachment points move -- so choosing by length would swap sides mid-motion.
    const above = cylinder([-2, 0, 0], [2, 0, 0], R, 10, [0, 1]);
    const below = cylinder([-2, 0, 0], [2, 0, 0], R, 10, [0, -1]);
    expect(above.status).toBe('wrapped');
    expect(below.status).toBe('wrapped');
    expect(above.ay).toBeGreaterThan(0);
    expect(below.ay).toBeLessThan(0);
    expect(above.length).toBeCloseTo(below.length, 12);
  });

  it('takes the long way round when told to', () => {
    // Asymmetric endpoints, so the two arcs really differ. Following the declared side rather
    // than the shorter arc is what keeps a moment arm from changing sign between ticks.
    const p = [-2, 0.5, 0];
    const q = [1.5, 1.2, 0];
    const near = cylinder(p, q, R, 10, [0, 1]);
    const far = cylinder(p, q, R, 10, [0, -1]);
    expect(near.status).toBe('wrapped');
    expect(far.status).toBe('wrapped');
    expect(far.length).toBeGreaterThan(near.length);
  });

  it('says so when an endpoint is inside', () => {
    expect(cylinder([0.5, 0, 3], [3, 0, 0]).status).toBe('inside');
  });

  it('ignores a path that runs parallel to the axis outside it', () => {
    const r = cylinder([2, 0, -5], [2, 0, 5]);
    expect(r.status).toBe('clear');
    expect(r.length).toBeCloseTo(10, 12);
  });

  it('puts the reaction on the axis, between the tangent points', () => {
    const r = cylinder([-2, 0.3, -0.4], [2.2, -0.2, 0.6]);
    expect(r.px).toBe(0);
    expect(r.py).toBe(0);
    expect(r.pz).toBeCloseTo((r.az + r.bz) / 2, 12);
  });
});

describe('sampling a wrapped arc', () => {
  const scratch = new Float64Array(3);
  const at = (r: WrapResult, t: number) => {
    sampleWrapArc(r, t, scratch, 0);
    return [scratch[0] as number, scratch[1] as number, scratch[2] as number];
  };

  it('starts at the first tangent point and ends at the second', () => {
    // The two conditions that make this a parameterisation of *this* arc rather than some other
    // curve between the same two points.
    for (const r of [
      sphere([-2, 0.4, 0], [2.5, -0.3, 0.2]),
      cylinder([-2, 0.3, -0.4], [2.2, -0.2, 0.6]),
    ]) {
      expect(r.status).toBe('wrapped');
      const start = at(r, 0);
      const end = at(r, 1);
      expect(start[0]).toBeCloseTo(r.ax, 12);
      expect(start[1]).toBeCloseTo(r.ay, 12);
      expect(start[2]).toBeCloseTo(r.az, 12);
      expect(end[0]).toBeCloseTo(r.bx, 9);
      expect(end[1]).toBeCloseTo(r.by, 9);
      expect(end[2]).toBeCloseTo(r.bz, 9);
    }
  });

  it('stays on the sphere the whole way round', () => {
    const r = sphere([-2, 0.4, 0], [2.5, -0.3, 0.2]);
    for (let i = 0; i <= 20; i++) {
      const p = at(r, i / 20);
      expect(Math.hypot(...p), `at t=${i / 20}`).toBeCloseTo(R, 9);
    }
  });

  it('stays on the cylinder, climbing at a constant rate', () => {
    const r = cylinder([-2, 0.3, -0.4], [2.2, -0.2, 0.6]);
    let previous: number | null = null;
    for (let i = 0; i <= 20; i++) {
      const p = at(r, i / 20);
      expect(Math.hypot(p[0] as number, p[1] as number), `at t=${i / 20}`).toBeCloseTo(R, 9);
      if (previous !== null) {
        // Equal steps in t give equal rises: that is what makes the helix a geodesic.
        expect((p[2] as number) - previous).toBeCloseTo((r.bz - r.az) / 20, 12);
      }
      previous = p[2] as number;
    }
  });

  it('measures out the arc length the wrap reported', () => {
    // Summing the sampled chords has to converge on the reported arc length. It ties the number
    // the fiber model uses to the curve anything else will draw -- if they disagreed, the picture
    // would not be of the muscle being simulated.
    for (const r of [
      sphere([-2, 0.4, 0], [2.5, -0.3, 0.2]),
      cylinder([-2, 0.3, -0.4], [2.2, -0.2, 0.6]),
    ]) {
      let walked = 0;
      let previous = at(r, 0);
      for (let i = 1; i <= 2000; i++) {
        const p = at(r, i / 2000);
        walked += Math.hypot(
          (p[0] as number) - (previous[0] as number),
          (p[1] as number) - (previous[1] as number),
          (p[2] as number) - (previous[2] as number),
        );
        previous = p;
      }
      expect(walked).toBeCloseTo(r.arcLength, 6);
    }
  });

  it('goes the way the declared side sent it, not always the short way', () => {
    // A long-way-round wrap sweeps past where the short one would have stopped. Sampling has to
    // follow it there, or a drawing would show a path the solver is not simulating.
    const p = [-2, 0.5, 0] as const;
    const q = [1.5, 1.2, 0] as const;
    const near = cylinder(p, q, R, 10, [0, 1]);
    const far = cylinder(p, q, R, 10, [0, -1]);
    expect(Math.abs(far.sweep)).toBeGreaterThan(Math.abs(near.sweep));
    expect(Math.sign(far.sweep)).toBe(-Math.sign(near.sweep));
    // Half way round the long arc is on the far side of the cylinder from half way round the short.
    const midNear = at(near, 0.5);
    const midFar = at(far, 0.5);
    expect(Math.sign(midNear[1] as number)).not.toBe(Math.sign(midFar[1] as number));
  });
});
