# pose-bridge

How a simulation hands its body pose to a renderer it does not own. The writing end, in
TypeScript; the reading end is `apps/xr-viewer/src/bridge.rs`.

The layout, the seqlock and the reasons are in the header comment of `src/index.ts` -- that is
the single statement of the format, and the Rust side's comment points back here rather than
restating it.

Two things worth knowing without opening it:

- It is **latest-wins and non-blocking both ways** (ADR-012). The simulation never waits for a
  reader; a reader never waits for the simulation. A pose superseded before anyone read it is
  overwritten.
- The two implementations are checked against each other through a file. `pnpm
  generate:pose-bridge-fixture` writes `apps/xr-viewer/fixtures/pose-bridge.bin` from this
  writer, `cargo test` in the viewer reads it and pins the numbers, and `--check` is a CI gate.
  Change the layout on one side and the other side's test says so.

`pnpm publish:pose` is the headless simulation that writes one; `apps/xr-viewer` is what reads it.
