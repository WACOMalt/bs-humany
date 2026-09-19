import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import type { IPhysicsBackend } from '@bs-humany/compiler';
import { SCENARIOS, type Scenario } from '@bs-humany/scenarios';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFORMANCE, compareTrajectories } from './conformance.js';
import { trajectoryHash } from './hash.js';
import { DEFAULT_TOLERANCES, MUJOCO_TOLERANCES, checkPlausibility } from './plausibility.js';
import { type Trajectory, runScenario } from './runner.js';

/**
 * The enabled backends. Rapier is disabled and hidden (ADR-003 reassessment, 2026-09-13):
 * with convex-hull proxies it injects energy and tears joints in three scenarios, and it is
 * five times slower than MuJoCo. Its factory stays here, commented, for the day it is revisited.
 */
const BACKENDS: Record<string, () => IPhysicsBackend> = {
  mujoco: () => new MujocoBackend(),
  // rapier: () => new RapierBackend(),
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
        {
          ...(backend === 'mujoco' ? MUJOCO_TOLERANCES : DEFAULT_TOLERANCES),
          ...scenario.plausibility,
        },
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

  // Cross-backend conformance needs two enabled backends; it resumes with Rapier.
  it.skipIf(Object.keys(BACKENDS).length < 2)(
    'agrees across backends within the documented tolerances',
    async () => {
      const [first, second] = Object.keys(BACKENDS);
      if (!first || !second) throw new Error('two backends');
      const [a, b] = await Promise.all([trajectory(scenario, first), trajectory(scenario, second)]);
      const disagreements = compareTrajectories(
        a,
        b,
        { ...DEFAULT_CONFORMANCE, ...scenario.conformance },
        { expectRest: true },
      );
      expect(disagreements.map((d) => `${d.check}: ${d.message}`)).toEqual([]);
    },
  );
});
