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
import { type ExportNode, blenderImportScript, buildAnimatedGlb } from '@bs-humany/export-gltf';
import { IDENTITY_TRANSFORM } from '@bs-humany/frames';
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

  // Keyframes in node order; a bone the pose channel does not carry stays at rest.
  const n = nodes.length;
  const position = new Float32Array(capture.frames * n * 3);
  const orientation = new Float32Array(capture.frames * n * 4);
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
  const times = Float64Array.from({ length: capture.frames }, (_, f) => f / rate);

  const stem = `bs-humany-${simulation.recording.scenario}-${simulation.articulation.profileId}-${rate}hz`;
  const glb = buildAnimatedGlb({
    nodes,
    animation: { times, position, orientation },
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
      hierarchy: 'bones nested by anatomical parent; each node carries its own rigid mesh',
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
