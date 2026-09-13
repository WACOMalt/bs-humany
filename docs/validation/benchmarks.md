# Benchmarks

Milestone M3.19. Milliseconds per kernel tick (physics, passive joints, skeleton pose and
metrics modules) on the standing-collapse drop, two simulated seconds after a warm-up, by
fidelity profile, backend and physics rate. "Real time" is how many times faster than wall
clock the tick rate runs. Regenerate with `pnpm bench`; commit the result with the change that
motivated it.

Generated 2026-09-13 on linux-x64, Node v22.22.2.

| Profile | Backend | Rate (Hz) | Bodies | nv | ms / step | Real time |
|---|---|---|---|---|---|---|
| l0_ragdoll | rapier | 240 | 15 | 35 | 0.325 | 12.8x |
| l0_ragdoll | rapier | 500 | 15 | 35 | 0.233 | 8.6x |
| l0_ragdoll | rapier | 1000 | 15 | 35 | 0.210 | 4.8x |
| l0_ragdoll | mujoco | 240 | 15 | 35 | 0.174 | 23.9x |
| l0_ragdoll | mujoco | 500 | 15 | 35 | 0.129 | 15.5x |
| l0_ragdoll | mujoco | 1000 | 15 | 35 | 0.117 | 8.5x |
| l1_standard | rapier | 240 | 23 | 48 | 0.347 | 12.0x |
| l1_standard | rapier | 500 | 23 | 48 | 0.345 | 5.8x |
| l1_standard | rapier | 1000 | 23 | 48 | 0.358 | 2.8x |
| l1_standard | mujoco | 240 | 23 | 48 | 0.194 | 21.5x |
| l1_standard | mujoco | 500 | 23 | 48 | 0.186 | 10.8x |
| l1_standard | mujoco | 1000 | 23 | 48 | 0.176 | 5.7x |
| l2_biomechanical | rapier | 240 | 49 | 98 | 0.520 | 8.0x |
| l2_biomechanical | rapier | 500 | 49 | 98 | 0.825 | 2.4x |
| l2_biomechanical | rapier | 1000 | 49 | 98 | 0.828 | 1.2x |
| l2_biomechanical | mujoco | 240 | 49 | 98 | 0.361 | 11.5x |
| l2_biomechanical | mujoco | 500 | 49 | 98 | 0.367 | 5.4x |
| l2_biomechanical | mujoco | 1000 | 49 | 98 | 0.364 | 2.7x |
| l3_anatomical | rapier | 240 | 109 | 185 | 0.538 | 7.7x |
| l3_anatomical | rapier | 500 | 109 | 185 | 1.338 | 1.5x |
| l3_anatomical | rapier | 1000 | 109 | 185 | 0.487 | 2.1x |
| l3_anatomical | mujoco | 240 | 109 | 185 | 1.249 | 3.3x |
| l3_anatomical | mujoco | 500 | 109 | 185 | 1.300 | 1.5x |
| l3_anatomical | mujoco | 1000 | 109 | 185 | 1.205 | 0.8x |
