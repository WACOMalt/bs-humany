# Backend conformance and plausibility

Spec sections 13.2 to 13.4. Every scenario in `@bs-humany/scenarios` runs on both backends in
`packages/testkit/src/scenarios.test.ts`. Three things are checked, with the tolerances and their
reasons written next to the numbers in `plausibility.ts` and `conformance.ts` rather than here, so
they cannot drift apart.

## What is compared

**Plausibility**, per backend: no NaN or Inf; the energy balance (kinetic, gravitational, the
elastic energy of the passive curves and emulated stops, less the work of emulated couplings)
never rises in a passive system beyond 20 J per 20 ms sample on Rapier or 2 J on MuJoCo; no DoF
past its stop by more than 0.5 rad on Rapier or 0.2 rad on MuJoCo; penetration under 4 cm on
Rapier and 3 cm on MuJoCo; joint drift under 5 cm; the body at rest (under 1 J kinetic) at the
end; the centre of mass falling at g during free flight.

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
| drop-standing-collapse | 0.44 rad, 27 mm, 0.3 mm, 0.00 J | 0.11 rad, 18 mm, 0.0 mm, 0.00 J | ok |
| drop-supine | 0.00 rad, 1 mm, 0.2 mm, 0.00 J | 0.06 rad, 8 mm, 0.0 mm, 0.00 J | ok |
| drop-prone | 0.04 rad, 4 mm, 0.1 mm, 0.00 J | 0.02 rad, 10 mm, 0.0 mm, 0.00 J | ok |
| stairs-tumble | 0.20 rad, 30 mm, 1.7 mm, 0.02 J | 0.09 rad, 10 mm, 0.0 mm, 0.00 J | ok, per-scenario tolerances |
| hang-from-wrist | 0.37 rad, 26 mm, 0.7 mm, 0.09 J | 0.12 rad, 13 mm, 0.0 mm, 0.00 J | ok |
| seated-on-box | 0.05 rad, 7 mm, 0.4 mm, 0.06 J | 0.04 rad, 24 mm, 0.0 mm, 0.03 J | ok |
| grab-and-swing | 0.36 rad, 14 mm, 1.0 mm, 0.00 J | 0.06 rad, 9 mm, 0.0 mm, 0.00 J | ok |

The Rapier stop yields (up to 0.44 rad at the ankle in the standing collapse, 0.37 rad at the
hanging shoulder) are the subject of OQ-009. Joint couplings (M5.2) run natively on MuJoCo and as one-way soft corrections on
Rapier, whose work is subtracted in the energy balance. The stairs scenario carries its own
conformance tolerance, with the reason in its definition: which step a body stops on is chaotic,
so resting heights may differ by up to 0.6 m between backends.
