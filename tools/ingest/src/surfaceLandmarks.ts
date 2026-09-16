/**
 * Markers put back on the bone they name.
 *
 *   pnpm --filter @bs-humany/ingest surface-landmarks [dataDir]
 *
 * The dataset's markers are label anchors. They are placed *beside* the feature they name, in the
 * clear, so a text label can point at it without the text sitting inside the mesh -- which is what
 * they are for, and it makes them unusable as positions. Measured against the bone each one names,
 * not a single marker in the arm lies on it:
 *
 *     Olecranon                        9.9 mm off the surface
 *     Medial epicondyle               12.0 mm
 *     Tuberosity of ulna              12.2 mm
 *     Lateral supracondylar ridge     22.7 mm
 *     Lateral epicondyle              25.9 mm
 *     Anteromedial surface of humerus 29.7 mm
 *
 * A muscle attachment ten to thirty millimetres off the bone is not a small error. Muscle spec
 * 13.2's sweep found the consequence at the elbow: brachialis, whose insertion marker stands 50 mm
 * from the flexion axis where the reference model's insertion stands 24, has twice the moment arm
 * it should and never touches the surface it is supposed to wrap, because the straight line from
 * origin to insertion passes outside the joint entirely.
 *
 * ## The rule
 *
 * For each marker, on the bone it names: take the nearest vertex of that bone, gather the surface
 * patch within `PATCH_RADIUS` of it, and take that patch's centroid; then take the nearest vertex
 * to the centroid, so the result is a point *on* the bone rather than just inside it.
 *
 * Why not simply the nearest vertex. A single vertex is wherever the mesh happens to have one, and
 * two markers a centimetre apart can snap to the same one or to neighbours on opposite sides of a
 * ridge. The patch centroid is stable under both, and it is also the better answer anatomically:
 * a muscle does not attach at a point, it attaches over a footprint, and the centroid of that
 * footprint is the line of action's origin.
 *
 * Why a label anchor's nearest surface is the right surface. The anchor is placed out along the
 * feature's own outward direction, so the nearest bone to it is the feature. Where that is not
 * true the measurement says so: `offset` is how far the marker moved, and anything far past the
 * spread of the rest is a marker to look at rather than trust.
 *
 * ## What this does not do
 *
 * It does not touch joint frames. The epicondyle markers are in the table above for a reason --
 * they float too, and the elbow's flexion axis is the line between them -- but a joint axis is not
 * a point on a surface and projecting its two ends is not obviously the right correction. That is
 * recorded as its own question rather than folded in here.
 *
 * Reads the packed meshes rather than the source export, so it re-runs without the 500 MB FBX.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.argv[2] ?? join(HERE, '../../../packages/assets-anatomical/data'));

/**
 * How wide an attachment footprint is taken to be, metres.
 *
 * Fifteen millimetres. Attachments are not all one size -- the coracoid's is a tubercle and the
 * humeral shaft's runs half the bone -- so any single figure is a modelling choice rather than a
 * measurement, and this one is chosen to be small enough that a patch stays on the feature it
 * started on. What it buys is stability: at this radius every marker in the arm gathers hundreds
 * of vertices, so the centroid does not move if the mesh is retriangulated.
 *
 * It is not a claim about the attachment's size. A footprint is something the muscle module's
 * Tier V work would need and this is not it; here the patch exists to locate a point.
 */
export const PATCH_RADIUS = 0.015;

/**
 * The fewest vertices a patch may be taken over.
 *
 * The meshes are not evenly tessellated: an articular end carries hundreds of vertices in fifteen
 * millimetres and a shaft carries seven, because a cylinder needs few. A centroid over seven
 * vertices is a centroid over wherever those seven happen to be, so where the patch comes out thin
 * it is widened -- doubling the radius up to four times -- until there are enough to average. The
 * widening is recorded per landmark, so a point taken over a 60 mm patch is not mistaken for one
 * taken over a 15 mm patch.
 */
export const MIN_PATCH = 12;

/** How far the patch may be widened when the mesh is sparse there. */
export const MAX_WIDENING = 4;

interface Manifest {
  readonly dataset: unknown;
  readonly bones: readonly {
    readonly id: string;
    readonly vertexOffset: number;
    readonly vertexCount: number;
  }[];
}

export interface SurfaceLandmark {
  readonly bone: string;
  readonly feature: string;
  /** Where the marker is, world metres at the dataset stature. */
  readonly marker: readonly [number, number, number];
  /** Where the bone is, world metres: the answer. */
  readonly surface: readonly [number, number, number];
  /** How far the marker was from the bone it names, metres. */
  readonly offset: number;
  /** Vertices in the patch the centroid was taken over. */
  readonly vertices: number;
  /** The patch radius it took to gather them, metres: the default unless the mesh was sparse. */
  readonly patchRadius: number;
  readonly rule: string;
}

export interface SurfaceLandmarkTable {
  readonly format: 'bs-humany.surface-landmarks/1';
  readonly generatedAt: string;
  readonly dataset: unknown;
  readonly patchRadius: number;
  readonly landmarks: readonly SurfaceLandmark[];
}

/** The vertex of `bone` nearest a point, as an index into the packed positions. */
function nearestVertex(
  positions: Float32Array,
  from: number,
  count: number,
  point: readonly [number, number, number],
): { index: number; distance: number } {
  let best = Number.POSITIVE_INFINITY;
  let at = from;
  for (let i = 0; i < count; i++) {
    const o = 3 * (from + i);
    const dx = (positions[o] as number) - point[0];
    const dy = (positions[o + 1] as number) - point[1];
    const dz = (positions[o + 2] as number) - point[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) {
      best = d;
      at = from + i;
    }
  }
  return { index: at, distance: Math.sqrt(best) };
}

/** The centroid of the bone's vertices within `radius` of a point, and how many there were. */
function patchCentroid(
  positions: Float32Array,
  from: number,
  count: number,
  point: readonly [number, number, number],
  radius: number,
): { centroid: [number, number, number]; vertices: number } {
  const limit = radius * radius;
  let n = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < count; i++) {
    const o = 3 * (from + i);
    const x = positions[o] as number;
    const y = positions[o + 1] as number;
    const z = positions[o + 2] as number;
    const dx = x - point[0];
    const dy = y - point[1];
    const dz = z - point[2];
    if (dx * dx + dy * dy + dz * dz > limit) continue;
    n++;
    cx += x;
    cy += y;
    cz += z;
  }
  if (n === 0) return { centroid: [point[0], point[1], point[2]], vertices: 0 };
  return { centroid: [cx / n, cy / n, cz / n], vertices: n };
}

/** Put one marker on its bone. Exported so the rule can be tested on a mesh of known shape. */
export function projectToSurface(
  positions: Float32Array,
  from: number,
  count: number,
  marker: readonly [number, number, number],
  radius = PATCH_RADIUS,
): { surface: [number, number, number]; offset: number; vertices: number; radius: number } {
  const anchor = nearestVertex(positions, from, count, marker);
  const seed: [number, number, number] = [
    positions[3 * anchor.index] as number,
    positions[3 * anchor.index + 1] as number,
    positions[3 * anchor.index + 2] as number,
  ];
  let used = radius;
  let patch = patchCentroid(positions, from, count, seed, used);
  while (patch.vertices < MIN_PATCH && used < radius * MAX_WIDENING) {
    used = Math.min(used * 2, radius * MAX_WIDENING);
    patch = patchCentroid(positions, from, count, seed, used);
  }
  const { centroid, vertices } = patch;
  // Back onto the bone: the centroid of a curved patch sits inside it, and an attachment inside
  // the bone pulls a muscle's line of action through the surface it is supposed to lie on.
  const settled = nearestVertex(positions, from, count, centroid);
  const surface: [number, number, number] = [
    positions[3 * settled.index] as number,
    positions[3 * settled.index + 1] as number,
    positions[3 * settled.index + 2] as number,
  ];
  return {
    surface,
    offset: Math.hypot(surface[0] - marker[0], surface[1] - marker[1], surface[2] - marker[2]),
    vertices,
    radius: used,
  };
}

const manifest = JSON.parse(readFileSync(join(dataDir, 'manifest.json'), 'utf8')) as Manifest;
const landmarks = JSON.parse(readFileSync(join(dataDir, 'landmarks.json'), 'utf8')) as Record<
  string,
  Record<string, [number, number, number]>
>;
const bin = readFileSync(join(dataDir, 'skeleton.bin'));
const positions = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
const packed = new Map(manifest.bones.map((b) => [b.id, b]));

const round = (x: number) => Math.round(x * 1e6) / 1e6;
const RULE =
  'nearest vertex of the named bone, then the centroid of the surface patch around it ' +
  `(${PATCH_RADIUS * 1000} mm, widened where the mesh is sparser than ${MIN_PATCH} vertices), ` +
  'then the nearest vertex to that centroid';

const measured: SurfaceLandmark[] = [];
const thin: string[] = [];

for (const [bone, table] of Object.entries(landmarks)) {
  const mesh = packed.get(bone);
  if (!mesh) continue;
  for (const [feature, marker] of Object.entries(table)) {
    const { surface, offset, vertices, radius } = projectToSurface(
      positions,
      mesh.vertexOffset,
      mesh.vertexCount,
      marker,
    );
    if (vertices < MIN_PATCH) thin.push(`${bone}/${feature} (${vertices} vertices)`);
    measured.push({
      bone,
      feature,
      marker: marker.map(round) as [number, number, number],
      surface: surface.map(round) as [number, number, number],
      offset: round(offset),
      vertices,
      patchRadius: round(radius),
      rule: RULE,
    });
  }
}

const table: SurfaceLandmarkTable = {
  format: 'bs-humany.surface-landmarks/1',
  generatedAt: new Date().toISOString().slice(0, 10),
  dataset: manifest.dataset,
  patchRadius: PATCH_RADIUS,
  landmarks: measured,
};

writeFileSync(join(dataDir, 'landmarks-surface.json'), `${JSON.stringify(table, null, 1)}\n`);

const offsets = measured.map((m) => m.offset).sort((a, b) => a - b);
const median = offsets[Math.floor(offsets.length / 2)] ?? 0;
console.error(
  `surface landmarks: ${measured.length} markers on ${packed.size} bones put back on the bone. ` +
    `Median move ${(median * 1000).toFixed(1)} mm, worst ${((offsets.at(-1) ?? 0) * 1000).toFixed(1)} mm.`,
);
if (thin.length > 0) {
  console.error(`  ${thin.length} thin patch(es), fewer than ${MIN_PATCH} vertices:`);
  for (const t of thin.slice(0, 10)) console.error(`    ${t}`);
}
