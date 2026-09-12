# ADR-009 — Licensing: quality first; core stays permissive by structure, not by sacrifice

**Status:** Accepted

## Context

The project owner has stated that commercial viability is subordinate to result quality:
restrictive licenses are acceptable if they produce a better simulator, and unnecessary if they do
not.

## Decision

Three tiers, with the boundary drawn by **technical role** rather than by license anxiety.

1. **Core packages** (`kernel`, `hsdl`, `frames`, `anthropometry`, `skeleton`, `compiler`, both
   backends, `modules-*`, `render-three`) depend only on permissively-licensed software — MuJoCo
   and Rapier are Apache-2.0, three.js is MIT — and on data sources with no redistribution
   restrictions: de Leva (1996), ANSUR II, the ISB recommendations, Rajagopal 2016, MyoSuite's
   Apache-licensed models. **No copyleft and no non-commercial material enters these packages.**
2. **Asset packs** (`assets-anatomical`) MAY carry CC BY-SA content, with attribution and
   Share-Alike obligations documented in the package and propagated to derivatives — retopology,
   LODs, generated hulls.
3. **Validation tooling** (`tools/validate-external`, developer-local, never published) MAY use
   non-commercially-licensed models such as MyoSkeleton as reference oracles.

## Rationale

Investigating what the permissive constraint was actually costing turned up very little. The two
best non-permissive candidates fail on **technical** grounds before licensing becomes relevant:

- **MyoSkeleton** is a fixed generic model with external scaling — scaling in that ecosystem is an
  OpenSim Scale Tool step driven by motion-capture markers, not a property of the model. A
  fixed-anthropometry MJCF file cannot be the canonical model for a parametric morphology system,
  which is a stated core requirement. Its license is the *second* reason to exclude it, not the
  first.
- **Z-Anatomy meshes** are static geometry, which per ADR-005 cannot be the source of truth for a
  parametric skeleton regardless of license, and which the owner has deferred anyway.

Meanwhile the things that genuinely determine quality — joint definitions, DoF allocation, body
frames, inertial parameters, dimensional percentiles, the solver itself — are **all available
permissively**. There is no accuracy tax being paid.

So: keep the core permissive because it happens to cost nothing, and take the benefits of a relaxed
posture in the two places they actually exist — an anatomical mesh pack that is planned rather than
hedged, and unrestricted use of external models as validation oracles.

## Legal care required in tier 3

Use external non-commercial models as **behavioral** oracles — simulate both and compare joint
axes, ranges of motion and coupling behavior — rather than transcribing their parameter values.
Copied values plausibly carry the source license and would contaminate tier 1.

An agent "helpfully" copying numbers out of a reference model to fill a gap is a realistic and
damaging failure mode. When a validation run reveals a discrepancy, **the fix is to find a citable
published source, not to adopt the oracle's number.**

## Share-Alike compatibility analysis

Adopting CC BY-SA assets in tier 2 does not conflict with any other selection:

- **Software licenses are unaffected.** Apache-2.0 and MIT impose no constraints on what they are
  combined with. Compatibility is one-directional — permissive material may flow into a Share-Alike
  work but not back out — and since meshes are data loaded at runtime rather than code linked into
  a combined work, the code and the assets remain separate works.
- **BY-SA is not NonCommercial.** Share-Alike permits commercial use. It requires only that
  derivatives of the licensed material remain under the same license with attribution.
  Commercialization is foreclosed by MyoSkeleton's NC license, not by BY-SA. Do not conflate these.
- **Version chain.** BodyParts3D is CC BY-SA 2.1 JP. Z-Anatomy redistributes as CC BY-SA 4.0.
  Verify the relicensing chain before relying on 4.0 terms rather than assuming them.

## The real risk: derivative-work creep via measurement

Obvious derivatives — retopologized meshes, decimated LODs, generated convex hulls — all live
inside the asset pack and are contained. The dangerous case is different:

> **Landmark coordinates picked by clicking on CC BY-SA mesh geometry are arguably a derivative of
> that geometry.** Landmarks are not a leaf node: they determine bone local frames, which determine
> joint frames and joint centers, which is effectively all of `skeleton`, `frames`, and every joint
> definition. One afternoon of convenient landmark-picking would propagate a Share-Alike obligation
> through the entire core.

The same applies to procedural geometry recipes whose profile curves are traced from licensed
meshes.

**Therefore: licensed meshes are a rendering asset only, never a measurement source.** Landmarks
and frames MUST be derived from sources without redistribution obligations. The ISB recommendations
define their landmarks textually as palpable bony features. Rajagopal 2016 documents its body
coordinate systems relative to bony landmarks. MyoSuite's models are Apache-2.0. These are also
*better provenance* than a click position.

Where a landmark cannot be derived from a citable source, record it in
`docs/sources/open-questions.md` rather than reaching for the mesh.

This rule is non-obvious and is exactly the kind of shortcut an implementing agent takes without
considering provenance. It is restated in `CONTRIBUTING.md` §11 and is an acceptance criterion for
M1.2 and M5.8.

## Revisit if

The owner later wants to commercialize. Under this structure that requires dropping or replacing
one asset pack and deleting a dev tool — a deliberately cheap exit, retained for free.
