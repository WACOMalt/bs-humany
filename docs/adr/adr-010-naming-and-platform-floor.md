# ADR-010 — Project naming and platform floor

**Status:** Accepted; status note 2026-09-26, updated 2026-09-27 (the floor is unchanged; see
[Status note, 2026-09-26](#status-note-2026-09-26))
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

## Status note, 2026-09-26

The platform floor is unchanged: **`L0` must run on mobile.** The naming decision is unchanged.
What this note records is how far the consequences listed under "Decision — platform floor" hold
in the code today, since two of them assumed a worker and a second backend that the studio does not
have. It records the owner's decisions of 2026-09-26 and 2026-09-27 and does not reopen the floor.

- **The worker transport has no app behind it.** The studio runs its simulation on the main
  thread under an interim exception to ADR-008, with shared channels off. The transferable
  `ArrayBuffer` path is still a first-class path in the kernel and is tested on its own there
  (`packages/kernel/src/transport.test.ts`, "copy transport (the mobile path)"), but no app
  exercises it. `SharedArrayBuffer` is still only ever an optimization detected at runtime, never
  a requirement.
- **MuJoCo is not dynamically imported, and cannot spare `L0` its download.** That bullet was
  written when a lighter backend would run the low profiles. Since the ADR-003 reassessment of
  2026-09-13 MuJoCo has been the only enabled backend, and since 2026-09-26 the only backend, so
  every profile needs it: the studio imports `@bs-humany/backend-mujoco` statically, and a phone
  running `L0` downloads MuJoCo's single-threaded wasm, about 10 MB. What MuJoCo costs on a phone,
  in payload and in step time, is unmeasured; ADR-003 names that measurement as the open question
  about this floor.
- **The multi-threaded MuJoCo build is not used at all**, isolated or not; the single-threaded
  build is the only one loaded, which keeps the portable default.

**Update 2026-09-27.** The owner decided ADR-008's follow-on: a headless `@bs-humany/session`
package first (package headless-session-package, wave 15 of the experience pass), and the move of
the simulation into a worker in a later pass built on it. The numbers it was decided from are in
ADR-008. A mobile `L0` target is one of the two triggers ADR-008 names for revisiting the studio's
main-thread exception, and it would bring the worker move forward, because a phone's main thread
is the one least able both to simulate and to render.
