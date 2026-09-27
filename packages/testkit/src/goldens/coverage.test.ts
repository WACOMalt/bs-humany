import { existsSync, readFileSync } from 'node:fs';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { SCENARIOS, scenario } from '@bs-humany/scenarios';
import { describe, expect, it } from 'vitest';
import { GOLDEN_GROUPS, expectedGoldenKeys, readGoldens, updatingGoldens } from '../goldenSuite.js';
import { runScenario } from '../runner.js';

/**
 * What keeps the split suite whole. A scenario in no group would never be checked, and one in two
 * would be stepped twice and, in update mode, recorded twice; a group without its file would be a
 * group nobody runs. A golden no scenario writes is a record of something that no longer exists --
 * a renamed scenario, a moved profile, a deleted backend -- and would sit in the file looking
 * checked while nothing checks it.
 */
describe('the golden suite', () => {
  it('puts every scenario in exactly one group', () => {
    const misplaced = SCENARIOS.flatMap((s) => {
      const groups = Object.entries(GOLDEN_GROUPS)
        .filter(([, select]) => select(s))
        .map(([name]) => name);
      return groups.length === 1 ? [] : [`${s.id}: ${groups.length ? groups.join(', ') : 'none'}`];
    });
    expect(misplaced).toEqual([]);
  });

  it('runs every group from its own file', () => {
    const missing = Object.keys(GOLDEN_GROUPS).filter((group) => {
      const file = new URL(`./${group}.test.ts`, import.meta.url);
      return !existsSync(file) || !readFileSync(file, 'utf8').includes(`pinScenarios('${group}')`);
    });
    expect(missing).toEqual([]);
  });

  // An update run prunes orphans itself, and may be partway through doing so while this runs.
  it.skipIf(updatingGoldens())('keeps no golden that no scenario writes', () => {
    const expected = expectedGoldenKeys();
    const orphans = Object.keys(readGoldens()).filter((key) => !expected.has(key));
    expect(
      orphans,
      'goldens for no pinned scenario, profile and backend; `pnpm goldens:update` prunes them',
    ).toEqual([]);
  });

  // The suite's timeouts are only as good as this: vitest's timer cannot fire inside the
  // synchronous stepping loop, so the runner's budget is what ends a run that has stalled.
  it('stops a scenario that has used its wall-clock budget', async () => {
    await expect(
      runScenario(new MujocoBackend(), scenario('drop-supine'), { budgetMs: 0 }),
    ).rejects.toThrow(/drop-supine.*wall-clock budget by tick \d+ of 1500/);
  });
});
