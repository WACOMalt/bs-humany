import { defineConfig } from 'vite';

/**
 * Dev server configuration.
 *
 * The cross-origin isolation headers are served even though nothing needs them yet. ADR-008
 * requires `SharedArrayBuffer` and MuJoCo's multi-threaded build to be *available*, and ADR-010
 * records that they cannot be *assumed*, because the platform floor is that `L0` runs on mobile.
 *
 * Serving the headers in development means the isolated path is the one being exercised daily, so
 * it cannot quietly rot; the non-isolated fallback is a first-class path that gets its own tests.
 * Discovering a missing header after the worker boundary is built is the expensive order to do
 * this in, and the specification calls it out as an easy thing to find far too late.
 */
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'es2022',
  },
  optimizeDeps: {
    // MuJoCo locates its .wasm next to its own module file; pre-bundling moves the module and
    // leaves the wasm behind. Served as-is, both stay together.
    exclude: ['@mujoco/mujoco'],
  },
});
