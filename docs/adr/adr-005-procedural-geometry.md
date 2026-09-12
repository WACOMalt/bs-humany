# ADR-005 — Bone geometry comes from an anatomical mesh dataset; procedural geometry is the fallback and the low-detail LOD

**Status:** Rewritten 2026-09-12 (spec 0.5). See ADR-011 for why.

## Decision

Bone shape and rest placement come from a curated anatomical mesh dataset -- Z-Anatomy, derived
from BodyParts3D -- ingested offline into per-bone meshes keyed by HSDL bone `id`. Each mesh carries
its own local frame, and the dataset's relative placements supply the rest transforms.

Morphology acts through **per-bone rigid placement at parametric joint centres plus per-bone
scaling driven by the dimension expressions**. The sliders still reshape the body: bones move to
where the parametric layout puts their joints and scale along their own axes. Their *shape* is
measured, not invented.

Procedural recipes are retained for two roles: a fallback for any bone the dataset lacks, and a
low-triangle LOD for the mobile `L0` budget.

## Rationale

The original decision -- procedural geometry as the source of truth, meshes as a later cosmetic
pack -- was implemented through M1.8. It produced a skeleton that was complete and passed every
structural test, and was visibly mis-placed. Hand-authoring 206 rest transforms and checking each
by eye is not a reliable way to position a body. A measured dataset fixes shape and placement
wholesale.

The parametric requirement is met by rigid scaling, which is the rigid-placement-first path the
original text already anticipated. Only the direction of authority is reversed.

## Consequences

- Meshes are now a *measurement* source. Landmarks, local frames and joint centres may be derived
  from them.
- The skeleton data package is CC BY-SA 4.0 (ADR-009).
- The `assets-anatomical` boundary remains as load-time modularity: binary payload stays out of
  the kernel and backends.
- M1.11 (dataset ingestion) is added and is blocking for visual credibility.

## Revisit if

A better-curated dataset appears -- AnatomyTOOL's Open 3D Anatomical Model is the candidate -- or
per-bone rigid scaling proves visibly wrong at extreme morphology and a deformation cage is needed.
