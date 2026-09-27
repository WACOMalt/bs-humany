/**
 * The studio as the smoke tests see it: a fresh page, booted, with its errors and its calls to the
 * training dashboard written down.
 *
 * Everything here reaches the page by element id and `data-tab`, never by what a label says or
 * where a tab sits in the strip. Later changes reword buttons and move panels between tabs while
 * keeping the ids, and a smoke test that broke on a new label would be noise in exactly the
 * changes it is there to watch.
 */

import { type ConsoleMessage, type Page, test as base, expect } from '@playwright/test';

/** Where the Brain panel looks for `pnpm train:dashboard`. */
export const DASHBOARD_ORIGIN = 'http://localhost:5280';

export interface Studio {
  readonly page: Page;
  /** Every console message of type error since the page was opened, in order. */
  readonly consoleErrors: ConsoleMessage[];
  /** Every exception the page threw and nothing caught, in order. */
  readonly pageErrors: Error[];
  /** Every request the page made to the dashboard, each of which was refused. */
  readonly dashboardRequests: string[];
  /** When the page was opened, by the test's clock, for a test that watches a span of time. */
  readonly openedAt: number;
}

/**
 * A fresh studio page, booted to rest, for each test.
 *
 * The dashboard is refused for every test, not only the one about handing over without it. The
 * suite runs with `reuseExistingServer` locally, on a machine where somebody may well have
 * `pnpm train:dashboard` up, and a smoke test should see the same studio there as on CI: the one a
 * person gets who has never started the dashboard.
 *
 * A test fails on any exception the page did not catch, whatever it was checking. An uncaught
 * error in the frame loop or behind a button is a break somebody would see, and the tests after
 * boot would otherwise pass straight over one as long as the readout they watch kept moving.
 */
export const test = base.extend<{ studio: Studio }>({
  studio: async ({ page }, use) => {
    const consoleErrors: ConsoleMessage[] = [];
    const pageErrors: Error[] = [];
    const dashboardRequests: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message);
    });
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route(`${DASHBOARD_ORIGIN}/**`, async (route) => {
      dashboardRequests.push(route.request().url());
      await route.abort('connectionrefused');
    });

    const openedAt = Date.now();
    await page.goto('/');
    await waitForRest(page);

    await use({ page, consoleErrors, pageErrors, dashboardRequests, openedAt });

    expect(
      pageErrors.map((error) => error.stack ?? error.message),
      'the page threw an error nothing caught',
    ).toEqual([]);
  },
});

export { expect };

/**
 * Wait until the body is on screen and nothing is running: the moment Start first does something.
 *
 * The readout says "At rest" once the skeleton has loaded and the full-detail mesh with it; before
 * that it says what it is waiting for, and Start refuses with a message.
 */
export async function waitForRest(page: Page): Promise<void> {
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page.locator('#sim-status')).toHaveText(/at rest/i);
  await expect(page.locator('#simStart')).toBeEnabled();
}

/** The simulated seconds the run readout gives, or undefined when it gives none. */
export async function simulatedSeconds(page: Page): Promise<number | undefined> {
  const text = (await page.locator('#sim-status').textContent()) ?? '';
  // "Running, 1.25 s simulated, …" and "Paused at 1.25 s.": the first number followed by
  // seconds. The life-speed factor is a number too, but it is followed by an x.
  const match = /(\d+(?:\.\d+)?) s\b/.exec(text);
  return match ? Number(match[1]) : undefined;
}

/** Wait until the simulated time goes past `after`, and return what it reached. */
export async function timeAdvancesPast(page: Page, after: number): Promise<number> {
  let reached = after;
  await expect
    .poll(
      async () => {
        reached = (await simulatedSeconds(page)) ?? Number.NaN;
        return reached;
      },
      { message: `simulated time should move past ${after} s` },
    )
    .toBeGreaterThan(after);
  return reached;
}

/**
 * Start a run from rest and wait until it is running.
 *
 * Every text the readout takes on the way is kept, because the compile's own message lasts only
 * as long as the compile does -- a few seconds, painted once -- and a test that polled for it
 * could miss it on a fast machine and wait for it forever on a slow one.
 */
export async function startRun(page: Page): Promise<string[]> {
  await page.evaluate(() => {
    const status = document.querySelector('#sim-status');
    const seen: string[] = [];
    window.__smokeStatusSeen = seen;
    if (!status) return;
    new MutationObserver(() => seen.push(status.textContent ?? '')).observe(status, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  await page.locator('#simStart').click();
  await expect(page.locator('#sim-status')).toHaveText(/running/i);
  return page.evaluate(() => [...(window.__smokeStatusSeen ?? [])]);
}

declare global {
  interface Window {
    /** Every text `#sim-status` took since `startRun` began watching it. */
    __smokeStatusSeen?: string[];
  }
}
