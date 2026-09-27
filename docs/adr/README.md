# Architecture Decision Records

One file per decision, appended over time. Each records what would need to change for the decision
to be revisited, so future contributors do not re-open settled questions blindly.

**Do not relitigate an ADR without flagging it to the project owner.**

When a decision changes or a number in it turns out wrong, amend the ADR; do not rewrite it.
Append a dated section that says what changed and why, mark any paragraph it supersedes, and
update the status here. The text as first written is the record of what was known when the
decision was made, and a future reader needs both. ADR-008's amendment and ADR-014's are the
pattern.

| ADR | Title | Status |
|---|---|---|
| [001](adr-001-two-layer-body-model.md) | Two-layer body model: anatomy is complete, dynamics is scalable | Accepted |
| [002](adr-002-hsdl-canonical-format.md) | Canonical model format is a project-owned declarative schema, shaped as an MJCF superset | Accepted |
| [003](adr-003-two-backends.md) | Two backends in Phase 1: Rapier as default, MuJoCo as the accuracy backend | Reassessed 2026-09-13 (MuJoCo only); Rapier deleted 2026-09-26 |
| [004](adr-004-module-kernel.md) | Fixed-timestep, phase-ordered, single-writer module kernel | Accepted |
| [005](adr-005-procedural-geometry.md) | Bone geometry comes from an anatomical mesh dataset; procedural geometry is the fallback and low-detail LOD | Rewritten in 0.5 |
| [006](adr-006-collision-proxies.md) | Collision geometry is never anatomical geometry | Accepted |
| [007](adr-007-typescript-monorepo.md) | TypeScript monorepo, no UI framework in the core | Accepted |
| [008](adr-008-web-worker.md) | Simulation runs in a Web Worker from day one | Accepted (not yet adopted by the studio); interim studio exception 2026-09-26, session package first decided 2026-09-27 |
| [009](adr-009-licensing.md) | Licensing: skeleton data is CC BY-SA 4.0, code is Apache-2.0, nothing is done for commercial reasons | Rewritten in 0.5 |
| [010](adr-010-naming-and-platform-floor.md) | Project naming and platform floor | Accepted; status note 2026-09-26, updated 2026-09-27 (floor unchanged) |
| [011](adr-011-measurement-from-datasets.md) | Commercial viability is not a goal; measurement from licensed meshes is permitted | Accepted |
| [012](adr-012-render-rate-independent-of-simulation-rate.md) | The render rate is independent of the simulation rate | Accepted |
| [013](adr-013-the-nerves-a-policy-over-the-drive.md) | The nerves: a policy over the drive, trained on the simulation itself | Accepted; forward note 2026-09-26 |
| [014](adr-014-a-spinal-cord-under-the-brain.md) | A spinal cord under the brain, and a search that needs no terminal | Accepted, amended 2026-09-22 |
