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

| Scenario | Rapier plausibility | MuJoCo plausibility | Conformance |
|---|---|---|---|
| drop-standing-collapse | ok (ankle stop yields 0.40 rad) | ok | ok |
| drop-supine | ok | ok | ok |
| drop-prone | ok | ok | ok |
| stairs-tumble | ok (3.7 cm on a step edge) | ok (0.15 rad at a stop) | ok |
| hang-from-wrist | ok (shoulder stop yields 0.40 rad) | ok (0.15 rad) | ok |
| seated-on-box | ok | ok | ok |
| grab-and-swing | ok | ok | ok |

The parenthesised numbers are the largest values seen, kept here so the tolerances can be read
against what they actually cover. The Rapier stop yields are the subject of OQ-009.
