# ADR-009 — Licensing: skeleton data is CC BY-SA 4.0, code is Apache-2.0, nothing is done for commercial reasons

**Status:** Rewritten 2026-09-12 (spec 0.5). The 0.4 text is in git history. See ADR-011.
Amended 2026-09-26: the owner placed `muscle-data` in the Data tier as a whole and the `scenarios`
fixtures in it too, and asked for the tiers to name every package.

## Context

The 0.4 version of this record drew a hard line between a permissive core and a Share-Alike asset
pack, and forbade taking any measurement from a licensed mesh, reasoning that a cheap commercial
exit was worth retaining for free. The owner has since stated that commercial viability is not a
goal at all, so that reasoning no longer applies.

## Decision

Two licence tiers, and a third for tooling that is never distributed.

1. **Code** is **Apache-2.0** and depends only on permissively-licensed software. Not as a
   commercial hedge: code is not a derivative of the data it loads, so there is no obligation to
   relicense it, and Apache-2.0 is the least surprising licence for the engines it sits between.
   It is:
   - in `packages/`: `anthropometry`, `backend-mujoco`, `compiler`, `export-gltf`, `frames`,
     `hsdl`, `kernel`, `modules-mechanics`, `modules-muscle`, `modules-nerves`,
     `modules-sensing`, `muscle-model`, `muscle-path`, `muscle-volume`, `pose-bridge`,
     `render-three`, `scenarios` (all but its fixtures) and `testkit`;
   - in `apps/`: `studio`, with its `src-tauri` desktop shell, and `xr-viewer`;
   - in `tools/`: `blender`, `cli`, `ingest` and `train`;
   - the repository root.

2. **Data** is **CC BY-SA 4.0**, with attribution to BodyParts3D and Z-Anatomy in `NOTICE` and in
   the package. It is:
   - `skeleton`;
   - `assets-anatomical`, whose data is under `data/`;
   - `muscle-data`, as a whole package. Its attachments name sites that the skeleton locates on
     the meshes, its muscle length ranges are swept on those bones, and some of its fibre lengths
     are distances between attachments there, so those values are derivatives. The MyoSuite
     scalars beside them are Apache-2.0 and Seth 2019's are CC BY; both licences permit their use
     in a CC BY-SA work.
   - the `scenarios` fixtures, under `packages/scenarios/data/`. The rest of that package is code,
     so its `package.json` names both licences and the root `NOTICE` covers the fixtures.
   - every other value derived from Z-Anatomy or BodyParts3D geometry, wherever it lands.

   Landmarks, local frames, joint centres, rest transforms, convex hulls, decimated LODs and
   procedural profiles traced from the meshes are all derivatives and all carry the licence. This
   is accepted and is the point of the decision. A package wholly in this tier carries
   `CC-BY-SA-4.0` in its `package.json`, the licence text in `LICENSE`, and a `NOTICE` that says
   what it derives from.

3. **Validation tooling** -- `tools/validate-external` -- is developer-local and is never
   published. It may hold MyoSkeleton as a behavioural oracle (see below). The MyoSuite models
   vendored there are Apache-2.0, and the root `NOTICE` lists the parts of them that the studio
   ships.

Every workspace package is named above, and the tier table in `CONTRIBUTING.md` names the same
ones. A new package takes its place in both before it lands.

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
