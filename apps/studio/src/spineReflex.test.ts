/**
 * The cord the Spine panel shows is the cord the body runs.
 *
 * The panel used to open with Damping at a quarter over a body whose damping was zero, and to
 * print Stretch 'off' whenever stretch was zero, damping or no damping. So the opening panel
 * described a cord no run had, and moving Damping alone left a label saying there were no
 * reflexes while there were. The panel says 'off' only when both gains are zero. Since
 * 2026-09-27 it opens on the measured cord (`OPENING_CORD` in brain.ts, the trainer's
 * `DEFAULT_REFLEX`, a stretch of 8.5) and hands that to the body, so the opening panel is the
 * opening body; a `Simulation` handed no cord at all runs the module's own default, which is off.
 * These check that default, and that what the panel sets is what the body then uses.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { DEFAULT_SPINAL_GAINS } from '@bs-humany/modules-nerves';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation.js';
import { spineNote, stretchLabel } from './training/buttons.js';

const document = buildDocument();

async function running(): Promise<Simulation> {
  const simulation = new Simulation(
    document,
    resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 }),
    {
      profileId: 'l3_anatomical',
      backend: 'mujoco',
      passiveJoints: true,
      redistribute: true,
      dropHeight: 0.2,
      groundHeight: 0,
      muscles: true,
    },
  );
  await simulation.start();
  return simulation;
}

describe('the Spine panel and the body', () => {
  it('opens on the cord a run opens with', async () => {
    const simulation = await running();
    // Every muscle run has a cord under it, dormant or not. This one is handed none, as a
    // headless caller is, so it runs the module's default: off.
    expect(simulation.spine).toBeDefined();
    const gains = simulation.spine?.gains;
    expect(gains?.stretch).toBe(0);
    expect(gains?.velocity).toBe(0);
    // That default is the module's own, and the studio does not open on it: it passes the
    // measured cord, which its sliders start from (brain.ts, `OPENING_CORD`).
    expect(DEFAULT_SPINAL_GAINS.stretch).toBe(gains?.stretch);
    expect(DEFAULT_SPINAL_GAINS.velocity).toBe(gains?.velocity);
    // What the panel says of a body with no cord.
    expect(stretchLabel(DEFAULT_SPINAL_GAINS.stretch, DEFAULT_SPINAL_GAINS.velocity)).toBe('off');
    expect(spineNote(DEFAULT_SPINAL_GAINS)).toContain('no reflexes at all');
    simulation.dispose();
  });

  it('runs the cord the panel sets', async () => {
    const simulation = await running();
    simulation.setReflex({ stretch: 3.5, velocity: 0.25 });
    const gains = simulation.spine?.gains;
    expect(gains?.stretch).toBe(3.5);
    expect(gains?.velocity).toBe(0.25);
    // A body with damping and no stretch gain still has reflexes, and the label says so.
    simulation.setReflex({ stretch: 0 });
    expect(
      stretchLabel(simulation.spine?.gains.stretch ?? 0, simulation.spine?.gains.velocity ?? 0),
    ).toBe('0.00');
    simulation.dispose();
  });
});
