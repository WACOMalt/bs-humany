#version 450

layout(location = 0) in vec2 vUv;
layout(location = 1) in vec4 vColour;
layout(set = 1, binding = 0) uniform sampler2D tex;
layout(location = 0) out vec4 outColour;

void main() {
    outColour = vColour * texture(tex, vUv);
}
