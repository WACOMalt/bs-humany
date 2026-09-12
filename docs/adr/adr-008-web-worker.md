# ADR-008 — Simulation runs in a Web Worker from day one

**Status:** Accepted

## Decision

The kernel and physics backend run in a dedicated Web Worker. The main thread owns rendering and UI
only. State crosses the boundary via `SharedArrayBuffer` where cross-origin isolation is available,
falling back to transferable `ArrayBuffer` double-buffering where it is not.

## Rationale

Retrofitting a worker boundary is expensive and invasive. Establishing it while there are three
modules is nearly free. It is also the same boundary a remote backend would sit behind, so the
"backend later" path in ADR-002 reduces to swapping the transport. MuJoCo's multi-threaded WASM
build needs cross-origin isolation anyway, so the headers are required regardless.

## Amendment (see ADR-010)

The platform floor is **`L0` must run on mobile**, so cross-origin isolation **cannot** be assumed.
The transferable-`ArrayBuffer` double-buffered path is therefore a **first-class transport**, not a
degraded fallback, and must be tested as such. MuJoCo's multi-threaded build remains gated behind
detected isolation; the single-threaded build is the portable default.

## Consequences

The dev server and any deployment MUST be able to serve `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp` when isolation is wanted, and MUST degrade cleanly
when it is not. This is an easy thing to discover far too late.
