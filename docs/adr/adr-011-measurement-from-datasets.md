# ADR-011 — Commercial viability is not a goal. Measurement from licensed meshes is permitted

**Status:** Accepted
**Date:** 2026-09-12
**Supersedes:** the provenance rule in ADR-009 (0.4 text), the "meshes render, they do not
measure" consequence of ADR-005

## Context

Milestone M1.9 produced the first rendered skeleton. All 206 bones were present and the tree,
symmetry and proportions all passed their tests, but placement was hand-authored -- 206 rest
transforms each checked by eye -- and it showed: rotated scapulae, a mis-swept clavicle, a sternum
that spent a while four centimetres off the midline. Each was found one at a time by looking.

The owner reviewed the result and directed that the prohibition on measuring from anatomical mesh
datasets be removed, stating that commercial viability is of no concern at all. That prohibition
had been the sole reason for hand-authoring placement.

## Decision

Anatomical mesh datasets **may** be used as the source of bone geometry, bone placement, landmarks,
local frames and joint centres. Z-Anatomy (CC BY-SA 4.0, derived from BodyParts3D) is adopted as
the primary dataset.

The skeleton data is published **CC BY-SA 4.0**. Code stays Apache-2.0, because code is not a
derivative of the data it loads.

## What this changes

- **ADR-005** is rewritten: the mesh dataset is the source of truth for shape and placement.
  Procedural recipes become the fallback and the low-detail LOD. Morphology acts by per-bone rigid
  placement at parametric joint centres plus per-bone scaling.
- **ADR-009** is rewritten: two tiers, code and data, with no commercial reasoning anywhere.
- **CONTRIBUTING rules 4 and 5** are rewritten. Rule 5 now says the opposite of what it did.
- **M1.11** is added: the dataset ingestion tool. **M1.2** and **M5.8** are revised.

## What does not change

MyoSkeleton stays a behavioural oracle only, never transcribed. **The reason is no longer
commercial.** Its non-commercial research licence is incompatible with CC BY-SA: Share-Alike
requires every derivative to permit commercial use, and the NC licence forbids it, so the two
cannot coexist in one work. A single copied value would make the skeleton data undistributable
under either licence.

Every landmark still cites its ISB or literature *definition*. The dataset is where the landmark is
*located*, and the record says which dataset, version and structure it was located on, so the
value can be re-derived when the dataset is updated.

## Revisit if

The owner's position on commercial use changes. The 0.4 text of ADR-009 is preserved in git
history and describes the structure that would be required.
