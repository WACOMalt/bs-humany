/**
 * Assembling the Blender export from a running simulation.
 *
 * Nodes are the document's bones in their anatomical hierarchy, parents before children; each
 * carries the measured mesh at rest (scaled to stature, as the viewer draws it), and the
 * keyframes are the captured bone transforms at every stride-th tick -- every tick, unless one
 * output frame would hold more than `MAX_SAMPLES_PER_FRAME` of them. The muscle bellies are one
 * mesh beside them, moved by a PC2 vertex cache of one sample per output frame. The glTF writer
 * moves meshes into bone frames and keyframes into parent-relative form; this module only
 * gathers the pieces and the provenance that goes with them.
 */

import type { SkeletonAssets } from '@bs-humany/assets-anatomical';
import { attributionText } from '@bs-humany/assets-anatomical';
import {
  type ExportNode,
  blenderImportScript,
  boxMesh,
  buildAnimatedGlb,
  newestAtOrBefore,
  planeMesh,
  writePointCache,
} from '@bs-humany/export-gltf';
import { IDENTITY_TRANSFORM, type Transform, compose, transformPoint } from '@bs-humany/frames';
import { type HsdlDocument, evaluate, param } from '@bs-humany/hsdl';
import {
  BEAD_RADIUS,
  DISC_HEIGHT,
  DISC_RADIUS,
  type Simulation,
  barMesh,
  cylinderMesh,
  sphereMesh,
  tissueOf,
} from '@bs-humany/session';
import { computeWorldTransforms } from '@bs-humany/skeleton';
import { sweepRings } from './ringSweep.js';

export interface BlenderExport {
  readonly glb: Uint8Array;
  readonly script: string;
  readonly glbFileName: string;
  readonly scriptFileName: string;
  /** Keyframes written, which is the recording's samples after the stride. */
  readonly frames: number;
  /** Recorded samples skipped between keyframes; 1 when every one was kept. */
  readonly stride: number;
  /** The belly vertex cache and its file name, absent when no muscles were running. */
  readonly pointCache?: { readonly name: string; readonly bytes: Uint8Array } | undefined;
  /** Simulation steps per second, which is what sets a keyframe's time. */
  readonly rate: number;
  /** Frames a second of the exported timeline is divided into. */
  readonly outputFramerate: number;
  /** Simulated seconds the export covers, which is the same number of seconds in Blender. */
  readonly seconds: number;
  readonly full: boolean;
}

/** Bone order with every parent before its children, from the document's hierarchy. */
function hierarchyOrder(document: HsdlDocument): { id: string; parent: number }[] {
  const byId = new Map(document.bones.map((b) => [b.id, b]));
  const placed = new Map<string, number>();
  const out: { id: string; parent: number }[] = [];
  const place = (id: string): number => {
    const known = placed.get(id);
    if (known !== undefined) return known;
    const bone = byId.get(id);
    if (!bone) return -1;
    const parent = bone.parent ? place(bone.parent) : -1;
    const index = out.push({ id, parent }) - 1;
    placed.set(id, index);
    return index;
  };
  for (const bone of document.bones) place(bone.id);
  return out;
}

/** Place a local mesh in the world, which is how the writer expects rest geometry. */
function worldMesh(
  mesh: { positions: Float32Array; indices: Uint32Array },
  at: Transform,
): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p = transformPoint(at, {
      x: mesh.positions[i] ?? 0,
      y: mesh.positions[i + 1] ?? 0,
      z: mesh.positions[i + 2] ?? 0,
    });
    positions[i] = p.x;
    positions[i + 1] = p.y;
    positions[i + 2] = p.z;
  }
  return { positions, indices: mesh.indices };
}

/**
 * Our coordinates into the ones Blender's glTF importer will have left everything else in.
 *
 * glTF is +Y up and Blender is +Z up, and the importer does not resolve that with an object
 * rotation -- it bakes `(x, y, z) -> (x, -z, y)` into the mesh data and leaves the object's matrix
 * at identity. Measured, not assumed: a vertex written at `(0.1588, 1.6116, 0.0342)` comes back
 * out of the importer at `(0.1588, -0.0342, 1.6116)`.
 *
 * The vertex cache does not go through that importer. It is read by a modifier, straight off
 * disk, into the mesh's own space -- so it has to arrive already converted or the bellies sit
 * ninety degrees about X away from the bones they belong to, which is exactly what they did.
 *
 * The rest mesh in the glTF is deliberately *not* converted here: that one does go through the
 * importer and would be converted twice.
 */
function toBlenderAxes(from: Float64Array, into: Float32Array, vertices: number): void {
  for (let v = 0; v < vertices; v++) {
    into[v * 3] = from[v * 3] as number;
    into[v * 3 + 1] = -(from[v * 3 + 2] as number);
    into[v * 3 + 2] = from[v * 3 + 1] as number;
  }
}

/**
 * The most keyframes worth writing inside one output frame.
 *
 * Fifty is a ceiling rather than a target, and it is there because a sample costs one thing here
 * and another in Blender: twenty-eight bytes in a flat array against a BezTriple with two handles
 * and an interpolation mode, some seventy bytes, in a curve that has to be sorted and evaluated.
 * Fifty inside a frame is already more resolution than a frame can show; past that the file is
 * paying for detail only a re-render at a far higher frame rate could reach, in the one currency
 * Blender is short of.
 */
export const MAX_SAMPLES_PER_FRAME = 50;

/** Recorded samples to skip between keyframes, so no output frame holds more than the ceiling. */
export function exportStride(stepsPerSecond: number, outputFramerate: number): number {
  const perFrame = stepsPerSecond / Math.max(1, outputFramerate);
  return Math.max(1, Math.ceil(perFrame / MAX_SAMPLES_PER_FRAME));
}

/** Keyframes a recording of this many samples yields at this stride. */
export function sampleCount(frames: number, stride: number): number {
  if (frames <= 0) return 0;
  return Math.floor((frames - 1) / stride) + 1;
}

/** One muscle's slice of the joined belly mesh, so the import script can name it. */
export interface MuscleVertexGroup {
  readonly name: string;
  readonly displayName: string;
  readonly start: number;
  readonly count: number;
}

/**
 * The ring capture's flat view, and the one question the export asks of it: which ring frame was
 * showing at a bone tick. The newest at or before it, which is what `MuscleRingCapture`'s own
 * `indexForTick` answers; written against the view here because the export holds a view rather
 * than the capture itself, and the view carries each frame's tick for it.
 */
interface RingView {
  readonly frames: number;
  readonly rings: number;
  readonly ticks: Int32Array;
  readonly position: Float32Array;
  readonly orientation: Float32Array;
  readonly radius: Float32Array;
}

function ringIndexForTick(view: RingView, tick: number): number {
  return newestAtOrBefore(view.frames, (index) => view.ticks[index] ?? -1, tick);
}

/**
 * Sweep one ring frame of the view into belly vertices, with the studio's one sweep -- the one
 * the playhead and the followed tubes use, so the cache holds what was on screen. The view is one
 * contiguous block per stream, so a frame is a subarray and nothing is copied out of it first.
 */
function sweepRingFrame(
  view: RingView,
  index: number,
  segments: number,
  position: Float64Array,
  normal: Float64Array,
): boolean {
  if (index < 0 || index >= view.frames) return false;
  const rings = view.rings;
  sweepRings(
    view.position.subarray(index * rings * 3, (index + 1) * rings * 3),
    view.orientation.subarray(index * rings * 4, (index + 1) * rings * 4),
    view.radius.subarray(index * rings, (index + 1) * rings),
    rings,
    segments,
    position,
    normal,
  );
  return true;
}

export function buildBlenderExport(
  simulation: Simulation,
  document: HsdlDocument,
  assets: SkeletonAssets,
): BlenderExport {
  const capture = simulation.capture.view();
  // One keyframe per simulation step, or per stride-th step, timed in seconds. That is the whole
  // of the timing contract: a second of simulated time is a second of Blender timeline, however
  // many steps went into it and whatever frame rate the scene is set to. Nothing here resamples.
  const rate = simulation.stepsPerSecond;
  const outputFramerate = Math.max(1, Math.round(simulation.outputFramerate));
  // How many recorded samples to skip between keyframes. One means none are skipped, which is the
  // usual answer: a thousand steps a second into a sixty fps scene is seventeen samples a frame,
  // well inside the ceiling. It bites when the output rate is low against the step rate -- a
  // thousand steps into twelve fps is eighty-three a frame, and eighty-three keyframes inside one
  // frame is eighty-three nobody will ever see between two they will.
  const stride = exportStride(rate, outputFramerate);
  const context = simulation.resolved.context;
  const stature = evaluate(param('stature'), context);
  const datasetScale = stature / assets.manifest.subjectStature;
  const rest = computeWorldTransforms(document, context);
  const order = hierarchyOrder(document);
  const channelIndex = new Map(simulation.boneOrder().map((id, i) => [id, i]));

  const nodes: ExportNode[] = order.map(({ id, parent }) => {
    const bone = document.bones.find((b) => b.id === id);
    const measured = assets.bones.get(id);
    const positions = measured
      ? Float32Array.from(measured.positions, (v) => v * datasetScale)
      : undefined;
    return {
      id,
      parent,
      restWorld: rest.get(id) ?? IDENTITY_TRANSFORM,
      ...(positions && measured ? { mesh: { positions, indices: measured.indices } } : {}),
      extras: {
        displayName: bone?.displayName,
        ta: bone?.ta,
        region: bone?.region,
        segment: simulation.segmentOfBone(id),
      },
    };
  });

  // Joint centres, one node each, parented to the bone the pivot is fixed in. They carry no
  // channels of their own: a joint frame is rigid in its parent bone, so inheriting that bone's
  // animation puts each pivot exactly where the solver had it. This is what makes a pivot
  // checkable against the bone it turns inside.
  const boneNode = new Map(nodes.map((n, i) => [n.id, i]));
  const model = simulation.articulation;
  // The connective tissue: a disc or a bead is rigid in its joint's parent, so it is the joint
  // node's own mesh and moves with the bone the node inherits from; a bar of cartilage moves
  // with two segments, so it is a skinned mesh with one end bound to each. Same shapes the
  // studio's overlay draws, from the same table.
  const tissue = tissueOf(model);
  const discAt = new Map(tissue.discs.map((d) => [d.joint, d]));
  const discShape = cylinderMesh(DISC_RADIUS, DISC_HEIGHT);
  const beadShape = sphereMesh(BEAD_RADIUS);
  for (const joint of model.joints) {
    const parentSegment = model.segments[joint.parentSegment];
    const host = boneNode.get(joint.parentBone);
    if (!parentSegment || host === undefined) continue;
    const restWorld = compose(parentSegment.restWorld, joint.frameInParent);
    const disc = discAt.get(joint.index);
    nodes.push({
      id: `joint__${joint.id}`,
      parent: host,
      restWorld,
      animated: false,
      ...(disc ? { mesh: worldMesh(disc.kind === 'disc' ? discShape : beadShape, restWorld) } : {}),
      extras: {
        role: disc
          ? `joint centre; ${disc.kind === 'disc' ? 'intervertebral disc' : 'costovertebral hold'}`
          : 'joint centre',
        joint: joint.id,
        parentBone: joint.parentBone,
        childBone: joint.childBone,
        dofs: joint.dofs.map((d) => ({
          axis: d.axisName,
          kind: d.kind,
          vector: [d.vector.x, d.vector.y, d.vector.z],
          range: d.range,
          neutral: d.neutral,
        })),
      },
    });
  }

  // The cartilage: one skinned bar a weld, each end bound to its segment's anchor bone.
  const tissueRoot =
    tissue.bars.length > 0
      ? nodes.push({
          id: 'tissue',
          parent: -1,
          restWorld: IDENTITY_TRANSFORM,
          animated: false,
          extras: { role: 'connective tissue: the costal cartilage, one bar a weld' },
        }) - 1
      : -1;
  for (const bar of tissue.bars) {
    const segA = model.segments[bar.a];
    const segB = model.segments[bar.b];
    const nodeA = segA ? boneNode.get(segA.anchor) : undefined;
    const nodeB = segB ? boneNode.get(segB.anchor) : undefined;
    if (!segA || !segB || nodeA === undefined || nodeB === undefined) continue;
    const sides = 6;
    const mesh = barMesh(
      transformPoint(segA.restWorld, bar.onA),
      transformPoint(segB.restWorld, bar.onB),
      undefined,
      sides,
    );
    const vertexJoint = new Uint16Array(sides * 2);
    vertexJoint.fill(1, sides);
    nodes.push({
      id: `cartilage__${bar.id}`,
      parent: tissueRoot,
      restWorld: IDENTITY_TRANSFORM,
      animated: false,
      mesh,
      skin: { joints: [nodeA, nodeB], vertexJoint },
      extras: { role: 'costal cartilage', weld: bar.id, from: segA.id, to: segB.id },
    });
  }

  // Scene geometry the body interacts with: the ground and the scenario's static boxes, as
  // unanimated nodes under their own root so they import as a separate hierarchy.
  const GROUND_HALF_SIZE = 10;
  const sceneRoot =
    nodes.push({
      id: 'scene',
      parent: -1,
      restWorld: IDENTITY_TRANSFORM,
      animated: false,
      extras: { role: 'static scene geometry' },
    }) - 1;
  const groundRest = {
    translation: { x: 0, y: simulation.groundHeight, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
  nodes.push({
    id: 'ground',
    parent: sceneRoot,
    restWorld: groundRest,
    animated: false,
    mesh: worldMesh(planeMesh(GROUND_HALF_SIZE), groundRest),
    extras: { role: 'ground plane', halfSize: GROUND_HALF_SIZE },
  });
  for (const box of simulation.staticBoxes) {
    const restWorld = {
      translation: box.position,
      rotation: box.rotation ?? { x: 0, y: 0, z: 0, w: 1 },
    };
    nodes.push({
      id: box.id,
      parent: sceneRoot,
      restWorld,
      animated: false,
      mesh: worldMesh(boxMesh(box.halfExtents), restWorld),
      extras: { role: 'static box', halfExtents: box.halfExtents, contactClass: box.contactClass },
    });
  }

  // Muscles, as one belly mesh moved by a vertex cache. A belly is swept anew along its path, so
  // it is rigid in no bone and cannot be a node with a mesh the way a bone is; what the capture
  // holds is its rings, one frame a sweep, and every vertex is rebuilt from those.
  const muscleRings = simulation.muscleCapture.view();
  const volume = simulation.muscleVolume;
  const units = simulation.muscles?.units;
  // The bone frames the rings can be laid against, as a span of ticks: every bone tick finds the
  // newest ring frame at or before it, which is the belly that was showing then. The two captures
  // are held to the same span as they are taken (`Simulation.keepCapturesLevel`), so that is
  // normally every bone frame -- but the test is whether there are rings at all rather than an
  // exact match, because an exact test means that the moment the two diverge the export writes a
  // file with an empty Muscles collection and says nothing about it. They diverge for a reason
  // that has nothing to do with the muscles being wrong: the two hold very different amounts
  // against the same budget, so the muscle capture stops first. A belly that holds its last pose
  // is a better answer than no belly.
  const muscleAvailable = muscleRings.frames > 0 ? capture.frames : 0;
  // The bellies: one mesh, and their movement in a cache beside the file rather than in it.
  //
  // They used to be a hundred and forty-eight skinned meshes over 3552 armature bones, keyed
  // every sample -- ninety-six per cent of every animation channel in the file, and measured at
  // 4.3 GB of Blender for six tenths of a second of simulation. See `pointCache.ts`. What leaves
  // now is the mesh at its first frame, joined into one object, with a PC2 vertex cache Blender
  // streams from disk through a Mesh Cache modifier. No keyframes, and the memory a scene needs
  // stops depending on how long the run was.
  const muscleGroups: MuscleVertexGroup[] = [];
  let pointCache: Uint8Array | undefined;
  let pointCacheSamples = 0;
  if (volume && units && muscleAvailable > 0 && muscleRings.rings === units.length * volume.rings) {
    const perUnit = volume.rings * volume.segments;
    const vertices = units.length * perUnit;
    // One index buffer for the joined mesh: each unit's own connectivity, shifted past the units
    // before it.
    const indices = new Uint32Array(units.length * volume.index.length);
    for (let unit = 0; unit < units.length; unit++) {
      const offset = unit * perUnit;
      for (let k = 0; k < volume.index.length; k++) {
        indices[unit * volume.index.length + k] = (volume.index[k] as number) + offset;
      }
      muscleGroups.push({
        name: units[unit]?.id ?? `unit_${unit}`,
        displayName: units[unit]?.displayName ?? units[unit]?.id ?? `unit_${unit}`,
        start: offset,
        count: perUnit,
      });
    }

    // The mesh itself is the first sample, because a Mesh Cache modifier replaces every vertex
    // anyway and a rest shape that is one of the real ones is the least surprising thing to find
    // when the modifier is turned off.
    const swept = new Float64Array(vertices * 3);
    // A PC2 cache is positions only, and Blender recomputes the normals from them; the sweep
    // writes its normals here all the same and nothing reads them.
    const sweptNormal = new Float64Array(vertices * 3);
    /** Sweep the rings showing at a bone frame of the capture into `swept`. */
    const sweepAt = (boneFrame: number): boolean =>
      sweepRingFrame(
        muscleRings,
        ringIndexForTick(muscleRings, capture.firstTick + boneFrame),
        volume.segments,
        swept,
        sweptNormal,
      );
    const positions = new Float64Array(vertices * 3);
    if (sweepAt(0)) positions.set(swept);

    nodes.push({
      id: 'muscles',
      parent: -1,
      restWorld: IDENTITY_TRANSFORM,
      animated: false,
      mesh: { positions, indices },
      extras: {
        role: 'muscle bellies, one mesh; the movement is in the .pc2 beside this file',
        units: units.length,
        rings: volume.rings,
        segments: volume.segments,
        verticesPerUnit: perUnit,
      },
    });

    // One sample per output frame, which is what a mesh cache is: Blender plays frames, and a
    // cache finer than the frames it is played at is bytes nobody reads. The bone curves keep
    // every stride-th step -- they are cheap and they are the part somebody edits. Each sample is
    // the bone frame on that output frame's tick, and the rings that were showing there.
    pointCacheSamples = Math.max(
      1,
      Math.floor(((muscleAvailable - 1) * outputFramerate) / rate) + 1,
    );
    pointCache = writePointCache(
      { points: vertices, samples: pointCacheSamples, startFrame: 0, sampleRate: 1 },
      (index, into) => {
        const at = Math.min(muscleAvailable - 1, Math.round((index * rate) / outputFramerate));
        if (sweepAt(at)) toBlenderAxes(swept, into, vertices);
      },
    );
  }

  // Keyframes in node order; a bone the pose channel does not carry stays at rest, as does
  // scene geometry.
  const n = nodes.length;
  const samples = sampleCount(capture.frames, stride);
  const position = new Float32Array(samples * n * 3);
  const orientation = new Float32Array(samples * n * 4);
  const scale = new Float32Array(samples * n * 3).fill(1);
  for (let f = 0; f < samples; f++) {
    const source = Math.min(capture.frames - 1, f * stride);
    nodes.forEach((node, i) => {
      const c = channelIndex.get(node.id);
      const p = (f * n + i) * 3;
      const q = (f * n + i) * 4;
      if (c === undefined) {
        const t = node.restWorld;
        position.set([t.translation.x, t.translation.y, t.translation.z], p);
        orientation.set([t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w], q);
        return;
      }
      const at = source * capture.bones + c;
      position.set(capture.position.subarray(at * 3, at * 3 + 3), p);
      orientation.set(capture.orientation.subarray(at * 4, at * 4 + 4), q);
    });
  }
  // Times stay in seconds off the recorded index, so dropping samples shortens the curve without
  // moving anything on it: a second of simulated time is still a second of timeline.
  const times = Float64Array.from(
    { length: samples },
    (_, f) => Math.min(capture.frames - 1, f * stride) / rate,
  );

  const seconds = capture.frames / rate;
  const stem =
    `bs-humany-${simulation.recording.scenario}-${simulation.articulation.profileId}` +
    `-${rate}hz-${outputFramerate}fps`;
  const glb = buildAnimatedGlb({
    nodes,
    animation: { times, position, orientation, scale },
    generator: 'bs-humany studio (export-gltf)',
    extras: {
      rateHz: rate,
      outputFramerate,
      seconds,
      frames: samples,
      stride,
      recordedSteps: capture.frames,
      firstTick: capture.firstTick,
      captureFull: capture.full,
      profile: simulation.articulation.profileId,
      backend: simulation.backendId,
      scenario: simulation.recording.scenario,
      morphology: simulation.resolved.input,
      frame: '+X right, +Y up, +Z posterior (anterior is -Z); metres; seconds',
      hierarchy:
        'bones nested by anatomical parent, each carrying its own rigid mesh; a joint__<id> ' +
        'node at every joint centre, parented to the bone the pivot is fixed in, carrying the ' +
        'intervertebral disc or costovertebral bead where there is one; the costal cartilage ' +
        'under a "tissue" root, one bar a weld, each skinned to the two bones it joins; the ' +
        'ground and the scenario furniture under a static "scene" root; the muscle bellies as ' +
        'one unskinned "muscles" mesh whose movement is the .pc2 beside the file, one sample ' +
        'per output frame',
      muscles: muscleGroups.length,
      attribution: attributionText(assets.manifest),
      dataLicense: assets.manifest.dataset.license,
    },
  });
  return {
    glb,
    script: blenderImportScript({
      glbFileName: `${stem}.glb`,
      rate,
      outputFramerate,
      frames: samples,
      stride,
      steps: capture.frames,
      ...(pointCache
        ? {
            pointCacheFileName: `${stem}.pc2`,
            pointCacheSamples,
            muscleGroups,
          }
        : {}),
    }),
    glbFileName: `${stem}.glb`,
    scriptFileName: `${stem}.py`,
    frames: samples,
    stride,
    ...(pointCache ? { pointCache: { name: `${stem}.pc2`, bytes: pointCache } } : {}),
    rate,
    outputFramerate,
    seconds,
    full: capture.full,
  };
}
