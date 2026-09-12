/**
 * Evaluating an HSDL `GeometryRecipe` into mesh data.
 *
 * This is the join between the declarative model and something drawable. Every dimension in a
 * recipe is a `ScalarExpr` over morphology parameters, so the same recipe produces a different
 * bone for every position of the sliders -- which is the whole reason ADR-005 chose procedural
 * geometry over a fixed mesh set.
 */

import {
  IDENTITY_TRANSFORM,
  type Transform,
  type Vec3,
  rotate,
  transformPoint,
  vec3,
} from '@bs-humany/frames';
import {
  type ExprContext,
  type GeometryRecipe,
  type LoftSection,
  type Profile,
  type ScalarExpr,
  evaluate as evaluateExpr,
} from '@bs-humany/hsdl';
import { DEFAULT_AXIS } from './axis.js';
import { type ResolvedSection, box, capsule, loft, revolve, sphere } from './primitives.js';
import {
  type MeshData,
  QUALITY_MEDIUM,
  type TessellationQuality,
  createBuilder,
  finish,
} from './types.js';

const TAU = Math.PI * 2;

export interface EvaluateOptions {
  readonly quality?: TessellationQuality;
  /** Points used to approximate an elliptical cross-section in a loft. */
  readonly ellipseSegments?: number;
}

/**
 * Turn a recipe into mesh data.
 *
 * Throws rather than producing a degenerate mesh when a dimension resolves to something
 * impossible. A bone that silently renders as a zero-length sliver is far harder to trace back to
 * its cause than an error naming the recipe that failed.
 */
export function evaluateRecipe(
  recipe: GeometryRecipe,
  context: ExprContext,
  options: EvaluateOptions = {},
): MeshData {
  const quality = options.quality ?? QUALITY_MEDIUM;
  const ellipseSegments = options.ellipseSegments ?? quality.radial;
  const value = (expr: ScalarExpr) => evaluateExpr(expr, context);

  switch (recipe.kind) {
    case 'capsule': {
      const length = value(recipe.length);
      const radiusProximal = value(recipe.radiusProximal);
      const radiusDistal =
        recipe.radiusDistal === undefined ? radiusProximal : value(recipe.radiusDistal);
      return capsule(length, radiusProximal, radiusDistal, recipe.axis ?? DEFAULT_AXIS, quality);
    }

    case 'sphere':
      return sphere(value(recipe.radius), quality);

    case 'box':
      return box(value(recipe.size.x), value(recipe.size.y), value(recipe.size.z));

    case 'revolve':
      return revolve(
        recipe.profile.map((point) => ({ at: value(point.at), radius: value(point.radius) })),
        recipe.axis ?? DEFAULT_AXIS,
        quality,
        recipe.segments,
      );

    case 'loft': {
      const sections = recipe.sections.map((section) =>
        resolveSection(section, value, ellipseSegments),
      );
      harmonizeOutlines(sections);
      return loft(sections, recipe.axis ?? DEFAULT_AXIS, recipe.capped ?? true);
    }

    case 'composite': {
      const parts = recipe.parts.map((part) => ({
        mesh: evaluateRecipe(part.recipe, context, options),
        transform: part.transform ? toTransform(part.transform, value) : IDENTITY_TRANSFORM,
      }));
      return mergeMeshes(parts);
    }
  }
}

function toTransform(
  data: {
    translation: { x: ScalarExpr; y: ScalarExpr; z: ScalarExpr };
    rotation: { x: number; y: number; z: number; w: number };
  },
  value: (expr: ScalarExpr) => number,
): Transform {
  return {
    translation: vec3(
      value(data.translation.x),
      value(data.translation.y),
      value(data.translation.z),
    ),
    rotation: data.rotation,
  };
}

function resolveSection(
  section: LoftSection,
  value: (expr: ScalarExpr) => number,
  ellipseSegments: number,
): ResolvedSection {
  const twist = section.twist === undefined ? 0 : value(section.twist);
  const outline = resolveProfile(section.profile, value, ellipseSegments).map(
    ([u, v]): readonly [number, number] => {
      if (twist === 0) return [u, v];
      const cos = Math.cos(twist);
      const sin = Math.sin(twist);
      return [u * cos - v * sin, u * sin + v * cos];
    },
  );

  return {
    at: value(section.at),
    outline,
    offset: section.offset ? [value(section.offset.u), value(section.offset.v)] : [0, 0],
  };
}

function resolveProfile(
  profile: Profile,
  value: (expr: ScalarExpr) => number,
  ellipseSegments: number,
): Array<readonly [number, number]> {
  if (profile.kind === 'polygon') {
    return profile.points.map((point): readonly [number, number] => [
      value(point.u),
      value(point.v),
    ]);
  }

  const radiusA = value(profile.radiusA);
  const radiusB = value(profile.radiusB);
  const segments = Math.max(3, ellipseSegments);
  const points: Array<readonly [number, number]> = [];
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * TAU;
    points.push([Math.cos(theta) * radiusA, Math.sin(theta) * radiusB]);
  }
  return points;
}

/**
 * Bring every section's outline to the same point count, by resampling ellipses.
 *
 * A recipe may reasonably mix an elliptical section with a polygonal one -- a shaft that becomes a
 * flared end. Ellipses are resampled to match, since a sampled ellipse has no privileged point
 * count. Polygons are **not** resampled: their points are authored, carry meaning, and guessing a
 * correspondence between two different polygons is how a lofted surface ends up twisted.
 */
function harmonizeOutlines(sections: ResolvedSection[]): void {
  const counts = new Set(sections.map((s) => s.outline.length));
  if (counts.size <= 1) return;

  const target = Math.max(...counts);
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (!section || section.outline.length === target) continue;
    sections[i] = { ...section, outline: resampleClosedOutline(section.outline, target) };
  }
}

/** Resample a closed outline to `count` points, evenly in arc length. */
function resampleClosedOutline(
  outline: ReadonlyArray<readonly [number, number]>,
  count: number,
): Array<readonly [number, number]> {
  const n = outline.length;
  if (n === 0) return [];

  const cumulative: number[] = [0];
  for (let i = 0; i < n; i++) {
    const a = outline[i] ?? [0, 0];
    const b = outline[(i + 1) % n] ?? [0, 0];
    cumulative.push((cumulative[i] ?? 0) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const perimeter = cumulative[n] ?? 0;
  if (perimeter <= 0) return Array.from({ length: count }, () => outline[0] ?? [0, 0]);

  const result: Array<readonly [number, number]> = [];
  let segment = 0;
  for (let i = 0; i < count; i++) {
    const target = (i / count) * perimeter;
    while (segment < n - 1 && (cumulative[segment + 1] ?? 0) < target) segment++;
    const start = cumulative[segment] ?? 0;
    const end = cumulative[segment + 1] ?? perimeter;
    const t = end > start ? (target - start) / (end - start) : 0;
    const a = outline[segment] ?? [0, 0];
    const b = outline[(segment + 1) % n] ?? [0, 0];
    result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return result;
}

/**
 * Merge meshes, applying each part's transform.
 *
 * Normals are rotated but not translated -- they are directions, not points. Passing a normal
 * through a point transform is a classic slip that produces lighting which drifts as a body moves.
 */
export function mergeMeshes(
  parts: ReadonlyArray<{ readonly mesh: MeshData; readonly transform: Transform }>,
): MeshData {
  const builder = createBuilder();

  for (const part of parts) {
    const base = builder.positions.length / 3;
    const count = part.mesh.positions.length / 3;

    for (let i = 0; i < count; i++) {
      const position: Vec3 = vec3(
        part.mesh.positions[i * 3] ?? 0,
        part.mesh.positions[i * 3 + 1] ?? 0,
        part.mesh.positions[i * 3 + 2] ?? 0,
      );
      const normal: Vec3 = vec3(
        part.mesh.normals[i * 3] ?? 0,
        part.mesh.normals[i * 3 + 1] ?? 0,
        part.mesh.normals[i * 3 + 2] ?? 0,
      );

      const worldPosition = transformPoint(part.transform, position);
      const worldNormal = rotate(part.transform.rotation, normal);

      builder.positions.push(worldPosition.x, worldPosition.y, worldPosition.z);
      builder.normals.push(worldNormal.x, worldNormal.y, worldNormal.z);
    }

    for (const index of part.mesh.indices) {
      builder.indices.push(base + index);
    }
  }

  return finish(builder);
}
