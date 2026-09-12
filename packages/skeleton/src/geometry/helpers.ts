/**
 * Shape helpers shared by the regional recipe builders.
 *
 * ADR-009 and CONTRIBUTING rule 5: every profile here comes from published proportions or from
 * textual anatomical description. **None of it is traced from mesh geometry.** Meshes render; they
 * do not measure.
 *
 * The quality bar for Phase 1 (spec section 5.4) is that a person familiar with anatomy should
 * recognize each bone and judge the proportions credible. Not medical-illustration quality.
 */

import { type GeometryRecipe, type ScalarExpr, type TransformExpr, mul } from '@bs-humany/hsdl';

export const NO_ROTATION = { x: 0, y: 0, z: 0, w: 1 } as const;

/** A transform with only a translation, all three components expressions. */
export function placed(x: ScalarExpr, y: ScalarExpr, z: ScalarExpr): TransformExpr {
  return { translation: { x, y, z }, rotation: NO_ROTATION };
}

/** A transform with a translation and a rotation about a named axis. */
export function placedRotated(
  x: ScalarExpr,
  y: ScalarExpr,
  z: ScalarExpr,
  axis: readonly [number, number, number],
  angle: number,
): TransformExpr {
  const half = angle / 2;
  const s = Math.sin(half);
  const length = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  return {
    translation: { x, y, z },
    rotation: {
      x: (axis[0] / length) * s,
      y: (axis[1] / length) * s,
      z: (axis[2] / length) * s,
      w: Math.cos(half),
    },
  };
}

/** Scale an expression by a constant. */
export const times = (fraction: number, expr: ScalarExpr): ScalarExpr => mul(fraction, expr);

export interface LongBoneOptions {
  /** Distance between the two joint centres. The bone runs from the origin up `+Y` by this much. */
  readonly length: ScalarExpr;
  /** Radius at mid-shaft, where a long bone is narrowest. */
  readonly shaftRadius: ScalarExpr;
  /** Radius of the proximal expansion, at `+length`. */
  readonly proximalRadius: ScalarExpr;
  /** Radius of the distal expansion, at the origin. */
  readonly distalRadius: ScalarExpr;
  /**
   * Anterior bow at mid-shaft, as a displacement of the section centre.
   *
   * The femur and the radius both bow anteriorly, and the bow is what stops a rendered long bone
   * reading as a dowel. Displacing the section centre rather than bending the axis keeps the local
   * frame aligned with the mechanical long axis that joints and inertia are defined against.
   */
  readonly bow?: ScalarExpr;
  /** Medio-lateral flattening of the shaft. 1 is circular; below 1 is flattened side to side. */
  readonly flatten?: number;
}

/**
 * A long bone: narrow shaft with expanded ends.
 *
 * Five sections -- distal head, distal metaphysis, mid-shaft, proximal metaphysis, proximal head --
 * which is the smallest number that reads as a bone rather than as a capsule. The metaphyseal
 * sections are what give the characteristic flare; without them the ends look glued on.
 */
export function longBone(options: LongBoneOptions): GeometryRecipe {
  const { length, shaftRadius, proximalRadius, distalRadius } = options;
  const flatten = options.flatten ?? 1;
  const bow = options.bow;

  const section = (fraction: number, radius: ScalarExpr, offsetV?: ScalarExpr) => ({
    at: times(fraction, length),
    profile: {
      kind: 'ellipse' as const,
      radiusA: times(flatten, radius),
      radiusB: radius,
    },
    ...(offsetV ? { offset: { u: 0 as ScalarExpr, v: offsetV } } : {}),
  });

  return {
    kind: 'loft',
    capped: true,
    sections: [
      section(0, times(0.82, distalRadius)),
      section(0.14, times(0.72, distalRadius)),
      // Anterior is -Z, and the loft's `v` maps to the axis-perpendicular direction that becomes
      // Z for a Y-axis loft, so an anterior bow is a negative v offset.
      section(0.5, shaftRadius, bow ? mul(-1, bow) : undefined),
      section(0.86, times(0.72, proximalRadius)),
      section(1, times(0.82, proximalRadius)),
    ],
  };
}

/** A short bone: a squat capsule. Carpals, tarsals, phalanges. */
export function shortBone(
  length: ScalarExpr,
  radius: ScalarExpr,
  distalRadius?: ScalarExpr,
): GeometryRecipe {
  return {
    kind: 'capsule',
    length,
    radiusProximal: radius,
    ...(distalRadius ? { radiusDistal: distalRadius } : {}),
  };
}

/** A flat plate, for the scapula, the ilium and the cranial vault bones. */
export function plate(
  width: ScalarExpr,
  height: ScalarExpr,
  thickness: ScalarExpr,
): GeometryRecipe {
  return { kind: 'box', size: { x: width, y: height, z: thickness } };
}

/**
 * A vertebra: body, plus the posterior arch and processes.
 *
 * Four parts, which is the minimum that reads as a vertebra from the side -- the profile of the
 * spinous processes down the back is most of what makes a rendered spine recognisable.
 */
export function vertebra(options: {
  readonly bodyWidth: ScalarExpr;
  readonly bodyHeight: ScalarExpr;
  readonly bodyDepth: ScalarExpr;
  readonly spinousLength: ScalarExpr;
  readonly transverseLength: ScalarExpr;
  /** Downward tilt of the spinous process, radians. Steep in the thoracic spine. */
  readonly spinousTilt?: number;
}): GeometryRecipe {
  const {
    bodyWidth,
    bodyHeight,
    bodyDepth,
    spinousLength,
    transverseLength,
    spinousTilt = 0,
  } = options;

  return {
    kind: 'composite',
    parts: [
      {
        name: 'corpus',
        recipe: {
          kind: 'revolve',
          axis: 'y',
          segments: 12,
          profile: [
            { at: times(-0.5, bodyHeight), radius: times(0.5, bodyWidth) },
            { at: times(-0.25, bodyHeight), radius: times(0.44, bodyWidth) },
            { at: times(0.25, bodyHeight), radius: times(0.44, bodyWidth) },
            { at: times(0.5, bodyHeight), radius: times(0.5, bodyWidth) },
          ],
        },
      },
      {
        name: 'arcus',
        recipe: plate(times(0.9, bodyWidth), times(0.6, bodyHeight), times(0.35, bodyDepth)),
        transform: placed(0, 0, times(0.62, bodyDepth)),
      },
      {
        name: 'processus_spinosus',
        recipe: shortBone(spinousLength, times(0.16, bodyWidth), times(0.1, bodyWidth)),
        transform: placedRotated(
          0,
          0,
          times(0.7, bodyDepth),
          [1, 0, 0],
          -Math.PI / 2 - spinousTilt,
        ),
      },
      {
        name: 'processus_transversus_r',
        recipe: shortBone(transverseLength, times(0.13, bodyWidth)),
        transform: placedRotated(
          times(0.45, bodyWidth),
          0,
          times(0.4, bodyDepth),
          [0, 0, 1],
          -Math.PI / 2,
        ),
      },
      {
        name: 'processus_transversus_l',
        recipe: shortBone(transverseLength, times(0.13, bodyWidth)),
        transform: placedRotated(
          times(-0.45, bodyWidth),
          0,
          times(0.4, bodyDepth),
          [0, 0, 1],
          Math.PI / 2,
        ),
      },
    ],
  };
}

/**
 * A curved rod built as a chain of capsules along a circular arc.
 *
 * Ribs sweep through roughly 150 degrees, which a loft along a straight axis cannot represent: the
 * section planes would stay perpendicular to the wrong direction. A chain of short capsules placed
 * around the arc is simple, obviously correct, and cheap.
 *
 * The arc lies in the plane containing the `+X` and `+Z` axes -- the transverse plane -- sweeping
 * from posterior toward anterior, with an optional downward slope.
 */
export function arc(options: {
  readonly radius: ScalarExpr;
  readonly startAngle: number;
  readonly endAngle: number;
  readonly segments: number;
  readonly thickness: ScalarExpr;
  /** Total drop over the arc, applied linearly. Ribs slope downward as they run forward. */
  readonly drop?: ScalarExpr;
  /** Fraction of `radius` used for the medio-lateral semi-axis, flattening the arc. */
  readonly flatten?: number;
}): GeometryRecipe {
  const { radius, startAngle, endAngle, segments, thickness } = options;
  const flatten = options.flatten ?? 1;
  const drop = options.drop;

  const parts = [];
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const a0 = startAngle + (endAngle - startAngle) * t0;
    const a1 = startAngle + (endAngle - startAngle) * t1;
    const mid = (a0 + a1) / 2;

    // Chord length for this sub-arc, as a fraction of the radius.
    const chord = 2 * Math.sin(Math.abs(a1 - a0) / 2);

    const x = Math.cos(mid) * flatten;
    const z = Math.sin(mid);
    const dropFraction = (t0 + t1) / 2;

    // The capsule runs along its own +Y, so it is rotated to lie along the arc tangent. The
    // tangent at `mid` is perpendicular to the radius.
    parts.push({
      name: `segment_${i}`,
      recipe: shortBone(times(chord, radius), thickness),
      transform: placedRotated(
        times(x, radius),
        drop ? mul(dropFraction, mul(-1, drop)) : 0,
        times(z, radius),
        [0, 1, 0],
        0,
      ),
    });
  }

  // Each capsule is oriented along the arc tangent by composing the placement rotation below.
  return {
    kind: 'composite',
    parts: parts.map((part, i) => {
      const t0 = i / segments;
      const t1 = (i + 1) / segments;
      const mid = startAngle + (endAngle - startAngle) * ((t0 + t1) / 2);
      const tangent = mid + Math.PI / 2;
      return {
        ...part,
        transform: {
          translation: part.transform.translation,
          // Rotate the capsule's +Y axis onto the arc tangent, which lies in the XZ plane.
          rotation: rotationFromYToXZ(tangent),
        },
      };
    }),
  };
}

/**
 * Compose two axis-angle rotations into one placement.
 *
 * Needed wherever a bone has to be both flipped and swung -- the thumb's metacarpal is turned to
 * hang downward *and* rotated out of the plane of the other four at the saddle joint.
 */
export function placedRotated2(
  x: ScalarExpr,
  y: ScalarExpr,
  z: ScalarExpr,
  first: { axis: readonly [number, number, number]; angle: number },
  second: { axis: readonly [number, number, number]; angle: number },
): TransformExpr {
  const a = axisAngleQuat(first.axis, first.angle);
  const b = axisAngleQuat(second.axis, second.angle);
  return { translation: { x, y, z }, rotation: multiplyQuat(a, b) };
}

function axisAngleQuat(axis: readonly [number, number, number], angle: number) {
  const length = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const half = angle / 2;
  const s = Math.sin(half);
  return {
    x: (axis[0] / length) * s,
    y: (axis[1] / length) * s,
    z: (axis[2] / length) * s,
    w: Math.cos(half),
  };
}

function multiplyQuat(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number },
) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/**
 * A wedge of the cranial vault.
 *
 * The vault is close to an ellipsoid, and each of its bones -- frontal, the two parietals, the
 * occipital -- occupies one region of that surface. Each is therefore built as a solid lofted
 * along `+Y` whose elliptical sections follow the ellipsoid's profile, then offset into its own
 * quadrant. The pieces overlap inside the cranium, where nothing can see them, and their union is
 * the head's silhouette.
 *
 * The earlier attempt lofted a constant-radius section over a short span, which produced a flat
 * disc sticking out of the side of the head rather than a curved vault.
 *
 * `yFrom` and `yTo` are fractions of the vertical semi-axis, in `[-1, 1]`, selecting the band of
 * the ellipsoid this bone covers.
 */
export function vaultWedge(options: {
  /** Semi-axes of the vault ellipsoid: medio-lateral, vertical, antero-posterior. */
  readonly semiAxes: readonly [ScalarExpr, ScalarExpr, ScalarExpr];
  readonly yFrom: number;
  readonly yTo: number;
  /** Scale applied to the section radii, to keep a piece within its own quadrant. */
  readonly widthScale?: number;
  readonly depthScale?: number;
  /** Lateral and antero-posterior displacement of the section centres. */
  readonly offsetU?: ScalarExpr;
  readonly offsetV?: ScalarExpr;
  readonly steps?: number;
}): GeometryRecipe {
  const { semiAxes, yFrom, yTo } = options;
  const widthScale = options.widthScale ?? 1;
  const depthScale = options.depthScale ?? 1;
  const steps = options.steps ?? 5;

  const sections = [];
  for (let i = 0; i <= steps; i++) {
    const t = yFrom + ((yTo - yFrom) * i) / steps;
    // Ellipsoid profile: radius shrinks toward the poles.
    const shrink = Math.sqrt(Math.max(0.04, 1 - t * t));
    sections.push({
      at: times(t, semiAxes[1]),
      profile: {
        kind: 'ellipse' as const,
        radiusA: times(shrink * widthScale, semiAxes[0]),
        radiusB: times(shrink * depthScale, semiAxes[2]),
      },
      ...(options.offsetU || options.offsetV
        ? { offset: { u: options.offsetU ?? 0, v: options.offsetV ?? 0 } }
        : {}),
    });
  }

  return { kind: 'loft', capped: true, sections };
}

/** Quaternion taking `+Y` onto the XZ-plane direction `(cos a, 0, sin a)`. */
function rotationFromYToXZ(angle: number): { x: number; y: number; z: number; w: number } {
  // Target direction.
  const tx = Math.cos(angle);
  const tz = Math.sin(angle);
  // Rotation axis is Y x target, normalized; the angle is 90 degrees since target is horizontal.
  const ax = -tz;
  const az = tx;
  const half = Math.PI / 4;
  const s = Math.sin(half);
  return { x: ax * s, y: 0, z: az * s, w: Math.cos(half) };
}
