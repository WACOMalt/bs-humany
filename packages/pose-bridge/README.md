# pose-bridge

How a simulation hands its body pose to a renderer it does not own. The writing end, in
TypeScript; the reading end is `apps/xr-viewer/src/bridge.rs`.

The layouts -- the pose ring, the muscle ring and the grab intents -- the seqlock and the reasons
are in the header comments of `src/codec.ts`. That is the single statement of the format; this
file and the Rust side point at it rather than restate it. `DEFAULT_PATH` there is where the
bridge lives when nobody names one: the command-line publishers take it from the codec, and the
studio's desktop build publishes on a path of its own (`apps/studio/src-tauri/src/main.rs`), so
Connect VR never touches a showcase's files. `src/bridgePath.test.ts` holds both to that.

The format is in `src/codec.ts`, which touches no file system so a browser can build the same
bytes: the studio does, and hands them to its Tauri side to write. `src/node.ts` is the Node end
-- a sink over `fs`, the `open` conveniences, a grab reader over a descriptor.

Three things worth knowing without opening it:

- It is **latest-wins and non-blocking both ways** (ADR-012). The simulation never waits for a
  reader; a reader never waits for the simulation. A pose superseded before anyone read it is
  overwritten.
- The two implementations are checked against each other through a file. `pnpm
  generate:pose-bridge-fixture` writes `apps/xr-viewer/fixtures/pose-bridge.bin` from this
  writer, `cargo test` in the viewer reads it and pins the numbers, and `--check` is a CI gate.
  Change the layout on one side and the other side's test says so.
- **Every create is a new file.** A writer builds the ring whole under a temporary name and
  renames it over the old one, never truncating a file a reader has mapped: truncation under a
  live mapping is a SIGBUS in the reader, and a rename leaves the old inode whole with whoever
  still holds it. A new run also writes a new `generation` in its status, which is what tells a
  reader to reopen.

`pnpm publish:pose` is the headless simulation that writes one; `apps/xr-viewer` is what reads it.

## And the muscles

`MuscleBridgeWriter` writes a second ring beside the first, `<pose path>-muscles`, holding every
belly's rings -- centre, orientation, radius, eight floats -- rather than its vertices, because a
swept tube is a function of its rings and the reader can sweep it itself for a hundredth of the
bytes. Its layout is stated in `src/codec.ts` beside the pose ring's. Same seqlock, same ring, and
the same fixture generator writes its fixture.

## And the panel

Two more files beside the ring, neither of them binary: `<path>-status.json`, which the publisher
renames into place ten times a second (every 100 ms), and `<path>-commands.jsonl`, which the
viewer appends to one JSON object a line. `tools/cli/bin/publish-pose.mjs` documents both; they
are what the headset's panel reads and writes.

## And back: grabs

`src/codec.ts` states a second, much smaller layout for the other direction -- `GrabIntentReader`
here, `GrabIntentWriter` in the Rust side -- one slot per hand beside the pose ring, saying whether
the hand is squeezing, which bone it holds and where the hand is. The publisher reads it every
tick and drives the grab module with it, which is how a tracked controller pulls the skeleton
about. Same seqlock, same never-wait rule, and a test on each side pins the same bytes by hand.
