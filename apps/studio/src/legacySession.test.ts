/**
 * A session saved while Rapier existed still opens, on MuJoCo.
 *
 * Rapier was deleted on 2026-09-26 (ADR-003), but session files outlive the code that wrote them:
 * they are downloaded, attached to bug reports and dropped back into the studio months later.
 * One that says 'rapier' has to load and run, and what runs it is MuJoCo -- the only backend the
 * studio has -- rather than an error about a backend nobody can pick any more.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { isSessionFile } from './session.js';
import { Simulation, type SimulationOptions } from './simulation.js';

/** A session file as the studio wrote them before the deletion, settings only. */
const SAVED = JSON.stringify({
  format: 'bs-humany.session/1',
  savedAt: '2026-09-10T12:00:00.000Z',
  settings: {
    sex: 0.5,
    stature: 1.7,
    mass: 70,
    crural: 0.9,
    brachial: 0.8,
    legLength: 0.47,
    profile: 'l1_standard',
    backend: 'rapier',
    scenario: '',
    passive: true,
    redistribute: true,
    dropHeight: 0.2,
  },
});

describe('a session saved with the Rapier backend', () => {
  it('loads, and runs on MuJoCo', async () => {
    const file: unknown = JSON.parse(SAVED);
    expect(isSessionFile(file)).toBe(true);
    if (!isSessionFile(file)) return;
    const { settings } = file;
    expect(settings.backend).toBe('rapier');
    // The studio hands the saved string on as it stands; the simulation is what decides.
    const simulation = new Simulation(
      buildDocument(),
      resolveMorphology({ sex: settings.sex, stature: settings.stature, mass: settings.mass }),
      {
        profileId: settings.profile,
        backend: settings.backend as SimulationOptions['backend'],
        passiveJoints: settings.passive,
        redistribute: settings.redistribute,
        dropHeight: settings.dropHeight,
        groundHeight: 0,
      },
    );
    expect(simulation.backendId).toBe('mujoco');
    expect(simulation.recording.backend).toBe('mujoco');
    await simulation.start();
    expect(simulation.backendReport?.backend).toBe('mujoco');
    for (let frame = 0; frame < 10; frame++) simulation.advance(1 / 60);
    expect(simulation.ticks).toBeGreaterThan(0);
    expect(simulation.failure).toBeUndefined();
    expect(simulation.paused).toBe(false);
    simulation.dispose();
  }, 60_000);
});
