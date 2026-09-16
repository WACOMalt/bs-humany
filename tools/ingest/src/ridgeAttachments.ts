/**
 * Where along a ridge a muscle actually attaches.
 *
 *   pnpm --filter @bs-humany/ingest ridge-attachments [dataDir]
 *
 * A marker names a feature; it does not say where along it. For a tubercle that distinction does
 * not arise, and for a ridge it is the whole question. The lateral supracondylar ridge runs the
 * lower third of the humerus, and the dataset gives it one marker, which -- put back on the bone
 * by `surfaceLandmarks.ts` -- sits 32 mm above the elbow, near the ridge's *bottom*. Brachioradialis
 * arises from the upper two-thirds of it.
 *
 * What that cost is not subtle. Swept against the model this project's muscle parameters come
 * from, brachioradialis had an 18 mm flexion moment arm where that model gives 90, the worst
 * disagreement of any muscle at the elbow. Moving the origin up the bone recovers it almost
 * exactly: 37 mm at 20 mm up, 57 at 40, 76 at 60. It was never the wrap surface, which is the
 * first thing it looked like -- the reference wraps a 15 mm cylinder there and ours is a 12.4 mm
 * one, close enough that it cannot be worth 70 mm of moment arm. It was the origin sitting at the
 * wrong end of a 100 mm feature.
 *
 * ## The rule
 *
 * A ridge is the outermost line of a bone in some direction, so it is measured as one. The bone's
 * long axis runs between two landmarks; the ridge faces the way a third landmark lies off that
 * axis. Take the vertices within the stretch of bone the ridge occupies, bin them along the axis,
 * and in each bin keep the vertex furthest out in the ridge's own direction. That traces the
 * ridge. Then take the centroid of the portion the muscle arises from, and settle it back onto
 * the nearest vertex so the result is a point on the bone.
 *
 * Two things are stated per entry and both are citations rather than choices: how far along the
 * bone the ridge runs, and which part of it the muscle takes. Gray gives both.
 *
 * Runs after `surface-landmarks` and reads its output, because the axis is built from the
 * epicondyles and the epicondyle markers are two of the worst floaters in the arm -- 103.5 mm
 * apart where the bone between them measures 63.8.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.argv[2] ?? join(HERE, '../../../packages/assets-anatomical/data'));

/** How many bins the ridge's stretch is divided into when tracing it. */
export const BINS = 24;

type Vec3 = readonly [number, number, number];

interface RidgeSpec {
  /** `$` takes the side. */
  readonly bone: string;
  /** The feature the ridge is, as the dataset names it. */
  readonly feature: string;
  /** What the measured point is called, as a feature on the same bone. */
  readonly named: string;
  /** The bone's long axis: from the first landmark to the midpoint of the rest. */
  readonly axis: readonly [string, readonly string[]];
  /** The ridge faces the way this landmark lies off the axis. */
  readonly outward: string;
  /** Where the ridge runs, as fractions of the bone's length from the distal end. */
  readonly span: readonly [number, number];
  /** Which part of the ridge the muscle takes, as fractions of the span from the distal end. */
  readonly portion: readonly [number, number];
  readonly anatomy: string;
}

/**
 * The ridges a muscle's line of action starts along, and how far along each one it starts.
 *
 * One so far. The rest of the attachments this project carries are either compact enough that the
 * marker answers, or they are footprints over several named features, which `attachments.ts`
 * handles by averaging them. A ridge is neither: one feature, and a hundred millimetres of it.
 */
const RIDGES: readonly RidgeSpec[] = [
  {
    bone: 'humerus_$',
    feature: 'Lateral_supracondylar_ridge',
    named: 'Lateral_supracondylar_ridge__upper_two_thirds',
    axis: ['Head_of_humerus', ['Medial_epicondyle_of_humerus', 'Lateral_epicondyle_of_humerus']],
    outward: 'Lateral_epicondyle_of_humerus',
    // Gray, on the humerus: the lateral border is a rounded ridge above and becomes the lateral
    // supracondylar ridge in the bone's lower third.
    span: [0, 1 / 3],
    // Gray, on brachioradialis: it arises from the upper two-thirds of that ridge.
    portion: [1 / 3, 1],
    anatomy:
      'Gray 1918, Osteology: the lateral border of the humerus becomes the lateral ' +
      'supracondylar ridge over the bone’s lower third; Myology, The Brachioradialis: it ' +
      'arises from the upper two-thirds of that ridge',
  },
  {
    bone: 'humerus_$',
    feature: 'Lateral_supracondylar_ridge',
    named: 'Lateral_supracondylar_ridge__lower_third',
    axis: ['Head_of_humerus', ['Medial_epicondyle_of_humerus', 'Lateral_epicondyle_of_humerus']],
    outward: 'Lateral_epicondyle_of_humerus',
    span: [0, 1 / 3],
    // Gray, on extensor carpi radialis longus: it arises from the lower third of the same ridge
    // brachioradialis takes the upper two-thirds of. Two muscles, one feature, one marker, and
    // the difference between them is most of a moment arm.
    portion: [0, 1 / 3],
    anatomy:
      'Gray 1918, Osteology: the lateral border of the humerus becomes the lateral ' +
      'supracondylar ridge over the bone’s lower third; Myology, The Extensor carpi radialis ' +
      'longus: it arises from the lower third of that ridge',
  },
];

interface Manifest {
  readonly dataset: unknown;
  readonly bones: readonly {
    readonly id: string;
    readonly vertexOffset: number;
    readonly vertexCount: number;
  }[];
}

export interface RidgeAttachment {
  readonly bone: string;
  readonly feature: string;
  /** Where the muscle starts, world metres at the dataset stature: the answer. */
  readonly surface: Vec3;
  /** Where the feature's own marker sits, for comparison. */
  readonly marker: Vec3;
  /** How far the two are apart, metres. */
  readonly offset: number;
  /** How far up the bone from its distal end the answer sits, metres. */
  readonly height: number;
  /** Bins along the ridge that held a vertex. */
  readonly traced: number;
  readonly rule: string;
  readonly anatomy: string;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

const manifest = JSON.parse(readFileSync(join(dataDir, 'manifest.json'), 'utf8')) as Manifest;
const surfaceTable = JSON.parse(readFileSync(join(dataDir, 'landmarks-surface.json'), 'utf8')) as {
  readonly landmarks: readonly { bone: string; feature: string; surface: Vec3 }[];
};
const rawTable = JSON.parse(readFileSync(join(dataDir, 'landmarks.json'), 'utf8')) as Record<
  string,
  Record<string, Vec3>
>;
const bin = readFileSync(join(dataDir, 'skeleton.bin'));
const positions = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
const packed = new Map(manifest.bones.map((b) => [b.id, b]));
const measured = new Map(surfaceTable.landmarks.map((l) => [`${l.bone}/${l.feature}`, l.surface]));

const round = (x: number) => Math.round(x * 1e6) / 1e6;
const RULE =
  `the vertex furthest along the ridge's own outward direction in each of ${BINS} bins across ` +
  'the stretch of bone the ridge runs, then the centroid of the bins in the portion the muscle ' +
  'arises from, settled onto the nearest vertex';

const found: RidgeAttachment[] = [];

for (const spec of RIDGES) {
  for (const s of ['r', 'l'] as const) {
    const bone = spec.bone.replace('$', s);
    const mesh = packed.get(bone);
    const at = (feature: string) => measured.get(`${bone}/${feature}`);
    const proximal = at(spec.axis[0]);
    const distalOf = spec.axis[1].map(at);
    const outwardAt = at(spec.outward);
    const marker = at(spec.feature) ?? rawTable[bone]?.[spec.feature];
    if (!mesh || !proximal || !outwardAt || !marker || distalOf.some((p) => !p)) continue;

    const midpoint = (i: 0 | 1 | 2) =>
      distalOf.reduce((total, p) => total + ((p as Vec3)[i] ?? 0), 0) / distalOf.length;
    const distal: Vec3 = [midpoint(0), midpoint(1), midpoint(2)];
    // Up the bone from its distal end, and how long the bone is along it.
    const up = norm(sub(proximal, distal));
    const length = dot(sub(proximal, distal), up);
    // Which way the ridge faces: the outward landmark's offset from the axis.
    const offAxis = sub(outwardAt, distal);
    const outward = norm([
      offAxis[0] - up[0] * dot(offAxis, up),
      offAxis[1] - up[1] * dot(offAxis, up),
      offAxis[2] - up[2] * dot(offAxis, up),
    ]);

    // Trace the ridge: the furthest vertex outward in each bin along its stretch.
    const low = spec.span[0] * length;
    const high = spec.span[1] * length;
    const best: (Vec3 | undefined)[] = Array.from({ length: BINS });
    const reach = new Float64Array(BINS).fill(Number.NEGATIVE_INFINITY);
    for (let i = 0; i < mesh.vertexCount; i++) {
      const o = 3 * (mesh.vertexOffset + i);
      const v: Vec3 = [
        positions[o] as number,
        positions[o + 1] as number,
        positions[o + 2] as number,
      ];
      const along = dot(sub(v, distal), up);
      if (along < low || along > high) continue;
      const slot = Math.min(BINS - 1, Math.floor(((along - low) / (high - low)) * BINS));
      const out = dot(sub(v, distal), outward);
      if (out > (reach[slot] as number)) {
        reach[slot] = out;
        best[slot] = v;
      }
    }

    // The portion the muscle arises from, as bins.
    const from = Math.round(spec.portion[0] * BINS);
    const to = Math.round(spec.portion[1] * BINS);
    const taken = best.slice(from, to).filter((v): v is Vec3 => v !== undefined);
    if (taken.length === 0) continue;
    const mean = (i: 0 | 1 | 2) => taken.reduce((total, v) => total + v[i], 0) / taken.length;
    const centroid: Vec3 = [mean(0), mean(1), mean(2)];

    // Back onto the bone: a centroid of points around a curved ridge sits just inside it.
    let nearest = centroid;
    let closest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const o = 3 * (mesh.vertexOffset + i);
      const dx = (positions[o] as number) - centroid[0];
      const dy = (positions[o + 1] as number) - centroid[1];
      const dz = (positions[o + 2] as number) - centroid[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < closest) {
        closest = d;
        nearest = [positions[o] as number, positions[o + 1] as number, positions[o + 2] as number];
      }
    }

    found.push({
      bone,
      feature: spec.named,
      surface: nearest.map(round) as unknown as Vec3,
      marker: (marker as Vec3).map(round) as unknown as Vec3,
      offset: round(Math.hypot(...sub(nearest, marker as Vec3))),
      height: round(dot(sub(nearest, distal), up)),
      traced: taken.length,
      rule: RULE,
      anatomy: spec.anatomy,
    });
  }
}

writeFileSync(
  join(dataDir, 'ridge-attachments.json'),
  `${JSON.stringify(
    {
      format: 'bs-humany.ridge-attachments/1',
      generatedAt: new Date().toISOString().slice(0, 10),
      dataset: manifest.dataset,
      bins: BINS,
      attachments: found,
    },
    null,
    1,
  )}\n`,
);

console.error(`ridge attachments: ${found.length} measured.`);
for (const a of found) {
  console.error(
    `  ${a.bone}/${a.feature}: ${(a.height * 1000).toFixed(0)} mm up the bone, ` +
      `${(a.offset * 1000).toFixed(0)} mm from the feature's own marker, ${a.traced} bins`,
  );
}
