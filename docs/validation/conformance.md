# Backend conformance and plausibility

Spec sections 13.2 to 13.4. Every scenario in `@bs-humany/scenarios` runs on both backends in
`packages/testkit/src/scenarios.test.ts`. Three things are checked, with the tolerances and their
reasons written next to the numbers in `plausibility.ts` and `conformance.ts` rather than here, so
they cannot drift apart.

## What is compared

**Plausibility**, per backend: no NaN or Inf; total energy (kinetic, gravitational, and the
elastic energy of the passive curves and emulated stops) never rises in a passive system beyond
2 J per 20 ms sample; no DoF past its stop by more than 0.45 rad on Rapier or 0.2 rad on MuJoCo;
penetration under 4 cm on Rapier and 3 cm on MuJoCo; joint drift under 5 cm; the body at rest
(under 1 J kinetic) at the end; the centre of mass falling at g during free flight.

**Conformance**, Rapier against MuJoCo: the centre of mass within 5 mm during the contact-free
prefix; both at rest at the end with resting centre-of-mass heights within 12 cm; dissipated
energy within a quarter of the initial mechanical energy.

**Goldens**: an FNV-1a hash of every sampled position, orientation and joint coordinate, per
scenario, profile and backend, committed in `packages/testkit/goldens/trajectories.json`. A
changed hash fails the suite. Updating a golden is a deliberate commit with a written reason;
run `UPDATE_GOLDENS=1 pnpm test` to regenerate. Rapier's hashes are platform-specific; MuJoCo's
should not be, but the file records the platform they were produced on.

## Results, 2026-09-13

Largest values seen per scenario and backend: range violation (rad), penetration (mm), joint
drift (mm), and kinetic energy at the end (J). Every run passes its checks; the numbers are kept
so the tolerances can be read against what they actually cover.

| Scenario | Rapier | MuJoCo | Conformance |
|---|---|---|---|
| drop-standing-collapse | 0.40 rad, 30 mm, 0.4 mm, 0.00 J | 0.06 rad, 10 mm, 0.0 mm, 0.00 J | ok |
| drop-supine | 0.00 rad, 2 mm, 0.4 mm, 0.00 J | 0.06 rad, 9 mm, 0.0 mm, 0.00 J | ok |
| drop-prone | 0.04 rad, 3 mm, 0.1 mm, 0.00 J | 0.05 rad, 9 mm, 0.0 mm, 0.00 J | ok |
| stairs-tumble | 0.19 rad, 32 mm, 0.2 mm, 0.00 J | 0.08 rad, 14 mm, 0.0 mm, 0.00 J | ok, per-scenario tolerances |
| hang-from-wrist | 0.40 rad, 28 mm, 3.1 mm, 0.83 J | 0.15 rad, 8 mm, 0.0 mm, 0.02 J | ok |
| seated-on-box | 0.08 rad, 6 mm, 0.4 mm, 0.02 J | 0.05 rad, 21 mm, 0.0 mm, 0.11 J | ok |
| grab-and-swing | 0.28 rad, 13 mm, 0.8 mm, 0.35 J | 0.08 rad, 8 mm, 0.0 mm, 0.00 J | ok |

The Rapier stop yields (0.40 rad at the ankle and the hanging shoulder) are the subject of
OQ-009. The stairs scenario carries its own tolerances, with the reasons in its definition:
step-edge impacts inject up to ~9 J per sample on Rapier, and which step a body stops on is
chaotic, so resting heights may differ by up to 0.6 m between backends.
