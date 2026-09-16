/**
 * Assembling the Blender export from a running simulation.
 *
 * Nodes are the document's bones in their anatomical hierarchy, parents before children; each
 * carries the measured mesh at rest (scaled to stature, as the viewer draws it), and the
 * keyframes are the captured bone transforms, every tick. The glTF writer moves meshes into
 * bone frames and keyframes into parent-relative form; this module only gathers the pieces
 * and the provenance that goes with them.
 */

import type { SkeletonAssets } from '@bs-humany/assets-anatomical';
import { attributionText } from '@bs-humany/assets-anatomical';
import {
  type ExportNode,
  blenderImportScript,
  boxMesh,
  buildAnimatedGlb,
  planeMesh,
} from '@bs-humany/export-gltf';
import { IDENTITY_TRANSFORM, type Transform, compose, transformPoint } from '@bs-humany/frames';
import { type HsdlDocument, evaluate, param } from '@bs-humany/hsdl';
import { computeWorldTransforms } from '@bs-humany/skeleton';
import type { Simulation } from './simulation.js';

export interface BlenderExport {
  readonly glb: Uint8Array;
  readonly script: string;
  readonly glbFileName: string;
  readonly scriptFileName: string;
  readonly frames: number;
  readonly rate: number;
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

/** One ring's rest pose, from the first captured frame: where the bind mesh is authored. */
function ringRest(
  rings: { position: Float32Array; orientation: Float32Array },
  at: number,
): Transform {
  return {
    translation: {
      x: rings.position[3 * at] ?? 0,
      y: rings.position[3 * at + 1] ?? 0,
      z: rings.position[3 * at + 2] ?? 0,
    },
    rotation: {
      x: rings.orientation[4 * at] ?? 0,
      y: rings.orientation[4 * at + 1] ?? 0,
      z: rings.orientation[4 * at + 2] ?? 0,
      w: rings.orientation[4 * at + 3] ?? 1,
    },
  };
}

/**
 * One muscle's bind mesh, rebuilt from the first frame's ring transforms.
 *
 * Not captured: reconstructed, because it is exactly what the sweep would have produced. A ring's
 * vertices are a circle of its own radius in its own frame, so the ring transforms captured for
 * the animation already say where every vertex was at bind time, and capturing the vertices as
 * well would be storing the same fact twice.
 *
 * Each vertex is bound to its own ring at full weight, which is what makes the skin exact rather
 * than an approximation of the sweep.
 */
function bindMesh(
  rings: { position: Float32Array; orientation: Float32Array; radius: Float32Array },
  unit: number,
  ringCount: number,
  segments: number,
): { positions: Float32Array; vertexJoint: Uint16Array } {
  const positions = new Float32Array(ringCount * segments * 3);
  const vertexJoint = new Uint16Array(ringCount * segments);
  for (let ring = 0; ring < ringCount; ring++) {
    const at = unit * ringCount + ring;
    const rest = ringRest(rings, at);
    const radius = rings.radius[at] ?? 0;
    for (let s = 0; s < segments; s++) {
      const angle = (2 * Math.PI * s) / segments;
      const local = { x: radius * Math.cos(angle), y: radius * Math.sin(angle), z: 0 };
      const world = transformPoint(rest, local);
      const v = ring * segments + s;
      positions[3 * v] = world.x;
      positions[3 * v + 1] = world.y;
      positions[3 * v + 2] = world.z;
      vertexJoint[v] = ring;
    }
  }
  return { positions, vertexJoint };
}

export function buildBlenderExport(
  simulation: Simulation,
  document: HsdlDocument,
  assets: SkeletonAssets,
): BlenderExport {
  const capture = simulation.capture.view();
  const rate = Math.round(1 / simulation.dt);
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
  for (const joint of model.joints) {
    const parentSegment = model.segments[joint.parentSegment];
    const host = boneNode.get(joint.parentBone);
    if (!parentSegment || host === undefined) continue;
    nodes.push({
      id: `joint__${joint.id}`,
      parent: host,
      restWorld: compose(parentSegment.restWorld, joint.frameInParent),
      animated: false,
      extras: {
        role: 'joint centre',
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

  // Muscles, as skinned bellies: one joint per ring, and a mesh bound to them a ring at a time.
  // A belly is swept anew every tick, so it is rigid in no bone and cannot be a node with a mesh
  // the way a bone is -- but it is rigid ring by ring, and that is exactly what a skin expresses.
  const muscleRings = simulation.muscleCapture.view();
  const volume = simulation.muscleVolume;
  const units = simulation.muscles?.units;
  // Whether there are any ring frames to lay against the pose frames, rather than whether there
  // are exactly as many. The two captures are held level as they are taken
  // (`Simulation.keepCapturesLevel`), so they normally match exactly -- but the test used to be
  // an equality, and an equality means that the moment they diverge the export writes a file
  // with an empty Muscles collection and says nothing about it. They diverge for a reason that
  // has nothing to do with the muscles being wrong: the two hold very different amounts per
  // frame against the same budget, so the muscle capture stops first and the bone capture runs
  // on. A belly animation that holds its last pose is a better answer than no belly.
  const muscleAvailable = muscleRings.frames;
  // Where the ring capture's first frame falls among the pose capture's. Outside the span the
  // rings hold the nearest frame they were captured at rather than collapsing to the origin.
  const muscleOffset = Math.max(0, muscleRings.firstTick - capture.firstTick);
  const ringNodes: number[][] = [];
  if (volume && units && muscleAvailable > 0 && muscleRings.rings === units.length * volume.rings) {
    const muscleRoot =
      nodes.push({
        id: 'muscles',
        parent: -1,
        restWorld: IDENTITY_TRANSFORM,
        animated: false,
        extras: { role: 'muscle bellies, skinned to one joint per cross-section' },
      }) - 1;
    for (let unit = 0; unit < units.length; unit++) {
      const id = units[unit]?.id ?? `unit_${unit}`;
      const joints: number[] = [];
      for (let ring = 0; ring < volume.rings; ring++) {
        const at = unit * volume.rings + ring;
        joints.push(
          nodes.push({
            id: `muscle__${id}__ring${String(ring).padStart(2, '0')}`,
            parent: muscleRoot,
            restWorld: ringRest(muscleRings, at),
            // The ring is authored as a unit circle and drawn at its own radius, so its bind
            // scale is that radius and its keyframes are the radius it has at each frame.
            bindScale: muscleRings.radius[at] || 1,
            extras: { role: 'muscle cross-section', unit: id, ring },
          }) - 1,
        );
      }
      ringNodes.push(joints);
      const bind = bindMesh(muscleRings, unit, volume.rings, volume.segments);
      nodes.push({
        id: `muscle__${id}`,
        parent: muscleRoot,
        restWorld: IDENTITY_TRANSFORM,
        animated: false,
        mesh: { positions: bind.positions, indices: volume.index },
        skin: { joints, vertexJoint: bind.vertexJoint },
        extras: {
          role: 'muscle belly',
          unit: id,
          rings: volume.rings,
          segments: volume.segments,
          displayName: units[unit]?.displayName,
        },
      });
    }
  }

  // Keyframes in node order; a bone the pose channel does not carry stays at rest, as does
  // scene geometry.
  const n = nodes.length;
  const position = new Float32Array(capture.frames * n * 3);
  const orientation = new Float32Array(capture.frames * n * 4);
  const scale = new Float32Array(capture.frames * n * 3).fill(1);
  for (let f = 0; f < capture.frames; f++) {
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
      position.set(
        capture.position.subarray((f * capture.bones + c) * 3, (f * capture.bones + c) * 3 + 3),
        p,
      );
      orientation.set(
        capture.orientation.subarray((f * capture.bones + c) * 4, (f * capture.bones + c) * 4 + 4),
        q,
      );
    });
  }
  // The ring joints' own keyframes, which the loop above could not fill: they are not bones and
  // the pose channel does not carry them.
  ringNodes.forEach((joints, unit) => {
    joints.forEach((node, ring) => {
      const at = unit * (volume?.rings ?? 0) + ring;
      for (let f = 0; f < capture.frames; f++) {
        // Clamped, so a ring capture that started late or stopped early holds its nearest frame
        // instead of leaving zeros -- a zero quaternion and a zero scale draw the belly as a
        // point at the world origin, which is what an unfilled frame would look like.
        const source = Math.min(Math.max(f - muscleOffset, 0), muscleAvailable - 1);
        const from = (source * muscleRings.rings + at) * 3;
        const fromQ = (source * muscleRings.rings + at) * 4;
        const to = (f * n + node) * 3;
        const toQ = (f * n + node) * 4;
        position[to] = muscleRings.position[from] ?? 0;
        position[to + 1] = muscleRings.position[from + 1] ?? 0;
        position[to + 2] = muscleRings.position[from + 2] ?? 0;
        orientation[toQ] = muscleRings.orientation[fromQ] ?? 0;
        orientation[toQ + 1] = muscleRings.orientation[fromQ + 1] ?? 0;
        orientation[toQ + 2] = muscleRings.orientation[fromQ + 2] ?? 0;
        orientation[toQ + 3] = muscleRings.orientation[fromQ + 3] ?? 1;
        const radius = muscleRings.radius[source * muscleRings.rings + at] ?? 1;
        scale[to] = radius;
        scale[to + 1] = radius;
        scale[to + 2] = radius;
      }
    });
  });

  const times = Float64Array.from({ length: capture.frames }, (_, f) => f / rate);

  const stem = `bs-humany-${simulation.recording.scenario}-${simulation.articulation.profileId}-${rate}hz`;
  const glb = buildAnimatedGlb({
    nodes,
    animation: { times, position, orientation, scale },
    generator: 'bs-humany studio (export-gltf)',
    extras: {
      rateHz: rate,
      frames: capture.frames,
      firstTick: capture.firstTick,
      captureFull: capture.full,
      profile: simulation.articulation.profileId,
      backend: simulation.backendId,
      scenario: simulation.recording.scenario,
      morphology: simulation.resolved.input,
      frame: '+X right, +Y up, +Z posterior (anterior is -Z); metres; seconds',
      hierarchy:
        'bones nested by anatomical parent, each carrying its own rigid mesh; a joint__<id> ' +
        'node at every joint centre, parented to the bone the pivot is fixed in; the ground ' +
        'and the scenario furniture under a static "scene" root; muscle bellies under a ' +
        '"muscles" root, each a skinned mesh bound one ring at a time to a joint per ' +
        'cross-section, which carries both the bend of the path and the swell of the belly',
      muscles: ringNodes.length,
      attribution: attributionText(assets.manifest),
      dataLicense: assets.manifest.dataset.license,
    },
  });
  return {
    glb,
    script: blenderImportScript({ glbFileName: `${stem}.glb`, rate, frames: capture.frames }),
    glbFileName: `${stem}.glb`,
    scriptFileName: `${stem}.py`,
    frames: capture.frames,
    rate,
    full: capture.full,
  };
}
