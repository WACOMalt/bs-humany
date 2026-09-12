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

## Naming

Project: `bs-humany`. Workspace scope: `@bs-humany/*`. Where a globally-unique identifier is needed
— JSON Schema `$id`, HSDL extension namespaces — the reverse-DNS namespace is
`bsums.xyz.bs-humany`.

## Documentation

- `docs/spec/` — the technical specification. Read §0 first.
- `docs/adr/` — architecture decision records. Do not relitigate these without flagging it.
- `docs/sources/bibliography.md` — every parameter citation.
- `CONTRIBUTING.md` — **read before your first change.** Especially §11.

## Licensing

Core packages: Apache-2.0, depending only on permissively-licensed software and unrestricted data
sources. See ADR-009 for the three-tier provenance structure and why the boundary is drawn by
technical role rather than license anxiety.
