import { describe, expect, it } from 'vitest';
import {
  MAX_WIDTH_OVER_LENGTH,
  PERFUSION_GAIN,
  SPECIFIC_TENSION,
  type SweptMesh,
  bellyLength,
  bellyProfile,
  createSweepScratch,
  createSweptMesh,
  enclosedVolume,
  muscleVolume,
  peakRadius,
  perfusedVolume,
  sweepMuscle,
} from './sweep.js';

/** A straight path of the given length along X, as a two-point polyline. */
function straight(length: number): Float64Array {
  return Float64Array.from([0, 0, 0, length, 0, 0]);
}

/** A path that turns a right angle, for the frame-carrying tests. */
function bent(): Float64Array {
  return Float64Array.from([0, 0, 0, 0.15, 0, 0, 0.15, 0.15, 0, 0.15, 0.15, 0.15]);
}

function sweep(
  points: Float64Array,
  pointCount: number,
  volume: number,
  bellyLength: number,
  mesh: SweptMesh = createSweptMesh(40, 16),
): SweptMesh {
  sweepMuscle(
    { points, from: 0, pointCount, volume, bellyLength, tendonRadius: 0.002 },
    createSweepScratch(pointCount),
    mesh,
  );
  return mesh;
}

describe('the belly profile', () => {
  it('comes to a point at both ends and is fattest in the middle', () => {
    // A square root at a zero of sine: the error in sin(pi) comes out amplified, so these are
    // zero to about eight digits rather than to machine precision. Nothing downstream cares --
    // it is a tenth of a micron on a muscle.
    expect(bellyProfile(0)).toBeCloseTo(0, 7);
    expect(bellyProfile(1)).toBeCloseTo(0, 7);
    expect(bellyProfile(0.5)).toBeCloseTo(1, 12);
    for (const t of [0.1, 0.2, 0.3, 0.4]) {
      expect(bellyProfile(t), `at ${t}`).toBeLessThan(bellyProfile(t + 0.1));
    }
  });

  it('is symmetric about the middle, as a fusiform muscle is', () => {
    for (const t of [0.05, 0.2, 0.37]) {
      expect(bellyProfile(t)).toBeCloseTo(bellyProfile(1 - t), 12);
    }
  });

  it('holds still outside its range rather than producing a NaN', () => {
    expect(bellyProfile(-0.5)).toBeCloseTo(0, 7);
    expect(bellyProfile(1.5)).toBeCloseTo(0, 7);
  });
});

describe('sizing a muscle', () => {
  it('turns force into volume through the cross-sectional area', () => {
    // A 300 N muscle at 0.45 MPa has 6.7 square centimetres of cross-section; 10 cm of fiber makes
    // 67 cubic centimetres of tissue. The arithmetic is worth pinning because everything drawn
    // rests on it, and the tension itself was chosen by what it produces: this set's four muscles
    // all land in their published volume ranges at 0.45 and are 30 to 60 per cent over at 0.3.
    const volume = muscleVolume(300, 0.1);
    expect(volume).toBeCloseTo((300 / 450_000) * 0.1, 15);
    expect(volume).toBeCloseTo(6.667e-5, 8);
    expect(muscleVolume(300, 0.1, SPECIFIC_TENSION)).toBe(volume);
  });

  it('gives a stronger muscle more tissue, in proportion', () => {
    expect(muscleVolume(600, 0.1)).toBeCloseTo(2 * muscleVolume(300, 0.1), 12);
    expect(muscleVolume(300, 0.2)).toBeCloseTo(2 * muscleVolume(300, 0.1), 12);
  });

  it('thickens the spindle as it shortens, by the square root', () => {
    // The whole bulge, in one line: halving the length multiplies the peak radius by root two.
    const volume = 1e-4;
    expect(peakRadius(volume, 0.1)).toBeCloseTo(Math.sqrt(volume / 0.2), 12);
    expect(peakRadius(volume, 0.05) / peakRadius(volume, 0.1)).toBeCloseTo(Math.SQRT2, 12);
  });
});

describe('perfusion, and the three ways a muscle contracts', () => {
  const tissue = 1e-5;

  it('leaves an isometric contraction alone, however hard it is working', () => {
    // Not changing length means nothing is being pumped anywhere, so the belly measures what it
    // measured -- at any activation.
    for (const activation of [0, 0.5, 1]) {
      expect(perfusedVolume(tissue, activation, 0), `at a=${activation}`).toBeCloseTo(tissue, 15);
    }
  });

  it('shrinks a concentric contraction and swells an eccentric one', () => {
    // Shortening under load squeezes blood out; lengthening under load raises tension without
    // that expulsion. The sign of the fiber velocity is what separates the two.
    expect(perfusedVolume(tissue, 1, -1)).toBeLessThan(tissue);
    expect(perfusedVolume(tissue, 1, 1)).toBeGreaterThan(tissue);
    expect(perfusedVolume(tissue, 1, -1)).toBeCloseTo(tissue * (1 - PERFUSION_GAIN), 15);
    expect(perfusedVolume(tissue, 1, 1)).toBeCloseTo(tissue * (1 + PERFUSION_GAIN), 15);
  });

  it('leaves a passive stretch alone, because it is about load and not motion', () => {
    // A relaxed muscle dragged through its range is not pumping anything. Multiplying by
    // activation is what makes that true, and it is the reason activation is a factor at all.
    expect(perfusedVolume(tissue, 0, 1)).toBeCloseTo(tissue, 15);
    expect(perfusedVolume(tissue, 0, -1)).toBeCloseTo(tissue, 15);
  });

  it('scales with how hard the muscle is working', () => {
    const half = perfusedVolume(tissue, 0.5, -1);
    const full = perfusedVolume(tissue, 1, -1);
    expect(tissue - half).toBeCloseTo((tissue - full) / 2, 15);
  });

  it('saturates rather than running away at an out-of-range velocity', () => {
    // A fiber velocity past the maximum contraction velocity is a diagnostic elsewhere; here it
    // must not be allowed to drive the volume negative.
    expect(perfusedVolume(tissue, 1, -50)).toBeCloseTo(tissue * (1 - PERFUSION_GAIN), 15);
    expect(perfusedVolume(tissue, 1, 50)).toBeCloseTo(tissue * (1 + PERFUSION_GAIN), 15);
    expect(perfusedVolume(tissue, 5, -50)).toBeGreaterThan(0);
  });

  it('stays a small correction, not a second bulge', () => {
    // The shape change a viewer sees has to come from the belly shortening, not from this. Over
    // the whole range of contraction the volume moves by a few per cent; the geometry moves the
    // radius by tens.
    const extremes = [perfusedVolume(tissue, 1, -1), perfusedVolume(tissue, 1, 1)];
    expect(Math.max(...extremes) / Math.min(...extremes)).toBeLessThan(1.1);
  });
});

describe('the swept mesh', () => {
  it('wires its topology once, and never needs to again', () => {
    const mesh = createSweptMesh(20, 12);
    expect(mesh.vertexCount).toBe(20 * 12);
    expect(mesh.index).toHaveLength((20 - 1) * 12 * 6);
    expect(mesh.position).toHaveLength(3 * mesh.vertexCount);
    // Every index addresses a vertex that exists.
    expect(Math.max(...mesh.index)).toBe(mesh.vertexCount - 1);
    expect(Math.min(...mesh.index)).toBe(0);
  });

  it('refuses a degenerate sweep rather than producing a mesh with no surface', () => {
    expect(() => createSweptMesh(1, 12)).toThrow(/at least 2 rings/);
    expect(() => createSweptMesh(20, 2)).toThrow(/3 segments/);
  });

  it('closes each ring, so the tube has no seam', () => {
    // The last segment of a ring has to join back to the first. A sweep that left the seam open
    // would look solid from most angles and be hollow from one.
    const mesh = sweep(straight(0.3), 2, 1e-4, 0.2);
    const ring = 10;
    const first = 3 * (ring * mesh.segments);
    const last = 3 * (ring * mesh.segments + mesh.segments - 1);
    const step = Math.hypot(
      (mesh.position[first] as number) - (mesh.position[last] as number),
      (mesh.position[first + 1] as number) - (mesh.position[last + 1] as number),
      (mesh.position[first + 2] as number) - (mesh.position[last + 2] as number),
    );
    // Neighbours around the ring, so no further apart than any other adjacent pair.
    const second = 3 * (ring * mesh.segments + 1);
    const neighbour = Math.hypot(
      (mesh.position[first] as number) - (mesh.position[second] as number),
      (mesh.position[first + 1] as number) - (mesh.position[second + 1] as number),
      (mesh.position[first + 2] as number) - (mesh.position[second + 2] as number),
    );
    expect(step).toBeCloseTo(neighbour, 9);
  });

  it('follows the path it was given', () => {
    const mesh = sweep(straight(0.3), 2, 1e-4, 0.2);
    // Every vertex sits on the path's own axis, offset by its radius.
    for (let i = 0; i < mesh.vertexCount; i++) {
      const x = mesh.position[3 * i] as number;
      expect(x, `vertex ${i}`).toBeGreaterThanOrEqual(-1e-6);
      expect(x, `vertex ${i}`).toBeLessThanOrEqual(0.3 + 1e-6);
    }
  });

  it('is fattest in the middle and thin at the ends', () => {
    const mesh = sweep(straight(0.3), 2, 1e-4, 0.2);
    const radiusAt = (ring: number) => {
      const v = 3 * ring * mesh.segments;
      return Math.hypot(mesh.position[v + 1] as number, mesh.position[v + 2] as number);
    };
    expect(radiusAt(Math.floor(mesh.rings / 2))).toBeGreaterThan(radiusAt(2));
    expect(radiusAt(2)).toBeCloseTo(0.002, 3);
    expect(radiusAt(mesh.rings - 1)).toBeCloseTo(0.002, 3);
  });

  it('encloses the volume it was asked to', () => {
    // Measured off the triangles by the divergence theorem, not recomputed from the formula that
    // placed them. A drawn muscle that did not hold the volume it was given would bulge by some
    // other rule than the one claimed.
    const volume = 1e-4;
    const mesh = sweep(straight(0.3), 2, volume, 0.2, createSweptMesh(200, 48));
    // The tendon cord adds a little either side of the belly, and a faceted tube is slightly
    // inside the smooth one it approximates.
    expect(enclosedVolume(mesh)).toBeGreaterThan(volume * 0.95);
    expect(enclosedVolume(mesh)).toBeLessThan(volume * 1.1);
  });

  it('holds that volume as the muscle shortens, which is the bulge', () => {
    // The point of the tier, and the part that is pure geometry: given a volume, a belly at half
    // the length can only enclose it by getting thicker. Perfusion is a separate, smaller effect
    // applied to the volume before it gets here -- see `perfusedVolume`.
    const volume = 1e-4;
    const path = 0.3;
    const cord = 0.002;
    // What the thin tendon cord contributes either side of the belly. It is not part of the
    // muscle's tissue, and a shorter belly leaves more of the path to it -- so comparing raw
    // enclosed volumes would show the belly growing when it is the cord that lengthened.
    const cordVolume = (belly: number) => Math.PI * cord * cord * (path - belly);

    const long = sweep(straight(path), 2, volume, 0.24, createSweptMesh(200, 48));
    const longVolume = enclosedVolume(long) - cordVolume(0.24);
    const longRadius = Math.hypot(
      long.position[3 * Math.floor(long.rings / 2) * long.segments + 1] as number,
      long.position[3 * Math.floor(long.rings / 2) * long.segments + 2] as number,
    );

    const short = sweep(straight(path), 2, volume, 0.12, createSweptMesh(200, 48));
    const shortVolume = enclosedVolume(short) - cordVolume(0.12);
    const shortRadius = Math.hypot(
      short.position[3 * Math.floor(short.rings / 2) * short.segments + 1] as number,
      short.position[3 * Math.floor(short.rings / 2) * short.segments + 2] as number,
    );

    expect(shortRadius / longRadius).toBeCloseTo(Math.SQRT2, 2);
    expect(shortVolume / longVolume).toBeGreaterThan(0.97);
    expect(shortVolume / longVolume).toBeLessThan(1.03);
  });

  it('carries its frame around a corner instead of spinning', () => {
    // A frame rebuilt from a world axis at each ring flips as the path turns through that axis,
    // which reads as the muscle twisting about itself. Carried, the reference direction changes
    // only as much as the tangent forces it to.
    const mesh = sweep(bent(), 4, 1e-4, 0.3, createSweptMesh(60, 16));
    let worst = 0;
    for (let ring = 1; ring < mesh.rings; ring++) {
      const a = 3 * ((ring - 1) * mesh.segments);
      const b = 3 * (ring * mesh.segments);
      const centreA = ringCentre(mesh, ring - 1);
      const centreB = ringCentre(mesh, ring);
      const da = norm([
        (mesh.position[a] as number) - centreA[0],
        (mesh.position[a + 1] as number) - centreA[1],
        (mesh.position[a + 2] as number) - centreA[2],
      ]);
      const db = norm([
        (mesh.position[b] as number) - centreB[0],
        (mesh.position[b + 1] as number) - centreB[1],
        (mesh.position[b + 2] as number) - centreB[2],
      ]);
      worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, dot(da, db)))));
    }
    // The path turns two right angles over sixty rings; no single step may turn the frame more
    // than the tangent does.
    expect(worst).toBeLessThan(Math.PI / 2);
  });

  it('gives back a flat mesh for a path with no length, rather than NaNs', () => {
    const mesh = sweep(Float64Array.from([0.1, 0.2, 0.3, 0.1, 0.2, 0.3]), 2, 1e-4, 0.1);
    expect(Array.from(mesh.position).every((v) => Number.isFinite(v))).toBe(true);
    expect(Array.from(mesh.normal).every((v) => Number.isFinite(v))).toBe(true);
  });

  it('never lets the belly outgrow the path it runs along', () => {
    // Asked for a belly longer than the whole muscle -- which a fiber length can be, briefly,
    // when a tendon has gone slack -- the sweep fits it to the path instead of running off it.
    const mesh = sweep(straight(0.1), 2, 1e-4, 0.5);
    for (let i = 0; i < mesh.vertexCount; i++) {
      const x = mesh.position[3 * i] as number;
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(x).toBeLessThanOrEqual(0.1 + 1e-6);
    }
  });

  it('points every normal outward from the path', () => {
    const mesh = sweep(straight(0.3), 2, 1e-4, 0.2);
    for (let ring = 1; ring < mesh.rings - 1; ring++) {
      const centre = ringCentre(mesh, ring);
      for (let s = 0; s < mesh.segments; s++) {
        const v = 3 * (ring * mesh.segments + s);
        const out = [
          (mesh.position[v] as number) - centre[0],
          (mesh.position[v + 1] as number) - centre[1],
          (mesh.position[v + 2] as number) - centre[2],
        ];
        const n = [
          mesh.normal[v] as number,
          mesh.normal[v + 1] as number,
          mesh.normal[v + 2] as number,
        ];
        expect(Math.hypot(...n)).toBeCloseTo(1, 6);
        expect(dot(norm(out), n), `ring ${ring} segment ${s}`).toBeGreaterThan(0.99);
      }
    }
  });
});

function ringCentre(mesh: SweptMesh, ring: number): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let s = 0; s < mesh.segments; s++) {
    const v = 3 * (ring * mesh.segments + s);
    x += mesh.position[v] as number;
    y += mesh.position[v + 1] as number;
    z += mesh.position[v + 2] as number;
  }
  return [x / mesh.segments, y / mesh.segments, z / mesh.segments];
}

function norm(v: number[]): number[] {
  const length = Math.hypot(v[0] as number, v[1] as number, v[2] as number) || 1;
  return [(v[0] as number) / length, (v[1] as number) / length, (v[2] as number) / length];
}

function dot(a: number[], b: number[]): number {
  return (
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number)
  );
}

describe('a pennate belly, which is longer than its fibers', () => {
  // Brachialis, as the elbow set carries it: 1169 N of force through 58 mm fibers. The force is
  // large because the muscle is pennate, and a pennate muscle's belly is far longer than any one
  // of its fibers -- so taking the fiber length as the belly length piles the tissue across the
  // muscle instead of along it.
  const volume = muscleVolume(1169, 0.0576);
  const fibers = 0.0576;

  it('would be drawn wider than long if the fiber length were taken as the belly', () => {
    // The bug this fixes, stated as the arithmetic that produced it: a quarter wider than it is
    // long, which is a discus and not a muscle.
    const naive = peakRadius(volume, fibers);
    expect((2 * naive) / fibers).toBeGreaterThan(1.2);
  });

  it('spreads along the path instead, and comes out longer than it is wide', () => {
    const path = 0.25;
    const belly = bellyLength(volume, fibers, path);
    expect(belly).toBeGreaterThan(fibers);
    const radius = peakRadius(volume, belly);
    expect((2 * radius) / belly).toBeCloseTo(MAX_WIDTH_OVER_LENGTH, 6);
  });

  it('lands on a belly length a real brachialis has', () => {
    // Not a coincidence worth passing over: the rule is about drawing, and the length it picks
    // for the most pennate muscle in the set is the length that muscle actually is.
    expect(bellyLength(volume, fibers, 0.25)).toBeGreaterThan(0.085);
    expect(bellyLength(volume, fibers, 0.25)).toBeLessThan(0.12);
  });

  it('leaves a fusiform muscle exactly as it was', () => {
    // The long head of biceps: 422 N through 127 mm fibers, which is already slimmer than the
    // limit. A rule that also moved these would be changing what it was not asked to.
    const biceps = muscleVolume(422, 0.1272);
    expect(bellyLength(biceps, 0.1272, 0.35)).toBe(0.1272);
    expect((2 * peakRadius(biceps, 0.1272)) / 0.1272).toBeLessThan(MAX_WIDTH_OVER_LENGTH);
  });

  it('still thickens as the muscle shortens, which the spreading must not undo', () => {
    // The fix must not cost the bulge. Once the belly is past the aspect limit the fiber length is
    // what sets it again, and the radius follows the volume as before.
    const path = 0.35;
    const biceps = muscleVolume(422, 0.1272);
    const long = peakRadius(biceps, bellyLength(biceps, 0.13, path));
    const short = peakRadius(biceps, bellyLength(biceps, 0.09, path));
    expect(short).toBeGreaterThan(long);
  });

  it('never runs the belly off the end of the path', () => {
    // A short path cannot hold a long belly, and the aspect rule must not make it try.
    const path = 0.06;
    expect(bellyLength(volume, fibers, path)).toBe(path);
  });
});
