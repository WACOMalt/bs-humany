# ADR-006 — Collision geometry is never anatomical geometry

**Status:** Accepted

## Decision

Every dynamic segment carries **collision proxies** — capsules, boxes, spheres, or precomputed
convex hulls — defined in HSDL independently of render geometry. Concave anatomical meshes are
never used for collision.

## Rationale

Standard practice. Stated explicitly as an ADR because it is the kind of thing an implementation
agent might "helpfully" shortcut.

Concave mesh collision at this body count is not real-time, and vertebral and carpal geometry in
particular would produce catastrophic contact behavior.

## Consequences

Convex hulls, where used, are stored in HSDL as precomputed vertex lists. They are **never**
hull-generated at runtime from render geometry — that would both cost frame time and create a
derivative-work path from any licensed mesh pack into the core.
