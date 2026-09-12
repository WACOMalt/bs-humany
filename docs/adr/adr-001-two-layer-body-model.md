# ADR-001 — Two-layer body model: anatomy is complete, dynamics is scalable

**Status:** Accepted

## Context

The project owner asked for a full anatomical skeleton (~206 bones) and also for a responsive
browser experience. A naive reading puts 206 rigid bodies and ~300 joints into a real-time solver,
which is both slow and numerically miserable — deep kinematic chains of low-mass bodies with tight
constraints are the worst case for most solvers.

## Decision

The body is represented in two distinct layers.

- The **anatomical layer** (`Skeleton`) always contains the full set of ~206 named bones with
  landmarks, local frames, and metadata.
- The **dynamic layer** (`Articulation`) contains the rigid bodies and joints actually handed to a
  solver, derived from the anatomical layer by a **fidelity profile**.

Bones not promoted to rigid bodies are kinematic followers of the segment that contains them.

## Rationale

Reconciles "full anatomical detail" with "responsive in a browser" without compromising either. It
also gives every downstream module a stable anatomical namespace to bind to: a muscle module
written years from now attaches an origin to `humerus_r.tuberculum_majus` regardless of whether the
humerus is currently its own rigid body or part of a lumped arm segment.

This is the single most important idea in the design. Fidelity becomes a slider; anatomy does not.

## Consequences

- `body.pose` (N segments, dynamic truth) and `body.boneTransforms` (~206 bones, anatomical
  presentation) are deliberately separate channels. Conflating them would collapse this ADR.
- Kinematic redistribution (spec §4.3) is required so lumped regions still articulate visually.

## Revisit if

Solver performance improves so dramatically that 206 bodies is trivially real-time. Even then,
keeping the layers separate is cheap.
