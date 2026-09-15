# HumanSim — Technical Specification

**Phase 1: Mechanical Framework (Articulated Skeleton)**
**Plus: interoperation contracts for future physiological modules**

| | |
|---|---|
| Document | `humansim-spec` |
| Version | 0.5 |
| Changes in 0.5 | **Provenance posture reversed by the owner (2026-09-12): commercial viability is not a goal at all.** Anatomical mesh datasets are now the primary source of bone geometry *and* of placement, landmarks and joint centres. ADR-005 and ADR-009 rewritten, ADR-011 added, §13.6, §15.3, M1.2, M1.8, M5.8 and §17.1 revised. Skeleton data becomes CC BY-SA 4.0. |
| Changes in 0.4 | ASD-STE100 (Issue 9) lint pass: semicolons removed, banned words replaced. Score 3.97 → 2.91 per 100 words (flavored target: under 2.50) |
| Changes in 0.3 | Share-Alike compatibility analysis and the measurement-provenance rule added to ADR-009. Guards added to M1.2 and M5.8 |
| Changes in 0.2 | Licensing posture resolved (ADR-009). ADR-005 revised. ANSUR II adopted for dimensional anthropometry. External validation added (§13.6). Write-vs-adopt boundary recorded (§15.4) |
| Status | Planning complete. No code written |
| Audience | Implementation agents working a Trello-style board |
| Scope of this doc | Mechanical layer only. Later modules are specified *at the interface boundary only.* |

---

## 0. How to use this document

This is a **contract document**, not a tutorial. It is written to be decomposed into board tickets.

- **Sections 1–4** are context and decisions. Read once. Do not relitigate the ADRs in §3 without flagging it to the human.
- **Sections 5–13** are the normative spec. These define the things that must be built and the shapes they must have.
- **Section 15.4** records what we write ourselves versus what we adopt. Read it before adding any dependency.
- **Section 14** defines forward-compatibility contracts. Nothing in §14 gets implemented in Phase 1, but Phase 1 **must not make §14 impossible.** If a Phase 1 implementation choice would violate a §14 contract, that is a blocking design bug.
- **Section 16** is the milestone and ticket breakdown. This is what goes on the board.
- **Section 17** contains open questions. Some tickets are blocked on these.

Conventions: **MUST**, **SHOULD**, **MAY** per RFC 2119. `monospace` = literal identifier to be used in code.

---

## 1. Project summary

### 1.1 What this is

HumanSim is a modular simulation framework for the human body, running in the browser with three.js as the presentation layer. It is built bottom-up from mechanical structure, with each physiological system added as a discrete, independently-versioned module that communicates only through declared data channels.

Phase 1 delivers the mechanical substrate: a **parametric, anatomically-named, articulated human skeleton** with realistic joint types, ranges of motion, passive joint properties, and mass distribution — simulated as a rigid-body system and rendered in three.js. Its flagship demo is a ragdoll: drop the skeleton, watch it collapse in an anatomically plausible way, drag it around, reset it.

### 1.2 What this is not (Phase 1)

No skinned mesh. No muscles. No nerves. No control policy beyond direct manipulation and joint-motor test harnesses. No soft tissue, organs, or physiology. No multiplayer, persistence, or accounts.

### 1.3 Design priorities, in order

1. **Correct module boundaries.** The framework's value is that a nerve module can be written in 2027 by someone who never read the physics code. Boundary quality outranks Phase 1 feature count.
2. **Visual credibility.** It has to look like a human skeleton falling over, not a box stack. This is the primary near-term deliverable per the project owner.
3. **Research-grade accuracy where it is cheap to have.** Use published anthropometry and joint conventions rather than eyeballed numbers. Accuracy that costs nothing to adopt is mandatory. Accuracy that costs frame rate is a user-facing toggle.
4. **Graceful fidelity scaling.** The user MUST be able to trade accuracy for responsiveness at runtime without reloading or changing the visual identity of the model.

### 1.4 The core tension and its resolution

The owner asked for a **full anatomical skeleton (~206 bones)** and also for a **responsive browser experience**. A naive reading puts 206 rigid bodies and ~300 joints into a real-time solver, which is both slow and numerically miserable (deep kinematic chains of low-mass bodies with tight constraints are the worst case for most solvers).

**Resolution: separate anatomy from dynamics.** See §4. The anatomical skeleton is always complete — 206 named bones, always with a valid world transform, always renderable and inspectable. The *dynamic* skeleton is a configurable subset of those bones promoted to solver rigid bodies. Non-promoted bones ride along as kinematic followers, with optional redistribution so that collapsed regions (a spine simulated as one body) still *articulate visually* across their constituent bones.

This is the single most important idea in the document. Fidelity becomes a slider, anatomy does not.

---

## 2. Research findings

Conducted before drafting. These findings drive §3.

### 2.1 Physics engine landscape

| Engine | Delivery | License | Articulated-body support | Notes |
|---|---|---|---|---|
| **MuJoCo 3.x** | Official WASM bindings, `@mujoco/mujoco`, maintained by Google DeepMind. Ships a single-threaded build and a multi-threaded build (`/mt`, requires `SharedArrayBuffer` and COOP/COEP cross-origin isolation headers). TypeScript definitions included. Three.js examples exist in-tree and in the community (`zalo/mujoco_wasm`, `mujoco-react`). | Apache 2.0 | Native. Reduced-coordinate (generalized) dynamics, so joint constraints are *structurally* satisfied rather than iteratively enforced. Equality constraints, joint limits with soft ranges, per-DoF stiffness/damping/armature. | Also natively supports `<tendon>` paths with wrapping geometry and `muscle` actuators with Hill-type dynamics. Model format is MJCF (XML). Designed for biomechanics and robotics, not games. |
| **Rapier 3D** | `@dimforge/rapier3d` WASM. | Apache 2.0 | Two systems: `ImpulseJoint` (maximal coordinates, iterative) and multibody joints (reduced coordinate). `GenericJoint` exposes per-axis `locked_axes` / `limit_axes` / `motor_axes` bitmasks with limits and PD motors — enough to express anatomical joints. | Advertises *optional* cross-platform determinism. Snapshotting built in. Game-oriented. Excellent for the "responsive, fun to poke" experience. Has no concept of muscles or tendons. |
| Jolt (JS port), Cannon-es, Ammo.js | WASM/JS | MIT / zlib | Ragdoll-capable. No reduced-coordinate biomechanics story. | Not recommended as primary. |

**Key finding:** the MuJoCo WASM situation changed materially and recently. A first-party, maintained, TypeScript-typed MuJoCo build now runs client-side in a browser. This was not true a couple of years ago and it substantially weakens the assumption that "accurate biomechanics requires a Python backend."

**Second key finding:** MuJoCo's native tendon and muscle-actuator support means the Phase 3 muscle module has a *dramatically* shorter path if MuJoCo is a first-class backend. Rapier would require implementing Hill-type muscle dynamics, moment-arm computation, and path wrapping from scratch.

### 2.2 Existing skeleton and musculoskeletal models

| Model | Content | License | Assessment |
|---|---|---|---|
| **OpenSim / Rajagopal 2016 full-body gait model** | 22 rigid bodies, 37 DoF, 80 Hill-type lower-limb muscle-tendon units, 17 upper-body torque actuators. Parameters derived from 21 cadaver specimens and MRI of 24 subjects. Body coordinate frames documented relative to bony landmarks. | Open, freely distributed via SimTK | **Adopt as the reference for joint definitions, DoF allocation, and body frames** in the lower limb and general body plan. Does not articulate the cervical spine. Known limitation, has published augmentations adding cervical and sternoclavicular joints. |
| **MyoSuite / MyoSim models** (`myoLeg`, `myoArm`, `myoHand`, `myoTorso`) | MuJoCo conversions of OpenSim models. e.g. `myoHand`: 29 bones, 23 joints, 39 muscle-tendon units. `myoLeg` tracks Rajagopal closely. | Apache 2.0 | **Adopt as reference** for how OpenSim biomechanics maps onto MJCF, and for future muscle work. |
| **MyoSkeleton** (`myolab/myo_model`) | Full-body: 152 DoF, all spinal levels articulated, fully articulated hand, articulated patella, governed by 66 equality constraints coupling adjacent vertebral levels. | Non-commercial scientific research license. Distributed separately, gated behind an init/acceptance step, not part of the Apache-licensed MyoSuite core. Shipped as a single generic MJCF file resolved via `get_model_xml_path()`. | **Use as a validation oracle. Do not vendor and do not transcribe values.** See ADR-011: the reason is no longer commercial. A non-commercial licence cannot be combined with CC BY-SA material in one derivative work, since Share-Alike requires the derivative to permit commercial use and the NC licence forbids it. The second issue is that MyoSkeleton is a *fixed generic model.* Scaling in this ecosystem is an external step (OpenSim's Scale Tool, anisotropic scaling driven by motion-capture markers), not a property of the model. A fixed-anthropometry MJCF file cannot be the canonical model for a parametric morphology system (§6), so it could never have been the foundation regardless of licensing. It remains extremely valuable as an independent cross-check on our derived joint structure. |
| **Z-Anatomy** | Open 3D anatomy atlas, Blender-based, derived from Japan's BodyParts3D dataset, organized by Terminologia Anatomica. Hundreds of individually named structures including full skeleton, muscles, nerves, vessels. | CC BY-SA 4.0 (BodyParts3D upstream: CC BY-SA 2.1 JP) | **Adopted as the primary source of bone geometry, bone placement, landmarks and joint centres** (ADR-011). Share-Alike is viral for the assets *and anything derived from them*, including measurements taken from them. This is accepted: the skeleton data is published CC BY-SA 4.0 and the owner has no commercial goal. Attribution and license notices travel with the data. |
| **AnatomyTOOL / Open 3D Anatomical Model** (Leiden/Utrecht/Maastricht/Leuven consortium) | Successor effort building on BodyParts3D and Z-Anatomy, with institutional anatomist review. Currently male-model-focused. | CC BY-SA | Watch. Potentially a better-curated mesh source than raw Z-Anatomy. Same Share-Alike constraint. |

### 2.3 Anthropometry and inertial parameters

**de Leva (1996), "Adjustments to Zatsiorsky-Seluyanov's segment inertia parameters," *J. Biomech.* 29(9):1223–1230.** This is the load-bearing citation for §6. It gives, as **separate male and female tables**, relative segment masses (fraction of total body mass), longitudinal center-of-mass positions (fraction of segment length from the proximal joint center), and principal radii of gyration — all referenced to **joint centers** rather than the skin landmarks of the original Zatsiorsky gamma-ray scanning study. Source population is college-aged adults.

The existence of complete, parallel male and female parameter sets referenced to joint centers is what makes the owner's requested sex/proportion slider tractable as a real biomechanical parameterization rather than a cosmetic scale factor.

Secondary: Dumas, Chèze & Verriest (2007) gives an alternative sex-specific set with full inertia tensors including off-diagonal terms, if principal-axis assumptions prove inadequate.

**ANSUR II (2012 US Army Anthropometric Survey) — adopted for dimensions and percentiles.** de Leva supplies *inertial* parameters but only coarse segment lengths. ANSUR II supplies traditional linear measurements plus 3D body scans across a large sample, sex-separated, and is the basis of published work that generates 50th-percentile male and female musculoskeletal models and then scales them across the 1st–99th percentile range — scaling joint skeleton, mass, inertia and strength together from a handful of input measurements (height, weight, and a few circumferences).

This is the right dimensional backbone for §6. It gives the proportions control a real percentile axis rather than an invented one, it is sex-separated at source, and it is US federal government work with no restrictive licensing. The combination — **ANSUR II for dimensions and percentiles, de Leva for inertial distribution** — covers the full parameterization.

Caveat to document: ANSUR II sampled US military personnel, who are not representative of the general population in body composition or age distribution. Like de Leva's college-aged sample, this is a real limitation to state plainly rather than paper over.

### 2.4 Joint coordinate conventions

**ISB (International Society of Biomechanics) recommendations, Wu et al.** — 2002 for the ankle, hip, spine and pelvis. 2005 for the shoulder, elbow, wrist and hand. These define standard segment coordinate systems and joint coordinate systems from bony landmarks. Adopting them means HumanSim joint angles are directly comparable to published literature and to motion-capture pipelines, at essentially zero implementation cost beyond care in frame definition.

### 2.5 Rendering

three.js is at **r186** (`three@0.186.x`), MIT licensed. WebGPU renderer is production-viable across major browsers as of the r171+ line. WebGL2 remains the safe default with automatic fallback.

---

## 3. Architecture decision records

Numbered, with the reasoning preserved so future contributors do not re-open settled questions blindly. Each records what would need to change for the decision to be revisited.

---

### ADR-001 — Two-layer body model: anatomy is complete, dynamics is scalable

**Decision.** The body is represented in two distinct layers. The **anatomical layer** (`Skeleton`) always contains the full set of ~206 named bones with landmarks, local frames, and metadata. The **dynamic layer** (`Articulation`) contains the rigid bodies and joints actually handed to a solver, derived from the anatomical layer by a **fidelity profile**. Bones not promoted to rigid bodies are kinematic followers of the segment that contains them.

**Rationale.** Reconciles "full anatomical detail" with "responsive in a browser" without compromising either. Also gives every downstream module a stable anatomical namespace to bind to: a muscle module in 2027 attaches an origin to `humerus.tuberculum_majus` regardless of whether the humerus is currently its own rigid body or part of a lumped arm segment.

**Revisit if.** Solver performance improves so dramatically that 206 bodies is trivially real-time. Even then, keeping the layers separate is cheap.

---

### ADR-002 — Canonical model format is a project-owned declarative schema, shaped as an MJCF superset

**Decision.** The single source of truth for a body is **HSDL** (HumanSim Description Language) — a versioned, JSON-serializable schema owned by this project (§5). Backend-specific representations (MJCF for MuJoCo, builder calls for Rapier) are **compile targets**, generated from HSDL, never hand-edited, never round-tripped back.

Critically: **HSDL's dynamics semantics MUST be a superset of MJCF's semantics.** Kinematic tree, one joint element per degree of freedom, per-DoF stiffness/damping/armature/range, equality constraints, contact-pair exclusion — HSDL adopts MuJoCo's model of the world, then adds what MuJoCo lacks (anatomical taxonomy, fidelity profiles, morphology parameters, module-binding metadata).

**Rationale.** The owner chose a swappable adapter, which requires engine neutrality. But naive neutrality means designing to the *intersection* of engine capabilities, which would cap accuracy at whatever the weakest backend supports — the opposite of what was asked for. Designing to MuJoCo's semantics instead means the accuracy ceiling is set by the most capable backend, and the Rapier adapter is explicitly and knowingly a *lossy projection* (§9.4) optimized for responsiveness. Compiling to MJCF is then close to mechanical, and the same HSDL model runs on a Python MuJoCo/MJX backend later with no translation layer.

**Consequences.** The Rapier adapter MUST declare its lossiness explicitly and MUST fail loudly rather than silently approximating. HSDL features unsupported by a backend produce a structured capability report (§9.3), surfaced in the UI.

**Revisit if.** MuJoCo's licensing or maintenance posture changes, or a clearly superior biomechanics engine with browser delivery emerges.

---

### ADR-003 — Two backends in Phase 1: Rapier as default, MuJoCo as the accuracy backend

**Decision.** Ship both. `RapierBackend` is the default for interactive use and for low fidelity profiles. `MujocoBackend` is selectable and is the default for high fidelity profiles and for anything a user labels a measurement run. Both sit behind `IPhysicsBackend` (§9).

**Rationale.** The two requirements — "responsive, visually fun" and "research accuracy, slow is acceptable" — genuinely want different engines, and the adapter was already mandated. Building the second adapter in Phase 1 rather than deferring it is the only way to know the abstraction is real. A single-implementation interface is a fiction. It also front-loads the discovery of where the abstraction leaks, while the codebase is small.

Ordering note: implement Rapier first (faster feedback loop, simpler API, easier debugging), then MuJoCo, then the conformance harness that runs both against the same scenarios.

**Cost.** Roughly 1.5× the adapter work of a single backend. Accepted deliberately.

**Revisit if.** MuJoCo-WASM proves fast enough at low fidelity to be the only backend. Reassess after M3 benchmarks.

**Reassessed 2026-09-13 (M5.8).** MuJoCo-WASM is fast enough: 0.11 ms per step at L0 and 0.17 ms at L1 on the desktop benchmark, unchanged by the move to convex-hull collision proxies, with every scenario plausible and platform-independent goldens. Rapier went from 0.24 and 0.33 ms to 0.95 and 1.6 ms with hulls and became unstable in three scenarios (energy injection, torn joints), and it already carried the joint-angle solver, the emulated range stops and couplings, and OQ-009 purely to behave like a reduced-coordinate engine. **Decision: MuJoCo is the only enabled backend. `RapierBackend` is retained in the tree as a vestigial remnant, disabled and hidden from the studio, its scenario checks skipped, so it can be revisited.** What remains untested in Rapier's favour is payload and behaviour on a phone (its wasm is 2 MB against MuJoCo's 10 MB); measuring MuJoCo on real mobile hardware is the condition for deleting Rapier outright.

---

### ADR-004 — Fixed-timestep, phase-ordered, single-writer module kernel

**Decision.** All simulation advances on a fixed timestep. Modules run in declared phases in a deterministic order. Every data channel has exactly one authoritative writer, except `actuation.*` channels which are explicitly **accumulators** (many writers, summed, zeroed each tick). Modules never hold references to other modules.

**Rationale.** This is the decision that makes the whole modular ambition work. The failure mode for a project like this is a dozen subsystems all mutating transforms, producing a simulation nobody can reason about, reproduce, or test. Single-writer channels plus accumulator actuation is precisely the structure that lets a nerve module, a muscle module, a brain module, and a direct-manipulation tool all influence the same body without fighting — because they all contribute *forces and activations*, and only the physics backend writes *state*.

Fixed timestep is non-negotiable for reproducibility, which is non-negotiable for both research use and automated regression testing of an agent-built codebase.

**Revisit if.** Never, without a very strong argument.

---

### ADR-005 — Bone geometry comes from an anatomical mesh dataset, fitted per bone to the parametric skeleton. Procedural geometry is the fallback and the low-detail LOD

**Status.** Rewritten in 0.5. The 0.4 decision — procedural geometry as the source of truth, meshes as a later cosmetic pack — was implemented through M1.8 and produced a skeleton that was complete but visibly mis-placed: 206 hand-authored rest transforms, each checked by eye, is not a reliable way to position a body. ADR-011 records the owner's decision that allowed the reversal.

**Decision.** Bone shape and rest placement come from a curated anatomical mesh dataset (Z-Anatomy, derived from BodyParts3D), ingested offline into per-bone meshes keyed by the HSDL bone `id`. Each bone's mesh carries its own local frame, and the dataset's relative placements give the rest transforms directly. Morphology acts on this through **per-bone rigid placement at parametric joint centres plus per-bone scaling driven by the dimension expressions**, so the sliders still reshape the body: bones move to where the parametric layout puts their joints and scale along their own axes, but their *shape* is measured, not invented.

Procedural recipes (§5.4) are retained only as an internal fallback for any bone the dataset lacks. **The procedural skeleton is not a user-facing option and is a future goal**, not a current deliverable: the owner's direction (2026-09-13) is that until it is anywhere near correct it stays disabled, and the measured skeleton is the only one rendered. A decimated-mesh LOD (M5.8) is the plan for the mobile `L0` budget rather than the recipes.

**Rationale.** Anatomical credibility was the primary near-term deliverable (§1.3 priority 2) and procedural geometry did not reach it. A measured dataset fixes shape and placement wholesale, where the procedural path fixes them one bone at a time by inspection. The parametric requirement is met by scaling rigid meshes, which is exactly the rigid-placement-first path the 0.4 text already anticipated — only the direction of authority is reversed.

**Consequence.** Meshes are now a *measurement* source. Landmarks, local frames and joint centres MAY be derived from them (ADR-011). The skeleton data package is CC BY-SA 4.0. The `assets-anatomical` boundary remains as load-time modularity: the ingested per-bone meshes are a separate package so the core kernel and backends stay free of binary payload.

**Revisit if.** A better-curated dataset appears (AnatomyTOOL's Open 3D Anatomical Model is the candidate), or if per-bone rigid scaling proves visibly wrong at extreme morphology and a deformation cage is needed.

---

### ADR-006 — Collision geometry is never anatomical geometry

**Decision.** Every dynamic segment carries **collision proxies** — capsules, boxes, or precomputed convex hulls — defined in HSDL independently of render geometry. Concave anatomical meshes are never used for collision.

**Rationale.** Standard practice. Stated explicitly because it is the kind of thing an implementation agent might "helpfully" shortcut. Concave mesh collision at this body count is not real-time, and vertebral and carpal geometry in particular would produce catastrophic contact behavior.

---

### ADR-007 — TypeScript monorepo, no UI framework in the core

**Decision.** pnpm workspaces monorepo. Strict TypeScript throughout. The kernel, HSDL, and backends have zero dependency on any UI framework or on three.js. three.js appears only in the render module. The demo application MAY use React.

**Rationale (ADR-009 follows).** The kernel must be runnable headless — in Node for CI, in a Web Worker for the app, potentially in a backend service. Any framework dependency in the core forecloses that.

---

### ADR-008 — Simulation runs in a Web Worker from day one

**Decision.** The kernel and physics backend run in a dedicated Web Worker. The main thread owns rendering and UI only. State crosses the boundary via `SharedArrayBuffer` where cross-origin isolation is available, falling back to transferable `ArrayBuffer` double-buffering where it is not.

**Rationale.** Retrofitting a worker boundary is expensive and invasive. Establishing it while there are three modules is nearly free. It is also the same boundary a remote backend would sit behind, so the "backend later" path in ADR-002 reduces to swapping the transport. MuJoCo's multi-threaded WASM build needs cross-origin isolation anyway, so the headers are required regardless.

---

### ADR-009 — Licensing: the skeleton data is CC BY-SA 4.0. Code stays Apache-2.0. Nothing is done for commercial reasons

**Status.** Rewritten in 0.5. The 0.4 version drew a hard line between a permissive core and a Share-Alike asset pack, and forbade taking any measurement from a licensed mesh, on the reasoning that a cheap commercial exit was worth retaining for free. The owner has since stated that commercial viability is not a goal at all, so the reasoning no longer applies and the line has been removed. See ADR-011 for the decision record.

**Decision.** Two tiers:

1. **Code** (`kernel`, `hsdl`, `frames`, `anthropometry`, `compiler`, both backends, `modules-*`, `render-three`, `testkit`, `tools`) is Apache-2.0 and depends only on permissively-licensed software. This is not a commercial hedge. It is because code is not a derivative of the mesh data it loads, so there is no obligation to relicense it, and Apache-2.0 is the least surprising licence for the engines it sits between.
2. **Data** (`skeleton`, `assets-anatomical`, `scenarios`' fixtures and every value derived from Z-Anatomy or BodyParts3D geometry) is **CC BY-SA 4.0**, with attribution to BodyParts3D and Z-Anatomy carried in `NOTICE` and in the package. Landmarks, local frames, joint centres, rest transforms, convex hulls, decimated LODs and procedural profile curves traced from the meshes are all derivatives and all carry the licence. This is accepted and is the point of the decision.

**What is still excluded, and why.** MyoSkeleton (`myolab/myo_model`) stays a behavioural oracle in developer-local tooling and is never transcribed. The reason is not commercial. Its non-commercial research licence is **incompatible with CC BY-SA**: Share-Alike requires every derivative to permit commercial use, and the NC licence forbids it, so the two cannot be combined in one work. A value copied from MyoSkeleton into the BY-SA skeleton data would make the data undistributable under either licence. §13.6's rule for oracles therefore stands, with that justification.

**Verification chain.** BodyParts3D is CC BY-SA 2.1 JP; Z-Anatomy redistributes as CC BY-SA 4.0. Confirm the relicensing chain when the dataset is ingested (M1.11) and record the finding in `docs/sources/`.

**Revisit if.** Never for commercial reasons. Revisit only if a dataset with a more permissive licence proves better.

### ADR-010 — Project naming and platform floor

Recorded in `docs/adr/adr-010-naming-and-platform-floor.md`. Project is `bs-humany`, reverse-DNS namespace `bsums.xyz.bs-humany`, and `L0` must run on mobile.

### ADR-011 — Commercial viability is not a goal. Measurement from licensed meshes is permitted

**Context.** During M1.9, the first rendered skeleton showed that hand-authored placement of 206 bones does not reach the visual-credibility bar. The owner reviewed the result and directed that the prohibition on measuring from licensed mesh datasets be removed, stating that commercial viability is of no concern at all.

**Decision.** Anatomical mesh datasets MAY be used as the source of bone geometry, placement, landmarks, local frames and joint centres. The skeleton data is published CC BY-SA 4.0. ADR-005 and ADR-009 are rewritten accordingly; §15.3 rules 4 and 5, §13.6 and the M1.2/M5.8 acceptance criteria are revised. Non-commercially-licensed material remains excluded from distributed data because of licence incompatibility with Share-Alike, not because of commerce.

**Consequences.** M1.8's procedural recipes become the fallback and the low-detail LOD. A new milestone M1.11 ingests the dataset. The ISB textual landmark definitions remain the *definition* of each landmark; the mesh is now a legitimate place to *locate* it.

**Revisit if.** The owner's position on commercial use changes. The 0.4 text of ADR-009 is preserved in git history and describes the structure that would be needed.

---

## 4. Domain model

### 4.1 Entities

```
Body                      an instance being simulated
├── Skeleton               ANATOMICAL LAYER — always complete
│   └── Bone × ~206        id, TA name, parent, rest transform, landmarks,
│                          dimensions, render geometry recipe, segment assignment
├── Articulation           DYNAMIC LAYER — derived, fidelity-dependent
│   ├── Segment × N        rigid body: mass, inertia tensor, CoM, collision proxies,
│   │                      set of bones it owns
│   └── Articulation × M   joint: parent/child segment, frame, DoF list, limits,
│                          passive stiffness & damping
├── Morphology             parameters that generated this instance (§6)
└── FidelityProfile        which bones are promoted to segments (§12)
```

### 4.2 Bones, segments, and the promotion rule

A `Bone` is anatomy. A `Segment` is dynamics. The mapping is many-to-one: every bone belongs to exactly one segment. Every segment owns one or more bones.

Exactly one bone per segment is the **anchor** — the segment's rigid body frame is the anchor bone's frame. Other bones in the segment are **followers**, posed at their rest transform relative to the anchor.

### 4.3 Kinematic redistribution

A segment that lumps an articulated region (say, a `torso` segment owning 24 vertebrae) will look wrong if those vertebrae stay rigid while the torso bends — the bend appears as a single crease at the segment joint.

Each follower bone MAY therefore declare a **redistribution weight** per axis. When the segment's parent joint deflects, the deflection is distributed across followers in proportion to their weights, purely kinematically, after the solve and before rendering. A torso bending 30° forward distributes that across L5–T1 by weight, producing a smooth anatomical curve.

This is **cosmetic only**. It does not feed back into dynamics. Mass properties are computed from the rest pose and are not updated by redistribution. It MUST be implementable as a pure function of (segment joint state → follower local transforms) so it can be disabled, unit-tested, and reasoned about independently.

This mechanism is why the fidelity slider does not change the model's visual identity. It is worth building carefully.

### 4.4 Nomenclature

Bone `id`s are stable, lowercase, snake_case, ASCII, anatomically specific: `femur_r`, `vertebra_l3`, `metacarpal_3_l`, `scapula_r`. Every bone MUST also carry its Latin Terminologia Anatomica term and an English display name. IDs are the ABI — downstream modules bind to them — and therefore MUST NOT change without a major HSDL version bump.

Sides use suffix `_r` / `_l`. Unpaired bones take no suffix.

---

## 5. HSDL — the model schema

### 5.1 Principles

Declarative. Serializable to JSON. Versioned with a `hsdlVersion` field. Diffable in git. Contains no code. Authored as TypeScript source-of-truth modules that export validated plain objects (so the skeleton definition gets editor tooling and type checking), with JSON as the wire and snapshot format. Validated by a JSON Schema, which is generated from the TypeScript types, not maintained by hand.

### 5.2 Shape sketch

Illustrative, not final. The implementing agent owns the final types. These are the required concepts.

```ts
interface HsdlDocument {
  hsdlVersion: "0.1";
  id: string;
  meta: { name: string; description?: string; sources: Citation[] };

  units: { length: "m"; mass: "kg"; angle: "rad" };   // SI, fixed
  bones: BoneDef[];
  joints: JointDef[];
  segmentation: SegmentationDef[];   // one per fidelity profile
  constraints: ConstraintDef[];
  contactRules: ContactRuleDef[];
  morphology: MorphologySpec;
  landmarks: LandmarkDef[];
  attachmentSites: AttachmentSiteDef[];  // reserved for muscles; see §14.2
}

interface BoneDef {
  id: string;                     // `femur_r`
  ta: string;                     // Terminologia Anatomica term
  displayName: string;
  parent: string | null;          // anatomical parent, not necessarily dynamic parent
  restTransform: Transform;       // relative to parent, neutral/anatomical pose
  frame: FrameDef;                // ISB-conformant where a standard exists
  dimensions: Record<string, ScalarExpr>;  // may reference morphology params
  geometry: GeometryRecipe;       // procedural; see §5.4
  density?: number;               // kg/m^3, for inertia fallback
  redistribution?: RedistributionWeights;   // §4.3
}

interface JointDef {
  id: string;                     // `hip_r`, `l4_l5`
  parentBone: string;
  childBone: string;
  frame: FrameDef;                // joint coordinate system
  dofs: DofDef[];                 // ORDERED; one entry per degree of freedom
  type: "spherical" | "revolute" | "universal" | "free" | "fixed" | "custom";
}

interface DofDef {
  axis: "flexion" | "abduction" | "rotation" | "tx" | "ty" | "tz" | string;
  kind: "hinge" | "slide";
  vector: Vec3;                   // in joint frame
  range: [number, number];        // hard limit, radians or metres
  neutral: number;
  passiveStiffness?: StiffnessCurve;  // §7.3
  passiveDamping?: number;
  armature?: number;              // added rotor inertia; numerical conditioning
  frictionLoss?: number;
  romSource?: Citation;           // where the range came from
}
```

### 5.3 Hard requirements

- **SI units everywhere, always.** Metres, kilograms, radians, seconds, newtons. No degrees in the data model. Degrees exist only in UI display code, converted at the boundary.
- **Every joint range of motion MUST carry a `romSource` citation.** A number without a source is a bug. This is the mechanism that keeps "research accuracy" from silently eroding into plausible-looking invention as the model grows.
- **Right-handed coordinates, Y-up.** Aligns with three.js. Note that ISB and OpenSim conventions differ (Rajagopal uses X anterior, Y superior, Z right — which is Y-up, right-handed, so the mapping is a permutation, not a handedness flip). The conversion MUST live in exactly one documented module with exhaustive tests, `@humansim/frames`. Coordinate-convention bugs are the single most likely source of silent wrongness in this project.
- **Anatomical neutral pose** is the HSDL rest pose: standing, feet parallel and slightly apart, arms at sides, palms facing anteriorly, gaze horizontal. Deviations (T-pose, A-pose) are *poses*, never the rest definition.

### 5.4 Procedural geometry recipes

A `GeometryRecipe` is a declarative description evaluated by the render module into three.js `BufferGeometry`. Minimum viable set:

- `capsule` — radius(es), length. Supports proximal/distal radius taper
- `box`
- `loft` — ordered cross-section profiles along a curve. The workhorse for long bones, ribs, and the mandible
- `revolve`
- `composite` — union of the above with local transforms. E.g. a vertebra as body + pedicles + spinous process + transverse processes

All recipe parameters MAY be expressions over morphology parameters (§6), so geometry reshapes with the slider.

Quality bar for Phase 1: a person familiar with anatomy should recognize each bone and judge the proportions credible. Not medical-illustration quality.

---

## 6. Parametric morphology

### 6.1 Parameters

```ts
interface Morphology {
  sex: number;          // 0.0 = female-typical … 1.0 = male-typical
  stature: number;      // m, total standing height
  mass: number;         // kg
  percentile?: number;  // 0..1 over the ANSUR II distribution for the blended sex;
                        // convenience input that fills stature + mass + proportions
  proportions?: {       // optional independent overrides, default derived from sex+stature
    biiliacBreadth?: number;
    biacromialBreadth?: number;
    crural?: number;        // tibia / femur length ratio
    brachial?: number;      // radius / humerus length ratio
    relativeLegLength?: number;
  };
  asymmetry?: number;   // 0 = perfectly symmetric; small values add realistic L/R variation
}
```

### 6.2 How `sex` works

`sex` is a **blend coefficient over two parameter sets**, not a scale factor. Two endpoint tables are defined — female-typical and male-typical — covering:

- **Segment inertial parameters:** relative mass, longitudinal CoM position, principal radii of gyration, per segment. Directly from de Leva (1996), which publishes complete parallel male and female tables referenced to joint centers.
- **Skeletal dimensions and proportion ratios:** derived from **ANSUR II**, which is sex-separated at source and supports percentile scaling. Two reference models — 50th-percentile female and 50th-percentile male — anchor the endpoints, with the `percentile` parameter scaling along the distribution. Covers long-bone lengths as fractions of stature, and the dimorphic features that actually read visually — bi-iliac breadth, pelvic inlet shape, subpubic angle, greater sciatic notch width, sacral breadth, biacromial breadth, clavicle length, rib cage depth and flare, skull features (supraorbital ridge, mastoid process, mental eminence, gonial angle), and femoral valgus (the Q-angle difference that follows from pelvic width).
- **Default joint ranges of motion** where sex differences are documented, notably hip and lumbar mobility.

Interpolation is linear in the parameter, with the interpolation performed on the **derived scalar parameters**, never on mesh vertices. Nonlinear blend curves MAY be specified per parameter where linear blending produces implausible intermediates.

### 6.3 Required honesty constraint

A blend at `sex = 0.5` is a **modeling convenience for exploring the parameter space.** It is not an anthropometric description of any real population, and it is emphatically not a model of intersex anatomy. The UI MUST label this control in terms of *skeletal proportions* rather than identity — "Skeletal proportions: female-typical ↔ male-typical" — and the docs MUST state the limitation plainly. Getting this wrong is both scientifically sloppy and needlessly alienating.

Likewise, both endpoint tables derive from specific source populations (de Leva's underlying sample is college-aged Caucasian adults). Population limitations MUST be documented rather than presented as universal human norms.

### 6.4 Scaling algorithm

1. Resolve morphology parameters, filling defaults from `sex` and `stature`.
2. Compute all bone dimensions by evaluating HSDL dimension expressions.
3. Compute bone rest transforms from dimensions (joint centers follow from bone geometry, not the reverse).
4. For each segment in the active fidelity profile: compute total mass from de Leva relative-mass fractions × total mass. CoM from relative position × segment length. Inertia tensor from radii of gyration × mass. Where a segment lumps multiple de Leva segments, combine via the parallel-axis theorem.
5. Validate: total mass within tolerance of target. Stature within tolerance. No inertia tensor violating the triangle inequality. No negative or degenerate values.

Step 5 is a required test, not an optional check. A physically impossible inertia tensor produces subtly wrong dynamics that is very hard to diagnose downstream.

---

## 7. Joint model

### 7.1 Per-DoF decomposition

Joints are defined as **ordered lists of single degrees of freedom**, not as composite types with hidden semantics. A hip is three sequential hinges with explicit axes and per-axis ranges. A knee is a hinge plus optional coupled translation. An elbow is a hinge (flexion) and a separate forearm joint carries pronation/supination.

This matches MJCF's model directly (ADR-002), makes per-axis ranges and passive properties natural, gives every DoF a stable index for the `actuation.jointTorque` channel, and avoids the Euler-order ambiguity that composite joint types smuggle in.

Rotation order for multi-DoF joints MUST be explicit and MUST follow ISB convention for the joint in question where one exists. Gimbal-lock-prone orderings MUST be flagged in the definition with a comment explaining the choice.

### 7.2 Reference joint set

Derive from Rajagopal 2016 for the body plan and lower limb, extended with published augmentations for the cervical spine and sternoclavicular joints, and from ISB 2005 conventions for the upper limb. Non-exhaustive, for the mid-tier fidelity profile:

| Region | Joints | Notes |
|---|---|---|
| Root | pelvis, 6 DoF free | Floating base |
| Lumbar | L5–S1 … L1–T12, 3 DoF each (or lumped 3 DoF) | Coupling constraints at high fidelity, §7.4 |
| Thoracic | T12–T1, low per-level range | Mostly lumped below high fidelity |
| Cervical | C7–C1, 3 DoF each. Atlanto-occipital and atlanto-axial handled specially | C1–C2 is rotation-dominant and MUST NOT be modeled as a generic 3-DoF ball |
| Shoulder girdle | sternoclavicular (3), acromioclavicular (3), scapulothoracic (constraint, not a joint) | Scapula gliding on the thorax is a constraint surface, not a ball joint. Do not shortcut this — it is the most commonly botched region in character rigs. |
| Glenohumeral | 3 DoF | ROM is posture-dependent. See §7.3 |
| Elbow | 1 DoF flexion | |
| Radioulnar | 1 DoF pronation/supination | Separate joint from the elbow |
| Wrist | 2 DoF (flexion/extension, radial/ulnar deviation) | Carpals lumped below high fidelity |
| Hand | CMC/MCP/PIP/DIP per digit | Thumb CMC is a saddle joint, 2 DoF, distinct axes |
| Hip | 3 DoF | |
| Knee | 1 DoF flexion + coupled AP/SI translation. Patella as constrained body at high fidelity | |
| Ankle | talocrural (1), subtalar (1) | Distinct, non-orthogonal axes |
| Foot | midtarsal, MTP | Toes lumped below high fidelity |

Every entry expands into a ticket with a citation requirement.

### 7.3 Limits and passive properties

A hard range stop alone produces a ragdoll that looks like a puppet — limbs swing freely and then slam into invisible walls. Real joints resist continuously.

Each DoF therefore carries a **passive moment curve**: soft exponential resistance rising near end-range, plus a constant viscous damping term, plus optional passive stiffness through mid-range from ligaments and joint capsule. Riener & Edrich (1999) style exponential formulations are the standard reference form for lower-limb passive moments.

Backends implement this as: native soft joint limits and per-DoF stiffness/damping where available (MuJoCo), or as an explicit `PassiveJointModule` writing to `actuation.jointTorque` where not (Rapier). **The passive model MUST be available identically on both backends** — this is a correctness requirement, not a nicety, because ragdoll plausibility depends on it more than on solver choice.

Note: several joint ROMs are genuinely posture-dependent (hip flexion range depends on knee angle via the hamstrings. Shoulder ROM depends on scapular position). Phase 1 MAY use fixed conservative ranges, but HSDL MUST leave room for coupled ranges, and each simplification MUST be recorded as a known limitation in the model metadata.

### 7.4 Equality constraints

High-fidelity spinal articulation requires coupling: lumbar flexion distributes across levels in roughly fixed proportions rather than each level moving freely. MJCF supports this natively via `<equality>` joint constraints, and MyoSkeleton's published structure uses 66 such constraints for exactly this purpose.

HSDL MUST include a `constraints` section supporting at minimum joint-to-joint linear coupling. The Rapier backend MAY implement these as a soft post-solve corrective module and MUST report them as approximated in its capability report.

---

## 8. Collision and contact

### 8.1 Proxies

Per ADR-006. Each segment declares one or more proxies: `capsule`, `box`, `sphere`, or `convexHull` (from a vertex list, precomputed and stored in HSDL — never hull-generated at runtime from render geometry).

### 8.2 Self-collision rules

Naive all-pairs self-collision on a human skeleton produces immediate explosive instability, because adjacent bones at a joint interpenetrate by design.

HSDL `contactRules` MUST support:
- **Exclusion pairs** — explicit pairs that never collide. Generated by default for all parent/child segment pairs, extended by hand for known problem regions (scapula/ribs, pelvis/femur, carpals).
- **Collision groups and masks** — per-proxy bitmasks. Both backends support this natively.
- **Contact parameters** — friction, restitution, and solver softness per pair class. Bone-on-bone, bone-on-ground, and bone-on-object want different values.

### 8.3 Contact reporting

Contacts are first-class output, not incidental. `contact.manifolds` (§10.4) publishes body pair, world point, normal, and normal impulse every tick. This channel is the future tactile-sensing substrate (§14.1) and the future injury-model input, so it MUST be published from Phase 1 even though nothing consumes it yet.

---

## 9. Physics backend adapter

### 9.1 Interface

```ts
interface IPhysicsBackend {
  readonly id: string;                     // "rapier" | "mujoco"
  readonly capabilities: BackendCapabilities;

  init(config: BackendConfig): Promise<void>;
  compile(model: CompiledArticulation): Promise<CompileReport>;
  dispose(): void;

  step(dt: number, substeps: number): void;

  // State — SoA typed arrays written in place, never allocated per call
  readPose(out: PoseBuffer): void;
  readVelocity(out: VelocityBuffer): void;
  readJointState(out: JointStateBuffer): void;
  readContacts(out: ContactBuffer): number;

  // Actuation
  applyGeneralizedForce(dofForces: Float64Array): void;
  setJointMotorTarget(jointDofIndex: number, target: MotorTarget): void;
  applyBodyWrench(segmentIndex: number, force: Vec3, torque: Vec3, point?: Vec3): void;

  // Direct manipulation
  setKinematic(segmentIndex: number, enabled: boolean): void;
  setPose(segmentIndex: number, transform: Transform): void;
  createGrabConstraint(segmentIndex: number, localPoint: Vec3, worldTarget: Vec3): GrabHandle;

  // Determinism
  snapshot(): Uint8Array;
  restore(snapshot: Uint8Array): void;
}
```

### 9.2 Hard rules

- **No allocation in `step` or any `read*`.** All buffers are preallocated and reused. GC pauses in the simulation loop are unacceptable and are very hard to diagnose later.
- **`Float64Array` for all state.** Float32 is tempting for GPU interop and wrong for a system with tight constraints and wide mass ratios. Convert to Float32 at the render boundary only.
- **Index-based, not string-based, hot paths.** Name→index resolution happens once at compile. `step`-rate code never touches a string.
- **Segment and DoF ordering is defined by `CompiledArticulation` and MUST be identical across backends** for the same model and fidelity profile. This is what makes the conformance harness (§13.3) possible.

### 9.3 Capability reporting

```ts
interface BackendCapabilities {
  reducedCoordinate: boolean;
  equalityConstraints: "native" | "approximated" | "unsupported";
  softJointLimits: "native" | "emulated";
  perDofStiffnessDamping: "native" | "emulated";
  tendons: "native" | "unsupported";          // matters from Phase 3
  muscleActuators: "native" | "unsupported";  // matters from Phase 3
  deterministicAcrossPlatforms: boolean;
  maxRecommendedBodies: number;
}
```

`compile()` returns a `CompileReport` listing every HSDL feature that was dropped, approximated, or emulated, with a severity. The UI MUST surface warnings and above. **Silent approximation is forbidden** — it is the mechanism by which a "research-accurate" simulator quietly becomes a toy.

### 9.4 Known Rapier lossiness

Declare up front, so it is not rediscovered as a bug: iterative impulse joints permit small constraint drift under load, unlike reduced-coordinate formulations. Equality constraints require emulation. No tendon or muscle primitives. Per-DoF passive properties require an emulation module. Constraint stiffness degrades with long chains and wide mass ratios (the cervical spine and hands are the stress cases).

None of this disqualifies Rapier for the interactive default. All of it is why MuJoCo is the accuracy backend.

---

## 10. Module kernel

The heart of the framework. Per ADR-004.

### 10.1 Module interface

```ts
interface SimModule {
  readonly manifest: ModuleManifest;
  init(ctx: ModuleInitContext): Promise<void> | void;
  step(ctx: ModuleStepContext): void;
  reset?(ctx: ModuleInitContext): void;
  dispose?(): void;
}

interface ModuleManifest {
  id: string;                          // "mechanics.physics", "nerves.spinal"
  version: string;                     // semver
  phase: Phase;
  order?: number;                      // tie-break within a phase
  rateDivisor?: number;                // 1 = every tick, 10 = every 10th tick
  dependsOn: ModuleRef[];              // by id + semver range
  reads: ChannelRef[];                 // declared, enforced
  writes: ChannelRef[];                // declared, enforced
  accumulates: ChannelRef[];           // additive contribution
  gives: ChannelSpec[];             // channels this module creates
  configSchema?: JsonSchema;
}
```

Declared `reads`/`writes` are **enforced**, not documentary. A module writing to an undeclared channel MUST throw in development builds. This is the mechanism that keeps module boundaries real over years of contribution, especially contribution by agents that have not read the whole codebase.

### 10.2 Phases

Fixed order, every tick:

| Phase | Purpose | Phase 1 occupants |
|---|---|---|
| `input` | External input: user interaction, scenario scripting, recorded playback | `InputModule`, `ScenarioModule` |
| `sense` | Read prior state, produce afferent/sensory channels | `VestibularModule` (demo), `ProprioceptionStubModule` |
| `control` | High-level intent from sensory input | *(empty in Phase 1)* |
| `actuate` | Convert intent into forces and activations | `PassiveJointModule`, `JointMotorTestModule`, `GrabModule` |
| `solve` | Step the physics backend | `PhysicsModule` — **exclusive writer of `body.*`** |
| `post` | Analysis, derived quantities, diagnostics, recording | `MetricsModule`, `RecorderModule` |
| `render` | Off the fixed clock. Interpolated | `RenderModule` (main thread) |

`sense` runs *before* `solve` and reads the *previous* tick's state. This is correct and intentional: it models the physical reality that sensing lags actuation, and it removes any ordering ambiguity about whether a sensor sees pre- or post-step state.

### 10.3 Channels

A channel is a named, versioned, typed buffer with declared ownership.

```ts
interface ChannelSpec {
  id: string;                          // "body.pose"
  version: string;
  layout: "SoA";
  fields: FieldSpec[];                 // name, dtype, componentsPerElement
  elementCount: number | "dynamic";
  mode: "single-writer" | "accumulator";
  backing: "shared" | "local";         // SharedArrayBuffer eligibility
}
```

`single-writer`: one module declares `writes`. All others may only `read`. Violations throw.

`accumulator`: zeroed at tick start, any number of modules add into it, consumed by a declared reader. **This is the extension point for all future actuation**, and the reason a nerve module and a manual joint-motor tool can coexist without either knowing the other exists.

### 10.4 Phase 1 channel registry

| Channel | Mode | Writer | Contents |
|---|---|---|---|
| `body.pose` | single-writer | `PhysicsModule` | position[3N], orientation[4N] per segment, world frame |
| `body.velocity` | single-writer | `PhysicsModule` | linear[3N], angular[3N] |
| `body.jointState` | single-writer | `PhysicsModule` | q[nq], qdot[nv] |
| `body.boneTransforms` | single-writer | `SkeletonPoseModule` | full ~206-bone world transforms after follower posing + redistribution (§4.3) |
| `actuation.jointTorque` | accumulator | *(many)* | generalized force per DoF, [nv] |
| `actuation.bodyWrench` | accumulator | *(many)* | force[3N], torque[3N] |
| `contact.manifolds` | single-writer | `PhysicsModule` | dynamic-length contact list (§8.3) |
| `sense.vestibular` | single-writer | `VestibularModule` | head linear acceleration, angular velocity |
| `diagnostics.energy` | single-writer | `MetricsModule` | kinetic, potential, and drift indicator |
| `diagnostics.limits` | single-writer | `MetricsModule` | per-DoF end-range proximity and violation flags |

`body.boneTransforms` is deliberately a separate channel from `body.pose`. `body.pose` is the dynamic truth (N segments). `body.boneTransforms` is the anatomical presentation (~206 bones). Conflating them would collapse ADR-001.

### 10.5 Delay lines

The kernel MUST give a `DelayLine<T>` primitive: a ring buffer, sized in ticks, that makes a channel's value from *k* ticks ago readable.

Nothing in Phase 1 needs this. It is specified now because neural conduction delay is a first-order determinant of whether a nerve module produces realistic behavior or an oscillating mess, and because retrofitting delay into a synchronous channel system is architecturally invasive. Build the primitive, test it, ship it unused. See §14.1.

### 10.6 Time and scheduling

```ts
interface SimClock {
  tick: number;            // integer, monotonic
  dt: number;              // fixed, seconds
  simTime: number;         // tick * dt, derived — never accumulated by summation
}
```

`simTime` MUST be computed as `tick * dt`, never accumulated incrementally. Accumulated float time drifts and silently breaks reproducibility.

Base rate is the physics rate. Slower modules use `rateDivisor`. `dt` is **immutable for a session** — changing it requires a new session, since changing timestep changes results. Wall-clock decoupling: the render loop accumulates real elapsed time and runs 0..*n* fixed ticks with a clamped maximum to avoid death spirals. Leftover time drives render interpolation. Never a variable-dt step.

### 10.7 Determinism contract

Given identical (HSDL model, fidelity profile, backend, seed, input sequence), the kernel MUST produce bit-identical output on the same platform and build.

Consequences that MUST be enforced: no `Math.random` anywhere in simulation code — a seeded PRNG is injected via `ModuleInitContext`. No `Date.now()` or `performance.now()` in simulation code. No iteration over unordered collections where order affects results. No dependence on module registration order beyond declared phase and `order`. No `async` inside `step`.

Cross-platform bit-determinism is a separate, weaker goal, and is achievable only with Rapier's deterministic mode. Do not promise it by default.

---

## 11. Render module

Owns three.js. Main thread. Reads `body.boneTransforms`, `contact.manifolds`, and `diagnostics.*`. Writes nothing.

Requirements:
- One `InstancedMesh` or merged geometry per geometry-recipe class where possible. Roughly 206 individual draw calls is wasteful.
- Interpolate between the last two simulation states using the render loop's leftover accumulator time. Do not render raw simulation state at render rate — it produces visible judder whenever rates do not divide evenly.
- Debug overlays, individually toggleable: collision proxies, joint frames and axes, CoM per segment and whole-body, contact points and normals, force/torque vectors, DoF end-range heat coloring, velocity trails.
- Bone picking by ray, resolving to bone `id`, with an inspector panel showing anatomical name, TA term, parent segment, mass contribution, and adjacent joint DoFs and current angles.
- Camera: orbit, pan, zoom, framing presets, plus a follow mode that tracks whole-body CoM.
- WebGL2 default. WebGPU opt-in behind a flag.

Phase 1 visual target: clean, legible, slightly technical. Neutral bone material, subtle ambient occlusion, a ground plane with a grid, soft shadows. Read the `frontend-design` skill before building UI chrome.

---

## 12. Fidelity profiles

The user-facing accuracy/performance control. Each profile is a named HSDL `segmentation` plus solver settings.

| Profile | Segments | Approx. DoF | Anatomical bones | Default backend | Target |
|---|---|---|---|---|---|
| `L0-ragdoll` | ~15 | ~40 | 206 (followers + redistribution) | Rapier | 60 fps, mobile-capable |
| `L1-standard` | ~25 | ~65 | 206 | Rapier | 60 fps desktop |
| `L2-biomechanical` | ~50 | ~110 | 206 | Rapier or MuJoCo | 60 fps desktop, MuJoCo ~30 fps |
| `L3-anatomical` | ~110 | ~200+ | 206 | MuJoCo | Non-real-time acceptable |

Independently adjustable beyond profile selection: physics rate (240 / 500 / 1000 Hz), solver iterations or substeps, self-collision granularity, constraint softness, and equality-constraint enforcement on/off.

Requirements:
- Profile switching MUST preserve the anatomical pose as closely as possible (project current bone transforms onto the new segmentation, then restore).
- Profile switching MUST NOT require page reload.
- The UI MUST show measured cost — ms/step, steps/frame, realtime factor — not just a quality label. "Research accuracy" means users can see what they are paying.
- Each profile MUST declare its known limitations in metadata, surfaced in the UI. `L0-ragdoll` says plainly that spinal kinematics are cosmetic.

---

## 13. Testing, reproducibility, and CI

Non-negotiable, because this codebase is being built by agents across many sessions, and the failure mode is plausible-looking wrongness that accumulates silently.

### 13.1 Unit tests

Frame conversions (exhaustive, including round-trips and known-value fixtures against published ISB examples). Inertia computation including parallel-axis combination. Morphology scaling including physical-validity assertions. HSDL schema validation including rejection of malformed input. Delay-line semantics. Channel access enforcement.

### 13.2 Golden trajectory tests

For each (model, profile, backend): run a fixed scenario for a fixed tick count from a fixed initial state, hash the resulting state trajectory, compare against a committed golden hash. Any unintended behavioral change fails CI immediately.

Golden updates MUST be a deliberate, reviewed commit with a written justification. An agent updating a golden hash to make a test pass is a serious process failure and should be called out explicitly in contributor docs.

### 13.3 Backend conformance harness

Run identical scenarios on both backends. Assert agreement within per-scenario tolerances. Tolerances are *documented and justified*, not tuned until green. Divergence beyond tolerance is either a bug or a newly-discovered capability gap that MUST be added to §9.4.

### 13.4 Physical plausibility assertions

Automated, on every scenario: total energy never increases in a passive system (beyond a documented numerical tolerance). Momentum conserved during free fall. No DoF exceeds its hard range by more than tolerance. No penetration beyond tolerance. No NaN or Inf ever. Whole-body CoM trajectory matches ballistic prediction during free flight. A released ragdoll comes to rest rather than jittering indefinitely.

### 13.5 Scenarios

Committed, versioned, declarative scenario files. Phase 1 minimum set: `drop-supine`, `drop-prone`, `drop-standing-collapse`, `stairs-tumble`, `hang-from-wrist`, `seated-on-box`, `grab-and-swing`, `joint-sweep` (drive each DoF through full range and record passive moment), `inertia-audit` (report mass properties vs. de Leva targets).

`joint-sweep` and `inertia-audit` double as validation reports and should produce human-readable output.

### 13.6 External validation against reference models

Per ADR-009 tier 3. A developer-local tool, never published, that cross-checks our derived articulation against established models. This is how "research accuracy" gets verified rather than asserted.

**Targets.** Rajagopal 2016 via OpenSim or its Apache-licensed MyoSuite MuJoCo conversion (permissive, so it may also be used in CI). MyoSkeleton where available (non-commercial. Local only, never in CI, never redistributed).

**Comparisons, per joint:**
- Joint axis orientation in the segment frame, relative to a shared anatomical landmark set — catches the frame-convention bugs §5.3 warns about.
- Range of motion bounds per DoF.
- Joint center location as a fraction of segment length.
- Passive moment curves swept through range.
- For coupled regions, the effective distribution of motion across levels.

**Output** is a discrepancy report with per-joint deltas and a pass/investigate flag, committed to `docs/validation/` so drift is visible over time.

**The rule for non-commercial oracles, restated because it matters:** when a discrepancy against MyoSkeleton appears, the resolution is to find a citable published source or a CC BY-SA / permissively-licensed model and record it as the `romSource`. It is *not* to adopt MyoSkeleton's number. Its non-commercial licence is incompatible with the CC BY-SA skeleton data (ADR-009), so a copied value would make the data undistributable. If no compatible source can be found, record the discrepancy as an open question rather than silently closing it. Values from Rajagopal 2016, MyoSuite (Apache-2.0) and Z-Anatomy (CC BY-SA) MAY be adopted directly, with citation.

### 13.7 Snapshots

Full deterministic snapshot/restore of kernel + backend + all channel state, serializable. Enables the scrubbable timeline in the UI, bug reports as attached state files, and test fixtures captured from live sessions.

---

## 14. Forward-compatibility contracts for future modules

Not implemented in Phase 1. **Phase 1 MUST NOT foreclose any of it.** Reviewers should treat a Phase 1 choice that violates one of these as a blocking bug.

The honest framing: we do not know how these modules will work internally. What we can know now is the *shape of the data crossing their boundaries*, because that shape follows from physiology and not from implementation choices. That is what is specified here.

### 14.1 Nervous system module (Phase 2 candidate)

**Afferent (sensory) channels it will produce or consume:**

| Channel | Physiological analogue | Phase 1 requirement |
|---|---|---|
| `sense.proprioception.spindle` | Muscle spindle: Ia (velocity-sensitive), II (length-sensitive) | Needs muscle length and velocity. Until muscles exist, derivable from joint angle and angular velocity. **`body.jointState` MUST publish both q and qdot.** ✅ |
| `sense.proprioception.tendon` | Golgi tendon organ: Ib, force-sensitive | Needs muscle force. Until then, joint torque. **Backends MUST be able to report realized constraint and actuator forces per DoF, not just commanded.** ⚠️ Verify this is exposed by both backends — it is easy to miss. |
| `sense.tactile` | Cutaneous mechanoreceptors | Needs contact location, normal force, and rate of change, mapped to body-surface coordinates. **`contact.manifolds` MUST publish per-contact impulse and be stable enough across ticks to differentiate.** ✅ |
| `sense.nociception` | Pain | Needs contact impulse magnitude, joint end-range violation, and eventually tissue strain. **`diagnostics.limits` MUST publish end-range proximity and violation, not just clamp silently.** ✅ |
| `sense.vestibular` | Otoliths and semicircular canals | Head linear acceleration and angular velocity. Implemented in Phase 1 as the demonstration case for the sensory channel pattern. ✅ |

**Efferent (motor) channels it will produce:** `efferent.alphaMotor` (per motor unit or muscle, drive level 0..1) and `efferent.gammaMotor` (spindle sensitivity gain). In the absence of muscles these collapse to `actuation.jointTorque`, which is already an accumulator. ✅

**Conduction delay.** Signal propagation delay is not a detail — it is a first-order determinant of stability in any closed sensorimotor loop, and a reflex arc modeled without it will oscillate. Each pathway carries a conduction velocity and a path length, yielding a per-pathway delay in ticks. **The kernel's `DelayLine` primitive (§10.5) exists for this and MUST be built in Phase 1.** ⚠️

**Anatomical binding.** Nerve pathways must attach to anatomical structures: a peripheral nerve has a root level, a course, and innervation targets. **Bone IDs MUST be stable, and HSDL MUST support extension namespaces so a nerve module can add `nerve.*` annotations without forking the schema.** ⚠️

**Spinal reflex loops** (monosynaptic stretch reflex, reciprocal inhibition, crossed extensor) are the natural first target: they are closed loops entirely within `sense` → `control` → `actuate`, need no brain, and produce immediately visible, verifiable behavior.

### 14.2 Muscle module (Phase 3 candidate)

**What it needs from the mechanical layer:**

- **Attachment sites.** Origin and insertion points in *bone-local* coordinates, on bones that may or may not be independent rigid bodies. **HSDL MUST include an `attachmentSites` section in Phase 1, populated at least for major landmarks, even though nothing reads it.** ⚠️ Retrofitting attachment geometry after the bone frames have drifted is painful.
- **Wrapping surfaces.** Cylinders and ellipsoids that muscle paths route around so they do not pass through bone. MuJoCo supports these natively as tendon wrapping geometry.
- **Moment arms.** Derived from path geometry and joint configuration, and posture-dependent. The reason this needs a real muscle path model rather than a fixed torque map.
- **Hill-type parameters** per muscle-tendon unit: maximum isometric force, optimal fiber length, pennation angle, tendon slack length, maximum contraction velocity, activation and deactivation time constants.

**Channels:** consumes `efferent.alphaMotor`, produces `muscle.state` (length, velocity, force, activation per unit) and contributes to `actuation.jointTorque` or, on MuJoCo, drives native tendon actuators directly.

**Backend split.** MuJoCo has native tendon paths and Hill-type muscle actuators. Rapier has neither. The muscle module will therefore be **MuJoCo-first**, with the Rapier path being a lumped joint-torque projection that loses moment-arm dependence. This is a further argument for ADR-003 and should be stated plainly rather than discovered later. ✅

**Reference material:** Rajagopal 2016 gives 80 validated lower-limb muscle-tendon units. MyoSuite gives MuJoCo-converted equivalents under Apache 2.0. MyoConverter exists for OpenSim→MuJoCo conversion, with known caveats around discontinuous wrapping paths and geometry parsing that will need manual tuning.

### 14.3 Brain / control module (Phase 4 candidate)

Deliberately thin: it consumes the afferent bundle and produces descending drive. It runs in the `control` phase at a slower `rateDivisor`. Whether it is a hand-written state machine, a CPG, a trained RL policy, or a spiking network is entirely an implementation detail behind that boundary — which is the point of specifying the boundary now.

**Phase 1 requirements:** the `control` phase must exist and be empty. `rateDivisor` must work. Channel snapshots must be serializable so a policy can be trained offline against recorded trajectories. ✅

Note for later: if RL training becomes a goal, MuJoCo's MJX path gives GPU-parallel rollouts on the *same MJCF* the browser runs. That is a significant strategic advantage of ADR-002 and worth preserving.

### 14.4 Other anticipated modules

Sketched only, to pressure-test the framework's generality. Each is a real candidate and each should be checked against the channel design.

- **Metabolic** — consumes `muscle.state`, produces energy expenditure and fatigue. Feeds back by reducing available muscle force. Requires that muscle parameters be *mutable at runtime*, not compile-time constants. ⚠️ Worth noting now.
- **Injury / failure** — consumes `contact.manifolds`, `diagnostics.limits`, and joint reaction forces. Produces tissue damage state. Feeds back by modifying joint ranges, passive stiffness, or removing constraints entirely (dislocation, fracture). Requires that **articulation topology be modifiable at runtime without a full recompile**, or at least that recompile-and-restore be fast and lossless. ⚠️ This is a real constraint on §9 and should be checked during M2.
- **Vascular / respiratory** — largely independent of mechanics, but coupled through thoracic volume change and rib motion. A consumer of rib joint state. Argues for real rib articulation at `L3`.
- **Vestibular-ocular / gaze** — consumes `sense.vestibular` and head pose, produces eye orientation. Small, self-contained, and a good early test of a non-mechanical output module.
- **Thermal** — consumes metabolic output and contact surface area.

### 14.5 Summary of Phase 1 obligations arising from §14

These are the concrete Phase 1 requirements that exist *only* to keep the future open. They MUST be in the M2/M3 acceptance criteria:

1. `DelayLine` primitive built and tested, unused.
2. `attachmentSites` in HSDL, populated for major landmarks.
3. HSDL extension namespaces supported, so modules can annotate without forking.
4. Realized (not just commanded) per-DoF force readable from both backends.
5. `contact.manifolds` published with per-contact impulse from Phase 1.
6. `diagnostics.limits` publishes end-range proximity and violation flags.
7. `control` phase exists and is empty. `rateDivisor` works and is tested.
8. `actuation.*` accumulator semantics work with 2+ simultaneous writers, tested.
9. Articulation recompile-and-restore is lossless and benchmarked.
10. Bone IDs treated as a stable public ABI, with a documented change policy.

---

## 15. Repository and stack

### 15.1 Layout

```
humansim/
├── packages/
│   ├── hsdl/              schema, types, validation, JSON Schema generation
│   ├── frames/            coordinate conventions & conversions — SMALL, PURE, EXHAUSTIVELY TESTED
│   ├── anthropometry/     de Leva tables, morphology solver, inertia math
│   ├── kernel/            scheduler, channels, event bus, delay lines, clock, state buffers
│   ├── skeleton/          skeleton definition data (~206 bones), segmentation profiles
│   ├── compiler/          HSDL → CompiledArticulation; MJCF emitter
│   ├── backend-rapier/
│   ├── backend-mujoco/
│   ├── modules-mechanics/ physics, passive joints, skeleton posing, grab, metrics
│   ├── modules-sensing/   vestibular sensing; the worked example of the module contract
│   ├── render-three/      three.js rendering + debug overlays
│   ├── scenarios/         scenario definitions + golden trajectory fixtures
│   └── testkit/           plausibility assertions, conformance harness, trajectory hashing
├── apps/
│   └── studio/            the demo/dev application
├── docs/
│   ├── spec/              this document and successors
│   ├── adr/               ADRs, one file each, appended over time
│   ├── validation/        joint-sweep and inertia-audit reports
│   └── sources/           bibliography with every ROM and parameter citation
└── tools/
    └── cli/               headless scenario runner for CI
```

### 15.2 Stack

pnpm workspaces. TypeScript strict, including `noUncheckedIndexedAccess`. Vite for the app, tsup for libraries. Vitest. three.js `^0.186`. `@dimforge/rapier3d-compat`. `@mujoco/mujoco`. Zod or TypeBox for runtime validation with type inference. Biome or ESLint + Prettier. Changesets for versioning.

Server requirements: the app MUST be served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` to enable `SharedArrayBuffer` and MuJoCo's multi-threaded build. Configure this in the dev server and document it for deployment — it is an easy thing to discover far too late.

### 15.3 Contributor rules for agents

Put these in `CONTRIBUTING.md`, prominently:

1. Do not add a dependency without a ticket noting why.
2. Do not change a golden hash to make a test pass. Escalate instead.
3. Do not introduce a joint range, mass, or dimension without a `romSource` citation.
4. Do not copy parameter values out of a **non-commercially-licensed** reference model (MyoSkeleton) to fill a gap, even when validation shows a discrepancy. Its licence is incompatible with the CC BY-SA skeleton data, so a copied value makes the data undistributable. Find a citable published source or a compatibly-licensed model, or record the discrepancy as open. See ADR-009 and §13.6.
5. Measurements taken from the anatomical mesh dataset are legitimate and are the preferred source for placement, landmarks and joint centres (ADR-011). Record which dataset, version and structure each value came from, so it can be re-derived when the dataset is updated. The ISB textual definition of a landmark is still what defines it; the mesh is where it is located.
6. Do not write to a channel you have not declared.
7. Do not use `Math.random`, `Date.now`, or `performance.now` in simulation code.
8. Do not put three.js or React types in `kernel`, `hsdl`, `frames`, `anthropometry`, or any backend.
9. Do not allocate in `step`.
10. If you find yourself needing to violate one of these, the design is wrong — say so rather than working around it.

---

## 15.4 Write our own versus use what exists

Stated explicitly so the boundary does not drift, and so an implementing agent knows when reaching for a dependency is correct and when it is a design failure.

Note on cost: every dependency named here is free and open source — Rapier and MuJoCo are Apache 2.0, three.js is MIT, and all parameter sources are published research or public government data. There are no paid components in this project. The only non-monetary obligation is CC BY-SA attribution and Share-Alike on the optional anatomical asset pack (ADR-005, ADR-009).

**Use what exists, deliberately:**

| Component | Why not ours |
|---|---|
| Constraint solver (Rapier, MuJoCo) | Reduced-coordinate articulated dynamics with stable contact is a multi-decade research effort. Writing one would be strictly worse and would consume the entire project. |
| Renderer (three.js) | Same reasoning, plus WebGL/WebGPU abstraction is a maintenance treadmill. |
| Published parameters (de Leva, ANSUR II, ISB, Rajagopal) | These are *data*. Deriving our own would mean inventing worse numbers. Citation is the whole point (§5.3). |
| MJCF as a compile target | A documented format with a reference implementation and a large model ecosystem. Inventing a wire format for MuJoCo would be pure loss. |

**Ours, because nothing off the shelf does it:** the module kernel and its scheduling and arbitration semantics. HSDL and its compiler. The two-layer anatomy/dynamics model and kinematic redistribution. The morphology solver. The bone taxonomy, frames and landmarks. Procedural geometry. The passive joint model. The backend adapters. The testkit and conformance harness.

This is the project's actual contribution. Existing engines will simulate a humanoid, but none of them has an anatomical namespace for a future module to bind to, a fidelity axis independent of anatomical completeness, or a contract that lets a nervous system be written by someone who never reads the physics code.

**Notable write-our-own call: the kernel.** ECS libraries (bitECS, miniplex) exist and were considered. Rejected as the primary abstraction because ECS solves entity composition, whereas the problem here is deterministic phase-ordered scheduling with write arbitration (ADR-004). An ECS library MAY later back the channel *storage* layer as an optimization. It MUST NOT replace the channel *semantics*.

**Known future fork: the muscle module (Phase 3).** MuJoCo has native tendon paths with wrapping geometry and Hill-type muscle actuators. Rapier has neither. Two paths:

- *Use MuJoCo's* — drive its native actuators. Fast to working muscles, validated against OpenSim, but muscles become backend-locked and the Rapier path degrades to lumped joint torques.
- *Write our own* — implement Hill-type dynamics and moment-arm computation as a module above `IPhysicsBackend`. Portable and fully ours. Substantially more work and easy to get subtly wrong.

**Recommendation: use MuJoCo's first, then write our own.** MuJoCo's implementation gets real muscles working quickly and, more importantly, gives us a correct reference oracle to validate against. Then write the portable version and check it against that (§13.6 machinery applies directly). Not a Phase 1 decision, but Phase 1 MUST NOT foreclose either path — which is what §14.2's attachment-site and channel requirements exist to guarantee.

---

## 16. Milestones and ticket breakdown

Sized for board decomposition. Each ticket needs acceptance criteria written at pickup time. The criteria sketched here are the intent.

### M0 — Foundations
`M0.1` Monorepo scaffold, tooling, CI running an empty test suite.
`M0.2` `frames` package: `Transform`, `Vec3`, `Quat`, frame definitions, ISB↔three.js conversion, exhaustive tests including round-trips and published-value fixtures. *Do this first and do it properly.*
`M0.3` HSDL v0.1 types + Zod schemas + generated JSON Schema + validation with useful error messages.
`M0.4` Seeded PRNG, `SimClock`, unit conventions, `docs/adr/` seeded with §3.
`M0.5` Bibliography scaffold in `docs/sources/` with a citation format and a lint rule that flags uncited parameters.

### M1 — Anatomy and morphology (no physics)
`M1.1` Bone taxonomy: all ~206 bones with IDs, TA terms, display names, anatomical parents. Data-entry heavy. Tedious. Foundational.
`M1.2` Landmark definitions per bone, ISB-conformant where a standard exists. Each landmark cites its ISB or literature *definition* and records the dataset structure it was *located* on (ADR-011).
`M1.3` Bone local frames from landmarks.
`M1.4` de Leva male and female inertial tables transcribed, with source verification and unit tests against published values.
`M1.4b` ANSUR II dimensional tables: 50th-percentile female and male reference measurements plus percentile scaling relations.
`M1.5` Morphology solver: `Morphology` → bone dimensions and rest transforms, blending the two endpoint parameter sets.
`M1.6` Inertia computation incl. parallel-axis combination + physical-validity assertions (§6.4 step 5).
`M1.7` `GeometryRecipe` evaluator → `BufferGeometry`.
`M1.8` Per-bone procedural geometry recipes. *Delivered in 0.4 form; now the fallback and low-detail LOD per ADR-005.*
`M1.11` **Anatomical dataset ingestion.** *Delivered 2026-09-13.* `tools/ingest` reads the Z-Anatomy FBX export headless, maps 206 structures to bone `id`s, welds and packs 200 bones (the ossicles held on OQ-004) into `@bs-humany/assets-anatomical` with 814 named landmarks, and the skeleton document takes its rest transforms from the measured centroids. Licence chain verified (BodyParts3D CC BY-SA 2.1 JP → Z-Anatomy CC BY-SA 4.0). Remaining: per-bone parametric placement from landmark-derived joint frames (M1.2/M1.3) so breadth and the sex blend act on the measured skeleton.
`M1.9` Minimal three.js viewer: static skeleton, orbit camera, morphology sliders live-updating. **First visible milestone — prioritize reaching it.**
`M1.10` Bone picking + inspector panel.

### M2 — Kernel
`M2.1` Channel registry, `ChannelSpec`, SoA buffer allocation, `SharedArrayBuffer` with fallback.
`M2.2` Single-writer enforcement + accumulator semantics + tests with multiple simultaneous writers.
`M2.3` Scheduler: phases, ordering, `rateDivisor`, dependency resolution with cycle detection.
`M2.4` `DelayLine<T>` + tests. *Unused by design. See §14.5.*
`M2.5` Snapshot/restore of kernel and channel state.
`M2.6` Web Worker host + main-thread proxy + transport abstraction (ADR-008).
`M2.7` Determinism harness: run twice, assert bit-identical.
`M2.8` Module lint: detect undeclared access, allocation in `step`, banned globals.

### M3 — Articulation and physics
`M3.1` Joint definitions for `L1-standard` with per-DoF axes, ranges, and citations. Split by region.
`M3.2` Segmentation profiles `L0`–`L2`. `L3` may land in M5.
`M3.3` Collision proxy definitions + default exclusion-pair generation.
`M3.4` HSDL compiler → `CompiledArticulation` with stable, backend-independent segment and DoF ordering.
`M3.5` `IPhysicsBackend` interface + `BackendCapabilities` + `CompileReport`.
`M3.6` Rapier backend: bodies, generic joints, limits, motors, contacts, snapshot.
`M3.7` `PhysicsModule` wiring backend to channels.
`M3.8` `SkeletonPoseModule`: segment poses → full bone transforms, incl. kinematic redistribution (§4.3).
`M3.9` `PassiveJointModule`: soft end-range + damping + capsular stiffness.
`M3.10` **First ragdoll.** Drop it. It should collapse plausibly. *The demo milestone.*
`M3.11` `GrabModule`: ray-pick, drag with a constraint, release.
`M3.12` `MetricsModule`: energy, momentum, limit diagnostics.
`M3.13` Debug overlays (§11).
`M3.14` MJCF emitter from HSDL + round-trip validation against `mj_forward` kinematics.
`M3.15` MuJoCo backend via `@mujoco/mujoco`.
`M3.16` Conformance harness across both backends with documented tolerances.
`M3.17` Golden trajectory infrastructure + first goldens.
`M3.18` Plausibility assertion suite (§13.4).
`M3.19` Benchmark suite: ms/step by profile × backend × physics rate, reported as a committed table. **Feeds the ADR-003 reassessment.**

### M4 — Studio application
`M4.1` App shell, layout, panels.
`M4.2` Morphology panel.
`M4.3` Fidelity panel with live measured cost readout (§12).
`M4.4` Backend selector + capability/warning display (§9.3).
`M4.5` Scenario picker + runner.
`M4.6` Timeline: pause, step, scrub via snapshots, reset.
`M4.7` Recording + export of trajectories.
`M4.8` Validation report views for `joint-sweep` and `inertia-audit`.
`M4.9` Save/load session state.

### M5 — Hardening and Phase 2 preparation
`M5.1` `L3-anatomical` profile: per-vertebra articulation, articulated hand, patella, ribs.
`M5.2` Equality constraints: native in MuJoCo, emulated in Rapier.
`M5.3` `attachmentSites` populated for major muscle landmarks (§14.5 item 2).
`M5.4` HSDL extension namespaces (§14.5 item 3).
`M5.5` Realized per-DoF force reporting verified on both backends (§14.5 item 4).
`M5.6` Runtime articulation recompile-and-restore, benchmarked (§14.5 item 9).
`M5.7` External validation tool (§13.6): comparison harness vs. Rajagopal/MyoSuite in CI, vs. MyoSkeleton locally, producing a committed discrepancy report. ✅ `pnpm validate:external`, reference vendored at a pinned commit, report in `docs/validation/external.md`, `--check` in CI. Found OQ-012: the neck ranges came from a joint the reference has commented out.
`M5.8` `assets-anatomical` pack hardening: decimated LODs, convex hulls for collision proxies, streaming, attribution and CC BY-SA notices propagated (ADR-005, ADR-009). *The pack is a measurement source as of ADR-011; the 0.4 one-way-consumer criterion is withdrawn.*
`M5.9` Module authoring guide + a worked example module. ✅ `docs/guides/module-authoring.md`, worked through `VestibularModule` in `@bs-humany/modules-sensing`, which implements the `sense.vestibular` channel of §14.1.
`M5.10` §14.5 audit: verify all ten obligations, with evidence, as a documented gate. ✅ `pnpm audit:obligations`, report in `docs/validation/obligations.md`, `--check` in CI. Obligation 10 needed a change policy, now in CONTRIBUTING.
`M5.11` Performance pass against M3.19 baselines. ✅ Measured in `docs/validation/benchmarks.md`: every module this project wrote is 5% of an L3 tick and collision against the hull proxies is 55% of the rest, so L3 runs at 0.8x real time and that is accepted rather than fixed. L0 to L2 run in real time.
`M5.12` Documentation and validation report publication.

### Critical path

`M0.2` → `M0.3` → `M1.1–1.6` → `M1.9` → `M2.1–2.3` → `M3.1–3.10`

`M1.9` (static skeleton on screen with working morphology sliders) and `M3.10` (first plausible ragdoll) are the two milestones that prove the project. Route work toward them.

---

## 17. Open questions

Blocking or near-blocking. Flagged for the human.

1. ~~**Does the project need to permit commercial use?**~~ **Resolved twice.** In 0.2 the owner said commercial viability was subordinate to quality and a permissive core was kept because it seemed free. In 0.5 the owner stated commercial viability is not a goal at all, after the permissive posture proved to have a real cost in placement quality. See ADR-011. Skeleton data is CC BY-SA 4.0.
2. **Is a Python/MuJoCo-MJX backend actually wanted, or does browser MuJoCo cover the accuracy case?** `IPhysicsBackend` accommodates a remote backend, but building one is significant work that the research findings suggest may be unnecessary. Recommend deferring until M3.19 benchmarks exist.
3. **Target platform floor.** Desktop-only, or must `L0` run on mobile? Affects WASM budget, worker strategy, and whether cross-origin isolation can be assumed.
4. **Should Phase 2 be nerves or muscles?** The original sketch said nerves first. Physiologically, nerves without muscles means reflex loops that act on abstract joint torques rather than on muscle activation — workable, and honestly a good way to validate the delay-line and afferent machinery cheaply, but slightly backwards. Muscles first gives nerves something real to drive. Worth a decision before M5.
5. **Spine coupling fidelity.** MyoSkeleton's approach (per-level joints plus dozens of equality constraints) is known-good but is behind a non-commercial license. Is independently deriving coupling ratios from the published biomechanics literature in scope, or is `L2` lumped-region spine sufficient for now?
6. **Hands.** A fully articulated pair of hands is ~54 bones and a large share of the total DoF budget, for relatively little ragdoll payoff. Recommend hands as a separate opt-in sub-profile rather than being bundled into `L3`. Confirm?
7. **Naming.** "HumanSim" and "HSDL" are placeholders used consistently throughout. Renaming later is cheap now and expensive after M3.

---

## 18. References

**Anthropometry and inertia**
- de Leva, P. (1996). Adjustments to Zatsiorsky-Seluyanov's segment inertia parameters. *Journal of Biomechanics*, 29(9), 1223–1230.
- Zatsiorsky, V. M., et al. (1990). In *Contemporary Problems of Biomechanics*, 272–291. CRC Press.
- Dumas, R., Chèze, L., & Verriest, J.-P. (2007). Adjustments to McConville et al. and Young et al. body segment inertial parameters. *Journal of Biomechanics*, 40(3), 543–553.

**Joint conventions**
- Gordon, C. C., et al. (2014). *2012 Anthropometric Survey of U.S. Army Personnel: Methods and Summary Statistics* (ANSUR II). US Army Natick Soldier Research, Development and Engineering Center.
- Wu, G., et al. (2002). ISB recommendation on definitions of joint coordinate system of various joints for the reporting of human joint motion — part I: ankle, hip, and spine. *Journal of Biomechanics*, 35(4), 543–548.
- Wu, G., et al. (2005). ISB recommendation … part II: shoulder, elbow, wrist and hand. *Journal of Biomechanics*, 38(5), 981–992.

**Musculoskeletal models**
- Rajagopal, A., Dembia, C. L., DeMers, M. S., Delp, D. D., Hicks, J. L., & Delp, S. L. (2016). Full-body musculoskeletal model for muscle-driven simulation of human gait. *IEEE Transactions on Biomedical Engineering*, 63(10), 2068–2079. Model: `simtk.org/projects/full_body`
- Caggiano, V., Wang, H., Durandau, G., Sartori, M., & Kumar, V. (2022). MyoSuite — A contact-rich simulation suite for musculoskeletal motor control. *L4DC*. arXiv:2205.13600
- Wang, H., et al. (2022). MyoSim: Fast and physiologically realistic MuJoCo models for musculoskeletal and exoskeletal studies. *ICRA 2022*.
- Caggiano, V., et al. (2024). MyoSkeleton: A Universal Human Skeletal Model. MyoLab Inc. white paper. *(non-commercial research license — reference only)*
- Seth, A., Sherman, M., Eastman, P., & Delp, S. (2010). Minimal formulation of joint motion for biomechanisms. *Nonlinear Dynamics*, 62(1), 291–303.
- Riener, R., & Edrich, T. (1999). Identification of passive elastic joint moments in the lower extremities. *Journal of Biomechanics*, 32(5), 539–544.

**Software**
- MuJoCo — `github.com/google-deepmind/mujoco`, WASM bindings under `/wasm`. Apache 2.0.
- Rapier — `rapier.rs`, `github.com/dimforge/rapier`. Apache 2.0.
- three.js — `threejs.org`. MIT.
- OpenSim — `opensim.stanford.edu`.
- Z-Anatomy — `z-anatomy.com`, `github.com/Z-Anatomy`. CC BY-SA 4.0.
- BodyParts3D — Database Center for Life Science. CC BY-SA 2.1 JP.
- AnatomyTOOL Open 3D Anatomical Model — `anatomytool.org/open3dmodel`. CC BY-SA.

---

*End of specification v0.1.*
