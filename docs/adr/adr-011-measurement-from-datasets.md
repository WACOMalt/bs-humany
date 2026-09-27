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

## Added 2026-09-27 — a marker names a feature and never positions it

The decision above says the mesh is where a landmark is located. It did not say that the export's
markers are not the mesh. They are label anchors: each is placed out in the clear beside the
feature it names, so that a text label can point at the feature without sitting inside the bone.
Measured against the bones they name, not one marker in the arm lies on its bone; they miss by 10
to 30 mm, and the two humeral epicondyle markers stand 103.5 mm apart across a bone that measures
63.8 between them (`landmarks.ts` has the measurement). Positions taken from them put the elbow's
flexion axis, brachialis's insertion and the hip and shoulder joint centres in the wrong place,
and each was found separately.

So the rule, written into CONTRIBUTING rule 5 as well: **a marker names a feature and never
positions it.** A position comes from the measured tables -- points put back on the bone by a
stated rule, points measured along a ridge, points derived off the mesh at ingest, and fitted
articular and contact centres -- through `locateFeature` in `@bs-humany/skeleton`, which answers
with the point and the table it came from, or `measuredWorld`, which throws where no table has
one. A feature nothing has measured still answers with its marker and says so (`table: 'marker'`),
so a gap is visible rather than silent. `markerWorld` answers only the question of where the
export put its label.

The attachment sites, the landmarks and the thorax generator read positions through that lookup.
Four places still position by a marker as this is written. Three of them use a marker where a
point of the same name has been put back on the bone: the radioulnar joint centre
(`Head_of_radius`, `joints.ts`), the L3 subtalar centre (`Tarsal_sinus`, `jointsL3.ts`) and the
ends of the humeral shaft's wrap cylinder (`Surgical_neck_of_humerus`, `wrapSurfaces.ts`). The
fourth is the neck generator, which measures its attachment lengths between markers. Moving any of
them changes the body the goldens are taken on, so each is left to a commit of its own that says
so, rather than slipped in under a rule written afterwards.
