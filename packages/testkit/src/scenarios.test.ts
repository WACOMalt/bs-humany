import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import type { IPhysicsBackend } from '@bs-humany/compiler';
import { SCENARIOS, SCENARIO_DEFINITIONS, type Scenario } from '@bs-humany/scenarios';
import { describe, expect, it } from 'vitest';
import { trajectoryHash } from './hash.js';
import { DEFAULT_TOLERANCES, checkPlausibility } from './plausibility.js';
import { type Trajectory, runScenario } from './runner.js';

/**
 * The backends every scenario runs on, by the name its golden is filed under. MuJoCo is the only
 * one since Rapier was deleted (ADR-003, 2026-09-26); the table stays because a golden's key
 * names its backend, and a second backend would join here and get goldens of its own.
 */
const BACKENDS: Record<string, () => IPhysicsBackend> = {
  mujoco: () => new MujocoBackend(),
};

const cache = new Map<string, Promise<Trajectory>>();
function trajectory(scenario: Scenario, backend: string): Promise<Trajectory> {
  const key = `${scenario.id}/${backend}`;
  let pending = cache.get(key);
  if (!pending) {
    const factory = BACKENDS[backend];
    if (!factory) throw new Error(backend);
    pending = runScenario(factory(), scenario);
    cache.set(key, pending);
  }
  return pending;
}

const GOLDENS = join(dirname(fileURLToPath(import.meta.url)), '..', 'goldens', 'trajectories.json');
type Goldens = Record<string, { hash: string; ticks: number; platform: string }>;
function readGoldens(): Goldens {
  return existsSync(GOLDENS) ? (JSON.parse(readFileSync(GOLDENS, 'utf8')) as Goldens) : {};
}

// A scenario driven by a trained policy has no golden: its policy file changes with every
// training run, and its physics is the same physics the others pin.
const PINNED = SCENARIOS.filter((s) => s.golden !== false);
describe.each(PINNED.map((s) => [s.id, s] as const))('scenario %s', (_id, scenario) => {
  describe.each(Object.keys(BACKENDS))('on %s', (backend) => {
    it('is physically plausible', async () => {
      const t = await trajectory(scenario, backend);
      const findings = checkPlausibility(
        t,
        { ...DEFAULT_TOLERANCES, ...scenario.plausibility },
        {
          passiveSystem: scenario.passiveSystem,
          expectRest: true,
          passiveJoints: scenario.passiveJoints,
        },
      );
      expect(findings.map((f) => `${f.check}: ${f.message}`)).toEqual([]);
    });

    it('matches its golden trajectory hash', async () => {
      const t = await trajectory(scenario, backend);
      const hash = trajectoryHash(t);
      const key = `${scenario.id}/${scenario.profileId}/${backend}`;
      const goldens = readGoldens();
      if (process.env.UPDATE_GOLDENS) {
        goldens[key] = { hash, ticks: t.ticks, platform: `${process.platform}-${process.arch}` };
        mkdirSync(dirname(GOLDENS), { recursive: true });
        const sorted = Object.fromEntries(
          Object.entries(goldens).sort(([a], [b]) => a.localeCompare(b)),
        );
        writeFileSync(GOLDENS, `${JSON.stringify(sorted, null, 2)}\n`);
        return;
      }
      const golden = goldens[key];
      expect(
        golden,
        `no golden for ${key}; run with UPDATE_GOLDENS=1 and commit the result with a justification`,
      ).toBeDefined();
      expect(
        hash,
        'trajectory changed: a golden update must be a deliberate, reviewed commit',
      ).toBe(golden?.hash);
    });
  });
});

/**
 * CONTRIBUTING rule 6, over the whole body. The golden runs above are left unaudited so they stay
 * fast (runner.ts); this pass runs the first 300 ticks of each again with the kernel's audit on, so
 * a module in any scenario's line-up that writes through a read view fails here rather than
 * quietly corrupting a channel something else owns. It asserts only that nothing throws: the
 * trajectory is the goldens' business.
 *
 * Each run builds its scenario afresh from its definition rather than reusing the shared one,
 * because a scenario's script can keep state in its closure -- the ankle strategy's last lean, the
 * shaken head's centre -- and a second run through the same closure would start from where the
 * golden run left it. The nerves scenario has no golden but is here, because it is the only one
 * that puts the nerves module in the loop.
 */
const AUDIT_TICKS = 300;
const AUDITED = [...PINNED.map((s) => s.id), 'nerves-stand'];
describe.each(AUDITED)('scenario %s under the declared-access audit', (id) => {
  const definition = SCENARIO_DEFINITIONS.find((d) => d.id === id);
  it.each(Object.keys(BACKENDS))('writes only what its modules declare, on %s', async (backend) => {
    if (!definition) throw new Error(`No scenario definition '${id}'.`);
    const factory = BACKENDS[backend];
    if (!factory) throw new Error(backend);
    const t = await runScenario(factory(), definition.build(), {
      audit: true,
      maxTicks: AUDIT_TICKS,
    });
    expect(t.ticks).toBe(AUDIT_TICKS);
  });
});
