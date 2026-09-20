#version 450
// One pass, both eyes. `gl_ViewIndex` is which eye this invocation is drawing, and it exists
// because the render pass was created with a multiview mask -- the saving that makes stereo
// affordable is not drawing the scene twice.
#extension GL_EXT_multiview : require

layout(location = 0) in vec3 inPosition;
layout(location = 1) in vec3 inNormal;
// Which bone this vertex belongs to. Posing is a buffer write, not a geometry rewrite. The last
// two slots are not bones at all but the controllers, and the fragment shader colours them by it.
layout(location = 2) in uint inBone;

layout(set = 0, binding = 0) uniform Views { mat4 viewProj[2]; } views;
layout(set = 0, binding = 1) uniform Bones { mat4 model[256]; } bones;

// Slots from tintBase up are not bones: they are colour codes on geometry that lives in the
// simulation's frame -- a muscle's tension bucket, a disc, a bead, a bar of cartilage -- and
// they are posed by the world slot's matrix, the placement, as the muscles are.
layout(push_constant) uniform Push { uint firstController; uint worldSlot; uint stageSlot; uint sceneSlot; uint tintBase; } push;

layout(location = 0) out vec3 vNormal;
layout(location = 1) flat out uint vBone;

void main() {
    uint slot = inBone >= push.tintBase ? push.worldSlot : inBone;
    mat4 model = bones.model[slot];
    vBone = inBone;
    // No non-uniform scale anywhere in this model, so the upper 3x3 transforms normals correctly
    // without an inverse transpose.
    vNormal = mat3(model) * inNormal;
    gl_Position = views.viewProj[gl_ViewIndex] * model * vec4(inPosition, 1.0);
}
