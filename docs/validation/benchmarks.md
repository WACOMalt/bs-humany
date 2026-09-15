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

## Where the time goes at L3

Milestone M5.11. Measured 2026-09-15 at 1000 Hz on the L3 profile, 109 bodies and 189 degrees of
freedom, by timing each module's own `step` against the whole tick and then ablating the backend.

| | ms / tick |
|---|---|
| Whole kernel tick | 1.64 |
| `PhysicsModule`, which is the backend step | 1.46 |
| `SkeletonPoseModule`, posing all 206 bones | 0.035 |
| `MetricsModule` | 0.028 |
| `PassiveJointModule` | 0.026 |
| `CouplingModule` (stands down on MuJoCo) | 0.000 |

Every module this project wrote costs 0.09 ms together, or 5% of the tick. The rest is inside
MuJoCo, and within that it is collision:

| | ms / step |
|---|---|
| As it runs | 1.38 |
| With nothing colliding | 0.62 |
| With only the ground colliding | 0.62 |
| At 4 solver iterations instead of 8 | 1.35 |
| At 20 solver iterations | 1.36 |

So 55% of the backend step is collision against the 333 convex hull proxies, and the constraint
solver's iteration count barely registers: there is no accuracy being bought back by spending
fewer iterations. Optimising the modules would be optimising 5% of the problem.

L3 therefore runs at about 0.8x real time at its own 1000 Hz rate, and L0 through L2 run in real
time with room to spare. **That is accepted rather than fixed.** L3 exists to be correct, not
quick: it is what the validation, the audit and the Blender export are run against, and none of
those care about wall-clock. The lever if it ever matters is the hull count, which is a fidelity
decision (M5.8) rather than a coding one, and taking it would be trading the accuracy L3 is for.

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
