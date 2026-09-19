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

Three ways, and none of them needs the others.

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
