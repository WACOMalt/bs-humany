#version 450

layout(location = 0) in vec3 vNormal;
layout(location = 0) out vec4 outColour;

void main() {
    vec3 n = normalize(vNormal);
    // A key and a fill from opposite sides, and a floor under both. A skeleton seen from inside a
    // headset is looked at from every angle including the ones a single light leaves black, and a
    // black bone reads as a hole rather than as a shadow.
    float key = max(dot(n, normalize(vec3(0.40, 0.80, -0.30))), 0.0);
    float fill = max(dot(n, normalize(vec3(-0.50, 0.20, 0.60))), 0.0);
    vec3 bone = vec3(0.90, 0.88, 0.83);
    outColour = vec4(bone * (0.18 + 0.70 * key + 0.24 * fill), 1.0);
}
