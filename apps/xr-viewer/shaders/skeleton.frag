#version 450

layout(location = 0) in vec3 vNormal;
layout(location = 1) flat in uint vBone;
layout(location = 0) out vec4 outColour;

// Slots from firstController up are the tracked controllers, and worldSlot is the muscles: each
// drawn in a colour no bone is.
layout(push_constant) uniform Push { uint firstController; uint worldSlot; uint stageSlot; uint sceneSlot; uint tintBase; } push;

void main() {
    vec3 n = normalize(vNormal);
    // A key and a fill from opposite sides, and a floor under both. A skeleton seen from inside a
    // headset is looked at from every angle including the ones a single light leaves black, and a
    // black bone reads as a hole rather than as a shadow.
    float key = max(dot(n, normalize(vec3(0.40, 0.80, -0.30))), 0.0);
    float fill = max(dot(n, normalize(vec3(-0.50, 0.20, 0.60))), 0.0);
    vec3 bone = vec3(0.90, 0.88, 0.83);
    vec3 controller = vec3(0.25, 0.60, 1.00);
    vec3 muscle = vec3(0.72, 0.26, 0.28);
    vec3 grid = vec3(0.34, 0.36, 0.40);
    vec3 scenery = vec3(0.52, 0.50, 0.46);
    // The studio's own colours: a slack muscle pale blue, a taut one signal red, the discs pale
    // teal and the cartilage a warm bar. Codes from tintBase: 0..15 the tension ramp, 16 a disc,
    // 17 a bead, 18 a bar.
    vec3 slack = vec3(0.66, 0.78, 0.91);
    vec3 taut = vec3(1.00, 0.23, 0.19);
    vec3 disc = vec3(0.62, 0.89, 0.85);
    vec3 cartilage = vec3(0.97, 0.77, 0.62);
    uint code = vBone >= push.tintBase ? vBone - push.tintBase : 999u;
    vec3 albedo = code < 16u ? mix(slack, taut, float(code) / 15.0)
        : code == 16u || code == 17u ? disc
        : code == 18u ? cartilage
        : vBone == push.sceneSlot ? scenery
        : vBone == push.stageSlot ? grid
        : vBone == push.worldSlot ? muscle
        : vBone >= push.firstController ? controller
        : bone;
    outColour = vec4(albedo * (0.18 + 0.70 * key + 0.24 * fill), 1.0);
}
