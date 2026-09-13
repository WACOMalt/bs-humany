/**
 * Procedural primitives.
 *
 * ADR-005: Phase 1 bones are procedural because procedural geometry is **parametric** -- the
 * morphology controls reshape it for free, where a fixed mesh set would need blend shapes or a
 * deformation cage.
 *
 * ## Anchoring convention
 *
 * Long-form primitives -- capsule, loft, revolve -- run from the local origin to `+length` along
 * their axis. Blob-form primitives -- box, sphere -- are centred on the origin.
 *
 * This is not arbitrary. A bone's local frame origin sits at a joint centre with the long axis
 * pointing along the shaft, so a capsule anchored at the origin lands exactly where the bone is
 * without a wrapping transform. A skull or a vertebral body has no such axis, and centring is what
 * a reader expects. Each primitive states its own convention, and the tests assert it.
 *
 * ## Provenance
 *
 * ADR-009 and CONTRIBUTING rule 5: profile curves must come from cited textual descriptions or
 * published dimensions. They must **not** be traced from licensed mesh geometry. Meshes render.
 * They do not measure.
 */

import type { Axis } from '@bs-humany/hsdl';
import { place } from './axis.js';
import {
  type MeshBuilder,
  type MeshData,
  type TessellationQuality,
  createBuilder,
  finish,
} from './types.js';

const TAU = Math.PI * 2;

function pushVertex(
  builder: MeshBuilder,
  position: readonly [number, number, number],
  normal: readonly [number, number, number],
): number {
  const index = builder.positions.length / 3;
  builder.positions.push(position[0], position[1], position[2]);
  builder.normals.push(normal[0], normal[1], normal[2]);
  return index;
}

function pushTriangle(builder: MeshBuilder, a: number, b: number, c: number): void {
  builder.indices.push(a, b, c);
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z);
  if (length < 1e-12) return [0, 1, 0];
  return [x / length, y / length, z / length];
}

/**
 * A capsule, optionally tapered.
 *
 * Runs from the origin to `+length` along `axis`, with hemispherical caps of `radiusProximal` at
 * the far end and `radiusDistal` at the origin. Most long bones taper, so the two radii differ.
 *
 * The shaft is a cone frustum rather than a true tangent surface between the two cap spheres. The
 * exact tangent capsule is a slightly narrower waist; at the radii bones actually have, the
 * difference is well under a millimetre and invisible, and the frustum keeps the generator simple
 * enough to be obviously correct.
 */
export function capsule(
  length: number,
  radiusProximal: number,
  radiusDistal: number,
  axis: Axis,
  quality: TessellationQuality,
): MeshData {
  if (!(length > 0)) throw new Error(`Capsule length must be positive, got ${length}.`);
  if (!(radiusProximal > 0) || !(radiusDistal > 0)) {
    throw new Error(
      `Capsule radii must be positive, got proximal ${radiusProximal}, distal ${radiusDistal}.`,
    );
  }

  const builder = createBuilder();
  const radial = Math.max(3, quality.radial);
  const caps = Math.max(1, quality.cap);

  // Slope of the frustum wall, needed so the shaft normals tilt correctly on a tapered capsule.
  // Without this a tapered bone lights as though it were a cylinder, which reads as a subtle
  // banding artefact rather than as an obvious error.
  const slope = (radiusProximal - radiusDistal) / length;
  const wallScale = 1 / Math.hypot(1, slope);

  const ringIndices: number[][] = [];

  // Distal hemisphere, below the origin.
  for (let ring = caps; ring >= 1; ring--) {
    const phi = (ring / caps) * (Math.PI / 2);
    const along = -Math.sin(phi) * radiusDistal;
    const ringRadius = Math.cos(phi) * radiusDistal;
    ringIndices.push(
      emitRing(builder, axis, along, ringRadius, radial, (u, v) =>
        normalize3(u, -Math.sin(phi) * radiusDistal, v),
      ),
    );
  }

  // Shaft: two rings are enough, since the wall is ruled.
  ringIndices.push(
    emitRing(builder, axis, 0, radiusDistal, radial, (u, v) =>
      normalize3(u * wallScale, slope * wallScale * Math.hypot(u, v), v * wallScale),
    ),
  );
  ringIndices.push(
    emitRing(builder, axis, length, radiusProximal, radial, (u, v) =>
      normalize3(u * wallScale, slope * wallScale * Math.hypot(u, v), v * wallScale),
    ),
  );

  // Proximal hemisphere, beyond `length`.
  for (let ring = 1; ring <= caps; ring++) {
    const phi = (ring / caps) * (Math.PI / 2);
    const along = length + Math.sin(phi) * radiusProximal;
    const ringRadius = Math.cos(phi) * radiusProximal;
    ringIndices.push(
      emitRing(builder, axis, along, ringRadius, radial, (u, v) =>
        normalize3(u, Math.sin(phi) * radiusProximal, v),
      ),
    );
  }

  stitchRings(builder, ringIndices, radial);
  return finish(builder);
}

/**
 * Emit one ring of `radial` vertices at `along` with radius `ringRadius`.
 *
 * A degenerate ring -- radius zero, at a pole -- still emits the full vertex count. Collapsing it
 * to a single vertex would make the stitching a special case for no benefit: the duplicate
 * vertices cost nothing visible and keep the topology uniform.
 */
function emitRing(
  builder: MeshBuilder,
  axis: Axis,
  along: number,
  ringRadius: number,
  radial: number,
  normalAt: (u: number, v: number) => [number, number, number],
): number[] {
  const indices: number[] = [];
  for (let i = 0; i < radial; i++) {
    const theta = (i / radial) * TAU;
    const u = Math.cos(theta) * ringRadius;
    const v = Math.sin(theta) * ringRadius;
    const unitU = Math.cos(theta);
    const unitV = Math.sin(theta);
    const normalCanonical = normalAt(unitU, unitV);
    indices.push(
      pushVertex(
        builder,
        place(axis, along, u, v),
        place(axis, normalCanonical[1], normalCanonical[0], normalCanonical[2]),
      ),
    );
  }
  return indices;
}

/** Connect consecutive rings with quads, split into triangles. */
function stitchRings(builder: MeshBuilder, rings: readonly number[][], radial: number): void {
  for (let r = 0; r + 1 < rings.length; r++) {
    const lower = rings[r];
    const upper = rings[r + 1];
    if (!lower || !upper) continue;
    for (let i = 0; i < radial; i++) {
      const next = (i + 1) % radial;
      const a = lower[i];
      const b = lower[next];
      const c = upper[next];
      const d = upper[i];
      if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
      pushTriangle(builder, a, b, c);
      pushTriangle(builder, a, c, d);
    }
  }
}

/**
 * A sphere, centred on the origin.
 */
export function sphere(radius: number, quality: TessellationQuality): MeshData {
  if (!(radius > 0)) throw new Error(`Sphere radius must be positive, got ${radius}.`);

  const builder = createBuilder();
  const radial = Math.max(3, quality.radial);
  const rings = Math.max(2, quality.cap * 2);

  const ringIndices: number[][] = [];
  for (let ring = 0; ring <= rings; ring++) {
    const phi = (ring / rings) * Math.PI - Math.PI / 2;
    const along = Math.sin(phi) * radius;
    const ringRadius = Math.cos(phi) * radius;
    ringIndices.push(
      emitRing(builder, 'y', along, ringRadius, radial, (u, v) =>
        normalize3(u * Math.cos(phi), Math.sin(phi), v * Math.cos(phi)),
      ),
    );
  }
  stitchRings(builder, ringIndices, radial);
  return finish(builder);
}

/**
 * An axis-aligned box, centred on the origin.
 *
 * Vertices are duplicated per face so the normals are flat. Sharing them would smooth the corners,
 * which on a vertebral body or a carpal reads as a soap bar rather than a bone.
 */
export function box(sizeX: number, sizeY: number, sizeZ: number): MeshData {
  for (const [name, value] of [
    ['x', sizeX],
    ['y', sizeY],
    ['z', sizeZ],
  ] as const) {
    if (!(value > 0)) throw new Error(`Box size ${name} must be positive, got ${value}.`);
  }

  const builder = createBuilder();
  const hx = sizeX / 2;
  const hy = sizeY / 2;
  const hz = sizeZ / 2;

  const faces: ReadonlyArray<{
    readonly normal: readonly [number, number, number];
    readonly corners: ReadonlyArray<readonly [number, number, number]>;
  }> = [
    {
      normal: [0, 0, 1],
      corners: [
        [-hx, -hy, hz],
        [hx, -hy, hz],
        [hx, hy, hz],
        [-hx, hy, hz],
      ],
    },
    {
      normal: [0, 0, -1],
      corners: [
        [hx, -hy, -hz],
        [-hx, -hy, -hz],
        [-hx, hy, -hz],
        [hx, hy, -hz],
      ],
    },
    {
      normal: [1, 0, 0],
      corners: [
        [hx, -hy, hz],
        [hx, -hy, -hz],
        [hx, hy, -hz],
        [hx, hy, hz],
      ],
    },
    {
      normal: [-1, 0, 0],
      corners: [
        [-hx, -hy, -hz],
        [-hx, -hy, hz],
        [-hx, hy, hz],
        [-hx, hy, -hz],
      ],
    },
    {
      normal: [0, 1, 0],
      corners: [
        [-hx, hy, hz],
        [hx, hy, hz],
        [hx, hy, -hz],
        [-hx, hy, -hz],
      ],
    },
    {
      normal: [0, -1, 0],
      corners: [
        [-hx, -hy, -hz],
        [hx, -hy, -hz],
        [hx, -hy, hz],
        [-hx, -hy, hz],
      ],
    },
  ];

  for (const face of faces) {
    const base = builder.positions.length / 3;
    for (const corner of face.corners) {
      pushVertex(builder, corner, face.normal);
    }
    pushTriangle(builder, base, base + 1, base + 2);
    pushTriangle(builder, base, base + 2, base + 3);
  }

  return finish(builder);
}

/**
 * A surface of revolution, running from the origin to `+length` along `axis`.
 *
 * The profile is a list of `(at, radius)` pairs measured along the axis. Used for round-ish bones
 * whose silhouette is a single curve -- the cranial vault, a vertebral body.
 */
export function revolve(
  profile: ReadonlyArray<{ readonly at: number; readonly radius: number }>,
  axis: Axis,
  quality: TessellationQuality,
  segments?: number,
): MeshData {
  if (profile.length < 2) {
    throw new Error(`A revolved profile needs at least two points, got ${profile.length}.`);
  }

  const sorted = [...profile].sort((a, b) => a.at - b.at);
  const radial = Math.max(3, segments ?? quality.radial);
  const builder = createBuilder();
  const ringIndices: number[][] = [];

  for (let i = 0; i < sorted.length; i++) {
    const point = sorted[i];
    if (!point) continue;
    if (point.radius < 0) {
      throw new Error(`Revolved profile radius must be non-negative, got ${point.radius}.`);
    }

    // Slope between neighbouring profile points, so the normal follows the silhouette.
    const previous = sorted[Math.max(0, i - 1)];
    const next = sorted[Math.min(sorted.length - 1, i + 1)];
    const deltaAlong = (next?.at ?? 0) - (previous?.at ?? 0);
    const deltaRadius = (next?.radius ?? 0) - (previous?.radius ?? 0);
    const slope = Math.abs(deltaAlong) < 1e-12 ? 0 : -deltaRadius / deltaAlong;

    ringIndices.push(
      emitRing(builder, axis, point.at, point.radius, radial, (u, v) => normalize3(u, slope, v)),
    );
  }

  stitchRings(builder, ringIndices, radial);
  return finish(builder);
}

/** One resolved loft cross-section, in the plane perpendicular to the axis. */
export interface ResolvedSection {
  readonly at: number;
  /** Cross-section outline, counter-clockwise, in `(u, v)` local coordinates. */
  readonly outline: ReadonlyArray<readonly [number, number]>;
  readonly offset: readonly [number, number];
}

/**
 * Loft a surface through a series of cross-sections.
 *
 * The workhorse for long bones, ribs and the mandible. Section `offset` is what gives a bone its
 * curve -- a femur's anterior bow, a rib's arc -- as a displaced axis rather than a twisted one,
 * which keeps the local frame aligned with the mechanical long axis that joints and inertia are
 * defined against.
 *
 * Every section must have the same number of outline points, so the surface has a well-defined
 * correspondence between consecutive rings. Resampling mismatched outlines would guess at that
 * correspondence and produce a twisted surface.
 */
export function loft(sections: readonly ResolvedSection[], axis: Axis, capped: boolean): MeshData {
  if (sections.length < 2) {
    throw new Error(`A loft needs at least two sections, got ${sections.length}.`);
  }

  const sorted = [...sections].sort((a, b) => a.at - b.at);
  const first = sorted[0];
  if (!first) throw new Error('A loft needs at least two sections.');
  const outlineLength = first.outline.length;

  for (const section of sorted) {
    if (section.outline.length !== outlineLength) {
      throw new Error(
        'Loft sections must all have the same number of outline points. Section at ' +
          `${section.at} has ${section.outline.length}, expected ${outlineLength}. Resampling ` +
          'mismatched outlines would guess at the point correspondence and twist the surface.',
      );
    }
  }

  const builder = createBuilder();
  const ringIndices: number[][] = [];

  for (const section of sorted) {
    const indices: number[] = [];
    for (const point of section.outline) {
      const u = point[0] + section.offset[0];
      const v = point[1] + section.offset[1];
      // Placeholder normal, replaced by the averaging pass below.
      indices.push(pushVertex(builder, place(axis, section.at, u, v), [0, 1, 0]));
    }
    ringIndices.push(indices);
  }

  stitchRings(builder, ringIndices, outlineLength);

  if (capped) {
    capRing(builder, ringIndices[0] ?? [], true);
    capRing(builder, ringIndices[ringIndices.length - 1] ?? [], false);
  }

  recomputeSmoothNormals(builder);
  return finish(builder);
}

/** Close a ring with a triangle fan about its centroid. */
function capRing(builder: MeshBuilder, ring: readonly number[], reverse: boolean): void {
  if (ring.length < 3) return;

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const index of ring) {
    cx += builder.positions[index * 3] ?? 0;
    cy += builder.positions[index * 3 + 1] ?? 0;
    cz += builder.positions[index * 3 + 2] ?? 0;
  }
  const centre = pushVertex(
    builder,
    [cx / ring.length, cy / ring.length, cz / ring.length],
    [0, 1, 0],
  );

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a === undefined || b === undefined) continue;
    if (reverse) pushTriangle(builder, centre, b, a);
    else pushTriangle(builder, centre, a, b);
  }
}

/**
 * Replace normals with area-weighted averages of the adjoining face normals.
 *
 * Area weighting rather than a plain average: a long thin triangle should not sway a vertex normal
 * as much as a large one adjoining the same vertex, and on a lofted bone the triangles vary a lot
 * in size.
 */
export function recomputeSmoothNormals(builder: MeshBuilder): void {
  const count = builder.positions.length / 3;
  const accumulated = new Float64Array(count * 3);

  for (let t = 0; t + 2 < builder.indices.length; t += 3) {
    const ia = builder.indices[t] ?? 0;
    const ib = builder.indices[t + 1] ?? 0;
    const ic = builder.indices[t + 2] ?? 0;

    const ax = builder.positions[ia * 3] ?? 0;
    const ay = builder.positions[ia * 3 + 1] ?? 0;
    const az = builder.positions[ia * 3 + 2] ?? 0;
    const bx = builder.positions[ib * 3] ?? 0;
    const by = builder.positions[ib * 3 + 1] ?? 0;
    const bz = builder.positions[ib * 3 + 2] ?? 0;
    const cx = builder.positions[ic * 3] ?? 0;
    const cy = builder.positions[ic * 3 + 1] ?? 0;
    const cz = builder.positions[ic * 3 + 2] ?? 0;

    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;

    // Un-normalized cross product: its magnitude is twice the triangle area, which is exactly the
    // weighting wanted.
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    for (const index of [ia, ib, ic]) {
      accumulated[index * 3] = (accumulated[index * 3] ?? 0) + nx;
      accumulated[index * 3 + 1] = (accumulated[index * 3 + 1] ?? 0) + ny;
      accumulated[index * 3 + 2] = (accumulated[index * 3 + 2] ?? 0) + nz;
    }
  }

  for (let i = 0; i < count; i++) {
    const [nx, ny, nz] = normalize3(
      accumulated[i * 3] ?? 0,
      accumulated[i * 3 + 1] ?? 0,
      accumulated[i * 3 + 2] ?? 0,
    );
    builder.normals[i * 3] = nx;
    builder.normals[i * 3 + 1] = ny;
    builder.normals[i * 3 + 2] = nz;
  }
}

/**
 * Smooth normals for finished mesh data, e.g. a dataset bone whose pack stores no normals.
 *
 * Same area-weighted averaging as the builder variant above; this one allocates the output.
 */
export function computeSmoothNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const builder = createBuilder();
  builder.positions = Array.from(positions);
  builder.indices = Array.from(indices);
  builder.normals = new Array<number>(positions.length).fill(0);
  recomputeSmoothNormals(builder);
  return new Float32Array(builder.normals);
}
