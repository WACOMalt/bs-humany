# Benchmarks

Milestones M3.19 and M5.11. Milliseconds per kernel tick on MuJoCo, for the bodies this project
actually runs: the skeleton alone, the whole body with its muscles, cord and nerves as the studio
and the trainer build it, and where that tick's time goes module by module. "Real time" is how
many times faster than wall clock the profile's own solver rate runs; below 1x the simulation runs
slower than life. Regenerate with `pnpm bench` and commit the result with the change that
motivated it.

The script writes only between the `bench:start` and `bench:end` markers below, and refuses to
run if they are missing. Everything outside them is written by hand and kept as it is.

<!-- bench:start -->

Generated 2026-09-27 on linux-x64, Node v22.22.2.

## Skeleton only

The golden runner on `drop-standing-collapse` at each profile and its own solver rate: physics,
grab, metrics, coupling and passive joints, no muscles.

| Profile | Rate (Hz) | Bodies | nv | Ticks | ms / tick | Real time |
|---|---|---|---|---|---|---|
| l0_ragdoll | 240 | 15 | 35 | 720 | 0.150 | 27.7x |
| l1_standard | 500 | 23 | 48 | 1500 | 0.223 | 9.0x |
| l2_biomechanical | 500 | 49 | 102 | 1500 | 0.476 | 4.2x |
| l3_anatomical | 1000 | 135 | 225 | 3000 | 1.542 | 0.6x |

## Full body

`Studio` is the training rig with the bones posed and the bellies swept, as the studio and the
showcase run it; `Trainer` is the same rig without them, as training and the dashboard run it.
Both carry the recipe module's default cord and a zero policy under the quiet-standing clip.
The two scenario rows are the golden runner: muscles and the scenario's own script, no cord.

| Body | Profile | Rate (Hz) | Bodies | nv | Ticks | ms / tick | Real time |
|---|---|---|---|---|---|---|---|
| Studio | l3_anatomical | 1000 | 135 | 225 | 2000 | 2.935 | 0.34x |
| Trainer | l3_anatomical | 1000 | 135 | 225 | 2000 | 2.569 | 0.39x |
| quiet-standing | l3_anatomical | 1000 | 135 | 225 | 3000 | 2.543 | 0.39x |
| clip-flail-arms | l3_anatomical | 1000 | 135 | 225 | 8000 | 2.547 | 0.39x |
| Studio | l2_biomechanical | 500 | 49 | 102 | 1000 | 2.439 | 0.82x |
| Studio | l1_standard | 500 | 23 | 48 | 1000 | 2.035 | 0.98x |

Headless baseline for the studio's frame cost: 2.935 ms per tick at L3 (1000 Hz), the first row.

## Where the time goes, by module

Milliseconds per tick of each module's own `step`, in the same runs as the table above, by
module id less its `bsums.xyz.bs-humany.` prefix. A module that runs one tick in several is
averaged over all of them, so its cost here is what it adds to the average tick.

| Module | Studio, L3 | Trainer, L3 | quiet-standing, L3 | clip-flail-arms, L3 | Studio, L2 | Studio, L1 |
|---|---|---|---|---|---|---|
| `physics` | 1.604 | 1.634 | 1.613 | 1.669 | 0.472 | 0.213 |
| `coupling` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `passive-joint` | 0.033 | 0.038 | 0.037 | 0.035 | 0.018 | 0.007 |
| `skeleton-pose` | 0.042 |  |  |  | 0.034 | 0.027 |
| `muscle.testDrive` | 0.002 | 0.002 | 0.002 | 0.002 | 0.002 | 0.002 |
| `muscle.path` | 0.053 | 0.053 | 0.052 | 0.056 | 0.057 | 0.051 |
| `muscle.dynamics` | 0.799 | 0.816 | 0.798 | 0.744 | 1.052 | 0.957 |
| `muscle.volume` | 0.374 |  |  |  | 0.779 | 0.753 |
| `spinal` | 0.008 | 0.009 |  |  | 0.008 | 0.007 |
| `nerves` | 0.009 | 0.007 |  |  | 0.010 | 0.009 |
| `motor-noise` | 0.005 | 0.005 |  |  | 0.004 | 0.004 |
| `grab` |  |  | 0.000 | 0.000 |  |  |
| `metrics` |  |  | 0.036 | 0.035 |  |  |
| Sum of the modules | 2.929 | 2.564 | 2.539 | 2.543 | 2.435 | 2.031 |
| Whole tick | 2.935 | 2.569 | 2.543 | 2.547 | 2.439 | 2.035 |

## Recompile and restore

Spec 14.5 item 9. Milliseconds to compile the same profile at a new morphology, build a fresh
backend, transfer the running joint state by joint id and place the new body there (M5.6).
Excludes the WASM module load, which happens once per session.

| Profile | ms |
|---|---|
| l1_standard | 241.7 |
| l2_biomechanical | 407.7 |

<!-- bench:end -->

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

## What the whole body costs

Written 2026-09-27, from the bench runs of that day that first measured the whole body; the figures
quoted are from the run committed above, and the ones before it agreed to within about a tenth. The
section above timed the skeleton alone, before the muscles, the cord and the nerves were part of
the body the studio and the trainer run. Its five per cent is true of that body; it is kept as it
was measured, and what follows is what the rest of the body changes.

- **At L3 the body the studio runs costs nearly twice the skeleton's tick**, about 2.9 ms against
  1.5, so it runs at about a third of real time rather than 0.6x. The trainer's body, without the
  posed bones and the swept bellies, costs about 2.6 ms.
- **MuJoCo is still the largest single cost, but no longer most of the problem.** The backend step
  is about 1.6 ms of the studio's 2.9 at L3, a little over half. Nearly all the rest is this
  project's: muscle dynamics about 0.8 ms, a quarter of the tick, and the bellies about 0.37 ms.
  The muscle paths, passive joints, bone pose, cord, nerves, tremor and drive come to about
  0.15 ms together. The M5.11 conclusion that optimising the modules would be optimising 5% of the
  problem no longer holds: at L3 it would be optimising nearly half of it.
- **Below L3 the muscles set the pace.** The muscle set is the same on every profile, so it costs
  as much at L1 as at L3 -- muscle dynamics a little more, at the 500 Hz rate -- while the
  skeleton under it costs a seventh as much or less. At L1 the modules this project wrote are
  nine tenths of the tick, and the whole body runs at about real time at L1 and at four fifths of
  it or a little better at L2, where the skeleton alone runs four to nine times faster than life.
  The claim that L0 to L2 run in real time with room to spare is a claim about the skeleton.
- **The bellies are the cost `apps/studio/src/simulation.ts` sweeps less often to avoid.**
  `MuscleVolumeModule` sweeps at 120 Hz, one tick in about eight at 1000 Hz and one in about four
  at 500 Hz, so its row is a sweep's cost spread over those ticks: about 3 ms a sweep on every
  profile in these runs, more than the 1.58 ms the comment there records. Swept every tick it
  would be the largest item in the studio's tick, larger than MuJoCo's step; at its own rate it
  is an eighth of the tick at L3 and about a third of it at L1 and L2.

The first full-body row is the baseline for the studio's frame cost: the studio's own L3 body, run
headless. What a studio frame costs beyond the ticks it advances is the rendering and the page,
not the simulation. These figures come from a desktop that was running other work at the same
time; compare rows within one run rather than across runs.

## Historical: ADR-003 reassessment evidence

Frozen. The skeleton-only table as the bench generated it on 2026-09-14 on linux-x64 with Node
v22.22.2, with both backends, kept as the evidence for the ADR-003 reassessment of 2026-09-13,
which made MuJoCo the only enabled backend. The bench then built its own kernel (physics, passive
joints, skeleton pose, metrics and coupling), lifted the body 0.3 m by hand, and ran every profile
at 240, 500 and 1000 Hz; it now runs the golden runner at each profile's own rate, so its figures
are not directly comparable with these. Rapier was the second backend until the owner deleted it
on 2026-09-26 (ADR-003). `pnpm bench` measures neither table any longer, so they will not change.

| Profile | Backend | Rate (Hz) | Bodies | nv | ms / step | Real time |
|---|---|---|---|---|---|---|
| l0_ragdoll | mujoco | 240 | 15 | 35 | 0.232 | 18.0x |
| l0_ragdoll | mujoco | 500 | 15 | 35 | 0.151 | 13.3x |
| l0_ragdoll | mujoco | 1000 | 15 | 35 | 0.156 | 6.4x |
| l1_standard | mujoco | 240 | 23 | 48 | 0.258 | 16.1x |
| l1_standard | mujoco | 500 | 23 | 48 | 0.260 | 7.7x |
| l1_standard | mujoco | 1000 | 23 | 48 | 0.247 | 4.1x |
| l2_biomechanical | mujoco | 240 | 49 | 98 | 0.542 | 7.7x |
| l2_biomechanical | mujoco | 500 | 49 | 98 | 0.574 | 3.5x |
| l2_biomechanical | mujoco | 1000 | 49 | 98 | 0.612 | 1.6x |
| l3_anatomical | mujoco | 240 | 109 | 185 | 1.310 | 3.2x |
| l3_anatomical | mujoco | 500 | 109 | 185 | 1.266 | 1.6x |
| l3_anatomical | mujoco | 1000 | 109 | 185 | 1.325 | 0.8x |
| l0_ragdoll | rapier | 240 | 15 | 35 | 0.438 | 9.5x |
| l0_ragdoll | rapier | 500 | 15 | 35 | 0.407 | 4.9x |
| l0_ragdoll | rapier | 1000 | 15 | 35 | 0.849 | 1.2x |
| l1_standard | rapier | 240 | 23 | 48 | 0.555 | 7.5x |
| l1_standard | rapier | 500 | 23 | 48 | 1.542 | 1.3x |
| l1_standard | rapier | 1000 | 23 | 48 | 1.877 | 0.5x |
| l2_biomechanical | rapier | 240 | 49 | 98 | 1.652 | 2.5x |
| l2_biomechanical | rapier | 500 | 49 | 98 | 7.352 | 0.3x |
| l2_biomechanical | rapier | 1000 | 49 | 98 | 9.978 | 0.1x |
| l3_anatomical | rapier | 240 | 109 | 185 | 1.370 | 3.0x |
| l3_anatomical | rapier | 500 | 109 | 185 | 18.012 | 0.1x |
| l3_anatomical | rapier | 1000 | 109 | 185 | 17.514 | 0.1x |

| Profile | Backend | Recompile and restore, ms |
|---|---|---|
| l1_standard | mujoco | 229.8 |
| l2_biomechanical | mujoco | 432.9 |
| l1_standard | rapier | 19.1 |
| l2_biomechanical | rapier | 20.5 |
