import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The studio is in here for one test: the Blender export is assembled there, and what it
    // assembles -- a muscle belly bound ring by ring to a skin -- can only be checked against the
    // simulation that produced it.
    include: ['packages/*/src/**/*.test.ts', 'tools/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    // Determinism (ADR-004, §10.7): tests must not depend on wall-clock or ordering luck.
    sequence: { shuffle: false },
    reporters: ['default'],
  },
});
