# ADR-004 — Fixed-timestep, phase-ordered, single-writer module kernel

**Status:** Accepted

## Decision

All simulation advances on a fixed timestep. Modules run in declared phases in a deterministic
order. Every data channel has exactly one authoritative writer, except `actuation.*` channels which
are explicitly **accumulators** — many writers, summed, zeroed each tick. Modules never hold
references to other modules.

## Rationale

This is the decision that makes the whole modular ambition work.

The failure mode for a project like this is a dozen subsystems all mutating transforms, producing a
simulation nobody can reason about, reproduce, or test. Single-writer channels plus accumulator
actuation is precisely the structure that lets a nerve module, a muscle module, a brain module and
a direct-manipulation tool all influence the same body without fighting — because they all
contribute *forces and activations*, and only the physics backend writes *state*.

Fixed timestep is non-negotiable for reproducibility, which is non-negotiable for both research use
and automated regression testing of an agent-built codebase.

## Consequences

Declared `reads`/`writes` are **enforced**, not documentary. A module writing to an undeclared
channel throws in development builds. This is the mechanism that keeps module boundaries real over
years of contribution, especially contribution by agents that have not read the whole codebase.

Determinism requires: no `Math.random`, no `Date.now`/`performance.now` in simulation code, no
iteration over unordered collections where order affects results, no `async` inside `step`.
`simTime` is computed as `tick * dt`, never accumulated.

## Revisit if

Never, without a very strong argument.
