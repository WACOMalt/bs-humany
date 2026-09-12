# ADR-002 — Canonical model format is a project-owned declarative schema, shaped as an MJCF superset

**Status:** Accepted

## Decision

The single source of truth for a body is **HSDL** (HumanSim Description Language) — a versioned,
JSON-serializable schema owned by this project. Backend-specific representations (MJCF for MuJoCo,
builder calls for Rapier) are **compile targets**: generated from HSDL, never hand-edited, never
round-tripped back.

Critically, **HSDL's dynamics semantics MUST be a superset of MJCF's semantics.** Kinematic tree,
one joint element per degree of freedom, per-DoF stiffness/damping/armature/range, equality
constraints, contact-pair exclusion — HSDL adopts MuJoCo's model of the world, then adds what
MuJoCo lacks: anatomical taxonomy, fidelity profiles, morphology parameters, module-binding
metadata.

## Rationale

The owner chose a swappable adapter, which requires engine neutrality. But naive neutrality means
designing to the *intersection* of engine capabilities, which would cap accuracy at whatever the
weakest backend supports — the opposite of what was asked for.

Designing to MuJoCo's semantics instead means the accuracy ceiling is set by the most capable
backend, and the Rapier adapter is explicitly and knowingly a **lossy projection** optimized for
responsiveness. Compiling to MJCF is then close to mechanical, and the same HSDL model runs on a
Python MuJoCo/MJX backend later with no translation layer.

## Consequences

- The Rapier adapter MUST declare its lossiness explicitly and MUST fail loudly rather than
  silently approximating.
- HSDL features unsupported by a backend produce a structured capability report, surfaced in the UI.
  **Silent approximation is forbidden** — it is the mechanism by which a research-accurate
  simulator quietly becomes a toy.

## Revisit if

MuJoCo's licensing or maintenance posture changes, or a clearly superior biomechanics engine with
browser delivery emerges.
