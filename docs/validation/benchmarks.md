# Benchmarks

Milestone M3.19. Milliseconds per kernel tick (physics, passive joints, skeleton pose and
metrics modules) on the standing-collapse drop, two simulated seconds after a warm-up, by
fidelity profile, backend and physics rate. "Real time" is how many times faster than wall
clock the tick rate runs. Regenerate with `pnpm bench`; commit the result with the change that
motivated it.

Generated 2026-09-14 on linux-x64, Node v22.22.2.

| Profile | Backend | Rate (Hz) | Bodies | nv | ms / step | Real time |
|---|---|---|---|---|---|---|
| l0_ragdoll | rapier | 240 | 15 | 35 | 0.438 | 9.5x |
| l0_ragdoll | rapier | 500 | 15 | 35 | 0.407 | 4.9x |
| l0_ragdoll | rapier | 1000 | 15 | 35 | 0.849 | 1.2x |
| l0_ragdoll | mujoco | 240 | 15 | 35 | 0.232 | 18.0x |
| l0_ragdoll | mujoco | 500 | 15 | 35 | 0.151 | 13.3x |
| l0_ragdoll | mujoco | 1000 | 15 | 35 | 0.156 | 6.4x |
| l1_standard | rapier | 240 | 23 | 48 | 0.555 | 7.5x |
| l1_standard | rapier | 500 | 23 | 48 | 1.542 | 1.3x |
| l1_standard | rapier | 1000 | 23 | 48 | 1.877 | 0.5x |
| l1_standard | mujoco | 240 | 23 | 48 | 0.258 | 16.1x |
| l1_standard | mujoco | 500 | 23 | 48 | 0.260 | 7.7x |
| l1_standard | mujoco | 1000 | 23 | 48 | 0.247 | 4.1x |
| l2_biomechanical | rapier | 240 | 49 | 98 | 1.652 | 2.5x |
| l2_biomechanical | rapier | 500 | 49 | 98 | 7.352 | 0.3x |
| l2_biomechanical | rapier | 1000 | 49 | 98 | 9.978 | 0.1x |
| l2_biomechanical | mujoco | 240 | 49 | 98 | 0.542 | 7.7x |
| l2_biomechanical | mujoco | 500 | 49 | 98 | 0.574 | 3.5x |
| l2_biomechanical | mujoco | 1000 | 49 | 98 | 0.612 | 1.6x |
| l3_anatomical | rapier | 240 | 109 | 185 | 1.370 | 3.0x |
| l3_anatomical | rapier | 500 | 109 | 185 | 18.012 | 0.1x |
| l3_anatomical | rapier | 1000 | 109 | 185 | 17.514 | 0.1x |
| l3_anatomical | mujoco | 240 | 109 | 185 | 1.310 | 3.2x |
| l3_anatomical | mujoco | 500 | 109 | 185 | 1.266 | 1.6x |
| l3_anatomical | mujoco | 1000 | 109 | 185 | 1.325 | 0.8x |

## Recompile and restore

Spec 14.5 item 9. Milliseconds to compile the same profile at a new morphology, build a fresh
backend, transfer the running joint state by joint id and place the new body there (M5.6).
Excludes the WASM module load, which happens once per session.

| Profile | Backend | ms |
|---|---|---|
| l1_standard | rapier | 19.1 |
| l1_standard | mujoco | 229.8 |
| l2_biomechanical | rapier | 20.5 |
| l2_biomechanical | mujoco | 432.9 |
