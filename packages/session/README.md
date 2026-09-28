# session

The simulation session, with no DOM: one compiled and placed articulation, one kernel with the
mechanical, muscle and nerve modules, the restore points, the bone and muscle captures and the
sampled recording, and what a publisher says about its run.

Three programs use it, and `src/index.ts` exports what they use and nothing else:

- the studio (`apps/studio`), which draws a `Simulation`, drives it from its panels and exports
  its captures;
- `pnpm publish:pose` (`tools/cli/bin/publish-pose.mjs`), which runs one headless and publishes
  its pose to the bridge, with `GrabIntents` for the headset's hands and `publisherStatus` for the
  panel's status file;
- `pnpm train:showcase` (`tools/train/bin/showcase.mjs`), which takes the tissue table for its
  status.

The two tools load it by package name through jiti, so `tools/cli/src/sessionSurface.test.ts`
touches every member they call: neither is type-checked, and a rename here would otherwise be
found at runtime.

It lived in `apps/studio/src` until the owner's decision of 2026-09-27 (ADR-008), when the tools
reached into the app's source for it. It became a package first so that the studio, the
publisher and the showcase share one session that needs no DOM, three.js or Tauri; moving it into
a worker is a later pass that builds on this one.

Things worth knowing without opening it:

- **It is a host, not a module.** It assembles a kernel and steps it, as the testkit's runner and
  the trainer's rig do, so `pnpm module:lint` does not scan it: the modules it registers are
  scanned in their own packages. It reads `performance.now` once per `advance` to report how long
  a tick took and how fast simulated time is coming out; neither reading decides how many ticks
  run, which is what keeps a run the same run on any machine (CONTRIBUTING rule 7).
- **The studio's kernel runs unaudited.** `audit: false` is passed on purpose, and the reason is
  in the constructor: the same modules are audited in the testkit's scenario pass.
- **It is the goldens' run.** `src/scenarioEquivalence.test.ts` holds a `Simulation` of three
  scenarios to the testkit's runner bit for bit, so what the studio shows is what the goldens pin.
