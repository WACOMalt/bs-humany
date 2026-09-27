import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The studio is in here because much of what it does can only be checked against the
    // simulation that drives it: the Blender export it assembles (a muscle belly bound ring by
    // ring to a skin), the run controller behind its transport, the tissue it draws and the
    // training it runs in the window. Those tests belong in the same run as the packages', so a
    // change to a package that breaks the studio fails where it was made.
    include: ['packages/*/src/**/*.test.ts', 'tools/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    // Determinism (ADR-004, §10.7): tests must not depend on wall-clock or ordering luck.
    sequence: { shuffle: false },
    // The same goes for a test's time limit. What a test checks is a result, never a speed (the
    // bench measures speed), and vitest's 5 s default made the heavier whole-body tests fail on
    // whatever else the machine was doing: a load average in the twenties turned a 5.2 s test red
    // twice in one merge. Thirty seconds still ends a genuinely hung test.
    testTimeout: 30_000,
    // CONTRIBUTING rule 6 is enforced here. The kernel's write audit -- every channel a module did
    // not declare, compared bit for bit with a copy from before its step -- follows this variable
    // when a host does not choose, so every module test, and every kernel a test builds, catches a
    // write through a read view without having to ask. Hosts that must not pay for it pass
    // `audit: false`.
    env: { BS_HUMANY_KERNEL_AUDIT: '1' },
    // The golden scenarios are split over several files so they step side by side. Updating them
    // (`pnpm goldens:update`) has each of those files read, modify and write the one goldens file,
    // so in that mode the files run one after another rather than race each other's writes.
    fileParallelism: !process.env.UPDATE_GOLDENS,
    reporters: ['default'],
  },
});
