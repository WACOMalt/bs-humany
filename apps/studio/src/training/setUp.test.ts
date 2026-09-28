/**
 * What Set up as trained would change, and whether that restarts a running body.
 *
 * Choosing a checkpoint only shows it now, and says how it differs from the tabs; Hand over sets
 * the tabs up first only when something differs, and the desktop asks before a restart throws a
 * long recording away. So a difference that is not one would restart a run on every hand-over, and
 * a live change counted as a restart would ask for no reason. These pin both.
 */

import { describe, expect, it } from 'vitest';
import {
  type StudioSetUp,
  describeSetUpDifferences,
  sameCord,
  setUpDifferences,
  setUpRestarts,
} from './setUp.js';

const HERE: StudioSetUp = {
  scenario: 'drop-standing-collapse',
  parameters: { clearance: 0.3 },
  profile: 'l3_anatomical',
  sex: 0.5,
  stature: 1.7,
  mass: 70,
  passive: true,
  redistribute: true,
  stepsPerSecond: 1000,
  cord: { stretch: 3.5, velocity: 0.25, setPoint: 0, inhibition: 0.3, delaySeconds: 0.03 },
  authority: 0.3,
  driving: false,
};

const NAMES = {
  scenario: (id: string) =>
    ({ 'drop-standing-collapse': 'Drop and collapse', 'quiet-standing': 'Standing quietly' })[id] ??
    id,
  profile: (id: string) => id.replace(/_.*/, '').toUpperCase(),
};

describe('setUpDifferences', () => {
  it('finds nothing when the tabs are as the checkpoint was trained', () => {
    expect(setUpDifferences(HERE, HERE, NAMES)).toEqual([]);
    // A number that went through a JSON file and back is the same setting.
    expect(setUpDifferences(HERE, { ...HERE, stature: 1.7 + 1e-12 }, NAMES)).toEqual([]);
  });

  it('names a changed scene, and restarts for it', () => {
    const list = setUpDifferences(HERE, { ...HERE, scenario: 'quiet-standing' }, NAMES);
    expect(list).toEqual([
      { text: 'scene Standing quietly (here Drop and collapse)', restarts: true },
    ]);
    expect(setUpRestarts(list)).toBe(true);
  });

  it('compares scene values only within one scene, and only the ones the recipe names', () => {
    // Another scene's values are part of changing scene.
    expect(
      setUpDifferences(
        HERE,
        { ...HERE, scenario: 'quiet-standing', parameters: { sway: 2 } },
        NAMES,
      ).map((d) => d.text),
    ).toEqual(['scene Standing quietly (here Drop and collapse)']);
    // A value the studio has and the recipe does not name is the scene's default.
    expect(setUpDifferences(HERE, { ...HERE, parameters: {} }, NAMES)).toEqual([]);
    expect(
      setUpDifferences(HERE, { ...HERE, parameters: { clearance: 0.5 } }, NAMES).map((d) => d.text),
    ).toEqual(["Drop and collapse's clearance 0.5 (here 0.3)"]);
  });

  it('restarts for the body, the joints and the step rate', () => {
    const list = setUpDifferences(
      HERE,
      {
        ...HERE,
        profile: 'l1_standard',
        stature: 1.8,
        mass: 80,
        sex: 0,
        passive: false,
        redistribute: false,
        stepsPerSecond: 500,
      },
      NAMES,
    );
    expect(list.map((d) => d.text)).toEqual([
      'body L1 (here L3)',
      'stature 1.800 m (here 1.700 m)',
      'mass 80.0 kg (here 70.0 kg)',
      'sex blend 0.00 (here 0.50)',
      'passive joints off (here on)',
      'spinal redistribution off (here on)',
      '500 steps a second (here 1000)',
    ]);
    expect(list.every((d) => d.restarts)).toBe(true);
  });

  it('changes the cord, the authority and the muscle sliders live, with no restart', () => {
    const list = setUpDifferences(
      { ...HERE, driving: true },
      {
        ...HERE,
        cord: {
          ...(HERE.cord as NonNullable<StudioSetUp['cord']>),
          stretch: 0,
          delaySeconds: 0.05,
        },
        authority: 1,
        driving: false,
      },
      NAMES,
    );
    expect(describeSetUpDifferences(list)).toBe(
      'cord stretch 0.00 (here 3.50), cord conduction 50 ms (here 30 ms), ' +
        'authority 1.00 (here 0.30), the muscle sliders at zero (here some are up)',
    );
    expect(setUpRestarts(list)).toBe(false);
  });

  it('compares the stretch region by region, as the body answers with it', () => {
    const cord = HERE.cord as NonNullable<StudioSetUp['cord']>;
    const byRegion = { ...cord, stretch: 8.5, regionStretch: { Arm: 2, Hand: 2 } };
    // Trained over a stretch by region, here one stretch everywhere: the regions that differ.
    const list = setUpDifferences(
      { ...HERE, cord: { ...cord, stretch: 8.5 } },
      { ...HERE, cord: byRegion },
      NAMES,
    );
    expect(describeSetUpDifferences(list)).toBe(
      'cord arm stretch 2.00 (here 8.50), cord hand stretch 2.00 (here 8.50)',
    );
    expect(setUpRestarts(list)).toBe(false);
    // A cord that names its one stretch in every region is that cord: no difference, and the
    // sliders are left alone.
    const everywhere = {
      ...cord,
      regionStretch: { Arm: 3.5, Hand: 3.5, Leg: 3.5, Trunk: 3.5, Neck: 3.5 },
    };
    expect(setUpDifferences(HERE, { ...HERE, cord: everywhere }, NAMES)).toEqual([]);
    expect(sameCord(cord, everywhere)).toBe(true);
    expect(sameCord(cord, byRegion)).toBe(false);
  });

  it('leaves alone what the recipe does not say', () => {
    // No step rate, no cord, and a checkpoint trained over something: none of those is set up,
    // so none of them is a difference.
    expect(
      setUpDifferences(
        { ...HERE, driving: true },
        { ...HERE, stepsPerSecond: undefined, cord: undefined, driving: undefined },
        NAMES,
      ),
    ).toEqual([]);
  });
});
