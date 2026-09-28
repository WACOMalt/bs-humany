# Contributing to bs-humany

This codebase is built incrementally, across many sessions, substantially by agents. The dominant
failure mode is **plausible-looking wrongness that accumulates silently**. Every rule below exists
to make that failure mode loud instead of quiet.

Read this file before your first change. It is short on purpose.

---

## The ten rules

1. **Do not add a dependency without a ticket noting why.** See `docs/spec/` §15.4 for the
   write-our-own versus adopt boundary. Reaching for a library where §15.4 says "ours" is a design
   failure, not a shortcut.
2. **Do not change a golden hash to make a test pass.** Escalate instead. A golden update is a
   deliberate, separately-reviewed commit carrying a written justification for the behavioral
   change. Editing a golden to get green is a serious process failure.
   To rebaseline on purpose, run `pnpm goldens:update`, check that `git diff
   packages/testkit/goldens/trajectories.json` moves only the keys the change was meant to move
   (the command prints each one with its old and new hash), and commit that file alone with the
   behavioural reason; `docs/validation/conformance.md` says what the goldens pin.
3. **Do not introduce a joint range, mass, or dimension without a citation.** A number without a
   source is a bug. `pnpm cite:lint` enforces this.
4. **Do not copy parameter values out of a non-commercially-licensed reference model**
   (MyoSkeleton) to fill a gap, even when validation shows a discrepancy. Its licence is
   incompatible with the CC BY-SA skeleton data, so a single copied value makes the data
   undistributable. Find a citable published source or a compatibly-licensed model, or record the
   discrepancy as open. See §11 below.
5. **Measurements from the anatomical mesh dataset are legitimate and preferred** for placement,
   landmarks and joint centres (ADR-011). Record which dataset, version and structure each value
   came from so it can be re-derived. The ISB textual definition of a landmark still defines it;
   the mesh is where it is located. The export's markers are label anchors: they name a feature and
   never position it. Positions come from the measured tables through `measuredWorld`/`locateFeature`;
   `markerWorld` answers only where the export put its label.
6. **Do not write to a channel you have not declared.** Declared `reads`/`writes` are enforced,
   not documentary. In every build the kernel hands a module a view only for an access its
   manifest declares, and refuses a second writer. A read view is the same memory as a write
   view, so a write through one is caught by the kernel's audit, which compares every channel a
   module did not declare, bit for bit, with a copy taken before its step and throws on any
   change. Every `vitest` run sets `BS_HUMANY_KERNEL_AUDIT=1` (`vitest.config.ts`), which turns
   the audit on for every kernel whose host does not choose. Two hosts choose off inside tests,
   for speed: the golden scenarios run unaudited at full length and again audited for their first
   300 ticks, and the studio's kernel stays unaudited because the same modules are audited in that
   scenario pass. Outside a test run the audit is off unless a host passes `KernelOptions.audit`.
7. **Do not use `Math.random`, `Date.now`, or `performance.now` in simulation code.** A seeded PRNG
   arrives via `ModuleInitContext`. Simulation time is `tick * dt`, never accumulated.
8. **Do not put three.js or React types in** `kernel`, `hsdl`, `frames`, `anthropometry`,
   `session`, or any backend. The kernel must run headless in Node and in a Worker, and so must the
   session that hosts it: `publish-pose` runs it in Node, and the studio's next step is a Worker.
   Its `tsconfig` has no DOM library, which holds it to that; the studio keeps the drawing, the
   panels and the input.
9. **Do not allocate in `step`**, or in anything `step` calls every tick. All buffers, scratch
   objects and result objects are preallocated and reused. GC pauses in the simulation loop are
   unacceptable and very hard to diagnose after the fact. A library function a step calls every
   tick carries `@stepPath` in its JSDoc, so `pnpm module:lint` holds it to this rule too.
10. **If you find yourself needing to violate one of these, the design is wrong.** Say so rather
    than working around it.

---

## 11. Why rule 4 is about licence compatibility, not commerce

Until spec 0.5 this section argued for keeping the core free of any mesh-derived measurement so a
commercial exit stayed cheap. The owner has stated commercial viability is not a goal at all, and
that reasoning is gone (ADR-011). Measuring from Z-Anatomy is now the *preferred* way to place
bones and locate landmarks.

One exclusion survives, for a different reason. **MyoSkeleton is licensed non-commercial. The
skeleton data is CC BY-SA.** Share-Alike requires every derivative to permit commercial use; the NC
licence forbids it. The two cannot coexist in one work, so a value copied from MyoSkeleton would
make the skeleton data undistributable under either licence. Use MyoSkeleton to *compare*
behaviour -- joint axes, ranges, coupling -- never to *supply* a number.

Where a value cannot be found in a compatible source, record it in
`docs/sources/open-questions.md` rather than reaching for the incompatible one.

## Licensing tiers

| Tier | Packages | Licence | May draw on |
|---|---|---|---|
| Code | `packages/`: `anthropometry`, `backend-mujoco`, `compiler`, `export-gltf`, `frames`, `hsdl`, `kernel`, `modules-mechanics`, `modules-muscle`, `modules-nerves` (all but its `policies/`), `modules-sensing`, `muscle-model`, `muscle-path`, `muscle-volume`, `pose-bridge`, `render-three`, `scenarios` (all but its `data/` fixtures), `session`, `testkit`. `apps/`: `studio` (with `src-tauri`), `xr-viewer` (all but its pose-bridge fixture). `tools/`: `blender`, `cli`, `ingest`, `train`. The repository root. | Apache-2.0 | Permissive software only. Not a derivative of the data it loads. |
| Data | `skeleton`, `assets-anatomical` (the data under `data/`), `muscle-data`, the `scenarios` fixtures under `packages/scenarios/data/`, the trained policies under `packages/modules-nerves/policies/`, and the pose-bridge fixture `apps/xr-viewer/fixtures/pose-bridge.bin` (with its sidecar and muscle file) | **CC BY-SA 4.0** | Z-Anatomy / BodyParts3D (BY-SA), Rajagopal 2016, MyoSuite (Apache-2.0), Seth 2019 (CC BY), de Leva, ANSUR II, ISB. **Not MyoSkeleton** -- licence incompatibility, see §11. |
| Validation tooling | `tools/validate-external`, developer-local, never published | n/a | MyoSkeleton as a behavioural oracle. Compare; never transcribe. |

Every workspace package is named in this table, and ADR-009 names the same ones. A new package
adds itself to both before it lands: which tier it is in decides what it may draw on, and a
package in neither is one nobody has decided about. A package wholly in the Data tier carries the
licence in its `package.json` (`CC-BY-SA-4.0`), a copy of the licence text in `LICENSE`, and a
`NOTICE` that says what it derives from. `scenarios` is split, code and fixtures, so its
`package.json` names both licences and the root `NOTICE` covers its fixtures. `modules-nerves` and
`xr-viewer` are split too, by the owner's decision of 2026-09-27: the trained policies, whose
weights were found against the Data-tier body, and the fixture that carries a sample of that
body's bones in the bridge format, are CC BY-SA 4.0, each with a `NOTICE` that says so
(`packages/modules-nerves/NOTICE`, `apps/xr-viewer/fixtures/NOTICE`). Their code, and the licence
fields that describe it, stay Apache-2.0.

`muscle-data` is in the Data tier as a whole, schema and validation code included. Its
attachments, its muscle length ranges and some of its fibre lengths are measured on the skeleton,
which makes them derivatives of the Z-Anatomy geometry; the MyoSuite scalars beside them are
Apache-2.0, which may be combined into a CC BY-SA work. The code packages that load it stay
Apache-2.0, for the same reason the ones that load `skeleton` do.

## Citations

Every range of motion, mass fraction, dimension, and landmark definition carries a citation key
resolving against `docs/sources/bibliography.md`. Format:

```ts
romSource: cite('wu2002', 'Table 1, hip flexion/extension'),
```

`pnpm cite:lint` fails the build on an unknown key and flags numeric parameter fields that carry no
citation.

## Units

SI everywhere, always. Metres, kilograms, radians, seconds, newtons. **No degrees in the data
model** — degrees exist only in UI display code, converted at the boundary. Right-handed, Y-up.

## Bone ids are a public ABI

A bone id (`femur_r`, `vertebra_l3`, `phalanx_proximal_2_l`) is the name everything outside this
repository uses to talk about a bone: a saved session, an exported animation, an HSDL document
somebody else wrote, a module that attaches something to the sternum. Renaming one silently
breaks all of them, and unlike a function signature nothing will fail to compile.

So they are treated as an ABI. Spec section 14.5 obligation 10, and `pnpm audit:obligations`
checks the rules below hold.

**The rules.**

- **Never rename a bone id in place.** Adding a bone is fine. Removing or renaming one is a
  breaking change to the data model and needs a major version of `@bs-humany/skeleton`.
- **To rename, add the new id and keep the old one as an alias** for at least one minor version,
  with the alias listed in `taxonomy.ts` and resolved by `getBone`. Announce the removal in the
  release notes of the version that deprecates it, not the one that removes it.
- **Ids are anatomical, not project-specific**, so they do not change when the project does
  (ADR-010). They are lower snake case, sided with a `_r` or `_l` suffix, and numbered from the
  proximal or superior end where a series exists.
- **The TA2 code is the anchor.** Where an id is ambiguous, the bone's `ta` field is what
  identifies it against Terminologia Anatomica, and that field is what a cross-reference should
  use rather than the id.

Nothing is aliased today because nothing has been renamed. The mechanism exists so that the first
rename is a considered change rather than an accident.

## Tests you are expected to write

- Frame conversions: round-trips plus known-value fixtures against published examples.
- Any new parameter table: a unit test asserting transcribed values against the publication.
- Any new module: channel access enforcement and a determinism check.
- Any physical quantity: a plausibility assertion (§13.4) — no NaN, no negative mass, no inertia
  tensor violating the triangle inequality.

## Lint configuration notes

`style/useTemplate` is off. Error messages in this codebase explain the *likely cause* of a
failure, not just the fact of it, so they routinely run past one line and are written as wrapped
string concatenations. Folding each into a single template literal would push those lines well past
the 100-column limit. The message text is worth more than the idiom.

`style/noNonNullAssertion` is on for production code and off for tests, fixtures and test
helpers. In production, under `noUncheckedIndexedAccess`, a non-null assertion is a claim the
compiler cannot check and is exactly what the rule should catch. In a test indexing a fixture whose
shape is written three lines above, the assertion is documentation rather than a risk, and
threading optional chaining through every assertion would obscure what is being tested.

If you disable another rule, record why here. A rule turned off without a reason gets turned back
on by the next person, and then turned off again.

## Commands

```bash
pnpm install
pnpm test              # vitest, all packages
pnpm vitest run packages/testkit -t "scenario drop-"   # a fast subset of the golden scenarios, by name
pnpm goldens:update    # rewrite the golden trajectories and print what moved (rule 2: on purpose only)
pnpm test:e2e          # the studio in Chromium: boots clean, Start, Space, tabs, hand over (needs `pnpm exec playwright install chromium` once)
pnpm typecheck         # tsc --build across project references
pnpm lint              # biome
pnpm cite:lint         # citation coverage
pnpm module:lint       # banned globals and allocation on the step path (--paths: what it reads)
pnpm check:generated   # every generator, measurement, validation report and audit, as CI runs them
pnpm regenerate        # rewrite generated data in dependency order, then check
pnpm build:studio      # the production bundle the container image serves
pnpm verify            # everything the CI check job runs, in its order
pnpm dev               # studio app
cargo test --manifest-path apps/xr-viewer/Cargo.toml   # the CI rust job: the headset viewer
```

The muscle-data region sets, `skeleton/src/muscleViaPoints.ts`, `muscle-data/src/ranges.ts`,
`muscle-data/src/sourceTravel.ts` and the reports those scripts write under `docs/validation`
change only through these scripts, never by hand.

`pnpm module:lint` scans `kernel`, `compiler`, `muscle-model`, `muscle-path`, `muscle-volume`,
`scenarios`, and every `modules-*` and `backend-*` package, which it finds by name so a new one is
covered without anyone remembering to list it. Banned globals are checked in every non-test file of
those packages. The allocation check reads, in each file, the bodies of every function or method
named `step`, of every function or method whose JSDoc carries a `@stepPath` tag, and of every
method of the same file those reach through `this.<name>(` and every function declared in the same
file they call by name, followed until nothing new is reached. It flags `new`, array and object
literals, spread, template literals, closures and the allocating array methods. It does not follow
a call into another file: a library function called from a step is covered only when its own file
tags it `@stepPath`, which is how `solveEquilibrium`, `withoutOvershoot`, `equilibriumFiberLength`,
`solveRigidTendon`, `sweepMuscle`, `bellyPlacement`, `clearStretch`, `DelayLine.push` and `read`,
and `ObservationBuilder.fill` are covered. `pnpm module:lint --paths` prints every definition it
reads and how each was reached. An allocation that is meant goes behind
`// allocation-ok: <reason>`, on the line or on a comment line of its own above the statement; that
is for error paths, and for the rare path that genuinely cannot avoid it (the MuJoCo backend
rebuilding its views after the WASM heap grows), never for the ordinary tick.

## Generated files

A lot of what is committed here is written by a script from a source: the muscle-data region
files from the vendored MyoSuite models, the via points, the measured ranges and source travel, the
pose-bridge fixture, the published HSDL JSON Schema, the Align tab's `sourceSites.json`, and the
validation reports and the §14.5 audit under `docs/validation`. Each is committed so that a reader,
a test and a build see it without running anything, and each can fall behind its source without a
test noticing, because the tests read the committed output.

`pnpm check:generated` is the guard. It runs every root script named `generate:*`, `measure:*`,
`validate:*` and `audit:*` with `--check`, in dependency order, names every file that is not what
its script would write, and fails if there is one. CI runs exactly this. The list and its order live in `tools/cli/lib/targets.mjs`, which
reads the names off `package.json`, so adding a generator is adding the script.

A script under one of those prefixes must honour `--check`: compare, exit non-zero on a
difference, and write nothing. `check:generated` fingerprints the working tree around each target
and fails one that changes it, so a script that ignores the flag is caught rather than trusted.
The one exception is a measurement that only prints its tables and writes nothing
(`measure:dataset-gap` and `measure:reflex-gains`, the `PRINT_ONLY` list in
`tools/cli/lib/targets.mjs`): with no file to compare there is nothing to check, so it takes no
`--check` and `check:generated` leaves it out rather than spend half an hour comparing nothing.
Format generated JSON and TypeScript the way `pnpm lint` will (the schema and source-sites
generators pipe theirs through Biome), so that a fresh write and the committed file are the same
bytes.

When a source changes, run `pnpm regenerate`. It writes every target in the same order, stops at
the first failure, and finishes with the check pass, because a validation report records a new
discrepancy and exits 0 while writing; only the check fails on it. Commit the regenerated files
with the change that caused them, and say in the message why they moved. It never touches golden
trajectories: those record what the simulation did rather than derive from a source, and move only
on purpose.
