# ADR-003 — Two backends in Phase 1: Rapier as default, MuJoCo as the accuracy backend

**Status:** Accepted

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
