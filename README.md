# bs-humany

A modular simulation framework for the human body, running in the browser, built bottom-up from
mechanical structure.

**What it is now:** a skeleton measured from the Z-Anatomy meshes, articulated with realistic
joint types, ranges of motion, passive joint properties and mass distribution; a set of Hill-type
muscles whose paths wrap the bones; a spinal cord of stretch and velocity reflexes under a
trained policy that drives those muscles (ADR-014 over ADR-013); the studio that runs all of it,
in a browser tab or as a desktop application; and a native OpenXR viewer that puts the body in a
headset. MuJoCo is the physics backend.

**Phase 1** was the mechanical substrate: a parametric, anatomically-named, articulated skeleton
simulated as a rigid-body system and rendered with three.js, whose flagship demo was dropping it
and watching it collapse plausibly. The muscle, nerve (policy) and VR-viewer work has landed since;
the specification in `docs/spec/` holds the status of each phase.

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

Every package, app and tool, in the words of its own `package.json` (or, where it has none, its
README).

```
core
  packages/hsdl/               HSDL schema, types, validation, JSON Schema generation
  packages/frames/             coordinate conventions and conversions; small, pure,
                               exhaustively tested
  packages/kernel/             scheduler, channels, delay lines, clock, state buffers
  packages/compiler/           HSDL to CompiledArticulation; MJCF emitter
  packages/scenarios/          scenario definitions, activation clips, muscle groups, and the
                               joint-sweep and inertia-audit reports (spec 13.5)
  packages/testkit/            scenario runner, plausibility assertions, trajectory hashing

anatomy and mass
  packages/skeleton/           bone taxonomy, landmarks, segmentation profiles
  packages/assets-anatomical/  anatomical bone meshes and landmarks derived from Z-Anatomy /
                               BodyParts3D; CC BY-SA 4.0 data
  packages/anthropometry/      de Leva and ANSUR II tables, morphology solver, inertia math
  packages/modules-mechanics/  physics, passive joints, skeleton posing, grab, metrics

muscle
  packages/muscle-data/        the muscle.* HSDL extension schema, and the cited muscle
                               definitions that populate it
  packages/muscle-model/       musculotendon dynamics: characteristic curves, activation, damped
                               equilibrium fibre model; pure numbers
  packages/muscle-path/        muscle path geometry: attachment sites, wrap surfaces, path
                               solvers, analytic path velocity and moment arms
  packages/muscle-volume/      tier V: procedural muscle volumes swept along the solved path
  packages/modules-muscle/     kernel modules for muscle: path solving and musculotendon dynamics

nerves and sensing
  packages/modules-nerves/     the nerves: a policy network that reads the body's afferents and
                               drives its muscles, trained on the simulation itself
  packages/modules-sensing/    sensory modules; vestibular sensing, and the worked example of
                               the module contract

backend
  packages/backend-mujoco/     MuJoCo physics backend; the only backend

rendering, export and bridge
  packages/render-three/       procedural bone geometry and the three.js skeleton mesh
  packages/export-gltf/        animated glTF (.glb) export of the bone hierarchy for Blender,
                               sampled at a stride, with the muscle bellies as a PC2 point cache
  packages/pose-bridge/        how a simulation hands its body pose to a renderer it does not
                               own: a latest-wins ring on tmpfs, per ADR-012

apps
  apps/studio/                 the bs-humany demo and development application (web and desktop)
  apps/xr-viewer/              a native OpenXR viewer (Rust)

tools
  tools/cli/                   repository lints and checks, the muscle-data generators and
                               measurements, the validation reports, bench, the desktop sidecar
                               and release tarball, and publish-pose: a headless scenario runner
                               that feeds the pose bridge
  tools/train/                 training the nerves: evolution strategies over a policy,
                               evaluated on the simulation across worker threads
  tools/ingest/                offline ingestion of anatomical mesh datasets into the skeleton
                               data package (M1.11)
  tools/blender/               checking an export in a real Blender
  tools/validate-external/     external reference models, for comparison only (spec 13.6)

docs/                          spec, ADRs, guides, validation reports, bibliography
```

## Prerequisites

- **Node 22 or newer.**
- **pnpm**, through `corepack enable`: corepack reads the `packageManager` field of the root
  `package.json` and runs the pnpm version pinned there (9.15.2), so every checkout builds with
  the same one.
- **Rust and the GTK and WebKit development packages**, but only for the desktop builds
  (`pnpm desktop:*`) and the VR viewer. The browser studio, the tests and the container need
  neither. `apps/studio/src-tauri/README.md` lists the packages for each distribution.

## Getting started

```bash
corepack enable
pnpm install
pnpm test
pnpm dev          # the studio, at http://localhost:5173/
```

Before you push, run `pnpm verify`: it runs what CI runs. `CONTRIBUTING.md` lists every check
and the command that regenerates the generated files, and says why each exists.

## Running the studio

Three ways, and none of them needs the others. The studio is laid out as a studio: a top bar
with the body's fidelity profile and the transport, a viewport with its own view and overlay
controls, a properties editor on the right with a tab a concern, a timeline under the viewport,
and a status bar. The tabs, in order:

- **Body**: who is being simulated, and how finely.
- **World**: what the body is in.
- **Sim**: how it is computed and recorded.
- **Scene**: what happens.
- **Muscles**: drive the body by hand.
- **Brain**: a trained policy in charge, and training (below).
- **Align**: the reference models beside ours, and the points on ours that need moving.
- **Export**: recordings, sessions, and a run for Blender (`docs/guides/blender-export.md`).
- **Health**: whether the numbers are right.

Drag to orbit, right- or Shift-drag to pan, scroll or pinch to zoom; click a bone to inspect it
and Ctrl-drag one to pull it during a run. Space starts, pauses and resumes a run; the arrows
step a frame, Home goes live, and 1, 3, 7 and 9 pick the front, left, three-quarter and back
views. The views, and F (or the Frame button) which keeps the angle, aim at the body wherever it
is and stand off in proportion to its stature. The top bar's first button is the same toggle as
Space, and never throws a run away; Reset, the Sim tab's restart with changed settings, Load
session, Follow bridge and a checkpoint's set-up do, and each asks first when the recording it
would throw away is longer than about five seconds.

The Brain tab hands a checkpoint control of the running body and trains new ones. With no
dashboard running it trains in the window itself: the desktop build reads and writes the same
data directory as the command-line trainer (see Training the nerves), and a browser tab keeps
what it trains in that browser's own storage. In a browser, then, listing the checkpoints on
disk needs `pnpm train:dashboard` running, and training and handing over do not. When the
dashboard is running the tab prefers it: it lists the checkpoints on disk and trains through
it, on every core. The redesign's plan, now a record: `docs/plans/studio-ui-redesign.md`.

**A desktop application.** The releases page carries two builds per version:

| | |
| --- | --- |
| `bs-humany-studio_<version>_amd64.AppImage` | runs anywhere; carries its own web view |
| `bs-humany-studio-<version>-linux-x86_64.tar.gz` | the bare binaries, wanting a current `libwebkit2gtk-4.1` |

`chmod +x` the AppImage and run it. The tarball holds the studio, the VR viewer, the mesh pack
the viewer needs and the attribution; unpack it anywhere and run `./bs-humany-studio`. Beside
them, `SHA256SUMS` holds both checksums, for `sha256sum -c`.

Both come from one command, `pnpm release:linux`, run on a clean checkout of the commit being
released: it builds the binary and the AppImage, packs the tarball in a fixed layout with the
licence files, and writes the two files and their sums to `dist-release/`. It publishes nothing;
tagging, pushing and uploading are done by hand. `pnpm desktop:appimage` and `pnpm desktop:build`
(the bare binary alone) build either one for yourself, and `apps/studio/src-tauri/README.md` says
what they need.

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

Then open `http://localhost:8080/`. With Podman, build with `podman build --format docker -t
bs-humany-studio .`: Podman writes OCI images by default, and the OCI format has no place for
the image's `HEALTHCHECK`, so without the flag it is silently dropped. `docker compose up -d
--build` does both steps at once. `docs/guides/deploy.md` covers updating it, what is in the
image, and the two headers it has to serve.

**The dev server**, which is `pnpm dev`.

## Training the nerves

A policy is trained by evolution strategies across every core; ADR-013 is why it is shaped this
way, and ADR-014 is the cord under it.

1. **Where the checkpoints live.** In the per-user data directory, not the repository:
   `~/.local/share/bs-humany/policies` on Linux (under `$XDG_DATA_HOME` when that is set),
   `~/Library/Application Support/bs-humany/policies` on macOS, and
   `%APPDATA%\bs-humany\policies` on Windows. Each run's history goes beside it, in `runs/`.
   `pnpm train:where` prints the paths and what is in them, and `BS_HUMANY_HOME` moves the whole
   directory. The first time the trainer or the dashboard starts, it copies in the checkpoints
   that ship in `packages/modules-nerves/policies`, once; that directory is only the seed.
2. **What a run is.** A run trains in a **recipe** and is named by it: the scenario and its
   parameter values, the body, whether the joints resist, what plays under the brain (nothing,
   the scenario's own muscle script, or an activation clip), the cord, and what is scored. The
   recipe is saved into the checkpoint. `pnpm train:nerves --recipe <file>` trains one;
   `pnpm train:nerves --print-recipe > mine.json` writes one to start from (change its `name`).
   The Brain tab writes its recipes to `<data>/runs/<name>-recipe.json` through the dashboard.
3. **A plain run.** With no recipe, the flags describe the reference stand -- the reference body
   on the ground with the quiet-standing clip under it -- saved as `stand.json`. A run never
   silently replaces a checkpoint: because `stand.json` is among the seeded ones, a plain
   `pnpm train:nerves` is refused. `--resume` continues the checkpoint, under the recipe it was
   saved with unless you give another; `--force` starts it afresh. `pnpm train:nerves --help`
   lists every flag and its default.
4. **Watching it.** `pnpm train:dashboard` serves `http://localhost:5280/` with the fitness
   curves, the live body and the network's activity. `pnpm train:showcase` keeps the current
   best running in a body published to the pose bridge, so the headset viewer shows the learner,
   and so does the studio: **Follow bridge** on the Brain tab shows whatever is publishing, live,
   muscles and all, through the dashboard's server.
5. **From the studio.** On the Brain tab, name the checkpoint and choose what is scored and what
   plays under the brain; set the scene on the Scene tab and the body on the Body tab. The
   **Tilting floor** scene is the one for a brain that has to react: the floor pitches and rolls
   in random pulses, and a posture held still goes over at the first. **Start training** goes
   through the dashboard when one is running, starting the trainer and the showcase and
   following them, and trains in the window when none is. Choosing a checkpoint only shows how
   it was trained and what differs from the tabs; **Set up as trained** puts that on the tabs,
   Authority included, and **Undo set-up** takes it back once. **Hand over control** sets them up
   first when they differ.

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

Two tiers, set out in ADR-009 (`docs/adr/adr-009-licensing.md`):

- **Code** is Apache-2.0 (`LICENSE`) and depends only on permissively-licensed software. It is not
  a derivative of the data it loads.
- **Anatomical data** -- everything derived from the Z-Anatomy and BodyParts3D geometry: bone
  meshes, landmarks, frames, joint centres, hulls -- is CC BY-SA 4.0, with the attribution in
  `NOTICE` and in the packages that carry it.

MyoSkeleton, being non-commercial, is incompatible with Share-Alike data and is never a source of
values; `CONTRIBUTING.md` §11 says why.
