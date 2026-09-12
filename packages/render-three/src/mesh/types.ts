/**
 * Mesh data, with no rendering library attached.
 *
 * Everything under `mesh/` is pure: it turns an HSDL `GeometryRecipe` into vertex buffers and
 * knows nothing about three.js. The three.js adapter is a thin wrapper one directory up.
 *
 * The split is not ceremony. It means the geometry mathematics -- which is where the bugs are, and
 * which is what morphology reshapes -- can be tested headlessly in CI without a WebGL context, and
 * it leaves the door open for the same recipes to be evaluated somewhere other than a browser.
 */

/** Interleaved-free vertex buffers, in the layout a GPU wants. */
export interface MeshData {
  /** `x, y, z` per vertex. */
  readonly positions: Float32Array;
  /** Unit normal per vertex, same count as `positions`. */
  readonly normals: Float32Array;
  /** Triangle indices, counter-clockwise when seen from outside. */
  readonly indices: Uint32Array;
}

export function vertexCount(mesh: MeshData): number {
  return mesh.positions.length / 3;
}

export function triangleCount(mesh: MeshData): number {
  return mesh.indices.length / 3;
}

/**
 * Tessellation density.
 *
 * The platform floor is that `L0` runs on mobile (ADR-010), so triangle budget is a real
 * constraint rather than an afterthought. A 206-bone skeleton at 32 radial segments per long bone
 * is a lot of triangles for a phone, and most of them are invisible at the scale a whole skeleton
 * is viewed.
 */
export interface TessellationQuality {
  /** Segments around a capsule, sphere or revolved profile. */
  readonly radial: number;
  /** Rings from pole to equator on a hemispherical cap. */
  readonly cap: number;
  /** Subdivisions between consecutive loft sections. 1 leaves the authored sections alone. */
  readonly loftSubdivision: number;
}

export const QUALITY_LOW: TessellationQuality = Object.freeze({
  radial: 8,
  cap: 2,
  loftSubdivision: 1,
});

export const QUALITY_MEDIUM: TessellationQuality = Object.freeze({
  radial: 16,
  cap: 4,
  loftSubdivision: 1,
});

export const QUALITY_HIGH: TessellationQuality = Object.freeze({
  radial: 32,
  cap: 8,
  loftSubdivision: 2,
});

/** A mesh under construction. Plain arrays, converted to typed arrays once at the end. */
export interface MeshBuilder {
  positions: number[];
  normals: number[];
  indices: number[];
}

export function createBuilder(): MeshBuilder {
  return { positions: [], normals: [], indices: [] };
}

export function finish(builder: MeshBuilder): MeshData {
  return {
    positions: new Float32Array(builder.positions),
    normals: new Float32Array(builder.normals),
    indices: new Uint32Array(builder.indices),
  };
}

export const EMPTY_MESH: MeshData = Object.freeze({
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  indices: new Uint32Array(0),
});
