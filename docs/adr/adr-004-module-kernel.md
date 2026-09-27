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

**Enforcement, as of 2026-09-26.** What "enforced" means in practice, stated exactly so it is not
read as more than it is. In every build, the kernel hands a module a channel view only for an
access its manifest declares, and a single-writer channel refuses a second writer at init. That
much cannot be bypassed from inside a module. What it cannot stop is a write through a *read*
view, because JavaScript has no read-only typed array and a read view is the writer's memory. That
write is caught by the kernel audit, which compares every channel a module neither writes nor
accumulates into, bit for bit, with a copy taken before the module's step and throws on any
change. It compares rather than hashes because a hash can collide: an interim word-wise hash
let two sign flips cancel, so a negated quaternion got through. Every `vitest` run sets the
`BS_HUMANY_KERNEL_AUDIT` environment variable, which turns the audit on for every kernel whose host
does not choose, so it guards every module test, the trainer's rig tests and the first 300 ticks
of every golden scenario. The studio's kernel passes `audit: false` even in tests, since the
scenario pass covers the same modules. Outside a test run no host turns it on by default, because
it costs a pass over every channel per module per tick; any host may with `KernelOptions.audit`.

Determinism requires: no `Math.random`, no `Date.now`/`performance.now` in simulation code, no
iteration over unordered collections where order affects results, no `async` inside `step`.
`simTime` is computed as `tick * dt`, never accumulated.

## Revisit if

Never, without a very strong argument.
