/**
 * Where the L3 joints that sit between two small bones put their centres.
 *
 * A joint centre is only as good as the rule that places it, and the one these joints used to take
 * -- where the two bones' bounding boxes meet along one axis, at the distal bone's centroid on the
 * other two -- was right only for a bone that runs along that axis. The thumb's metacarpal points
 * down and forward at once, and its saddle came out 20 mm from the metacarpal's base. Nothing
 * failed: the joint turned, the muscles crossing it pulled, and every moment arm about it was
 * measured from the wrong place. So these tests measure the centre against the bones themselves,
 * the packed meshes, rather than against the rule that produced it.
 */

import { fileURLToPath } from 'node:url';
import { resolveMorphology } from '@bs-humany/anthropometry';
import { loadSkeletonAssetsFromDisk } from '@bs-humany/assets-anatomical';
import { type Transform, compose, vec3 } from '@bs-humany/frames';
import { evaluate } from '@bs-humany/hsdl';
import { describe, expect, it } from 'vitest';
import { DATASET_MANIFEST, buildDocument } from './document.js';
import { measuredWorld } from './landmarks.js';
import { computeWorldTransforms } from './pose.js';

const assets = await loadSkeletonAssetsFromDisk(
  fileURLToPath(new URL('../../assets-anatomical/data', import.meta.url)),
);
const document = buildDocument();
const joints = new Map(document.joints.map((j) => [j.id, j]));
const atDataset = resolveMorphology({
  sex: 0.5,
  stature: DATASET_MANIFEST.subjectStature,
  mass: 70,
}).context;
const world = computeWorldTransforms(document, atDataset);

type P3 = readonly [number, number, number];

/** A joint's centre in the dataset's world frame, at the dataset stature. */
function centreOf(id: string): P3 {
  const joint = joints.get(id);
  if (!joint) throw new Error(`no joint ${id}`);
  const parent = world.get(joint.parentBone) as Transform | undefined;
  if (!parent) throw new Error(`no parent pose for ${id}`);
  const t = compose(parent, {
    translation: vec3(
      evaluate(joint.frame.translation.x, atDataset),
      evaluate(joint.frame.translation.y, atDataset),
      evaluate(joint.frame.translation.z, atDataset),
    ),
    rotation: joint.frame.rotation,
  }).translation;
  return [t.x, t.y, t.z];
}

const mm = (a: P3, b: P3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 1000;

/** The point of triangle abc nearest p (Ericson, Real-Time Collision Detection, 5.1.5). */
function nearestOnTriangle(p: P3, a: P3, b: P3, c: P3): P3 {
  const sub = (u: P3, v: P3): P3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u: P3, v: P3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const along = (o: P3, u: P3, t: number): P3 => [
    o[0] + u[0] * t,
    o[1] + u[1] * t,
    o[2] + u[2] * t,
  ];
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return along(a, ab, d1 / (d1 - d3));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return along(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/**
 * Millimetres from a point to the nearest point of one bone's packed surface.
 *
 * The surface rather than the nearest vertex: a small bone's facet is a few large triangles, and a
 * point in the middle of one is well over a millimetre from every corner of it.
 */
function millimetresFrom(bone: string, point: P3): number {
  const mesh = assets.bones.get(bone);
  if (!mesh) throw new Error(`'${bone}' is not in the packed dataset`);
  const p = mesh.positions;
  const vertex = (i: number): P3 => [
    p[3 * i] as number,
    p[3 * i + 1] as number,
    p[3 * i + 2] as number,
  ];
  let best = Number.POSITIVE_INFINITY;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const q = nearestOnTriangle(
      point,
      vertex(mesh.indices[t] as number),
      vertex(mesh.indices[t + 1] as number),
      vertex(mesh.indices[t + 2] as number),
    );
    best = Math.min(best, mm(point, q));
  }
  return best;
}

describe('the thumb carpometacarpal centre', () => {
  it('is at the base of the first metacarpal, where the trapezium meets it', () => {
    for (const s of ['r', 'l'] as const) {
      const centre = centreOf(`cmc_1_${s}`);
      // The bounds boundary it replaced was 20.3 mm from here.
      expect(mm(centre, measuredWorld(`metacarpal_1_${s}`, 'Base_of_digit_bone'))).toBeLessThan(5);
      expect(millimetresFrom(`trapezium_${s}`, centre)).toBeLessThan(3);
      expect(millimetresFrom(`metacarpal_1_${s}`, centre)).toBeLessThan(3);
    }
  });
});

describe('the tarsometatarsal centre', () => {
  it('lies between the intermediate cuneiform and the second metatarsal', () => {
    for (const s of ['r', 'l'] as const) {
      const centre = centreOf(`tarsometatarsal_${s}`);
      expect(millimetresFrom(`cuneiform_intermediate_${s}`, centre)).toBeLessThan(3);
      expect(millimetresFrom(`metatarsal_2_${s}`, centre)).toBeLessThan(3);
    }
  });
});
