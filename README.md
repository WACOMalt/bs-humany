# bs-humany

A modular simulation framework for the human body, running in the browser, built bottom-up from
mechanical structure.

**Phase 1 (current):** a parametric, anatomically-named, articulated human skeleton with realistic
joint types, ranges of motion, passive joint properties and mass distribution — simulated as a
rigid-body system and rendered with three.js. Flagship demo: drop the skeleton, watch it collapse
in an anatomically plausible way, drag it around, reset it.

**Not in Phase 1:** skinned meshes, muscles, nerves, organs, control policy beyond direct
manipulation.

## The central idea

Anatomy and dynamics are separate layers.

- The **anatomical layer** (`Skeleton`) always contains the full set of ~206 named bones, with
  landmarks, local frames and metadata. Always complete, always renderable, always inspectable.
- The **dynamic layer** (`Articulation`) contains only the rigid bodies and joints handed to a
  solver, derived from the anatomical layer by a **fidelity profile**. Bones not promoted to rigid
  bodies ride along as kinematic followers, with optional redistribution so a region simulated as
  one body still articulates visually across its constituent bones.

Fidelity becomes a slider. Anatomy does not. A muscle module written years from now attaches an
origin to `humerus_r.tuberculum_majus` regardless of whether the humerus is currently its own rigid
body or part of a lumped arm segment.

## Layout

```
packages/
  hsdl/              schema, types, validation, JSON Schema generation
  frames/            coordinate conventions & conversions — small, pure, exhaustively tested
  anthropometry/     de Leva tables, ANSUR II tables, morphology solver, inertia math
  kernel/            scheduler, channels, delay lines, clock, state buffers
  skeleton/          bone taxonomy (~206), landmarks, segmentation profiles
  compiler/          HSDL -> CompiledArticulation; MJCF emitter
  backend-rapier/    interactive default
  backend-mujoco/    accuracy backend
  modules-mechanics/ physics, passive joints, skeleton posing, grab, metrics
  render-three/      three.js rendering + debug overlays
  scenarios/         scenario definitions + golden trajectory fixtures
  testkit/           plausibility assertions, conformance harness, trajectory hashing
apps/studio/         the demo/dev application
tools/cli/           headless scenario runner, citation lint
docs/                spec, ADRs, validation reports, bibliography
```

## Getting started

```bash
pnpm install
pnpm test
pnpm dev
```

## Running the studio

Three ways, and none of them needs the others. The studio is laid out as a studio: a top bar
with the body's fidelity profile and the transport, a viewport with its own view and overlay
controls, a properties editor on the right with a tab a concern -- Body, World, Simulation,
Scenario, Muscles, Brain, Export, Health -- a timeline under the viewport, and a status bar.
Space starts and pauses, the arrows step a frame, Home goes live, 1, 3 and 7 pick a view. The
Brain tab lists the saved checkpoints, hands one control of the running body, and starts or
stops a training run on this machine; both need `pnpm train:dashboard` serving.
`docs/plans/studio-ui-redesign.md` is the plan it follows.

**A desktop application.** The releases page carries two builds per version:

| | |
| --- | --- |
| `bs-humany-studio_<version>_amd64.AppImage` | runs anywhere; carries its own web view |
| `bs-humany-studio-<version>-linux-x86_64.tar.gz` | the bare binaries, wanting a current `libwebkit2gtk-4.1` |

`chmod +x` the AppImage and run it. The tarball holds the studio, the VR viewer, the mesh pack
the viewer needs and the attribution; unpack it anywhere and run `./bs-humany-studio`. Build
either yourself with `pnpm desktop:appimage` or `pnpm desktop:build` — see
`apps/studio/src-tauri/README.md` for what they need.

**In a headset.** Both desktop builds carry a native OpenXR viewer. With SteamVR (or another
OpenXR runtime) running, start a run in the studio and click **Connect VR viewer**: the body on
screen is in the room, the controllers grab it, and a panel beside it drives the studio's
controls. `apps/xr-viewer/README.md` has the whole of it, including running the viewer on a
headless simulation with `pnpm publish:pose`.

**A container**, which is the right answer for serving it to more than one person. The image is
not published anywhere: build it from the repository, which takes one command and no account.

```bash
docker build -t bs-humany-studio .
docker run -d --name bs-humany -p 8080:80 --restart unless-stopped bs-humany-studio
```

Then open `http://localhost:8080/`. `podman` works in place of `docker`, and
`docker compose up -d --build` does both steps at once. `docs/guides/deploy.md` covers updating
it, what is in the image, and the two headers it has to serve.

**The dev server**, which is `pnpm dev`.

**Training the nerves.** `pnpm train:nerves` trains a policy by evolution strategies across
every core, saving the best to `packages/modules-nerves/policies/<name>.json` as it goes (a
policy fits any profile by the names of its senses, so `--resume` carries a search from a
coarser body onto a finer one). What it trains in is a **recipe**: the scenario and its
parameter values, the body, whether the joints resist, what plays under the brain -- nothing,
the scenario's own muscle script, or the quiet-standing clip -- and what is scored, standing
still or keeping the head still and level. The recipe is saved into the checkpoint. Without one,
the flags describe the reference body on the ground with the clip under it, saved as
`stand.json`. `pnpm train:dashboard` serves a page at `http://localhost:5280/` with the fitness
curves, the live body and the network's activity; `pnpm train:showcase` keeps the current best
running in a body published to the pose bridge, so the headset viewer shows the learner -- and
so does the studio: its **Follow bridge** button, on the Brain tab, shows whatever is publishing,
live, muscles and all, through the dashboard's server. The Brain tab is also where a checkpoint
is made: name it, choose what is scored and what plays under the brain, set the scene on the
Scene tab (the **Tilting floor** is the one for a brain that has to react: the floor pitches and
rolls in random pulses, and a posture held still goes over at the first) and the body on the
Body tab, and **Start training** starts the trainer and the showcase through the dashboard's
server and follows them. Choosing a checkpoint sets those tabs up the way it was trained.
ADR-013 is why it is shaped this way.

## Naming

Project: `bs-humany`. Workspace scope: `@bs-humany/*`. Where a globally-unique identifier is needed
— JSON Schema `$id`, HSDL extension namespaces — the reverse-DNS namespace is
`bsums.xyz.bs-humany`.

## Documentation

- `docs/spec/` — the technical specification. Read §0 first.
- `docs/adr/` — architecture decision records. Do not relitigate these without flagging it.
- `docs/sources/bibliography.md` — every parameter citation.
- `docs/guides/` — how to write a module, extend HSDL, export a run to Blender, and deploy the studio as a container.
- `CONTRIBUTING.md` — **read before your first change.** Especially §11.
- `docs/sources/humansim-activation-research.md` — where the activation clips come from: the
  literature on muscle timing, why clips carry excitation and not activation, and what the
  three shipped clips (`clip-*` scenarios) are for.

## Licensing

Core packages: Apache-2.0, depending only on permissively-licensed software and unrestricted data
sources. See ADR-009 for the three-tier provenance structure and why the boundary is drawn by
technical role rather than license anxiety.
