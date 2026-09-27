import { defineConfig, devices } from '@playwright/test';

/**
 * The studio smoke suite: the real page in a real browser, driven the way a person drives it.
 *
 * Vitest checks the studio's parts against the simulation behind them, but not the page those
 * parts are wired into, and main.ts is about to be split by a run of later changes. This suite is
 * the net under that: it fails when the page will not boot, Start does not run the body, Space
 * does not pause and resume, a tab shows the wrong panel, or a checkpoint cannot be put in charge
 * without the training dashboard. `pnpm test:e2e` runs it; `pnpm test` stays vitest alone.
 */

/**
 * The studio's own port for this suite, and nobody else's. 5173 is the desktop shell's `devUrl`
 * and the everyday `pnpm dev`, and 5273 is where a checkout being integrated is previewed; a suite
 * that borrowed either would test whatever happened to be serving there, or refuse to start.
 */
const PORT = 5299;

export default defineConfig({
  testDir: 'apps/studio/e2e',
  // One browser at a time. Every test compiles the full body, which takes a whole core for
  // seconds, and two at once on a CI runner's two cores is a timing test of the runner.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Once on CI, where a slow shared runner can miss a deadline no local run comes near; never
  // locally, where a retry would hide the flake somebody ought to see.
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  // Measured locally: the slowest test, the tab walk, takes about 30 s, and a run's test about
  // 17 s, of which the boot is 2 s and the compile of the body and MuJoCo's WebAssembly about 4 s.
  // The rest is the page itself: drawn in software, a frame takes 80 ms at rest and 200 ms with a
  // run going, and each step a test takes waits on one. Three times the slowest leaves room for a
  // slower CI runner without letting a hang sit for minutes.
  timeout: 90_000,
  // Long enough for one compile on a slow runner, which is the longest a single wait is for.
  expect: { timeout: 30_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      // A desktop-sized window, the layout the studio is built for: the properties editor the
      // tests click through sits beside the viewport rather than folded under it. WebGL needs no flags here: headless Chromium draws it with
      // SwiftShader, which Playwright already allows with --enable-unsafe-swiftshader, and the
      // boot test fails if the canvas has no live context.
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    // Vite straight from the studio's package, on the suite's own port, and failing rather than
    // moving if the port is taken. The studio's Vite config sends the cross-origin isolation
    // headers; the boot test checks they arrived.
    command: `pnpm --filter @bs-humany/studio exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
