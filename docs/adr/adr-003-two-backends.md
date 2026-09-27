# ADR-003 — Two backends in Phase 1: Rapier as default, MuJoCo as the accuracy backend

**Status:** Accepted; reassessed 2026-09-13 — MuJoCo is the only enabled backend; Rapier
deleted 2026-09-26, so MuJoCo is the only backend. See
[Reassessed 2026-09-13 (M5.8)](#reassessed-2026-09-13-m58) and
[Rapier deleted 2026-09-26](#rapier-deleted-2026-09-26).

## Decision

Ship both. `RapierBackend` is the default for interactive use and for low fidelity profiles.
`MujocoBackend` is selectable and is the default for high fidelity profiles and for anything a user
labels a measurement run. Both sit behind `IPhysicsBackend`.

## Rationale

The two requirements — "responsive, visually fun" and "research accuracy, slow is acceptable" —
genuinely want different engines, and the adapter was already mandated.

Building the second adapter in Phase 1 rather than deferring it is the only way to know the
abstraction is real. **A single-implementation interface is a fiction.** It also front-loads the
discovery of where the abstraction leaks, while the codebase is small.

## Implementation ordering

Rapier first (faster feedback loop, simpler API, easier debugging), then MuJoCo, then the
conformance harness that runs both against the same scenarios.

## Cost

Roughly 1.5x the adapter work of a single backend. Accepted deliberately.

## Revisit if

MuJoCo-WASM proves fast enough at low fidelity to be the only backend. Reassess after the M3.19
benchmarks.

It did, and it was: see the reassessment below.

## Reassessed 2026-09-13 (M5.8)

Recorded here on 2026-09-26. Until then the reassessment lived only in the specification
(`docs/spec/bs-humany-spec.md`, the paragraph closing its copy of this ADR), while the code and
the conformance report cited it as "the ADR-003 reassessment". This section records the
project owner's decisions. It does not reopen them.

**What was measured.** MuJoCo-WASM is fast enough: 0.11 ms per step at L0 and 0.17 ms at L1 on
the desktop benchmark, unchanged by the move to convex-hull collision proxies (ADR-006, M5.8),
with every scenario plausible and golden trajectories that do not depend on the platform. Rapier
went from 0.24 and 0.33 ms to 0.95 and 1.6 ms with the hulls, and became unstable in three
scenarios: it injected energy and tore joints. It also already carried a joint-angle solver,
emulated range stops and couplings, and OQ-009, only so that it would behave like a
reduced-coordinate engine. The one reason left in its favour was untested: its payload and
behaviour on a phone, where its wasm is 2 MB against MuJoCo's 10 MB.

**Decision of 2026-09-13.** MuJoCo is the only enabled backend. `RapierBackend` stays in the
tree as a vestigial remnant, disabled and hidden from the studio, with its scenario checks
skipped, so that it can be revisited. Measuring MuJoCo on real mobile hardware was the condition
for deleting Rapier outright.

**Decision of 2026-09-26.** The owner decided to delete Rapier now, and waived the
phone-measurement condition. So the "Decision" and "Implementation ordering" sections above are
history: there is one backend, and the conformance harness has one engine to hold to its
scenarios. The deletion itself is a separate change, and that change sets the final status line
of this ADR.

What this gives up is the reason the ADR gave for building two adapters: a single-implementation
interface is a fiction. `IPhysicsBackend` stays, and the next second backend (a native or remote
MuJoCo, or MJX) is what will test it again. The platform floor (ADR-010, `L0` on mobile) is not
changed by any of this. What MuJoCo costs on a phone is still unmeasured, and that measurement is
now a question about the floor, not about Rapier.

## Rapier deleted 2026-09-26

The change the decision above called for. It records what the owner decided and does not
reopen it.

**What went.** `packages/backend-rapier` and its dependency on `@dimforge/rapier3d-compat`; the
studio's import of it, which took about 2.7 MB of Rapier wasm out of every studio and desktop
load; its rows in the mechanics and testkit tests, which now run on MuJoCo; its rows in
`pnpm bench`; the cross-backend conformance harness, which had nothing left to compare
(`docs/validation/conformance.md`); and its line in `NOTICE`.

**What stays.** `IPhysicsBackend`, for the next backend. The `CouplingModule`, which stands
down on MuJoCo and is what a backend that approximates couplings would use. The HSDL
`defaultBackend` value `'rapier'`, accepted as a deprecated alias and read as `'mujoco'`, and the
studio's reading of a saved session that names it, so that documents and sessions written before
today still load and run. Rapier's last benchmark and plausibility figures, kept as dated
history in `docs/validation/benchmarks.md` and `docs/validation/conformance.md`.
