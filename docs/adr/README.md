# Architecture Decision Records

One file per decision, appended over time. Each records what would need to change for the decision
to be revisited, so future contributors do not re-open settled questions blindly.

**Do not relitigate an ADR without flagging it to the project owner.**

| ADR | Title | Status |
|---|---|---|
| [001](adr-001-two-layer-body-model.md) | Two-layer body model: anatomy is complete, dynamics is scalable | Accepted |
| [002](adr-002-hsdl-canonical-format.md) | Canonical model format is a project-owned declarative schema, shaped as an MJCF superset | Accepted |
| [003](adr-003-two-backends.md) | Two backends in Phase 1: Rapier as default, MuJoCo as the accuracy backend | Accepted |
| [004](adr-004-module-kernel.md) | Fixed-timestep, phase-ordered, single-writer module kernel | Accepted |
| [005](adr-005-procedural-geometry.md) | Phase 1 geometry is procedurally generated; anatomical meshes are a separate asset pack | Accepted |
| [006](adr-006-collision-proxies.md) | Collision geometry is never anatomical geometry | Accepted |
| [007](adr-007-typescript-monorepo.md) | TypeScript monorepo, no UI framework in the core | Accepted |
| [008](adr-008-web-worker.md) | Simulation runs in a Web Worker from day one | Accepted |
| [009](adr-009-licensing.md) | Licensing: quality first; core stays permissive by structure, not by sacrifice | Accepted |
| [010](adr-010-naming-and-platform-floor.md) | Project naming and platform floor | Accepted |
