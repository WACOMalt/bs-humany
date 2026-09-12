# ADR-005 — Phase 1 geometry is procedurally generated; anatomical meshes are a separate asset pack

**Status:** Accepted

## Decision

Phase 1 renders bones as procedurally generated geometry — tapered capsules, lofted profiles,
primitive composites — built from a landmark and dimension table in HSDL. No third-party mesh
assets are vendored into the core repository. An `assets-anatomical` package loads real anatomical
meshes, resolved against the same bone IDs, and is a planned Phase 2 deliverable.

## Rationale

Two reasons, both independent of licensing.

1. The owner explicitly said no mesh is needed yet, and procedural geometry gets to a visible
   skeleton far faster.
2. Procedural geometry is **parametric**, so the morphology controls reshape bones for free. A
   fixed mesh set requires either blend shapes between a male and female base or a rigged
   deformation cage, which is real work and should be scheduled as such rather than assumed.

The asset-pack boundary survives the licensing decision because it is load-time modularity worth
having anyway: it keeps a large binary payload out of the critical path, lets the render module
work with either geometry source, and confines Share-Alike obligations to one package.

## Consequences

The mesh pack, when built, **MUST NOT become the geometry source of truth.** Procedural geometry
remains the reference, because it is what responds to morphology parameters. Meshes are fitted *to*
the parametric skeleton — per-bone rigid placement first, deformation later — never the reverse.

## Revisit if

A permissively-licensed, well-topologized, sex-dimorphic anatomical mesh set appears. It would
simplify the pack's licensing but not change the architecture.
