# ADR-008 — Simulation runs in a Web Worker from day one

**Status:** Accepted; not yet adopted by the studio. An interim studio exception was recorded on
2026-09-26, and on 2026-09-27 the owner decided the path out of it: a headless session package
first, the worker move in a later pass. See
[Implementation status and the studio's interim exception, 2026-09-26](#implementation-status-and-the-studios-interim-exception-2026-09-26)
and [Decided 2026-09-27: a headless session package first](#decided-2026-09-27-a-headless-session-package-first).

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

## Implementation status and the studio's interim exception, 2026-09-26

The Decision above is kept as written: it is still where the simulation is meant to run. This
section records where it runs today, and the owner's decision of 2026-09-26 to accept that for now
as an exception rather than leave the ADR contradicted by the code without a word.

**What is built.** `WorkerHost`, `KernelProxy` and the dual-path transport (M2.6) are implemented
in `packages/kernel/src/host.ts` and `transport.ts` and tested there over a `MessageChannel`, on
both the shared and the transferable path. No app wires them in: nothing outside
`packages/kernel/src` imports either class. `KernelOptions.config`, the per-module configuration a
worker would hand to modules it builds, is reserved in the same way; no module reads
`ModuleInitContext.config`, and modules are configured through their constructors.

**Where the kernel runs instead.**

- The studio runs its one kernel on the main thread, in a lock-step frame loop that advances one
  output frame per rendered frame (the exemption ADR-012 records for the studio's own canvas
  loop), with shared channels off (`preferShared: false` in `apps/studio/src/simulation.ts`). It
  loads MuJoCo's single-threaded build.
- Training runs whole kernels inside workers of its own, without `WorkerHost`: in the studio,
  `apps/studio/src/training/pool.ts` starts Web Workers on `episodeWorker.ts`; on the command
  line, `tools/train/src/nodePool.ts` starts Node worker threads. An episode is self-contained and
  returns a score, so nothing crosses the boundary per tick and the transport has nothing to carry.

**Why the studio's exception, for now.** The studio's run is driven by calls that are synchronous
on the main thread and would each become a round trip, or a copy, across a worker boundary:

- *scrub*, which plays the captures back within the frame, and *Reset*, which restores the
  start-of-run snapshot;
- *restore*, which starts a saved session's run from its kernel snapshot;
- *carry*, which restarts a running body in the body the sliders now describe and hands the new
  run the old one's joint state (`carryFrom`);
- *grab*, which picks the bone under the pointer and drags it from the same frame's input;
- *captures*, the bone and muscle recordings the timeline and the Blender export read directly
  from memory.

Moving the kernel means turning each of these into a message and deciding where the captures
live. That is worth doing once it pays, and the owner asked for numbers before deciding it.

**Until then.** The studio, the trainer and the tests do not share a session object. Each
assembles its own run -- the studio in `apps/studio/src/simulation.ts`, the trainer in
`tools/train/src/rig.ts`, the tests in the testkit's runner -- and what they have in common goes
into narrow helpers only, such as the scenario API factory in `packages/scenarios/src/scenarioApi.ts`
and the frames package's maths. `WorkerHost`, `KernelProxy`, the
transport and the `config` plumbing stay in the kernel, tested and reserved for the move; they are
not dead code to delete.

**When to revisit, as recorded on 2026-09-26.** Either of:

1. the studio's L3 frame time once the frame-cost fixes of this pass had landed (the package
   studio-frame-cost-and-exports, merged in `bc59b27`); or
2. a mobile `L0` target (ADR-010), where a main thread that simulates and renders is least able
   to afford both.

The first came due on 2026-09-27, and the next section records it.

## Decided 2026-09-27: a headless session package first

**The numbers.** L3 with the muscles, the body the studio opens on:

| When | Browser: life speed | Browser: UI frames / s | Headless: ms / frame | Headless: ms / tick | Headless: life speed |
|---|---|---|---|---|---|
| At the audit | 0.07x | about 1.5 | -- | -- | -- |
| Before the frame-cost fixes (`3a82ace`) | 0.28x | -- | 60.6 | 3.67 | 0.27x |
| After them (`bc59b27`) | 0.33x | 20 running, 60 at rest | 49.0 | 2.97 | 0.34x |

How they were measured:

- *Browser.* The studio itself, in headless Chromium with the GPU enabled, on a desktop with an
  RTX 3090, measured by the integrator of this pass before and after the frame-cost merge
  and reported to the owner on 2026-09-27. The audit figure is the live finding that started the
  frame-cost work.
- *Headless.* The studio's own `Simulation` class, captures and all, in Node v22.22.2 on linux-x64: `quiet-standing` at L3, 1000 Hz, with the muscles, the default cord and a 60 fps output,
  advanced one output frame (16.67 ticks) at a time as the frame loop does; 180 frames timed after
  20 warm-up frames, the median of five alternating runs. The method and the table are in
  `docs/validation/benchmarks.md`, "The studio's frame, headless".

**What they say.** The browser and the headless figures agree: 20 rendered frames a second of
16.67 ticks each is 333 ticks a second, a third of life speed, and a headless frame of 49 ms is
20 frames a second. So nearly all of a running frame is the simulation's ticks, and the page adds
little on top. The frame-cost fixes removed what the studio kept rather than what it computed;
what remains is MuJoCo's step and the muscle dynamics (`docs/validation/benchmarks.md`). A worker
would not make the body faster. What it would buy is a page that renders and answers input at the
display's rate while the body runs at a third of life, which is ADR-012's shape for the headset
applied to the canvas as well.

**The decision (owner, 2026-09-27).** Option B: first a headless `@bs-humany/session` package,
and the worker move afterwards, as a later pass built on it. The option not taken was to move the
simulation into the worker directly.

The path, in order:

1. **The session package** -- package headless-session-package, wave 15 of the experience pass.
   The session (one compiled and placed articulation, one kernel, the mechanical, muscle and nerve
   modules, the restore points, the captures and the recording) moves out of
   `apps/studio/src/simulation.ts` into a package with no DOM, which the studio, `publish-pose`
   and the training showcase import, so nothing outside the studio reaches into its source.
   Behaviour, threading and every golden are unchanged. This is the first step, and the only one
   scheduled.
2. **The worker move** -- a later pass, not yet planned in detail. The session runs in a worker
   behind `WorkerHost`, or behind a session-level host over the same transport, and the studio
   drives it through a proxy. Each synchronous call listed above becomes a request, and the
   captures stay with the session and are sent across when the timeline or an export needs them.
   How that proxy is shaped is for that pass to decide.

The studio's interim exception stands until step 2 lands. `WorkerHost` and the `config` plumbing
stay reserved for it. A mobile `L0` target, the second trigger above, would bring step 2 forward.
