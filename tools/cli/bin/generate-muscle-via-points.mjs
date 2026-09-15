#!/usr/bin/env node
/**
 * Carries the reference model's muscle via points into this skeleton's bone frames -- OQ-015.
 *
 *   pnpm generate:via-points          # rewrite packages/skeleton/src/muscleViaPoints.ts
 *   pnpm generate:via-points --check  # fail if the file is not what this would write
 *
 * A muscle does not run straight from its origin to its insertion: it lies along the bones it
 * passes, and published models hold it there with via points. Without them the elbow flexors cut
 * through the humerus, and their moment arms are wrong in the direction of being far too large --
 * the biceps peaks at 65 mm against a published 36 to 40.
 *
 * Wrapping surfaces were tried first and are not the answer for a muscle running *along* a bone.
 * A cylinder is a poor model of a humerus: narrow through the shaft, flared at both ends, so one
 * wide enough to catch a muscle near the ends stands clear of the bone in the middle. The
 * measurements are in OQ-015. Via points are what the reference model uses, and they are what
 * this brings over.
 *
 * ## The frames problem, and how it is solved
 *
 * The reference model's points are in its own body frames, which are not ours -- a coordinate
 * lifted from one frame into another is a number that means nothing where it lands. So nothing is
 * lifted. Instead both models are asked for the same *anatomical* construction, and the transform
 * between the two answers is what carries the points across:
 *
 *   - The origin is the glenohumeral centre. In the reference model that is the humerus body's
 *     own frame origin; here it is the fitted centre of the humeral head.
 *   - One axis runs from the elbow up to that origin: the bone's long axis. The reference model
 *     gives the elbow as the forearm body's offset; here it is the midpoint of the epicondyles.
 *   - The other is the elbow's flexion axis. The reference model states it as a joint axis; here
 *     it is the line through the epicondyles.
 *
 * That is the same frame the ISB defines for the humerus (Wu 2005, 2.3.4), built twice from
 * whatever each model happens to carry. Two frames of the same bone, so the rotation between them
 * is the disagreement between two conventions and nothing else.
 *
 * Lengths are scaled by the ratio of the two humeri, so a point a third of the way down one bone
 * lands a third of the way down the other, and then divided by this subject's stature so it
 * scales with the morphology like every other point in the skeleton.
 *
 * ## One frame, the whole arm
 *
 * Every body in the reference model's arm is a pure translation of its parent at the neutral pose,
 * so adding the offsets down the chain puts every site in the humerus frame and the single
 * correspondence above carries points on the scapula and the forearm too. Both models put the
 * elbow at zero when extended and the forearm at zero in neutral rotation, so the two neutral
 * poses are the same pose.
 *
 * Lengths are scaled by the humerus ratio throughout, forearm points included. That assumes the
 * two skeletons have similar proportions; where they do not, a forearm point is out by the
 * difference between the two ratios, which is a few per cent of a bone.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CHAIN = 'myoarm_r_chain.xml';
const TENDON = 'myoarm_r_tendon.xml';
const SOURCE = join(ROOT, 'tools/validate-external/myo_sim', CHAIN);
const OUT = join(ROOT, 'packages/skeleton/src/muscleViaPoints.ts');
const check = process.argv.includes('--check');

const jiti = createJiti(import.meta.url);
const frames = await jiti.import(join(ROOT, 'packages/frames/src/index.ts'));
const skeleton = await jiti.import(join(ROOT, 'packages/skeleton/src/index.ts'));

/** Which of our units is which of the reference model's tendons. */
const UNITS = [
  { unit: 'biceps_brachii_long_r', tendon: 'BIClong' },
  { unit: 'biceps_brachii_short_r', tendon: 'BICshort' },
  { unit: 'brachialis_r', tendon: 'BRA' },
  { unit: 'brachioradialis_r', tendon: 'BRD' },
  { unit: 'triceps_brachii_long_r', tendon: 'TRIlong' },
  { unit: 'triceps_brachii_lateral_r', tendon: 'TRIlat' },
  { unit: 'triceps_brachii_medial_r', tendon: 'TRImed' },
];

/**
 * Which of a tendon's points are via points on the humerus.
 *
 * Read off the reference model's own path rather than assumed, because assuming gets it wrong.
 * The rule is the definition: a point is a via point if the path passes *through* it, so the
 * first and last are the origin and the insertion however they happen to be numbered. Brachialis
 * and brachioradialis are named P1 at the humerus and that P1 is where each one starts, not
 * somewhere it passes; the long head of triceps has a P1b between its first wrap and its P2 that
 * a numeric guess skips entirely.
 */
function viaPoints(tendon) {
  const block = tendonBlock(tendon);
  const path = [...block.matchAll(/<(?:site|geom) (?:site|geom)="([^"]+)"/g)].map((m) => m[1]);
  return path.filter((name, i) => i > 0 && i < path.length - 1 && sites.has(name));
}

// --- The reference model's humerus ---------------------------------------------------------

const xml = readFileSync(SOURCE, 'utf8');

function bodyBlock(name) {
  const start = xml.indexOf(`<body name="${name}"`);
  if (start < 0) throw new Error(`${CHAIN} has no body '${name}'`);
  // Up to the next nested body, which is where this body's own sites end.
  const next = xml.indexOf('<body ', start + 1);
  return xml.slice(start, next < 0 ? xml.length : next);
}

const tendonXml = readFileSync(join(ROOT, 'tools/validate-external/myo_sim', TENDON), 'utf8');

function tendonBlock(name) {
  const m = tendonXml.match(new RegExp(`<spatial name="${name}_tendon"[^>]*>(.*?)</spatial>`, 's'));
  if (!m) throw new Error(`${TENDON} has no tendon '${name}'`);
  return m[1];
}

function attribute(block, pattern) {
  const m = block.match(pattern);
  if (!m) throw new Error(`${CHAIN}: no match for ${pattern}`);
  return m[1].trim().split(/\s+/).map(Number);
}

const humerusBlock = bodyBlock('humerus_r');
// The forearm's offset from the humerus is the elbow centre in the humerus frame.
const elbowCentre = attribute(
  xml.slice(xml.indexOf('<body name="ulna_r"')),
  /^<body name="ulna_r"[^>]*pos="([^"]+)"/,
);
const elbowAxis = attribute(xml, /<joint axis="([^"]+)" name="elbow_flexion_r"/);

/**
 * Every site of the arm, in the reference model's humerus frame, with the bone it belongs to.
 *
 * Each body in that model is a pure translation of its parent at the neutral pose -- none carries
 * a rotation -- so adding the offsets down the chain puts every site in one frame, and a single
 * frame correspondence carries the whole arm rather than needing one per bone.
 */
const BODIES = [
  { body: 'scapula_r', bone: 'scapula_r' },
  { body: 'humerus_r', bone: 'humerus_r' },
  { body: 'ulna_r', bone: 'ulna_r' },
  { body: 'radius_r', bone: 'radius_r' },
];

const sites = new Map();
{
  const bodyPos = (name) =>
    attribute(
      xml.slice(xml.indexOf(`<body name="${name}"`)),
      new RegExp(`^<body name="${name}"[^>]*pos="([^"]+)"`),
    );
  const offset = new Map([
    ['scapula_r', [0, 0, 0]],
    ['humerus_r', [0, 0, 0]],
  ]);
  offset.set('ulna_r', bodyPos('ulna_r'));
  const forearm = offset.get('ulna_r');
  const radius = bodyPos('radius_r');
  offset.set('radius_r', [forearm[0] + radius[0], forearm[1] + radius[1], forearm[2] + radius[2]]);

  for (const { body, bone } of BODIES) {
    const at = offset.get(body);
    for (const m of bodyBlock(body).matchAll(/<site name="([^"]+)" pos="([^"]+)"/g)) {
      const p = m[2].trim().split(/\s+/).map(Number);
      sites.set(m[1], { bone, point: [at[0] + p[0], at[1] + p[1], at[2] + p[2]] });
    }
  }
}

// --- Frame arithmetic ------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (v) => {
  const n = Math.hypot(...v) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};

/**
 * The humerus frame, from the two things both models can state: the long axis and the elbow axis.
 *
 * Y up the bone, Z along the elbow's axis with whatever component along Y removed, X completing
 * a right-handed set. The same recipe `frames.ts` uses, so the two frames differ only by the
 * conventions they were each built under.
 */
function humerusFrame(gh, elbow, flexionAxis) {
  const y = norm(sub(gh, elbow));
  const raw = norm(flexionAxis);
  const z = norm(
    sub(
      raw,
      y.map((c) => c * dot(raw, y)),
    ),
  );
  const x = cross(y, z);
  // Columns are the frame's axes in the parent coordinates, so this maps frame -> parent.
  return [x, y, z];
}

/** Express a point given in the parent coordinates in the frame's own. */
const intoFrame = (basis, origin, p) => {
  const d = sub(p, origin);
  return [dot(d, basis[0]), dot(d, basis[1]), dot(d, basis[2])];
};

/** Express a point given in the frame's coordinates in the parent's. */
const outOfFrame = (basis, origin, q) => [
  origin[0] + basis[0][0] * q[0] + basis[1][0] * q[1] + basis[2][0] * q[2],
  origin[1] + basis[0][1] * q[0] + basis[1][1] * q[1] + basis[2][1] * q[2],
  origin[2] + basis[0][2] * q[0] + basis[1][2] * q[1] + basis[2][2] * q[2],
];

// The reference model's frame: the humerus body's origin is its own shoulder centre.
const referenceOrigin = [0, 0, 0];
const referenceBasis = humerusFrame(referenceOrigin, elbowCentre, elbowAxis);
const referenceLength = Math.hypot(...elbowCentre);

// Ours, built from the landmarks the same way.
const gh = skeleton.refWorld(['humerus_r', 'GH']);
const em = skeleton.refWorld(['humerus_r', 'EM']);
const el = skeleton.refWorld(['humerus_r', 'EL']);
const midEpicondyle = [(em[0] + el[0]) / 2, (em[1] + el[1]) / 2, (em[2] + el[2]) / 2];
const ourBasis = humerusFrame(gh, midEpicondyle, sub(el, em));
const ourLength = Math.hypot(...sub(gh, midEpicondyle));
const scale = ourLength / referenceLength;

const centroids = new Map(skeleton.DATASET_MANIFEST.bones.map((b) => [b.id, b.centroid]));
const stature = skeleton.DATASET_MANIFEST.subjectStature;

// --- Carry the points across -------------------------------------------------------------------

const round = (v) => Number(v.toPrecision(6));
const rows = [];
for (const spec of UNITS) {
  const names = viaPoints(spec.tendon);
  let index = 0;
  for (const name of names) {
    index++;
    const site = sites.get(name);
    if (!site) throw new Error(`${CHAIN}: no site '${name}' on any arm body`);
    const centroid = centroids.get(site.bone);
    if (!centroid) throw new Error(`'${site.bone}' is not in the packed dataset`);
    const inReference = intoFrame(referenceBasis, referenceOrigin, site.point);
    const scaled = inReference.map((c) => c * scale);
    const world = outOfFrame(ourBasis, gh, scaled);
    rows.push({
      id: `${spec.unit}__via_${index}`,
      unit: spec.unit,
      order: index,
      bone: site.bone,
      site: name,
      local: [
        round((world[0] - centroid[0]) / stature),
        round((world[1] - centroid[1]) / stature),
        round((world[2] - centroid[2]) / stature),
      ],
    });
  }
  console.error(
    `  ${spec.unit.padEnd(26)} ${String(names.length).padStart(2)} via point(s) on ` +
      `${[...new Set(names.map((n) => sites.get(n).bone))].join(', ') || '(none)'}`,
  );
}

const body = rows
  .map(
    (r) => `  {
    id: '${r.id}',
    unit: '${r.unit}',
    order: ${r.order},
    bone: '${r.bone}',
    referenceSite: '${r.site}',
    local: [${r.local.join(', ')}],
  },`,
  )
  .join('\n');

const rendered = `/**
 * Muscle via points, carried over from the reference model's frames into ours.
 *
 * **Generated by \`pnpm generate:via-points\`. Do not edit.**
 *
 * A muscle lies along the bones it passes rather than running straight between its attachments,
 * and published models hold it there with via points. Without them the elbow flexors cut through
 * the humerus and their moment arms come out far too large -- biceps peaked at 65 mm against a
 * published 36 to 40.
 *
 * ## Why these are not simply transcribed
 *
 * The reference model states them in its own body frames, and a coordinate lifted from one frame
 * into another means nothing where it lands. So both models are asked for the same *anatomical*
 * construction instead -- the glenohumeral centre, the bone's long axis, the elbow's flexion axis,
 * which is the humerus frame the ISB defines (Wu 2005, 2.3.4) -- and the rotation between the two
 * answers is the disagreement between two conventions and nothing else. Lengths are scaled by the
 * ratio of the two humeri, so a point a third of the way down one lands a third of the way down
 * the other.
 *
 * The transform was measured, not assumed: the two frames differ by ${((Math.acos(Math.min(1, Math.max(-1, dot(referenceBasis[1], [0, 1, 0])))) * 180) / Math.PI).toFixed(1)} degrees about the long
 * axis, and the humeri by a factor of ${scale.toFixed(4)} in length.
 *
 * Positions are a fraction of the subject's stature, as every other point in this package is, so
 * they scale with the morphology.
 */

/** One point a muscle passes through, in the order it meets them from origin to insertion. */
export interface MuscleViaPoint {
  readonly id: string;
  /** The muscle-tendon unit this point belongs to. */
  readonly unit: string;
  /** Position in the path, ascending from the origin. */
  readonly order: number;
  /** The bone it is fixed to, and moves with. */
  readonly bone: string;
  /** The reference model's own name for it, so the number can be traced back. */
  readonly referenceSite: string;
  /** Bone-local, as a fraction of stature. */
  readonly local: readonly [number, number, number];
}

export const MUSCLE_VIA_POINTS: readonly MuscleViaPoint[] = [
${body}
];

/** The points of one unit, in path order. */
export function viaPointsFor(unit: string): readonly MuscleViaPoint[] {
  return MUSCLE_VIA_POINTS.filter((p) => p.unit === unit).sort((a, b) => a.order - b.order);
}
`;

const existing = (() => {
  try {
    return readFileSync(OUT, 'utf8');
  } catch {
    return undefined;
  }
})();

if (check) {
  if (existing !== rendered) {
    console.error(
      `generate-via-points: ${relative(ROOT, OUT)} is not what the generator would write.\n` +
        '  Run `pnpm generate:via-points`.',
    );
    process.exit(1);
  }
  console.log(`generate-via-points: ok. ${rows.length} points match ${CHAIN}.`);
} else {
  writeFileSync(OUT, rendered);
  console.log(
    `generate-via-points: wrote ${relative(ROOT, OUT)} -- ${rows.length} points from ${CHAIN}.`,
  );
  console.log(
    `  humerus length: reference ${(referenceLength * 1000).toFixed(1)} mm, ours ${(ourLength * 1000).toFixed(1)} mm, scale ${scale.toFixed(4)}`,
  );
}
