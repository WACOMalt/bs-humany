/**
 * The golden and plausibility suite over every scenario -- spec sections 13.2 and 13.4.
 *
 * Each file under `goldens/` calls `pinScenarios` for one group of `GOLDEN_GROUPS`, so the
 * scenarios run in as many files as there are groups and vitest runs the files side by side. The
 * groups are balanced by how long their scenarios take to step, not by what they are about;
 * `goldens/coverage.test.ts` holds that every scenario is in exactly one group, that every group
 * has its file, and that the committed goldens name nothing no scenario would write.
 *
 * Every scenario is checked for plausibility. Only a pinned one (`golden !== false`) is checked
 * against, or writes, a golden hash: a scenario driven by a trained policy changes with every
 * training run, so its hash would record the last run rather than the physics.
 *
 * `pnpm goldens:update` runs these files with UPDATE_GOLDENS set. Each file then reads the goldens
 * once, records what its scenarios hash to, and writes the file back once when it is done, keeping
 * every entry it did not run (so a `-t` filter updates only what it selects) and dropping entries
 * no scenario writes. It prints what changed. vitest runs the files one at a time in that mode
 * (`vitest.config.ts`), because each is a read, modify and write of the same file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import type { IPhysicsBackend } from '@bs-humany/compiler';
import { SCENARIOS, SCENARIO_DEFINITIONS, type Scenario } from '@bs-humany/scenarios';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trajectoryHash } from './hash.js';
import {
  MUJOCO_TOLERANCES,
  type PlausibilityTolerances,
  checkPlausibility,
} from './plausibility.js';
import { type Trajectory, runScenario } from './runner.js';

/**
 * The backends every scenario runs on, by the name its golden is filed under. MuJoCo is the only
 * one since Rapier was deleted (ADR-003, 2026-09-26); the table stays because a golden's key
 * names its backend, and a second backend would join here and get goldens of its own.
 */
export const BACKENDS: Record<string, () => IPhysicsBackend> = {
  mujoco: () => new MujocoBackend(),
};

/**
 * Each backend's plausibility tolerances. A backend with none is an error rather than a fall back
 * to another's: tolerances are measured per backend, and borrowing them is how a looser solver's
 * slack once hid behind a stiffer one's numbers.
 */
const TOLERANCES: Record<string, PlausibilityTolerances> = {
  mujoco: MUJOCO_TOLERANCES,
};
function tolerancesFor(backend: string): PlausibilityTolerances {
  const tolerances = TOLERANCES[backend];
  if (!tolerances) {
    throw new Error(
      `No plausibility tolerances for backend '${backend}'. Measure its scenarios and add a set ` +
        'with reasons to plausibility.ts before it runs here.',
    );
  }
  return tolerances;
}

/**
 * The groups, one file each, by predicate. Balanced by stepping time as measured on 2026-09-27
 * (`docs/validation/conformance.md`): the L1 skeleton scenarios take under a second each, the
 * muscled ones at a kilohertz between seven and thirty.
 */
export const GOLDEN_GROUPS: Record<string, (s: Scenario) => boolean> = {
  skeleton: (s) =>
    s.profileId === 'l1_standard' || s.id === 'skull-wiggle' || s.id === 'tilting-floor',
  rangeOfMotion: (s) => s.id === 'muscle-range-of-motion',
  flail: (s) => s.id === 'arm-flail' || s.id === 'clip-flail-arms',
  standing: (s) =>
    s.id === 'quiet-standing' ||
    s.id === 'clip-quiet-standing' ||
    s.id === 'clip-walk-normal' ||
    s.id === 'nerves-stand',
};

/**
 * How long one scenario may take, in wall-clock milliseconds. The longest steps for about thirty
 * seconds on its own and perhaps three times that with every file running at once, so ten minutes
 * is never reached by a healthy run and bounds an unhealthy one. It is both the test's timeout and
 * the runner's budget, because a test runner's timer cannot fire inside the synchronous stepping
 * loop; the budget is what actually stops it (`RunOptions.budgetMs`).
 */
export const SCENARIO_TIMEOUT_MS = 600_000;

/** Ticks of each scenario rerun with the kernel's declared-access audit on. */
const AUDIT_TICKS = 300;

export const GOLDENS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'goldens',
  'trajectories.json',
);

export interface GoldenEntry {
  readonly hash: string;
  readonly ticks: number;
  readonly platform: string;
}
export type Goldens = Record<string, GoldenEntry>;

export function readGoldens(): Goldens {
  return existsSync(GOLDENS_FILE)
    ? (JSON.parse(readFileSync(GOLDENS_FILE, 'utf8')) as Goldens)
    : {};
}

function formatGoldens(goldens: Goldens): string {
  const sorted = Object.fromEntries(Object.entries(goldens).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export function goldenKey(scenario: Scenario, backend: string): string {
  return `${scenario.id}/${scenario.profileId}/${backend}`;
}

/** Every key a golden may be filed under: each pinned scenario, at its profile, on each backend. */
export function expectedGoldenKeys(): Set<string> {
  const keys = new Set<string>();
  for (const scenario of SCENARIOS) {
    if (scenario.golden === false) continue;
    for (const backend of Object.keys(BACKENDS)) keys.add(goldenKey(scenario, backend));
  }
  return keys;
}

const PLATFORM = `${process.platform}-${process.arch}`;

export function updatingGoldens(): boolean {
  return Boolean(process.env.UPDATE_GOLDENS);
}

/**
 * What a failed comparison says: which key, what to run, and what CONTRIBUTING asks of the commit.
 * The recorded platform is named when it is not this one, because MuJoCo's WASM should hash the
 * same everywhere, and a mismatch between machines is the first thing to rule in or out.
 */
function mismatchMessage(key: string, golden: GoldenEntry | undefined): string {
  if (!golden) {
    return (
      `no golden for ${key}. Run \`pnpm goldens:update\` and commit trajectories.json with a ` +
      'written justification (CONTRIBUTING rule 2).'
    );
  }
  const elsewhere =
    golden.platform === PLATFORM
      ? ''
      : ` It was recorded on ${golden.platform} and this is ${PLATFORM}, so first check whether ` +
        'the difference is the platform rather than the behaviour.';
  return (
    `the trajectory of ${key} changed.${elsewhere} If the new behaviour is intended, run ` +
    '`pnpm goldens:update` and commit trajectories.json alone with a written justification ' +
    '(CONTRIBUTING rule 2); if it is not, the change that moved it is the bug.'
  );
}

/**
 * Update mode's bookkeeping for one file: the goldens as they stood when it started, and what its
 * scenarios hashed to. Written back once, after the file's last test.
 */
function recordUpdates(group: string): Map<string, GoldenEntry> {
  const recorded = new Map<string, GoldenEntry>();
  let before: Goldens = {};
  beforeAll(() => {
    before = readGoldens();
  });
  afterAll(() => {
    const expected = expectedGoldenKeys();
    const next: Goldens = {};
    const pruned: string[] = [];
    for (const [key, entry] of Object.entries(before)) {
      if (expected.has(key)) next[key] = entry;
      else pruned.push(key);
    }
    const changed: string[] = [];
    const added: string[] = [];
    let unchanged = 0;
    for (const [key, entry] of recorded) {
      const old = before[key];
      if (!old) {
        added.push(key);
        next[key] = entry;
      } else if (old.hash !== entry.hash || old.ticks !== entry.ticks) {
        changed.push(`${key}: ${old.hash} -> ${entry.hash}`);
        next[key] = entry;
      } else {
        // The same hash keeps the entry it had, platform included: the platform says where the
        // hash was first produced, and an update run elsewhere that reproduced it changes nothing.
        unchanged++;
      }
    }
    const text = formatGoldens(next);
    const current = existsSync(GOLDENS_FILE) ? readFileSync(GOLDENS_FILE, 'utf8') : '';
    if (text !== current) {
      mkdirSync(dirname(GOLDENS_FILE), { recursive: true });
      writeFileSync(GOLDENS_FILE, text);
    }
    const lines = [
      `goldens, ${group}: ${changed.length} changed, ${unchanged} unchanged, ` +
        `${added.length} added, ${pruned.length} orphans pruned`,
      ...changed.map((c) => `  changed ${c}`),
      ...added.map((a) => `  added   ${a}`),
      ...pruned.map((p) => `  pruned  ${p}`),
    ];
    console.log(lines.join('\n'));
  });
  return recorded;
}

/**
 * Registers the plausibility check, the golden comparison (or, in update mode, the recording) and
 * the declared-access audit for every scenario in one group.
 */
export function pinScenarios(group: string): void {
  const select = GOLDEN_GROUPS[group];
  if (!select) {
    throw new Error(`No golden group '${group}'. Known: ${Object.keys(GOLDEN_GROUPS).join(', ')}.`);
  }
  const scenarios = SCENARIOS.filter(select);
  const update = updatingGoldens();
  const recorded = update ? recordUpdates(group) : undefined;
  let goldens: Goldens | undefined;

  // One run per scenario and backend, shared by its plausibility check and its hash.
  const cache = new Map<string, Promise<Trajectory>>();
  const trajectory = (scenario: Scenario, backend: string): Promise<Trajectory> => {
    const key = `${scenario.id}/${backend}`;
    let pending = cache.get(key);
    if (!pending) {
      const factory = BACKENDS[backend];
      if (!factory) throw new Error(backend);
      pending = runScenario(factory(), scenario, { budgetMs: SCENARIO_TIMEOUT_MS });
      cache.set(key, pending);
    }
    return pending;
  };

  describe.each(scenarios.map((s) => [s.id, s] as const))('scenario %s', (_id, scenario) => {
    describe.each(Object.keys(BACKENDS))('on %s', (backend) => {
      it(
        'is physically plausible',
        async () => {
          const t = await trajectory(scenario, backend);
          const findings = checkPlausibility(
            t,
            { ...tolerancesFor(backend), ...scenario.plausibility },
            {
              passiveSystem: scenario.passiveSystem,
              expectRest: scenario.settles !== false,
              passiveJoints: scenario.passiveJoints,
            },
          );
          // The findings go in the message as well as the diff, so a summary that shows only the
          // message (vitest folds identical ones together) still says what failed and by how much.
          const lines = findings.map((f) => `${f.check}: ${f.message} (limit ${f.limit})`);
          expect(lines, `${scenario.id} on ${backend}: ${lines.join('; ')}`).toEqual([]);
        },
        SCENARIO_TIMEOUT_MS,
      );

      it.runIf(scenario.golden !== false)(
        'matches its golden trajectory hash',
        async () => {
          const t = await trajectory(scenario, backend);
          const hash = trajectoryHash(t);
          const key = goldenKey(scenario, backend);
          if (recorded) {
            recorded.set(key, { hash, ticks: t.ticks, platform: PLATFORM });
            return;
          }
          goldens ??= readGoldens();
          const golden = goldens[key];
          expect(golden, mismatchMessage(key, undefined)).toBeDefined();
          expect(hash, mismatchMessage(key, golden)).toBe(golden?.hash);
        },
        SCENARIO_TIMEOUT_MS,
      );
    });
  });

  /**
   * CONTRIBUTING rule 6, over the whole body. The golden runs above are left unaudited so they
   * stay fast (runner.ts); this pass runs the first 300 ticks of each again with the kernel's
   * audit on, so a module in any scenario's line-up that writes through a read view fails here
   * rather than quietly corrupting a channel something else owns. It asserts only that nothing
   * throws: the trajectory is the goldens' business.
   *
   * Each run builds its scenario afresh from its definition rather than reusing the shared one,
   * because a scenario's script can keep state in its closure -- the ankle strategy's last lean,
   * the shaken head's centre -- and a second run through the same closure would start from where
   * the golden run left it. Every scenario is audited, pinned or not: the nerves scenario is the
   * only one that puts the nerves module in the loop.
   */
  describe.each(scenarios.map((s) => s.id))('scenario %s under the declared-access audit', (id) => {
    const definition = SCENARIO_DEFINITIONS.find((d) => d.id === id);
    it.each(Object.keys(BACKENDS))(
      'writes only what its modules declare, on %s',
      async (backend) => {
        if (!definition) throw new Error(`No scenario definition '${id}'.`);
        const factory = BACKENDS[backend];
        if (!factory) throw new Error(backend);
        const t = await runScenario(factory(), definition.build(), {
          audit: true,
          maxTicks: AUDIT_TICKS,
          budgetMs: SCENARIO_TIMEOUT_MS,
        });
        expect(t.ticks).toBe(AUDIT_TICKS);
      },
      SCENARIO_TIMEOUT_MS,
    );
  });
}
