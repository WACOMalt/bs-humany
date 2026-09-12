# ADR-007 — TypeScript monorepo, no UI framework in the core

**Status:** Accepted

## Decision

pnpm workspaces monorepo. Strict TypeScript throughout, including `noUncheckedIndexedAccess`. The
kernel, HSDL, and backends have zero dependency on any UI framework or on three.js. three.js
appears only in the render module. The demo application MAY use a UI framework.

## Rationale

The kernel must be runnable headless — in Node for CI, in a Web Worker for the app, potentially in
a backend service. Any framework dependency in the core forecloses that.

## Enforcement

CONTRIBUTING rule 8. A dependency-boundary lint should be added once the package graph stabilizes.
