/**
 * Every attachment lies on the bone it names.
 *
 * A site is a point in a bone's frame, and nothing downstream checks that the point is anywhere
 * near that bone: the compiler places it, the path solver carries it, and a muscle attached to
 * empty air is drawn and simulated as confidently as one attached to a tuberosity. The moment arm
 * is the perpendicular distance from the joint's axis to the line of action, so a point in the
 * wrong place is a lever of the wrong length, and the failure is silent.
 *
 * Measured against the packed meshes themselves rather than against a bounding box, because a
 * long bone's box is mostly not bone: a point at the corner of the radius's box is 30 mm from any
 * radius.
 *
 * ## Two populations, two standards
 *
 * **Origins and insertions** are measured on these very meshes -- a ridge trace, or a marker
 * projected onto the surface -- so they land on the bone by construction and are held to it.
 *
 * **Via points** are carried across from a reference model through a frame correspondence, and
 * they do not. The ceilings below are what that carry-over currently achieves, bone by bone; they
 * are the subject of OQ-015 and OQ-021 and they exist to be lowered. Nothing may exceed its
 * bone's ceiling and no bone may appear that is not in the table, so the error can shrink and
 * cannot spread.
 */

import { fileURLToPath } from 'node:url';
import { resolveMorphology } from '@bs-humany/anthropometry';
import { loadSkeletonAssetsFromDisk } from '@bs-humany/assets-anatomical';
import { evaluate } from '@bs-humany/hsdl';
import { describe, expect, it } from 'vitest';
import { DATASET_MANIFEST, buildDocument } from './document.js';
import { MUSCLE_VIA_POINTS } from './muscleViaPoints.js';

const assets = await loadSkeletonAssetsFromDisk(
  fileURLToPath(new URL('../../assets-anatomical/data', import.meta.url)),
);
const context = resolveMorphology({
  sex: 0.5,
  stature: DATASET_MANIFEST.subjectStature,
  mass: 70,
}).context;
const stature = DATASET_MANIFEST.subjectStature;
const centroids = new Map(DATASET_MANIFEST.bones.map((b) => [b.id, b.centroid]));

/** Millimetres from a point in the dataset's world frame to the nearest vertex of one bone. */
function millimetresFrom(bone: string, world: readonly [number, number, number]): number {
  const mesh = assets.bones.get(bone);
  if (!mesh) throw new Error(`'${bone}' is not in the packed dataset`);
  let best = Number.POSITIVE_INFINITY;
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    const d =
      ((p[i] as number) - world[0]) ** 2 +
      ((p[i + 1] as number) - world[1]) ** 2 +
      ((p[i + 2] as number) - world[2]) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best) * 1000;
}

/** A bone-local offset, in the dataset's world frame. */
function worldOf(bone: string, local: readonly [number, number, number]) {
  const c = centroids.get(bone);
  if (!c) throw new Error(`'${bone}' is not in the packed dataset`);
  return [
    local[0] + (c[0] as number),
    local[1] + (c[1] as number),
    local[2] + (c[2] as number),
  ] as const;
}

/** How far a measured attachment may sit from its own bone. A surface point is on the surface. */
const ENDPOINT_CEILING_MM = 10;

/**
 * How far a carried via point currently sits from its bone, at worst, by bone.
 *
 * Not a target. These are measurements of the frame correspondences described in
 * `tools/cli/bin/generate-muscle-via-points.mjs`, one per bone group. What is left is what those
 * correspondences do not reach: the scapula, a broad flat bone carried on the arm's frame and
 * with no frame of its own, and the ordinary standoff of a tendon in its sheath. Every number
 * here may fall and none may rise.
 */
const VIA_CEILING_MM: Readonly<Record<string, number>> = {
  scapula: 56.7,
  // Rose from 12.5 when the supinator's side site was put on the radial head's wrap cylinder: it
  // stands off that surface, 1.6 mm outside a 10.9 mm radius about the pronation axis, not off
  // the bone, and the radial neck below the head is narrower than the head.
  radius: 13,
  femur: 29,
  humerus: 23.6,
  // The leg's rose on 2026-09-27, when the malleoli stopped being projected onto the bone and
  // were answered by their own rules again (OQ-032). The shank's frame correspondence is built on
  // them, and turned by the move, it carries the foot's points a few millimetres further off
  // their bones: the first metatarsal's from 4.8 to 11.9, the navicular's from 4.5 to 7.9.
  fibula: 24.6,
  tibia: 22.8,
  calcaneus: 22,
  ulna: 17.8,
  cuneiform_medial: 20.5,
  metatarsal_4: 11.4,
  cuboid: 11.3,
  metatarsal_1: 12,
  navicular: 8,
  patella: 0.1,
  // The clavicular head of pectoralis major's one point on the clavicle, drawn in to 5 mm: carried,
  // it arrived 57 mm off the bone on the upper arm's frame.
  clavicle: 5.1,
};

const sideless = (bone: string) => bone.replace(/_[rl]$/, '');

describe('the attachments this skeleton carries', () => {
  it('puts every origin, insertion and ligament on the bone it names', () => {
    const document = buildDocument();
    const sites = document.attachmentSites.filter((s) => s.kind !== 'tendon_via_point');
    expect(sites.length).toBeGreaterThan(400);
    const worst: { id: string; mm: number }[] = [];
    for (const site of sites) {
      if (!assets.bones.has(site.bone)) continue;
      const local = [
        evaluate(site.position.x, context),
        evaluate(site.position.y, context),
        evaluate(site.position.z, context),
      ] as const;
      const mm = millimetresFrom(site.bone, worldOf(site.bone, local));
      if (mm > ENDPOINT_CEILING_MM) worst.push({ id: site.id, mm });
    }
    expect(worst.map((w) => `${w.id} ${w.mm.toFixed(1)} mm`)).toEqual([]);
  });

  it('keeps every carried via point inside the ceiling its bone has been measured at', () => {
    expect(MUSCLE_VIA_POINTS.length).toBeGreaterThan(150);
    const over: string[] = [];
    const unlisted = new Set<string>();
    for (const via of MUSCLE_VIA_POINTS) {
      const bone = sideless(via.bone);
      const ceiling = VIA_CEILING_MM[bone];
      if (ceiling === undefined) {
        unlisted.add(bone);
        continue;
      }
      const local = via.local.map((c) => c * stature) as unknown as readonly [
        number,
        number,
        number,
      ];
      const mm = millimetresFrom(via.bone, worldOf(via.bone, local));
      if (mm > ceiling)
        over.push(`${via.id} ${mm.toFixed(1)} mm on ${via.bone}, ceiling ${ceiling}`);
    }
    expect(over).toEqual([]);
    // A bone that has never been measured is a bone whose via points nobody has looked at.
    expect([...unlisted]).toEqual([]);
  });

  it('holds the ceilings to what the carry-over actually achieves, so they can only fall', () => {
    // The table is a record of a known error, so a number left far above the measurement would
    // quietly let the error grow back. Each ceiling is within a millimetre of its bone's worst.
    const worstOf = new Map<string, number>();
    for (const via of MUSCLE_VIA_POINTS) {
      const bone = sideless(via.bone);
      const local = via.local.map((c) => c * stature) as unknown as readonly [
        number,
        number,
        number,
      ];
      const mm = millimetresFrom(via.bone, worldOf(via.bone, local));
      worstOf.set(bone, Math.max(worstOf.get(bone) ?? 0, mm));
    }
    const slack = [...worstOf.entries()]
      .map(([bone, mm]) => ({ bone, slack: (VIA_CEILING_MM[bone] ?? 0) - mm }))
      .filter((s) => s.slack > 1)
      .map((s) => `${s.bone} has ${s.slack.toFixed(1)} mm of slack`);
    expect(slack).toEqual([]);
  });
});
