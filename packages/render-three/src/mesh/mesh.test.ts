import { IDENTITY_TRANSFORM, UNIT_Y, fromAxisAngle, transform, vec3 } from '@bs-humany/frames';
import type { ExprContext, GeometryRecipe } from '@bs-humany/hsdl';
import { mul, param } from '@bs-humany/hsdl';
import { describe, expect, it } from 'vitest';
import { evaluateRecipe, mergeMeshes } from './evaluate.js';
import { box, capsule, loft, revolve, sphere } from './primitives.js';
import {
  type MeshData,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  triangleCount,
  vertexCount,
} from './types.js';

const ctx: ExprContext = { sex: 0.5, stature: 1.7, mass: 70 };

/** Axis-aligned bounds, for asserting where a primitive actually sits. */
function bounds(mesh: MeshData) {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = mesh.positions[i + a] ?? 0;
      min[a] = Math.min(min[a] ?? 0, v);
      max[a] = Math.max(max[a] ?? 0, v);
    }
  }
  return { min, max };
}

/** Every mesh must satisfy these, whatever produced it. */
function expectWellFormed(mesh: MeshData, label: string) {
  expect(mesh.positions.length % 3, `${label}: positions`).toBe(0);
  expect(mesh.normals.length, `${label}: normal count`).toBe(mesh.positions.length);
  expect(mesh.indices.length % 3, `${label}: indices`).toBe(0);
  expect(vertexCount(mesh), `${label}: has vertices`).toBeGreaterThan(0);
  expect(triangleCount(mesh), `${label}: has triangles`).toBeGreaterThan(0);

  for (const value of mesh.positions) {
    expect(Number.isFinite(value), `${label}: finite position`).toBe(true);
  }

  const count = vertexCount(mesh);
  for (const index of mesh.indices) {
    expect(index, `${label}: index in range`).toBeLessThan(count);
  }

  // Normals must be unit length, or lighting is wrong in a way that reads as a material bug.
  for (let i = 0; i < count; i++) {
    const length = Math.hypot(
      mesh.normals[i * 3] ?? 0,
      mesh.normals[i * 3 + 1] ?? 0,
      mesh.normals[i * 3 + 2] ?? 0,
    );
    expect(length, `${label}: normal ${i} length`).toBeCloseTo(1, 5);
  }
}

describe('capsule', () => {
  it('is well formed', () => {
    expectWellFormed(capsule(0.4, 0.03, 0.025, 'y', QUALITY_MEDIUM), 'capsule');
  });

  it('runs from the origin to +length along its axis, plus the caps', () => {
    // The anchoring convention: a bone's frame origin sits at a joint centre, so a capsule
    // anchored at the origin lands where the bone is without a wrapping transform.
    const mesh = capsule(0.4, 0.03, 0.02, 'y', QUALITY_MEDIUM);
    const { min, max } = bounds(mesh);
    expect(min[1]).toBeCloseTo(-0.02, 6);
    expect(max[1]).toBeCloseTo(0.43, 6);
  });

  it('honours the requested axis', () => {
    for (const [axis, index] of [
      ['x', 0],
      ['y', 1],
      ['z', 2],
    ] as const) {
      const mesh = capsule(0.5, 0.02, 0.02, axis, QUALITY_LOW);
      const { min, max } = bounds(mesh);
      expect(max[index] ?? 0, `axis ${axis} extent`).toBeCloseTo(0.52, 6);
      // The cross-section is small on the other two axes.
      for (let a = 0; a < 3; a++) {
        if (a === index) continue;
        expect(max[a] ?? 0, `axis ${axis} cross-section`).toBeCloseTo(0.02, 6);
      }
      expect(min[index] ?? 0).toBeCloseTo(-0.02, 6);
    }
  });

  it('tapers between the two radii', () => {
    const mesh = capsule(1, 0.1, 0.02, 'y', QUALITY_MEDIUM);
    // Widest near the proximal end, narrowest near the distal end.
    let widthAtDistal = 0;
    let widthAtProximal = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const y = mesh.positions[i + 1] ?? 0;
      const r = Math.hypot(mesh.positions[i] ?? 0, mesh.positions[i + 2] ?? 0);
      if (Math.abs(y) < 1e-6) widthAtDistal = Math.max(widthAtDistal, r);
      if (Math.abs(y - 1) < 1e-6) widthAtProximal = Math.max(widthAtProximal, r);
    }
    expect(widthAtDistal).toBeCloseTo(0.02, 6);
    expect(widthAtProximal).toBeCloseTo(0.1, 6);
  });

  it('tilts shaft normals on a taper, so it does not light like a cylinder', () => {
    // The shaft is ruled, so it needs only two rings and has no strictly-interior vertices. The
    // check is therefore on the axial component of the normals present on the shaft rings.
    const axialNormalsAtBase = (mesh: MeshData) => {
      const values: number[] = [];
      for (let i = 0; i < mesh.positions.length; i += 3) {
        if (Math.abs(mesh.positions[i + 1] ?? 0) > 1e-6) continue;
        values.push(mesh.normals[i + 1] ?? 0);
      }
      return values;
    };

    const slope = (0.15 - 0.02) / 1;
    const expectedTilt = slope / Math.hypot(1, slope);
    const tapered = axialNormalsAtBase(capsule(1, 0.15, 0.02, 'y', QUALITY_MEDIUM));
    expect(tapered.some((ny) => Math.abs(ny - expectedTilt) < 1e-5)).toBe(true);

    // An untapered capsule's shaft normals stay perpendicular to the axis.
    const straight = axialNormalsAtBase(capsule(1, 0.05, 0.05, 'y', QUALITY_MEDIUM));
    expect(straight.every((ny) => Math.abs(ny) < 1e-6)).toBe(true);
  });

  it('gets denser with quality', () => {
    const low = triangleCount(capsule(0.4, 0.03, 0.03, 'y', QUALITY_LOW));
    const medium = triangleCount(capsule(0.4, 0.03, 0.03, 'y', QUALITY_MEDIUM));
    const high = triangleCount(capsule(0.4, 0.03, 0.03, 'y', QUALITY_HIGH));
    expect(medium).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(medium);
  });

  it('stays within a mobile triangle budget at low quality', () => {
    // ADR-010: L0 must run on mobile, so the whole 206-bone skeleton has to fit a phone GPU.
    const perBone = triangleCount(capsule(0.4, 0.03, 0.025, 'y', QUALITY_LOW));
    expect(perBone * 206).toBeLessThan(60_000);
  });

  it('refuses degenerate dimensions rather than emitting a sliver', () => {
    expect(() => capsule(0, 0.03, 0.03, 'y', QUALITY_LOW)).toThrow(/length must be positive/);
    expect(() => capsule(0.4, 0, 0.03, 'y', QUALITY_LOW)).toThrow(/radii must be positive/);
  });
});

describe('sphere', () => {
  it('is well formed and centred on the origin', () => {
    const mesh = sphere(0.05, QUALITY_MEDIUM);
    expectWellFormed(mesh, 'sphere');
    const { min, max } = bounds(mesh);
    for (let a = 0; a < 3; a++) {
      expect(min[a] ?? 0).toBeCloseTo(-0.05, 5);
      expect(max[a] ?? 0).toBeCloseTo(0.05, 5);
    }
  });

  it('puts every vertex on the surface', () => {
    const mesh = sphere(0.2, QUALITY_HIGH);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const r = Math.hypot(
        mesh.positions[i] ?? 0,
        mesh.positions[i + 1] ?? 0,
        mesh.positions[i + 2] ?? 0,
      );
      expect(r).toBeCloseTo(0.2, 6);
    }
  });

  it('points every normal outward, along the radius', () => {
    const mesh = sphere(0.2, QUALITY_MEDIUM);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const px = mesh.positions[i] ?? 0;
      const py = mesh.positions[i + 1] ?? 0;
      const pz = mesh.positions[i + 2] ?? 0;
      const dot =
        (px * (mesh.normals[i] ?? 0) +
          py * (mesh.normals[i + 1] ?? 0) +
          pz * (mesh.normals[i + 2] ?? 0)) /
        0.2;
      expect(dot).toBeCloseTo(1, 5);
    }
  });

  it('refuses a non-positive radius', () => {
    expect(() => sphere(0, QUALITY_LOW)).toThrow(/radius must be positive/);
  });
});

describe('box', () => {
  it('is well formed and centred', () => {
    const mesh = box(0.2, 0.1, 0.3);
    expectWellFormed(mesh, 'box');
    const { min, max } = bounds(mesh);
    // Positions are Float32Array, so these compare approximately rather than exactly.
    const expectedMin = [-0.1, -0.05, -0.15];
    const expectedMax = [0.1, 0.05, 0.15];
    for (let a = 0; a < 3; a++) {
      expect(min[a] ?? 0).toBeCloseTo(expectedMin[a] ?? 0, 6);
      expect(max[a] ?? 0).toBeCloseTo(expectedMax[a] ?? 0, 6);
    }
  });

  it('has exactly twelve triangles and flat normals', () => {
    // Vertices are duplicated per face on purpose: sharing them would smooth the corners, which on
    // a vertebral body reads as a soap bar rather than a bone.
    const mesh = box(1, 1, 1);
    expect(triangleCount(mesh)).toBe(12);
    expect(vertexCount(mesh)).toBe(24);
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const components = [mesh.normals[i] ?? 0, mesh.normals[i + 1] ?? 0, mesh.normals[i + 2] ?? 0];
      const nonZero = components.filter((c) => Math.abs(c) > 1e-9);
      expect(nonZero.length).toBe(1);
      expect(Math.abs(nonZero[0] ?? 0)).toBeCloseTo(1, 9);
    }
  });

  it('refuses a non-positive size', () => {
    expect(() => box(0, 1, 1)).toThrow(/size x must be positive/);
    expect(() => box(1, 1, -1)).toThrow(/size z must be positive/);
  });
});

describe('revolve', () => {
  it('is well formed', () => {
    const mesh = revolve(
      [
        { at: 0, radius: 0.01 },
        { at: 0.05, radius: 0.04 },
        { at: 0.1, radius: 0.01 },
      ],
      'y',
      QUALITY_MEDIUM,
    );
    expectWellFormed(mesh, 'revolve');
  });

  it('follows the profile radii', () => {
    const mesh = revolve(
      [
        { at: 0, radius: 0.02 },
        { at: 0.1, radius: 0.06 },
      ],
      'y',
      QUALITY_MEDIUM,
    );
    let radiusAtBase = 0;
    let radiusAtTop = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const y = mesh.positions[i + 1] ?? 0;
      const r = Math.hypot(mesh.positions[i] ?? 0, mesh.positions[i + 2] ?? 0);
      if (Math.abs(y) < 1e-6) radiusAtBase = Math.max(radiusAtBase, r);
      if (Math.abs(y - 0.1) < 1e-6) radiusAtTop = Math.max(radiusAtTop, r);
    }
    expect(radiusAtBase).toBeCloseTo(0.02, 6);
    expect(radiusAtTop).toBeCloseTo(0.06, 6);
  });

  it('sorts an out-of-order profile', () => {
    const ordered = revolve(
      [
        { at: 0, radius: 0.02 },
        { at: 0.1, radius: 0.04 },
      ],
      'y',
      QUALITY_LOW,
    );
    const scrambled = revolve(
      [
        { at: 0.1, radius: 0.04 },
        { at: 0, radius: 0.02 },
      ],
      'y',
      QUALITY_LOW,
    );
    expect(Array.from(scrambled.positions)).toEqual(Array.from(ordered.positions));
  });

  it('refuses a profile with fewer than two points', () => {
    expect(() => revolve([{ at: 0, radius: 1 }], 'y', QUALITY_LOW)).toThrow(/at least two points/);
  });
});

describe('loft', () => {
  const square = [
    [-0.02, -0.01],
    [0.02, -0.01],
    [0.02, 0.01],
    [-0.02, 0.01],
  ] as ReadonlyArray<readonly [number, number]>;

  it('is well formed', () => {
    const mesh = loft(
      [
        { at: 0, outline: square, offset: [0, 0] },
        { at: 0.2, outline: square, offset: [0, 0] },
      ],
      'y',
      true,
    );
    expectWellFormed(mesh, 'loft');
  });

  it('applies section offsets, which is what gives a bone its curve', () => {
    // A femur's anterior bow and a rib's arc are displaced section centres, not twists -- that
    // keeps the local frame aligned with the mechanical long axis.
    const mesh = loft(
      [
        { at: 0, outline: square, offset: [0, 0] },
        { at: 0.1, outline: square, offset: [0.05, 0] },
        { at: 0.2, outline: square, offset: [0, 0] },
      ],
      'y',
      false,
    );
    const { max } = bounds(mesh);
    expect(max[0] ?? 0).toBeCloseTo(0.07, 6);
  });

  it('caps the ends when asked, and leaves them open when not', () => {
    const open = loft(
      [
        { at: 0, outline: square, offset: [0, 0] },
        { at: 0.2, outline: square, offset: [0, 0] },
      ],
      'y',
      false,
    );
    const capped = loft(
      [
        { at: 0, outline: square, offset: [0, 0] },
        { at: 0.2, outline: square, offset: [0, 0] },
      ],
      'y',
      true,
    );
    expect(triangleCount(capped)).toBeGreaterThan(triangleCount(open));
  });

  it('refuses sections with mismatched outline lengths', () => {
    // Resampling mismatched polygons would guess at the point correspondence and twist the
    // surface, so it fails loudly instead.
    expect(() =>
      loft(
        [
          { at: 0, outline: square, offset: [0, 0] },
          { at: 0.2, outline: square.slice(0, 3), offset: [0, 0] },
        ],
        'y',
        false,
      ),
    ).toThrow(/same number of outline points/);
  });

  it('refuses fewer than two sections', () => {
    expect(() => loft([{ at: 0, outline: square, offset: [0, 0] }], 'y', false)).toThrow(
      /at least two sections/,
    );
  });
});

describe('evaluateRecipe', () => {
  it('resolves dimension expressions against the morphology context', () => {
    const recipe: GeometryRecipe = {
      kind: 'capsule',
      length: mul(0.245, param('stature')),
      radiusProximal: 0.03,
      radiusDistal: 0.025,
    };
    const mesh = evaluateRecipe(recipe, ctx);
    expectWellFormed(mesh, 'recipe capsule');
    const { max } = bounds(mesh);
    expect(max[1] ?? 0).toBeCloseTo(0.245 * 1.7 + 0.03, 5);
  });

  it('reshapes when morphology changes, which is the point of ADR-005', () => {
    const recipe: GeometryRecipe = {
      kind: 'capsule',
      length: mul(0.245, param('stature')),
      radiusProximal: 0.03,
    };
    const short = bounds(evaluateRecipe(recipe, { ...ctx, stature: 1.5 }));
    const tall = bounds(evaluateRecipe(recipe, { ...ctx, stature: 2.0 }));
    expect((tall.max[1] ?? 0) - (short.max[1] ?? 0)).toBeCloseTo(0.245 * 0.5, 5);
  });

  it('builds a composite from its parts', () => {
    // How a vertebra is described: body, plus processes, each in its own local frame.
    const recipe: GeometryRecipe = {
      kind: 'composite',
      parts: [
        { recipe: { kind: 'box', size: { x: 0.04, y: 0.02, z: 0.03 } }, name: 'body' },
        {
          recipe: { kind: 'box', size: { x: 0.01, y: 0.01, z: 0.04 } },
          name: 'spinous_process',
          transform: {
            translation: { x: 0, y: 0, z: 0.035 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          },
        },
      ],
    };
    const mesh = evaluateRecipe(recipe, ctx);
    expectWellFormed(mesh, 'composite');
    expect(triangleCount(mesh)).toBe(24);
    const { max } = bounds(mesh);
    expect(max[2] ?? 0).toBeCloseTo(0.055, 6);
  });

  it('evaluates a loft with elliptical sections', () => {
    const recipe: GeometryRecipe = {
      kind: 'loft',
      sections: [
        { at: 0, profile: { kind: 'ellipse', radiusA: 0.02, radiusB: 0.015 } },
        { at: 0.1, profile: { kind: 'ellipse', radiusA: 0.012, radiusB: 0.01 } },
        { at: 0.2, profile: { kind: 'ellipse', radiusA: 0.025, radiusB: 0.02 } },
      ],
      capped: true,
    };
    expectWellFormed(evaluateRecipe(recipe, ctx), 'elliptical loft');
  });

  it('resamples ellipses to match a polygon, without resampling the polygon', () => {
    // Mixing an authored polygon with a sampled ellipse is reasonable. The ellipse has no
    // privileged point count, so it yields; the polygon's points carry meaning and are kept.
    const recipe: GeometryRecipe = {
      kind: 'loft',
      sections: [
        {
          at: 0,
          profile: {
            kind: 'polygon',
            points: [
              { u: -0.02, v: -0.01 },
              { u: 0.02, v: -0.01 },
              { u: 0.02, v: 0.01 },
              { u: -0.02, v: 0.01 },
              { u: 0, v: 0.02 },
            ],
          },
        },
        { at: 0.1, profile: { kind: 'ellipse', radiusA: 0.015, radiusB: 0.012 } },
      ],
    };
    expect(() => evaluateRecipe(recipe, ctx)).not.toThrow();
    expectWellFormed(evaluateRecipe(recipe, ctx), 'mixed loft');
  });

  it('propagates a missing morphology parameter instead of rendering a sliver', () => {
    const recipe: GeometryRecipe = {
      kind: 'capsule',
      length: param('biiliacBreadth'),
      radiusProximal: 0.03,
    };
    expect(() => evaluateRecipe(recipe, ctx)).toThrow(/'biiliacBreadth' is not set/);
  });
});

describe('mergeMeshes', () => {
  it('rotates normals as directions, not as points', () => {
    // Passing a normal through a point transform is a classic slip: lighting then drifts as the
    // body moves, which reads as a material bug rather than a geometry one.
    const source = box(0.1, 0.1, 0.1);
    const moved = mergeMeshes([
      { mesh: source, transform: transform(vec3(10, 20, 30), fromAxisAngle(UNIT_Y, 0)) },
    ]);
    for (let i = 0; i < source.normals.length; i++) {
      expect(moved.normals[i] ?? 0).toBeCloseTo(source.normals[i] ?? 0, 9);
    }
    expect(moved.positions[0] ?? 0).toBeCloseTo((source.positions[0] ?? 0) + 10, 6);
  });

  it('rotates normals when the transform rotates', () => {
    const source = box(0.1, 0.1, 0.1);
    const rotated = mergeMeshes([
      { mesh: source, transform: transform(vec3(0, 0, 0), fromAxisAngle(UNIT_Y, Math.PI / 2)) },
    ]);
    let changed = false;
    for (let i = 0; i < source.normals.length; i++) {
      if (Math.abs((rotated.normals[i] ?? 0) - (source.normals[i] ?? 0)) > 1e-6) changed = true;
    }
    expect(changed).toBe(true);
    expectWellFormed(rotated, 'rotated merge');
  });

  it('offsets indices so parts do not reference each other', () => {
    const a = box(0.1, 0.1, 0.1);
    const b = box(0.2, 0.2, 0.2);
    const merged = mergeMeshes([
      { mesh: a, transform: IDENTITY_TRANSFORM },
      { mesh: b, transform: IDENTITY_TRANSFORM },
    ]);
    expect(vertexCount(merged)).toBe(vertexCount(a) + vertexCount(b));
    expect(triangleCount(merged)).toBe(triangleCount(a) + triangleCount(b));
    for (const index of merged.indices) {
      expect(index).toBeLessThan(vertexCount(merged));
    }
  });

  it('produces an empty mesh from no parts', () => {
    const merged = mergeMeshes([]);
    expect(merged.positions.length).toBe(0);
    expect(merged.indices.length).toBe(0);
  });
});
