# ADR-009 — Licensing: skeleton data is CC BY-SA 4.0, code is Apache-2.0, nothing is done for commercial reasons

**Status:** Rewritten 2026-09-12 (spec 0.5). The 0.4 text is in git history. See ADR-011.

## Context

The 0.4 version of this record drew a hard line between a permissive core and a Share-Alike asset
pack, and forbade taking any measurement from a licensed mesh, reasoning that a cheap commercial
exit was worth retaining for free. The owner has since stated that commercial viability is not a
goal at all, so that reasoning no longer applies.

## Decision

Two tiers.

1. **Code** -- `kernel`, `hsdl`, `frames`, `anthropometry`, `compiler`, both backends, `modules-*`,
   `render-three`, `testkit`, `tools` -- is **Apache-2.0** and depends only on permissively-licensed
   software. Not as a commercial hedge: code is not a derivative of the data it loads, so there is
   no obligation to relicense it, and Apache-2.0 is the least surprising licence for the engines
   it sits between.

2. **Data** -- `skeleton`, `assets-anatomical`, scenario fixtures, and every value derived from
   Z-Anatomy or BodyParts3D geometry -- is **CC BY-SA 4.0**, with attribution to BodyParts3D and
   Z-Anatomy in `NOTICE` and in the package. Landmarks, local frames, joint centres, rest
   transforms, convex hulls, decimated LODs and procedural profiles traced from the meshes are all
   derivatives and all carry the licence. This is accepted and is the point of the decision.

## What is still excluded, and why

MyoSkeleton stays a behavioural oracle in developer-local tooling and is never transcribed.

**The reason is licence incompatibility, not commerce.** Share-Alike requires every derivative to
permit commercial use; MyoSkeleton's non-commercial research licence forbids it. A value copied
from MyoSkeleton into the BY-SA skeleton data would make that data undistributable under either
licence. §13.6's rule for oracles stands with that justification.

Rajagopal 2016 (freely distributed), MyoSuite (Apache-2.0) and Z-Anatomy (CC BY-SA) may all be
adopted directly, with citation.

## Verification chain

BodyParts3D is CC BY-SA 2.1 JP; Z-Anatomy redistributes as CC BY-SA 4.0. Confirm the relicensing
chain when the dataset is ingested (M1.11) and record the finding in `docs/sources/`.

## Revisit if

Never for commercial reasons. Only if a dataset with a more permissive licence proves better.
