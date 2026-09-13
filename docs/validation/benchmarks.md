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
| l0_ragdoll | rapier | 500 | 15 | 35 | 0.240 | 8.3x |
| l0_ragdoll | rapier | 1000 | 15 | 35 | 0.215 | 4.6x |
| l0_ragdoll | mujoco | 240 | 15 | 35 | 0.184 | 22.6x |
| l0_ragdoll | mujoco | 500 | 15 | 35 | 0.133 | 15.0x |
| l0_ragdoll | mujoco | 1000 | 15 | 35 | 0.120 | 8.3x |
| l1_standard | rapier | 240 | 23 | 48 | 0.363 | 11.5x |
| l1_standard | rapier | 500 | 23 | 48 | 0.334 | 6.0x |
| l1_standard | rapier | 1000 | 23 | 48 | 0.352 | 2.8x |
| l1_standard | mujoco | 240 | 23 | 48 | 0.203 | 20.5x |
| l1_standard | mujoco | 500 | 23 | 48 | 0.199 | 10.1x |
| l1_standard | mujoco | 1000 | 23 | 48 | 0.178 | 5.6x |
| l2_biomechanical | rapier | 240 | 49 | 98 | 0.875 | 4.8x |
| l2_biomechanical | rapier | 500 | 49 | 98 | 0.861 | 2.3x |
| l2_biomechanical | rapier | 1000 | 49 | 98 | 0.837 | 1.2x |
| l2_biomechanical | mujoco | 240 | 49 | 98 | 0.401 | 10.4x |
| l2_biomechanical | mujoco | 500 | 49 | 98 | 0.375 | 5.3x |
| l2_biomechanical | mujoco | 1000 | 49 | 98 | 0.364 | 2.8x |
| l3_anatomical | rapier | 240 | 109 | 185 | 0.659 | 6.3x |
| l3_anatomical | rapier | 500 | 109 | 185 | 0.897 | 2.2x |
| l3_anatomical | rapier | 1000 | 109 | 185 | 0.537 | 1.9x |
| l3_anatomical | mujoco | 240 | 109 | 185 | 1.281 | 3.3x |
| l3_anatomical | mujoco | 500 | 109 | 185 | 1.200 | 1.7x |
| l3_anatomical | mujoco | 1000 | 109 | 185 | 1.175 | 0.9x |

## Recompile and restore

Spec 14.5 item 9. Milliseconds to compile the same profile at a new morphology, build a fresh
backend, transfer the running joint state by joint id and place the new body there (M5.6).
Excludes the WASM module load, which happens once per session.

| Profile | Backend | ms |
|---|---|---|
| l1_standard | rapier | 8.3 |
| l1_standard | mujoco | 44.1 |
| l2_biomechanical | rapier | 9.4 |
| l2_biomechanical | mujoco | 80.9 |
