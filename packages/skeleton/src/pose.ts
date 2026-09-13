/**
 * World transforms for every bone in the rest pose.
 *
 * Composes each bone's parent-relative rest transform down the anatomical tree. Pure: no
 * rendering, no physics. Lives in the skeleton package because the landmark frames, the render
 * layer and, later, the pose module all need it, and none of them should depend on each other.
 */

import { IDENTITY_TRANSFORM, type Transform, compose, vec3 } from '@bs-humany/frames';
import type { BoneDef, ExprContext, HsdlDocument } from '@bs-humany/hsdl';
import { evaluate } from '@bs-humany/hsdl';

export function computeWorldTransforms(
  document: Pick<HsdlDocument, 'bones'>,
  context: ExprContext,
): Map<string, Transform> {
  const byId = new Map(document.bones.map((b) => [b.id, b]));
  const world = new Map<string, Transform>();

  const resolve = (bone: BoneDef): Transform => {
    const cached = world.get(bone.id);
    if (cached) return cached;
    const local: Transform = {
      translation: vec3(
        evaluate(bone.restTransform.translation.x, context),
        evaluate(bone.restTransform.translation.y, context),
        evaluate(bone.restTransform.translation.z, context),
      ),
      rotation: bone.restTransform.rotation,
    };
    const parent = bone.parent === null ? undefined : byId.get(bone.parent);
    const parentWorld = parent ? resolve(parent) : IDENTITY_TRANSFORM;
    const result = compose(parentWorld, local);
    world.set(bone.id, result);
    return result;
  };

  for (const bone of document.bones) resolve(bone);
  return world;
}
