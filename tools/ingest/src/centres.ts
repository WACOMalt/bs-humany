/**
 * Articular joint centres fitted to the bone meshes.
 *
 *   pnpm --filter @bs-humany/ingest centres [dataDir]
 *
 * The Z-Anatomy export marks anatomical features with small marker meshes, and `ingest` records
 * each marker's centroid as the landmark's position. For a surface feature that is what one
 * wants. For the centre of a ball it is not: the marker for the femoral head is anchored on the
 * label side of the head, about a centimetre clear of the bone, so using it as the hip centre
 * puts the pivot above the femur instead of inside the ball. The femur then swings about the top
 * of its own head rather than about the centre of it.
 *
 * A ball-and-socket centre is a measurable quantity: the articular surface is a sphere, and its
 * centre is what both ISB recommendations define the joint centre to be (Wu 2002 section 2.2 for
 * the hip, Wu 2005 section 2.4 for the shoulder). This tool measures it -- a robust least-squares
 * sphere fit over the vertices of the articular surface -- and writes the result with its
 * residual and inlier count, so the quality of each fit is on the record.
 *
 * Reads the packed meshes rather than the source export, so it re-runs without the 500 MB FBX;
 * the pack is a faithful copy of those meshes (ADR-011). Offline by design: no runtime fitting.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.argv[2] ?? join(HERE, '../../../packages/assets-anatomical/data'));

/** Inlier band for the refinement, metres. A bone mesh is accurate to well under a millimetre. */
export const INLIER_BAND = 0.0025;
/** Refinement passes. The fit settles in three or four; the rest are free. */
const PASSES = 12;
/** Minimum inliers for a fit to be trusted; a real articular surface has hundreds. */
export const MIN_INLIERS = 60;

interface PackedBone {
  readonly id: string;
  readonly vertexOffset: number;
  readonly vertexCount: number;
  readonly centroid: readonly [number, number, number];
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * An articular surface to fit.
 *
 * `seedFeature` names a landmark lying on or near the surface, used only to choose the vertices
 * the first fit sees; the refinement then follows the surface itself, so the answer does not
 * depend on where the marker sits. `seedRadius` is the size of that first neighbourhood.
 */
interface Target {
  readonly bone: string;
  /** Feature name the fitted centre is published under. */
  readonly feature: string;
  readonly seedFeature: string;
  readonly seedRadius: number;
  readonly description: string;
}

const TARGETS: readonly Target[] = [
  {
    bone: 'femur',
    feature: 'Head_of_femur__articular_centre',
    seedFeature: 'Fovea_for_ligament_of_head_of_femur',
    seedRadius: 0.04,
    description: 'Centre of the femoral head: the hip joint centre (Wu 2002, 2.2)',
  },
  {
    bone: 'humerus',
    feature: 'Head_of_humerus__articular_centre',
    seedFeature: 'Head_of_humerus',
    seedRadius: 0.04,
    description: 'Centre of the humeral head: the glenohumeral rotation centre (Wu 2005, 2.4)',
  },
];

/**
 * A pair of bones whose joint centre is where they meet.
 *
 * For a joint that is a contact between two surfaces rather than a ball in a socket, the centre
 * is the place the bones nearly touch. The marker for such a feature is no better placed than
 * any other -- the acromioclavicular marker sits 16 mm clear of the scapula it is supposed to
 * pivot -- so the contact is measured instead.
 */
interface ContactTarget {
  readonly a: string;
  readonly b: string;
  /** Feature name the measured centre is published under, on bone `a`. */
  readonly feature: string;
  readonly description: string;
}

const CONTACTS: readonly ContactTarget[] = [
  {
    a: 'clavicle',
    b: 'scapula',
    feature: 'Acromial_end__contact_centre',
    description: 'Where the clavicle meets the acromion: the acromioclavicular joint centre',
  },
  {
    a: 'talus',
    b: 'navicular',
    feature: 'Head_of_talus__contact_centre',
    description: 'Where the talar head meets the navicular: the talonavicular joint centre',
  },
];

/** Vertex pairs no further apart than the closest pair plus this count as touching, metres. */
export const CONTACT_BAND = 0.002;

export interface ContactCentre {
  readonly bones: readonly [string, string];
  readonly feature: string;
  readonly description: string;
  readonly centre: [number, number, number];
  /** Distance between the two surfaces at their closest, metres. */
  readonly gap: number;
  /** Vertex pairs within `CONTACT_BAND` of that closest approach. */
  readonly pairs: number;
  readonly rule: string;
}

/**
 * Midpoint of the region where two bones come closest.
 *
 * Every pair of vertices within `CONTACT_BAND` of the closest approach contributes its midpoint,
 * and the centre is their average: one stray vertex cannot move it, and a joint whose surfaces
 * are broadly parallel gets the middle of that whole area rather than an arbitrary corner.
 */
export function contactCentre(
  a: Float64Array,
  b: Float64Array,
): { centre: [number, number, number]; gap: number; pairs: number } {
  const na = a.length / 3;
  const nb = b.length / 3;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < na; i++) {
    const ax = a[3 * i] as number;
    const ay = a[3 * i + 1] as number;
    const az = a[3 * i + 2] as number;
    for (let j = 0; j < nb; j++) {
      const dx = ax - (b[3 * j] as number);
      const dy = ay - (b[3 * j + 1] as number);
      const dz = az - (b[3 * j + 2] as number);
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) best = d;
    }
  }
  const gap = Math.sqrt(best);
  const cut = (gap + CONTACT_BAND) ** 2;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let pairs = 0;
  for (let i = 0; i < na; i++) {
    const ax = a[3 * i] as number;
    const ay = a[3 * i + 1] as number;
    const az = a[3 * i + 2] as number;
    for (let j = 0; j < nb; j++) {
      const bx = b[3 * j] as number;
      const by = b[3 * j + 1] as number;
      const bz = b[3 * j + 2] as number;
      const d = (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2;
      if (d > cut) continue;
      sx += (ax + bx) / 2;
      sy += (ay + by) / 2;
      sz += (az + bz) / 2;
      pairs += 1;
    }
  }
  return { centre: [sx / pairs, sy / pairs, sz / pairs], gap, pairs };
}

export interface FittedCentre {
  readonly bone: string;
  readonly feature: string;
  readonly description: string;
  /** World metres at the dataset stature. */
  readonly centre: [number, number, number];
  readonly radius: number;
  readonly inliers: number;
  /** Mean absolute distance of an inlier from the fitted sphere, metres. */
  readonly residual: number;
  readonly rule: string;
}

/** Algebraic sphere fit: solve for the centre and radius minimising the squared algebraic error. */
function fitSphere(
  points: Float64Array,
  count: number,
): { centre: [number, number, number]; radius: number } {
  // Normal equations of [2x 2y 2z 1] [cx cy cz k]^T = x^2 + y^2 + z^2, with r^2 = k + |c|^2.
  const A = new Float64Array(16);
  const b = new Float64Array(4);
  const row = new Float64Array(4);
  for (let i = 0; i < count; i++) {
    const x = points[3 * i] as number;
    const y = points[3 * i + 1] as number;
    const z = points[3 * i + 2] as number;
    row[0] = 2 * x;
    row[1] = 2 * y;
    row[2] = 2 * z;
    row[3] = 1;
    const rhs = x * x + y * y + z * z;
    for (let r = 0; r < 4; r++) {
      b[r] = (b[r] as number) + (row[r] as number) * rhs;
      for (let c = 0; c < 4; c++) {
        A[r * 4 + c] = (A[r * 4 + c] as number) + (row[r] as number) * (row[c] as number);
      }
    }
  }
  const x = solve4(A, b);
  const centre: [number, number, number] = [x[0] as number, x[1] as number, x[2] as number];
  const radius = Math.sqrt(
    Math.max((x[3] as number) + centre[0] ** 2 + centre[1] ** 2 + centre[2] ** 2, 0),
  );
  return { centre, radius };
}

/** Gaussian elimination with partial pivoting on a 4x4 system. */
function solve4(A: Float64Array, b: Float64Array): Float64Array {
  const m = Float64Array.from(A);
  const v = Float64Array.from(b);
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++) {
      if (Math.abs(m[r * 4 + col] as number) > Math.abs(m[pivot * 4 + col] as number)) pivot = r;
    }
    if (pivot !== col) {
      for (let c = 0; c < 4; c++) {
        const t = m[col * 4 + c] as number;
        m[col * 4 + c] = m[pivot * 4 + c] as number;
        m[pivot * 4 + c] = t;
      }
      const t = v[col] as number;
      v[col] = v[pivot] as number;
      v[pivot] = t;
    }
    const d = m[col * 4 + col] as number;
    if (Math.abs(d) < 1e-18) throw new Error('singular sphere-fit system');
    for (let r = col + 1; r < 4; r++) {
      const f = (m[r * 4 + col] as number) / d;
      if (f === 0) continue;
      for (let c = col; c < 4; c++) {
        m[r * 4 + c] = (m[r * 4 + c] as number) - f * (m[col * 4 + c] as number);
      }
      v[r] = (v[r] as number) - f * (v[col] as number);
    }
  }
  const out = new Float64Array(4);
  for (let r = 3; r >= 0; r--) {
    let sum = v[r] as number;
    for (let c = r + 1; c < 4; c++) sum -= (m[r * 4 + c] as number) * (out[c] as number);
    out[r] = sum / (m[r * 4 + r] as number);
  }
  return out;
}

/**
 * Fit the sphere through the articular surface around `seed`.
 *
 * Starts from every vertex within `seedRadius` of the seed, then repeatedly refits to the
 * vertices lying within `INLIER_BAND` of the current sphere. The articular surface is the only
 * large spherical patch on the bone, so the band excludes the neck and the shaft after the
 * first pass and the fit converges onto the ball.
 */
export function fitArticularSphere(
  vertices: Float64Array,
  seed: readonly [number, number, number],
  seedRadius: number,
): { centre: [number, number, number]; radius: number; inliers: number; residual: number } {
  const count = vertices.length / 3;
  const scratch = new Float64Array(vertices.length);
  let selected = 0;
  for (let i = 0; i < count; i++) {
    const dx = (vertices[3 * i] as number) - seed[0];
    const dy = (vertices[3 * i + 1] as number) - seed[1];
    const dz = (vertices[3 * i + 2] as number) - seed[2];
    if (dx * dx + dy * dy + dz * dz > seedRadius * seedRadius) continue;
    scratch[3 * selected] = vertices[3 * i] as number;
    scratch[3 * selected + 1] = vertices[3 * i + 1] as number;
    scratch[3 * selected + 2] = vertices[3 * i + 2] as number;
    selected += 1;
  }
  if (selected < MIN_INLIERS) throw new Error(`only ${selected} vertices near the seed`);
  let fit = fitSphere(scratch, selected);
  for (let pass = 0; pass < PASSES; pass++) {
    let next = 0;
    for (let i = 0; i < count; i++) {
      const dx = (vertices[3 * i] as number) - fit.centre[0];
      const dy = (vertices[3 * i + 1] as number) - fit.centre[1];
      const dz = (vertices[3 * i + 2] as number) - fit.centre[2];
      if (Math.abs(Math.hypot(dx, dy, dz) - fit.radius) > INLIER_BAND) continue;
      scratch[3 * next] = vertices[3 * i] as number;
      scratch[3 * next + 1] = vertices[3 * i + 1] as number;
      scratch[3 * next + 2] = vertices[3 * i + 2] as number;
      next += 1;
    }
    if (next < MIN_INLIERS) break;
    selected = next;
    fit = fitSphere(scratch, selected);
  }
  let residual = 0;
  for (let i = 0; i < selected; i++) {
    const dx = (scratch[3 * i] as number) - fit.centre[0];
    const dy = (scratch[3 * i + 1] as number) - fit.centre[1];
    const dz = (scratch[3 * i + 2] as number) - fit.centre[2];
    residual += Math.abs(Math.hypot(dx, dy, dz) - fit.radius);
  }
  return { ...fit, inliers: selected, residual: residual / Math.max(selected, 1) };
}

// --- Driver ------------------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(join(dataDir, 'manifest.json'), 'utf8')) as {
  dataset: Record<string, unknown>;
  subjectStature: number;
  totals: { vertices: number };
  bones: PackedBone[];
};
const landmarks = JSON.parse(readFileSync(join(dataDir, 'landmarks.json'), 'utf8')) as Record<
  string,
  Record<string, [number, number, number]>
>;
const bin = readFileSync(join(dataDir, 'skeleton.bin'));
const positions = new Float32Array(
  bin.buffer.slice(bin.byteOffset, bin.byteOffset + manifest.totals.vertices * 12),
);
const packed = new Map(manifest.bones.map((b) => [b.id, b]));

const round = (x: number) => Math.round(x * 1e6) / 1e6;
const fitted: FittedCentre[] = [];
for (const target of TARGETS) {
  for (const side of ['r', 'l'] as const) {
    const boneId = `${target.bone}_${side}`;
    const bone = packed.get(boneId);
    const seed = landmarks[boneId]?.[target.seedFeature];
    if (!bone || !seed) throw new Error(`no ${boneId} or its seed ${target.seedFeature}`);
    const vertices = Float64Array.from(
      positions.subarray(bone.vertexOffset * 3, (bone.vertexOffset + bone.vertexCount) * 3),
    );
    const fit = fitArticularSphere(vertices, seed, target.seedRadius);
    fitted.push({
      bone: boneId,
      feature: target.feature,
      description: target.description,
      centre: fit.centre.map(round) as [number, number, number],
      radius: round(fit.radius),
      inliers: fit.inliers,
      residual: round(fit.residual),
      rule:
        `least-squares sphere through the articular surface: vertices within ${target.seedRadius * 1000} mm ` +
        `of ${target.seedFeature}, refined to those within ${INLIER_BAND * 1000} mm of the sphere`,
    });
    console.error(
      `${boneId}: centre ${fit.centre.map((v) => v.toFixed(4)).join(', ')}  radius ${(fit.radius * 1000).toFixed(1)} mm  ` +
        `${fit.inliers} inliers  residual ${(fit.residual * 1000).toFixed(2)} mm`,
    );
  }
}

const contacts: ContactCentre[] = [];
for (const target of CONTACTS) {
  for (const side of ['r', 'l'] as const) {
    const aId = `${target.a}_${side}`;
    const bId = `${target.b}_${side}`;
    const boneA = packed.get(aId);
    const boneB = packed.get(bId);
    if (!boneA || !boneB) throw new Error(`no ${aId} or ${bId}`);
    const va = Float64Array.from(
      positions.subarray(boneA.vertexOffset * 3, (boneA.vertexOffset + boneA.vertexCount) * 3),
    );
    const vb = Float64Array.from(
      positions.subarray(boneB.vertexOffset * 3, (boneB.vertexOffset + boneB.vertexCount) * 3),
    );
    const fit = contactCentre(va, vb);
    contacts.push({
      bones: [aId, bId],
      feature: target.feature,
      description: target.description,
      centre: fit.centre.map(round) as [number, number, number],
      gap: round(fit.gap),
      pairs: fit.pairs,
      rule:
        `midpoint of every vertex pair within ${CONTACT_BAND * 1000} mm of the closest approach ` +
        `between ${aId} and ${bId}`,
    });
    console.error(
      `${aId}/${bId}: contact centre ${fit.centre.map((v) => v.toFixed(4)).join(', ')}  ` +
        `gap ${(fit.gap * 1000).toFixed(1)} mm  ${fit.pairs} pairs`,
    );
  }
}

const out = {
  format: 'bs-humany.articular-centres/1',
  // A measurement of the meshes carries their licence and attribution (ADR-009, ADR-011).
  dataset: manifest.dataset,
  generator: 'tools/ingest/src/centres.ts',
  subjectStature: manifest.subjectStature,
  units: 'm',
  frame: 'canonical world frame at the dataset stature',
  centres: fitted,
  contacts,
};
writeFileSync(join(dataDir, 'articular-centres.json'), `${JSON.stringify(out, null, 1)}\n`);
console.error(
  `wrote ${join(dataDir, 'articular-centres.json')}: ${fitted.length} fitted centres, ${contacts.length} contact centres`,
);
