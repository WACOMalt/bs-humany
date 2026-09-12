import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tools/*/src/**/*.test.ts'],
    environment: 'node',
    // Determinism (ADR-004, §10.7): tests must not depend on wall-clock or ordering luck.
    sequence: { shuffle: false },
    reporters: ['default'],
  },
});
