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
4. **Do not copy parameter values out of a non-commercially-licensed reference model**
   (MyoSkeleton) to fill a gap, even when validation shows a discrepancy. Its licence is
   incompatible with the CC BY-SA skeleton data, so a single copied value makes the data
   undistributable. Find a citable published source or a compatibly-licensed model, or record the
   discrepancy as open. See §11 below.
5. **Measurements from the anatomical mesh dataset are legitimate and preferred** for placement,
   landmarks and joint centres (ADR-011). Record which dataset, version and structure each value
   came from so it can be re-derived. The ISB textual definition of a landmark still defines it;
   the mesh is where it is located.
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
| Code | `hsdl`, `frames`, `anthropometry`, `kernel`, `compiler`, `backend-*`, `modules-*`, `render-three`, `testkit`, `tools` | Apache-2.0 | Permissive software only. Not a derivative of the data it loads. |
| Data | `skeleton`, `assets-anatomical`, scenario fixtures | **CC BY-SA 4.0** | Z-Anatomy / BodyParts3D (BY-SA), Rajagopal 2016, MyoSuite (Apache-2.0), de Leva, ANSUR II, ISB. **Not MyoSkeleton** -- licence incompatibility, see §11. |
| Validation tooling | `tools/validate-external`, developer-local, never published | n/a | MyoSkeleton as a behavioural oracle. Compare; never transcribe. |

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
pnpm test          # vitest, all packages
pnpm typecheck     # tsc --build across project references
pnpm lint          # biome
pnpm cite:lint     # citation coverage
pnpm module:lint   # banned globals and allocation in step()
pnpm dev           # studio app
```
