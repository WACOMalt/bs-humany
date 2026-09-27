/**
 * The cord the Spine panel shows is the cord the body runs.
 *
 * The panel used to open with Damping at a quarter over a body whose damping was zero, and to
 * print Stretch 'off' whenever stretch was zero, damping or no damping. So the opening panel
 * described a cord no run had, and moving Damping alone left a label saying there were no
 * reflexes while there were. The panel now opens on the module's own defaults and says 'off'
 * only when both gains are zero; these check that those defaults are the body a run opens with,
 * and that what the panel sets is what the body then uses.
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
    // Every muscle run has a cord under it, dormant or not.
    expect(simulation.spine).toBeDefined();
    const gains = simulation.spine?.gains;
    expect(gains?.stretch).toBe(0);
    expect(gains?.velocity).toBe(0);
    // The panel's sliders start from these, so the opening panel is the opening body.
    expect(DEFAULT_SPINAL_GAINS.stretch).toBe(gains?.stretch);
    expect(DEFAULT_SPINAL_GAINS.velocity).toBe(gains?.velocity);
    // And it says what that body is.
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
