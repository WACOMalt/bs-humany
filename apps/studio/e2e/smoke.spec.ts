/**
 * The studio's basics, in a real browser: it boots clean, Start runs the body, Space pauses and
 * resumes, each tab shows its own panel, and a shipped checkpoint can be put in charge with no
 * training dashboard anywhere. Each test opens its own page, so one that fails leaves nothing
 * behind for the next.
 */

import type { ConsoleMessage } from '@playwright/test';
import { expect, simulatedSeconds, startRun, test, timeAdvancesPast } from './studio.js';

/** How long after opening the page a console error still counts as part of booting. */
const BOOT_WATCH_MS = 10_000;

/**
 * The console errors a clean boot is allowed, each with the reason it cannot be avoided. None
 * today: the Brain panel used to ask the dashboard once as every page opened, and with nothing on
 * the port the browser logged both refused requests as errors. It now asks only when something
 * reads the answer (the Brain tab, the follow mode or the VR link), and a fresh page opens on Body.
 */
const ALLOWED_CONSOLE_ERRORS: readonly ((message: ConsoleMessage) => boolean)[] = [];

/** A console message in a form a failure can print. */
const describe = (message: ConsoleMessage): string =>
  `${message.text()} (${message.location().url || 'no location'})`;

test('boots with a live WebGL canvas, cross-origin isolated, and a clean console', async ({
  studio,
}) => {
  const { page } = studio;

  // The dev server's COOP and COEP headers (ADR-008): lose one and SharedArrayBuffer goes with it.
  expect(await page.evaluate(() => crossOriginIsolated), 'crossOriginIsolated').toBe(true);

  const canvas = page.locator('#viewport canvas');
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toBeVisible();
  // Asking the canvas for the kind of context it already has returns that context, so this reads
  // the renderer's own rather than making one.
  const gl = await canvas.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext('webgl2');
    return {
      live: context !== null && !context.isContextLost(),
      width: element.width,
      height: element.height,
    };
  });
  expect(gl.live, 'the viewport canvas has a live WebGL2 context').toBe(true);
  expect(gl.width).toBeGreaterThan(0);
  expect(gl.height).toBeGreaterThan(0);

  // The whole of the first ten seconds, not only up to rest: a poll or a late load that fails
  // does so after the body is already on screen.
  const remaining = BOOT_WATCH_MS - (Date.now() - studio.openedAt);
  if (remaining > 0) await page.waitForTimeout(remaining);

  expect(
    studio.pageErrors.map((error) => error.stack ?? error.message),
    'uncaught errors in the first ten seconds',
  ).toEqual([]);
  const unexpected = studio.consoleErrors
    .filter((message) => !ALLOWED_CONSOLE_ERRORS.some((allowed) => allowed(message)))
    .map(describe);
  expect(unexpected, 'console errors in the first ten seconds').toEqual([]);
  expect(
    studio.dashboardRequests,
    'the dashboard was asked while booting, with no Brain tab, follow or headset to read it',
  ).toEqual([]);
});

test('Start compiles and runs the body; Space pauses and resumes it', async ({ studio }) => {
  const { page } = studio;
  const status = page.locator('#sim-status');
  const start = page.locator('#simStart');

  // The readout's texts from the press on: the compile first, and nothing running before it.
  const seen = await startRun(page);
  const said = seen.join(' | ');
  const compiling = seen.findIndex((text) => /compil/i.test(text));
  const running = seen.findIndex((text) => /running/i.test(text));
  expect(compiling, `the readout should say it is compiling; it said ${said}`).toBeGreaterThan(-1);
  expect(
    running,
    `the readout should say running after compiling; it said ${said}`,
  ).toBeGreaterThan(compiling);

  // Read twice, a second apart: a run that says it is running and does not move is not running.
  const first = (await simulatedSeconds(page)) ?? Number.NaN;
  await page.waitForTimeout(1000);
  await timeAdvancesPast(page, first);

  // The click on Start gave focus back to the page, so Space is the transport's and not the
  // button's: a Space on a focused Start would press it, and on a live run that is Restart.
  await page.keyboard.press('Space');
  await expect(status, 'Space on a live run should pause it').toHaveText(/paused/i);
  await expect(start, 'Start on a paused run should offer to resume it').toHaveText(/resume/i);
  const pausedAt = (await simulatedSeconds(page)) ?? Number.NaN;
  await page.waitForTimeout(1000);
  expect(await simulatedSeconds(page), 'simulated time while paused').toBe(pausedAt);
  await expect(status).toHaveText(/paused/i);

  await page.keyboard.press('Space');
  await expect(status, 'Space on a paused run should carry it on').toHaveText(/running/i);
  await timeAdvancesPast(page, pausedAt);
  // Carried on, not started again: a resumed run goes on from where it paused.
  expect((await simulatedSeconds(page)) ?? 0).toBeGreaterThan(pausedAt);
});

test('each tab shows its own panel and hides the rest', async ({ studio }) => {
  const { page } = studio;
  const tabs = page.locator('#tabs button[data-tab]');
  const names = await tabs.evaluateAll((buttons) =>
    buttons.map((button) => (button as HTMLElement).dataset.tab ?? ''),
  );
  expect(names).toEqual(expect.arrayContaining(['muscles', 'brain']));

  // Which panels are showing, read in one trip. The page spends most of each frame drawing in
  // software under a headless browser, so a separate check for each of nine panels on each of
  // nine tabs took the best part of a minute; the question is the same asked once.
  const showing = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('#panels [data-panel]')]
        .filter((panel) => panel.checkVisibility())
        .map((panel) => panel.dataset.panel ?? ''),
    );
  for (const name of names) {
    await page.locator(`#tabs button[data-tab="${name}"]`).click();
    await expect.poll(showing, { message: `only the ${name} panel should show` }).toEqual([name]);
  }

  // The Muscles panel's drive sliders, one a group, generated from the table the headset shares.
  // They open folded, a section a region, so the first section is unfolded to reach one.
  await page.locator('#tabs button[data-tab="muscles"]').click();
  const drives = page.locator('#muscle-drives input[type="range"]');
  expect(await drives.count(), 'muscle drive sliders').toBeGreaterThan(0);
  await page.locator('#muscle-drives details > summary').first().click();
  await expect(
    page.locator('#muscle-drives details').first().locator('input[type="range"]').first(),
  ).toBeVisible();
  await expect(page.locator('#muscle-readout')).toBeVisible();

  // The Brain panel's checkpoint list and the controls that put one in charge.
  await page.locator('#tabs button[data-tab="brain"]').click();
  for (const id of ['#brain-policy', '#brain-authority', '#brain-handover', '#brain-release']) {
    await expect(page.locator(id), id).toBeVisible();
  }
});

test('a shipped checkpoint takes charge of a run with no dashboard', async ({ studio }) => {
  const { page } = studio;
  await page.locator('#tabs button[data-tab="brain"]').click();

  // The shipped balance behaviour, the one checkpoint the studio carries in its bundle: with the
  // dashboard refused, the list is what this studio holds itself.
  const policy = page.locator('#brain-policy');
  await expect(policy.locator('option[value="balance"]')).toHaveCount(1);
  await policy.selectOption('balance');
  await expect(page.locator('#brain-handover')).toBeEnabled();

  await startRun(page);
  await page.locator('#brain-handover').click();
  // The panel's own account of what went in, which it gives only once the running body has taken
  // the policy: a refused or failed hand-over says so in the same line instead.
  await expect(
    page.locator('#brain-fit-note'),
    'the Brain panel should say the policy is in the loop',
  ).toHaveText(/in the loop: \d+ of \d+ senses and \d+ of \d+ drives/i);
  await expect(page.locator('#brain-release')).toBeEnabled();

  // And the body goes on under it.
  await expect(page.locator('#sim-status')).toHaveText(/running/i);
  const inCharge = (await simulatedSeconds(page)) ?? Number.NaN;
  await timeAdvancesPast(page, inCharge);

  // The panel did look for the dashboard, and found nothing there: the hand-over above came from
  // what the studio holds itself.
  expect(studio.dashboardRequests.length, 'requests to the dashboard').toBeGreaterThan(0);
});
