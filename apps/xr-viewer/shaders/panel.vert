#version 450
// The panel: egui's meshes, which are flat in points, stood up in the room by one matrix whose
// columns are the panel's right and down directions in metres a point. Both eyes in one pass, as
// the skeleton is drawn.
#extension GL_EXT_multiview : require

layout(location = 0) in vec2 inPosition;
layout(location = 1) in vec2 inUv;
layout(location = 2) in vec4 inColour;

layout(set = 0, binding = 0) uniform Views { mat4 viewProj[2]; } views;
layout(push_constant) uniform Push { mat4 model; } push;

layout(location = 0) out vec2 vUv;
layout(location = 1) out vec4 vColour;

// egui's colours are sRGB and premultiplied; the attachment is sRGB and blends in linear, so the
// colour is linearised here and the alpha left alone, which is what egui's own backends do.
vec3 linearFromSrgb(vec3 c) {
    vec3 low = c / 12.92;
    vec3 high = pow((c + 0.055) / 1.055, vec3(2.4));
    return mix(low, high, step(0.04045, c));
}

void main() {
    vUv = inUv;
    vColour = vec4(linearFromSrgb(inColour.rgb), inColour.a);
    gl_Position = views.viewProj[gl_ViewIndex] * push.model * vec4(inPosition, 0.0, 1.0);
}
