/**
 * Placing an articulation for a scenario: rotate the whole rest pose about the root and lift it
 * so the lowest segment origin sits at the requested clearance above the ground. Pure, so the
 * studio and the test runner place bodies identically.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import { type Quat, multiplyQuat, rotate, vec3 } from '@bs-humany/frames';

export function placeArticulation(
  model: CompiledArticulation,
  rotation: Quat | undefined,
  clearance: number,
  groundHeight: number,
): CompiledArticulation {
  const root = model.segments[model.root];
  if (!root) throw new Error('No root segment.');
  const pivot = root.restWorld.translation;
  const rotated = model.segments.map((s) => {
    const rel = vec3(
      s.restWorld.translation.x - pivot.x,
      s.restWorld.translation.y - pivot.y,
      s.restWorld.translation.z - pivot.z,
    );
    const turned = rotation ? rotate(rotation, rel) : rel;
    return {
      segment: s,
      translation: vec3(turned.x + pivot.x, turned.y + pivot.y, turned.z + pivot.z),
      rotation: rotation ? multiplyQuat(rotation, s.restWorld.rotation) : s.restWorld.rotation,
    };
  });
  let lowest = Number.POSITIVE_INFINITY;
  for (const r of rotated) lowest = Math.min(lowest, r.translation.y);
  const lift = groundHeight + clearance - lowest;
  return {
    ...model,
    segments: rotated.map(({ segment, translation, rotation: rot }) => ({
      ...segment,
      restWorld: {
        translation: vec3(translation.x, translation.y + lift, translation.z),
        rotation: rot,
      },
    })),
  };
}
