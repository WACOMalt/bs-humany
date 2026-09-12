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
3. **Do not introduce a joint range, mass, or dimension without a citation.** A number without a
   source is a bug. `pnpm cite:lint` enforces this.
4. **Do not copy parameter values out of a non-permissively-licensed reference model** to fill a
   gap, even when validation shows a discrepancy. Find a citable published source, or record the
   discrepancy as open. See rule 11 below for why this one is load-bearing.
5. **Do not take measurements off licensed mesh geometry.** Landmarks, frames, joint centers and
   geometry profiles come from cited sources, never from clicking on an asset-pack mesh.
   **Meshes render. They do not measure.**
6. **Do not write to a channel you have not declared.** Declared `reads`/`writes` are enforced at
   runtime in development builds, not documentary.
7. **Do not use `Math.random`, `Date.now`, or `performance.now` in simulation code.** A seeded PRNG
   arrives via `ModuleInitContext`. Simulation time is `tick * dt`, never accumulated.
8. **Do not put three.js or React types in** `kernel`, `hsdl`, `frames`, `anthropometry`, or any
   backend. The kernel must run headless in Node and in a Worker.
9. **Do not allocate in `step`.** All buffers are preallocated and reused. GC pauses in the
   simulation loop are unacceptable and very hard to diagnose after the fact.
10. **If you find yourself needing to violate one of these, the design is wrong.** Say so rather
    than working around it.

---

## 11. Why rules 4 and 5 matter more than they look

This is the one piece of process here that is non-obvious, so it gets its own section.

The core packages are permissively licensed **by structure**, not by sacrifice. Investigation
(ADR-009) found that everything which actually determines quality — joint definitions, DoF
allocation, body frames, inertial parameters, dimensional percentiles, the solver — is available
permissively. There is no accuracy tax being paid, so there is no reason to accept contamination.

The realistic contamination vector is **measurement**, and it is not a leaf node:

> Landmark coordinates picked by clicking on CC BY-SA mesh geometry are arguably a derivative of
> that geometry. Landmarks determine bone local frames, which determine joint frames and joint
> centers — which is effectively all of `skeleton`, `frames`, and every joint definition.

One afternoon of convenient landmark-picking would propagate a Share-Alike obligation through the
entire core. The same applies to procedural geometry recipes whose profile curves are traced from
licensed meshes.

Textual sources are also *better provenance* than a click position. The ISB recommendations define
their landmarks as palpable bony features in prose. Rajagopal 2016 documents its body coordinate
systems relative to bony landmarks. MyoSuite's models are Apache 2.0. Use those.

Where a landmark cannot be derived from a citable source, **record it as an open question in
`docs/sources/open-questions.md` rather than reaching for the mesh.**

---

## Provenance tiers

| Tier | Packages | May depend on |
|---|---|---|
| 1 — Core | `hsdl`, `frames`, `anthropometry`, `kernel`, `skeleton`, `compiler`, `backend-*`, `modules-*`, `render-three`, `scenarios`, `testkit` | Permissive software only (Apache-2.0, MIT, BSD). Data sources with no redistribution restrictions: de Leva 1996, ANSUR II, ISB recommendations, Rajagopal 2016, MyoSuite. **No copyleft. No non-commercial.** |
| 2 — Asset packs | `assets-anatomical` (not yet built) | MAY carry CC BY-SA content. Attribution and Share-Alike obligations documented in the package and propagated to derivatives — retopology, LODs, generated hulls. |
| 3 — Validation tooling | `tools/validate-external` (developer-local, **never published**) | MAY use non-commercially-licensed models such as MyoSkeleton as **behavioral oracles**. Simulate and compare. Never transcribe values. |

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

If you disable another rule, record why here. A rule turned off without a reason gets turned back
on by the next person, and then turned off again.

## Commands

```bash
pnpm install
pnpm test          # vitest, all packages
pnpm typecheck     # tsc --build across project references
pnpm lint          # biome
pnpm cite:lint     # citation coverage
pnpm dev           # studio app
```
