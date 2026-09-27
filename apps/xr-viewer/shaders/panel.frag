#version 450
// The panel's fragments, cut to their mesh's clip rectangle. egui drops a shape that lies wholly
// outside its rectangle and leaves the rest to the renderer, which on a desktop is a scissor; here
// the panel is a quad in the room, not a region of the screen, so the cut is made in the panel's
// own points instead, which is what both the vertex and the rectangle are given in.

layout(location = 0) in vec2 vUv;
layout(location = 1) in vec4 vColour;
layout(location = 2) in vec2 vPoint;
layout(set = 1, binding = 0) uniform sampler2D tex;
// After the vertex stage's 64-byte matrix: min x, min y, max x, max y, in points.
layout(push_constant) uniform Push { layout(offset = 64) vec4 clip; } push;
layout(location = 0) out vec4 outColour;

void main() {
    if (any(lessThan(vPoint, push.clip.xy)) || any(greaterThan(vPoint, push.clip.zw))) {
        discard;
    }
    outColour = vColour * texture(tex, vUv);
}
