# ADR-010 — Project naming and platform floor

**Status:** Accepted
**Date:** 2026-09-11
**Resolves:** spec §17.3 and §17.7

## Context

The specification used "HumanSim" and "HSDL" as placeholders throughout and flagged renaming as
cheap before M3 and expensive after, because bone IDs are a stable public ABI and the project name
is baked into every package scope. It separately flagged the target platform floor as
near-blocking, because it determines whether cross-origin isolation can be assumed.

Both were put to the project owner before any code was written.

## Decision — naming

The project is **`bs-humany`**, matching its repository directory.

- **Workspace scope:** `@bs-humany/*`. Chosen for import ergonomics, since this string appears in
  every import statement in the codebase.
- **Reverse-DNS namespace:** `bsums.xyz.bs-humany`, the owner's canonical package-name prefix. Used
  wherever a *globally unique* identifier is required — JSON Schema `$id` URIs, HSDL extension
  namespaces (spec §14.5 item 3), persisted storage keys, and any future published package scope.

The schema keeps the name **HSDL**. Only the product name changed, so "HumanSim Description
Language" is retained as the expansion for continuity with the specification document.

Bone IDs are unaffected — they are anatomical (`femur_r`, `vertebra_l3`) and carry no project
prefix by design.

## Decision — platform floor

**`L0-ragdoll` must run on mobile.**

Consequences, which amend ADR-008:

- Cross-origin isolation **cannot be assumed**. `SharedArrayBuffer` is an optimization, detected at
  runtime, never a requirement.
- The transferable-`ArrayBuffer` double-buffered transport is a **first-class path** that must be
  tested on its own, not a degraded fallback that only runs when something has gone wrong.
- MuJoCo's multi-threaded WASM build is gated behind detected isolation. The single-threaded build
  is the portable default.
- WASM payload size is a real budget, not an afterthought. The MuJoCo backend must be
  dynamically imported so mobile `L0` users never download it.
- Render budget for `L0` assumes a mobile GPU: instanced or merged geometry is mandatory, not an
  optimization to do later.

## Revisit if

The owner drops mobile support, in which case the `SharedArrayBuffer` path becomes the only one
worth maintaining and a meaningful amount of transport complexity can be deleted.
