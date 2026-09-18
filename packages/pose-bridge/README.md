# pose-bridge

How a simulation hands its body pose to a renderer it does not own. The writing end, in
TypeScript; the reading end is `apps/xr-viewer/src/bridge.rs`.

The layout, the seqlock and the reasons are in the header comment of `src/index.ts` -- that is
the single statement of the format, and the Rust side's comment points back here rather than
restating it.

The format is in `src/codec.ts`, which touches no file system so a browser can build the same
bytes: the studio does, and hands them to its Tauri side to write. `src/node.ts` is the Node end
-- a sink over `fs`, the `open` conveniences, a grab reader over a descriptor.

Two things worth knowing without opening it:

- It is **latest-wins and non-blocking both ways** (ADR-012). The simulation never waits for a
  reader; a reader never waits for the simulation. A pose superseded before anyone read it is
  overwritten.
- The two implementations are checked against each other through a file. `pnpm
  generate:pose-bridge-fixture` writes `apps/xr-viewer/fixtures/pose-bridge.bin` from this
  writer, `cargo test` in the viewer reads it and pins the numbers, and `--check` is a CI gate.
  Change the layout on one side and the other side's test says so.

`pnpm publish:pose` is the headless simulation that writes one; `apps/xr-viewer` is what reads it.

## And the muscles

`MuscleBridgeWriter` writes a second ring beside the first, `<pose path>-muscles`, holding every
belly's rings -- centre, orientation, radius, eight floats -- rather than its vertices, because a
swept tube is a function of its rings and the reader can sweep it itself for a hundredth of the
bytes. Same seqlock, same ring, and the same fixture generator writes its fixture.

## And the panel

Two more files beside the ring, neither of them binary: `<path>-status.json`, which the publisher
renames into place four times a second, and `<path>-commands.jsonl`, which the viewer appends to
one JSON object a line. `tools/cli/bin/publish-pose.mjs` documents both; they are what the
headset's panel reads and writes.

## And back: grabs

The same file states a second, much smaller layout for the other direction -- `GrabIntentReader`
here, `GrabIntentWriter` in the Rust side -- one slot per hand beside the pose ring, saying whether
the hand is squeezing, which bone it holds and where the hand is. The publisher reads it every
tick and drives the grab module with it, which is how a tracked controller pulls the skeleton
about. Same seqlock, same never-wait rule, and a test on each side pins the same bytes by hand.
