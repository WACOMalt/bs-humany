# Benchmarks

Milestone M3.19. Milliseconds per kernel tick (physics, passive joints, skeleton pose and
metrics modules) on the standing-collapse drop, two simulated seconds after a warm-up, by
fidelity profile, backend and physics rate. "Real time" is how many times faster than wall
clock the tick rate runs. Regenerate with `pnpm bench`; commit the result with the change that
motivated it.

Generated 2026-09-13 on linux-x64, Node v22.22.2.

| Profile | Backend | Rate (Hz) | Bodies | nv | ms / step | Real time |
|---|---|---|---|---|---|---|
| l0_ragdoll | rapier | 240 | 15 | 35 | 0.321 | 13.0x |
| l0_ragdoll | rapier | 500 | 15 | 35 | 0.225 | 8.9x |
| l0_ragdoll | rapier | 1000 | 15 | 35 | 0.206 | 4.8x |
| l0_ragdoll | mujoco | 240 | 15 | 35 | 0.177 | 23.6x |
| l0_ragdoll | mujoco | 500 | 15 | 35 | 0.136 | 14.7x |
| l0_ragdoll | mujoco | 1000 | 15 | 35 | 0.116 | 8.6x |
| l1_standard | rapier | 240 | 23 | 48 | 0.341 | 12.2x |
| l1_standard | rapier | 500 | 23 | 48 | 0.329 | 6.1x |
| l1_standard | rapier | 1000 | 23 | 48 | 0.338 | 3.0x |
| l1_standard | mujoco | 240 | 23 | 48 | 0.195 | 21.4x |
| l1_standard | mujoco | 500 | 23 | 48 | 0.185 | 10.8x |
| l1_standard | mujoco | 1000 | 23 | 48 | 0.178 | 5.6x |
