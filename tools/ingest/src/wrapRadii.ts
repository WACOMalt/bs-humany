/**
 * Radii of the bone surfaces a tendon rides over, measured from the meshes.
 *
 *   pnpm --filter @bs-humany/ingest wrap-radii [dataDir]
 *
 * A muscle crossing a joint does not run in a straight line from one attachment to the other: it
 * lies against the bone at the joint and turns over it. How far that surface stands off the joint
 * axis is the muscle's moment arm, and it is the difference between a muscle that can do work and
 * one that cannot. Measured with straight-line paths, the triceps moment arm falls from 20 mm at
 * full extension to zero at about 2 rad of flexion and then *reverses*, which makes the muscle a
 * flexor in deep flexion -- the failure muscle spec 13.2 calls a hard one.
 *
 * ## What is measured, and what is not
 *
 * Only the radius. Where the cylinder goes is not a mesh fact and is not measured here: the
 * surface must be coaxial with the joint, because that is what makes the moment arm constant
 * through the range, so the skeleton places it on the joint's own axis and centre. If this tool
 * fitted a free axis too, the two would disagree by a degree or so and the moment arm would
 * acquire a wobble with no anatomy behind it.
 *
 * So the measurement is: how far from the joint axis does the articular surface stand? Taken as
 * the distance from that axis to each vertex of the surface, reported as a median with the
 * spread around it, so the quality of each measurement is on the record the way the articular
 * sphere fits' residuals are.
 *
 * The axis used here is the line through the two epicondyle markers, which is the axis the elbow
 * joint is built on (Wu 2005, 3.3). Reading the radius in that same plane is what keeps the two
 * consistent.
 *
 * Reads the packed meshes rather than the source export, so it re-runs without the 500 MB FBX.
 * Offline by design: no runtime fitting.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.argv[2] ?? join(HERE, '../../../packages/assets-anatomical/data'));

/** Vertices further than this from the seed marker are not part of the surface being measured. */
export const SEED_RADIUS = 0.022;
/** Minimum vertices for a measurement to be trusted. */
export const MIN_VERTICES = 80;
/**
 * The middle of the distance distribution that counts.
 *
 * An articular surface is not a perfect cylinder: it has a groove down the middle of the trochlea
 * and it runs out at the edges, so the extremes of the distribution are the parts a tendon does
 * not bear on. Taking the middle band leaves the surface the tendon actually rides.
 */
export const TRIM = 0.25;

/**
 * One end of an axis: a marker, or the midpoint of two.
 *
 * The midpoint form is what a joint axis usually needs. The elbow's is the line through the two
 * epicondyles, and the humerus's own long axis runs from the head's centre to the point between
 * them -- which is no marker but is where the bone actually points.
 */
type AxisEnd = string | readonly [string, string];

interface Target {
  readonly bone: string;
  /** What the measured radius is published under. */
  readonly feature: string;
  /** The surface the tendon rides on. */
  readonly seedFeature: string;
  /** How far from the seed a vertex may be and still belong to the surface, metres. */
  readonly seedRadius?: number;
  /**
   * What the radius is a radius *of*, which is not the same question for every surface.
   *
   * `bearing` for a pulley: where a tendon sits on the surface, which is the middle of the
   * distance distribution. `enclosing` for a shaft: where the bone *ends*, which is near the top
   * of it, because a muscle lying along a bone lies outside all of it and not outside its average.
   *
   * Using the bearing statistic for a shaft is what made the biceps graze the cylinder instead of
   * lying on it: the path switched three times between hugging the bone and cutting through it
   * across a single sweep of the elbow, which reads as the muscle flicking from side to side.
   */
  readonly statistic?: 'bearing' | 'enclosing';
  /** The axis the radius is measured about. */
  readonly axis: readonly [AxisEnd, AxisEnd];
  readonly description: string;
}

const TARGETS: readonly Target[] = [
  {
    bone: 'humerus',
    feature: 'Trochlea_of_humerus__wrap_radius',
    seedFeature: 'Trochlea_of_humerus',
    axis: ['Medial_epicondyle_of_humerus', 'Lateral_epicondyle_of_humerus'],
    description:
      'Radius of the humeral trochlea about the epicondylar axis: the pulley the elbow ' +
      'flexors and extensors turn over (Wu 2005, 3.3 for the axis)',
  },
  {
    // The knee's pulley. The hamstrings and the two heads of gastrocnemius run behind the joint
    // and turn over the back of the femoral condyles; without a surface there their paths cut the
    // corner as the knee closes, and the knee closes further than any other joint in the body.
    //
    // Coaxial with the joint, for the reason the trochlea is: the condyles sweep about the knee's
    // own flexion axis, which is the line through the femoral epicondyles (Wu 2002, 2.3).
    bone: 'femur',
    feature: 'Condyles_of_femur__wrap_radius',
    seedFeature: 'Intercondylar_fossa',
    // The condyles are wide: a seed at the fossa between them has to reach both.
    seedRadius: 0.035,
    // A tendon lies outside the condyles rather than bearing in a groove on them, so the radius
    // is where the bone ends rather than the middle of its distance distribution.
    statistic: 'enclosing',
    axis: ['Medial_epicondyle_of_femur', 'Lateral_epicondyle_of_femur'],
    description:
      'Radius of the femoral condyles about the epicondylar axis: what the knee flexors turn ' +
      'over (Wu 2002, 2.3 for the axis)',
  },
  {
    bone: 'humerus',
    feature: 'Body_of_humerus__wrap_radius',
    seedFeature: 'Deltoid_tuberosity',
    // Generous: the shaft is long, and a radius taken from one narrow band of it would be a
    // measurement of that band rather than of the bone a muscle lies along.
    seedRadius: 0.07,
    statistic: 'enclosing',
    axis: ['Head_of_humerus', ['Medial_epicondyle_of_humerus', 'Lateral_epicondyle_of_humerus']],
    description:
      "Radius of the humeral shaft about the bone's own long axis: what the flexors lie in " +
      'front of and the extensors behind, rather than passing through (Wu 2005, 2.3.4 for the ' +
      'axis)',
  },
];

/*
 * The capitulum is deliberately absent.
 *
 * It is the other half of the elbow's articular surface and a muscle inserting on the radius
 * arguably turns over it rather than over the trochlea. Two reasons it is not measured here. It
 * is small: only 60 vertices lie within the seed radius, below what makes a measurement worth
 * trusting. And the path solver takes one surface per span, so a second surface at the same joint
 * could not be used by the same muscle without the multi-surface solve of N1.5. One pulley at the
 * elbow is what the geometry supports and what the moment arms need.
 */

export interface WrapRadius {
  readonly bone: string;
  readonly feature: string;
  readonly description: string;
  /** Metres, at the dataset stature. */
  readonly radius: number;
  /** Vertices the measurement is over, after trimming. */
  readonly vertices: number;
  /** Half the width of the middle band, metres: how cylindrical the surface actually is. */
  readonly spread: number;
  /**
   * Half the surface's extent along the axis, metres.
   *
   * A finite cylinder, which the geodesic solver respects: a tendon whose tangent point would
   * fall past the rim has slipped off, and a surface it has slipped off does not constrain the
   * path. Measuring the extent rather than guessing it is what keeps that a real answer instead
   * of an artefact of a number somebody picked.
   */
  readonly halfLength: number;
  readonly rule: string;
}

export interface WrapRadiusTable {
  readonly format: 'bs-humany.wrap-radii/1';
  readonly generatedAt: string;
  readonly dataset: unknown;
  readonly radii: readonly WrapRadius[];
}

/** Perpendicular distance from a point to a line through `origin` with unit direction `axis`. */
export function distanceToAxis(
  point: readonly [number, number, number],
  origin: readonly [number, number, number],
  axis: readonly [number, number, number],
): number {
  const dx = point[0] - origin[0];
  const dy = point[1] - origin[1];
  const dz = point[2] - origin[2];
  const along = dx * axis[0] + dy * axis[1] + dz * axis[2];
  return Math.hypot(dx - axis[0] * along, dy - axis[1] * along, dz - axis[2] * along);
}

/**
 * The radius of a surface about an axis, as the middle of the distance distribution.
 *
 * A median rather than a mean, and a trimmed band rather than the whole set, because the tails
 * are the parts of the bone the tendon never touches: the trochlear groove pulls the low tail in
 * and the flare at the edges pushes the high tail out. What a tendon bears on is the middle.
 */
export function trimmedRadius(distances: number[]): { radius: number; spread: number } {
  const sorted = [...distances].sort((a, b) => a - b);
  const low = Math.floor(sorted.length * TRIM);
  const high = Math.ceil(sorted.length * (1 - TRIM));
  const band = sorted.slice(low, high);
  const middle = band[Math.floor(band.length / 2)] ?? 0;
  return {
    radius: middle,
    spread: ((band[band.length - 1] ?? 0) - (band[0] ?? 0)) / 2,
  };
}

/**
 * The percentile of the distance distribution an enclosing radius is read at.
 *
 * Not the maximum. A bone has a few vertices further out than the rest -- a tubercle, a ridge, a
 * stray point on the flare at one end -- and a cylinder sized to the furthest of them would stand
 * well clear of the shaft everywhere else, holding muscles off the bone rather than against it.
 * The ninetieth is where the shaft proper ends.
 */
export const ENCLOSING_PERCENTILE = 0.9;

/** How far out the bone reaches, for a surface a muscle lies outside rather than bears on. */
export function enclosingRadius(distances: number[]): { radius: number; spread: number } {
  const sorted = [...distances].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * ENCLOSING_PERCENTILE));
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return {
    radius: sorted[at] ?? 0,
    // How much wider the bone's outside is than its middle: what the idealisation is papering
    // over, reported the same way the bearing statistic reports its own spread.
    spread: (sorted[at] ?? 0) - median,
  };
}

const manifest = JSON.parse(readFileSync(join(dataDir, 'manifest.json'), 'utf8')) as {
  readonly dataset: unknown;
  readonly bones: readonly {
    readonly id: string;
    readonly vertexOffset: number;
    readonly vertexCount: number;
  }[];
};
const landmarks = JSON.parse(readFileSync(join(dataDir, 'landmarks.json'), 'utf8')) as Record<
  string,
  Record<string, [number, number, number]>
>;
const bin = readFileSync(join(dataDir, 'skeleton.bin'));
const positions = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
const packed = new Map(manifest.bones.map((b) => [b.id, b]));

const round = (x: number) => Math.round(x * 1e6) / 1e6;
const name = (end: AxisEnd) => (typeof end === 'string' ? end : `midpoint of ${end.join(' and ')}`);
const measured: WrapRadius[] = [];

for (const target of TARGETS) {
  for (const side of ['r', 'l'] as const) {
    const boneId = `${target.bone}_${side}`;
    const bone = packed.get(boneId);
    const seed = landmarks[boneId]?.[target.seedFeature];
    const end = (which: AxisEnd): [number, number, number] => {
      if (typeof which === 'string') {
        const p = landmarks[boneId]?.[which];
        if (!p) throw new Error(`${boneId}: no axis marker '${which}'`);
        return p;
      }
      const p = landmarks[boneId]?.[which[0]];
      const q = landmarks[boneId]?.[which[1]];
      if (!p || !q) throw new Error(`${boneId}: no axis markers '${which[0]}'/'${which[1]}'`);
      return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    };
    if (!bone || !seed) {
      throw new Error(`${boneId}: missing mesh or seed ${target.seedFeature}`);
    }
    const a = end(target.axis[0]);
    const b = end(target.axis[1]);

    const span = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const axis = [(b[0] - a[0]) / span, (b[1] - a[1]) / span, (b[2] - a[2]) / span] as const;
    const origin = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] as const;

    const distances: number[] = [];
    const along: number[] = [];
    for (let i = 0; i < bone.vertexCount; i++) {
      const at = (bone.vertexOffset + i) * 3;
      const p = [
        positions[at] as number,
        positions[at + 1] as number,
        positions[at + 2] as number,
      ] as const;
      const reach = target.seedRadius ?? SEED_RADIUS;
      if (Math.hypot(p[0] - seed[0], p[1] - seed[1], p[2] - seed[2]) > reach) continue;
      distances.push(distanceToAxis(p, origin, axis));
      along.push(
        (p[0] - origin[0]) * axis[0] + (p[1] - origin[1]) * axis[1] + (p[2] - origin[2]) * axis[2],
      );
    }
    if (distances.length < MIN_VERTICES) {
      throw new Error(
        `${boneId} ${target.feature}: only ${distances.length} vertices near the seed, ` +
          `below the ${MIN_VERTICES} a trustworthy measurement needs.`,
      );
    }

    const { radius, spread } =
      target.statistic === 'enclosing' ? enclosingRadius(distances) : trimmedRadius(distances);
    // The extent along the axis, trimmed the same way, so one stray vertex at the rim cannot
    // stretch the cylinder past the surface it stands for.
    const sortedAlong = [...along].sort((a, b) => a - b);
    const lowAlong = sortedAlong[Math.floor(sortedAlong.length * TRIM)] ?? 0;
    const highAlong = sortedAlong[Math.ceil(sortedAlong.length * (1 - TRIM)) - 1] ?? 0;
    measured.push({
      bone: boneId,
      feature: target.feature,
      description: target.description,
      radius: round(radius),
      vertices: Math.ceil(distances.length * (1 - 2 * TRIM)),
      spread: round(spread),
      halfLength: round((highAlong - lowAlong) / 2),
      rule:
        target.statistic === 'enclosing'
          ? `${Math.round(ENCLOSING_PERCENTILE * 100)}th percentile distance from the ` +
            `${name(target.axis[0])} to ${name(target.axis[1])} axis, over mesh within ` +
            `${(target.seedRadius ?? SEED_RADIUS) * 1000} mm of ${target.seedFeature}`
          : `median distance from the ${name(target.axis[0])} to ${name(target.axis[1])} axis, ` +
            `over mesh within ${(target.seedRadius ?? SEED_RADIUS) * 1000} mm of ` +
            `${target.seedFeature}, taking the middle ` +
            `${Math.round((1 - 2 * TRIM) * 100)}% of the distribution`,
    });
  }
}

const table: WrapRadiusTable = {
  format: 'bs-humany.wrap-radii/1',
  generatedAt: new Date().toISOString(),
  dataset: manifest.dataset,
  radii: measured,
};

const out = join(dataDir, 'wrap-radii.json');
writeFileSync(out, `${JSON.stringify(table, null, 2)}\n`);
console.log(`wrap-radii: wrote ${out}`);
for (const r of measured) {
  console.log(
    `  ${r.bone.padEnd(12)} ${r.feature.padEnd(38)} r ${(r.radius * 1000).toFixed(1).padStart(5)} mm` +
      ` +/- ${(r.spread * 1000).toFixed(1)} mm, half-length ` +
      `${(r.halfLength * 1000).toFixed(1)} mm, ${r.vertices} vertices`,
  );
}
