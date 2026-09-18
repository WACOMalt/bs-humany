#version 450
// One pass, both eyes. `gl_ViewIndex` is which eye this invocation is drawing, and it exists
// because the render pass was created with a multiview mask -- the saving that makes stereo
// affordable is not drawing the scene twice.
#extension GL_EXT_multiview : require

layout(location = 0) in vec3 inPosition;
layout(location = 1) in vec3 inNormal;
// Which bone this vertex belongs to. Every bone is at the identity while the pose is static; the
// attribute is here so that feeding real transforms later is a buffer write rather than a rewrite.
layout(location = 2) in uint inBone;

layout(set = 0, binding = 0) uniform Views { mat4 viewProj[2]; } views;
layout(set = 0, binding = 1) uniform Bones { mat4 model[256]; } bones;

layout(location = 0) out vec3 vNormal;

void main() {
    mat4 model = bones.model[inBone];
    // No non-uniform scale anywhere in this model, so the upper 3x3 transforms normals correctly
    // without an inverse transpose.
    vNormal = mat3(model) * inNormal;
    gl_Position = views.viewProj[gl_ViewIndex] * model * vec4(inPosition, 1.0);
}
