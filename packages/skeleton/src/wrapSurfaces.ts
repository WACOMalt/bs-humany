/**
 * Wrapping surfaces: the bone a muscle turns over where it crosses a joint.
 *
 * A tendon crossing a joint does not run straight from one attachment to the other. It lies
 * against the bone at the joint and turns over it, and how far that surface stands off the joint
 * axis *is* the muscle's moment arm. Leave the surface out and the moment arm is whatever the
 * straight line happens to give, which at the elbow means the triceps arm falls from 20 mm at
 * full extension to zero at about 2 rad of flexion and then reverses sign -- the extensor becomes
 * a flexor, and a fully driven triceps holds a bent elbow bent. Muscle spec 13.2 calls a sign
 * change where published data shows none a hard failure, and it is right to.
 *
 * ## Coaxial with the joint, by construction
 *
 * The surface is placed on the joint's own axis and centre rather than fitted freely. That is not
 * a convenience: a tendon riding over a surface coaxial with the joint has a moment arm of exactly
 * that surface's radius at every angle, which is what a pulley is and what published moment arm
 * curves look like. A surface fitted with its own axis would disagree with the joint by a degree
 * or so and give the arm a wobble with no anatomy behind it.
 *
 * The elbow's flexion axis is the line through the humeral epicondyles (Wu 2005, 3.3), which is
 * the Z of the humerus ISB frame, so the cylinder simply takes that frame's orientation. The
 * radius is the one mesh fact here, measured by `tools/ingest/src/wrapRadii.ts` about that same
 * axis so the two cannot drift apart.
 *
 * ## What this is not
 *
 * The trochlea is not really a cylinder: it has a groove down the middle, which is why the
 * measured radius carries a spread of 3 mm around 18. A cylinder is the surface a tendon bears
 * on, not the surface the bone has, and the spread is the record of how good that idealisation
 * is. The capitulum, the other half of the elbow's articular surface, is not represented at all
 * -- the path solver takes one surface per span until N1.5.
 */

import radiiJson from '@bs-humany/assets-anatomical/data/wrap-radii.json' with { type: 'json' };
import { frameFromLandmarkPoints } from '@bs-humany/frames';
import { type WrappingSurfaceDef, cite, mul, param, writeExtension } from '@bs-humany/hsdl';
import { DATASET_MANIFEST } from './dataset.js';
import { type Ref, refWorld } from './frames.js';
import { PROVENANCE_NS } from './landmarks.js';

const vec = (p: readonly [number, number, number]) => ({ x: p[0], y: p[1], z: p[2] });

interface RadiusRow {
  readonly bone: string;
  readonly feature: string;
  readonly description: string;
  readonly radius: number;
  readonly vertices: number;
  readonly spread: number;
  readonly halfLength: number;
  readonly rule: string;
}

const RADII: readonly RadiusRow[] = (
  radiiJson as unknown as { readonly radii: readonly RadiusRow[] }
).radii;

/** The measured radius for a bone's surface, or a thrown error naming what is missing. */
export function wrapRadius(bone: string, feature: string): RadiusRow {
  const found = RADII.find((r) => r.bone === bone && r.feature === feature);
  if (!found) {
    throw new Error(
      `No measured wrap radius for '${feature}' on '${bone}'. Run ` +
        '`pnpm --filter @bs-humany/ingest wrap-radii` to measure it from the meshes.',
    );
  }
  return found;
}

/**
 * How long a wrap cylinder is made, relative to the surface measured.
 *
 * The measurement covers the middle of the trochlea, which is the part a tendon bears on; the
 * bone runs a little wider than that on both sides. A cylinder cut to exactly the measured extent
 * would have tendons slipping off its rim within the joint's normal range, and a tendon that has
 * slipped off a surface stops being constrained by it -- which is a length discontinuity for no
 * anatomical reason. Half again is enough to keep the contact inside the bone it stands for.
 */
export const LENGTH_MARGIN = 1.5;

interface SurfaceSpec {
  readonly id: string;
  readonly bone: string;
  readonly displayName: string;
  /** The joint centre the cylinder sits on. */
  readonly centre: Ref;
  readonly feature: string;
  /** Landmarks defining the bone's ISB frame, whose Z is the axis the cylinder runs along. */
  readonly frame: {
    readonly origin: Ref;
    readonly primaryFrom: Ref;
    readonly primaryTo: Ref;
    readonly secondaryFrom: Ref;
    readonly secondaryTo: Ref;
  };
  readonly source: ReturnType<typeof cite>;
}

function sideSpecs(s: 'l' | 'r'): SurfaceSpec[] {
  const side = s === 'r' ? 'right' : 'left';
  return [
    {
      id: `elbow_trochlea_${s}`,
      bone: `humerus_${s}`,
      displayName: `Humeral trochlea, ${side}`,
      centre: { virtual: `humerus_${s}__mid_el_em` },
      feature: 'Trochlea_of_humerus__wrap_radius',
      // The humerus ISB frame, exactly as `frames.ts` states it (Wu 2005, 2.3.4 option 1): Y from
      // the mid-epicondyle point up to GH, Z along the epicondyles to the right. That Z is the
      // elbow's flexion axis, which is what the cylinder has to run along.
      frame: {
        origin: [`humerus_${s}`, 'GH'],
        primaryFrom: { virtual: `humerus_${s}__mid_el_em` },
        primaryTo: [`humerus_${s}`, 'GH'],
        secondaryFrom: [`humerus_${s}`, 'EM'],
        secondaryTo: [`humerus_${s}`, 'EL'],
      },
      source: cite(
        'wu2005',
        '3.3, elbow: flexion about the humeral epicondylar axis. The radius is measured from ' +
          'the mesh; only the placement comes from here.',
      ),
    },
  ];
}

/**
 * The wrapping surfaces, in bone-local coordinates that scale with stature.
 *
 * Bone-local here is the dataset world frame translated to the bone's centroid, which is how every
 * other point in this package is expressed -- so the cylinder's own rotation is its ISB frame's
 * world rotation, with nothing further to compose.
 */
export function buildWrappingSurfaces(): WrappingSurfaceDef[] {
  const centroids = new Map(DATASET_MANIFEST.bones.map((b) => [b.id, b.centroid]));
  const out: WrappingSurfaceDef[] = [];

  for (const s of ['r', 'l'] as const) {
    for (const spec of sideSpecs(s)) {
      const centroid = centroids.get(spec.bone);
      if (!centroid)
        throw new Error(`Wrap surface '${spec.id}' is on unpacked bone '${spec.bone}'.`);
      const measured = wrapRadius(spec.bone, spec.feature);

      const frame = frameFromLandmarkPoints({
        origin: vec(refWorld(spec.frame.origin)),
        primaryFrom: vec(refWorld(spec.frame.primaryFrom)),
        primaryTo: vec(refWorld(spec.frame.primaryTo)),
        primaryAxis: 'y',
        secondaryFrom: vec(refWorld(spec.frame.secondaryFrom)),
        secondaryTo: vec(refWorld(spec.frame.secondaryTo)),
        secondaryAxis: 'z',
      });

      const world = refWorld(spec.centre);
      const local = (i: 0 | 1 | 2) => (world[i] as number) - (centroid[i] as number);
      const scaled = (i: 0 | 1 | 2) =>
        mul(local(i) / DATASET_MANIFEST.subjectStature, param('stature'));
      const metres = (v: number) => mul(v / DATASET_MANIFEST.subjectStature, param('stature'));

      out.push({
        id: spec.id,
        bone: spec.bone,
        displayName: spec.displayName,
        transform: {
          translation: { x: scaled(0), y: scaled(1), z: scaled(2) },
          rotation: frame.rotation,
        },
        shape: {
          kind: 'cylinder',
          radius: metres(measured.radius),
          length: metres(measured.halfLength * 2 * LENGTH_MARGIN),
        },
        source: spec.source,
        ext: writeExtension(undefined, PROVENANCE_NS, {
          dataset: DATASET_MANIFEST.dataset.name,
          datasetVersion: DATASET_MANIFEST.dataset.version,
          sourceSha256: DATASET_MANIFEST.dataset.sourceSha256,
          locatedBy: `${measured.rule}; placed on the ${spec.centre} axis`,
          radiusSpread: measured.spread,
          radiusVertices: measured.vertices,
        }),
      });
    }
  }

  return out;
}
