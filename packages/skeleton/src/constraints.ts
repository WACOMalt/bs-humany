/**
 * Equality constraints -- milestone M5.2, spec section 7.4.
 *
 * Every coupling here is transcribed from MyoSuite's equality section (Apache-2.0), file and
 * constraint named in the citation:
 *
 *   - **Lumbar levels** move in fixed proportion. The source drives each level from a lumped
 *     coordinate; this model has no lumped coordinate in the per-level profiles, so the levels
 *     are tied to L4/L5 by the ratio of their source coefficients, which says the same thing.
 *   - **Patella** rotation is a quartic in knee flexion.
 *   - **Shoulder rhythm**: the sternoclavicular and acromioclavicular angles are fixed fractions
 *     of glenohumeral elevation. This is how the scapula rides the thorax without a gliding
 *     surface (spec 7.2), and it is what keeps the shoulder girdle from flopping.
 *
 * MuJoCo solves these natively; on Rapier the CouplingModule enforces them softly.
 */

import { type ConstraintDef, cite } from '@bs-humany/hsdl';

const TORSO = 'myo_sim/models/torso/assets/myotorso_assets.xml';
const LEG = 'myo_sim/models/leg/assets/myolegs_assets.xml';
const ARM = 'myo_sim/models/arm/assets/myoarm_r_assets.xml';
const myo = (file: string, constraint: string) =>
  cite('caggiano2022', `${file}, equality ${constraint}`);

/** Source shares of the lumped lumbar motion per level and axis, in DoF order FE, LB, AR. */
const LUMBAR_SHARES: Record<string, readonly [number, number, number]> = {
  l4_l5: [0.185, 0.1811, 0.03778],
  l3_l4: [0.204, 0.2453, 0.03778],
  l2_l3: [0.231, 0.2501, 0.03111],
  l1_l2: [0.255, 0.188, 0.02889],
};
const LUMBAR_SOURCE_NAMES = ['FE', 'LB', 'AR'] as const;

function lumbarCouplings(): ConstraintDef[] {
  const base = LUMBAR_SHARES.l4_l5;
  if (!base) throw new Error('unreachable');
  const out: ConstraintDef[] = [];
  for (const level of ['l3_l4', 'l2_l3', 'l1_l2']) {
    const shares = LUMBAR_SHARES[level];
    if (!shares) continue;
    LUMBAR_SOURCE_NAMES.forEach((axis, dof) => {
      const source = level.toUpperCase();
      out.push({
        id: `${level}_${axis.toLowerCase()}_follows_l4_l5`,
        displayName: `${source.replace('_', '/')} ${axis} in proportion to L4/L5`,
        kind: {
          type: 'jointCoupling',
          dependent: { joint: level, dof },
          drivers: [
            { dof: { joint: 'l4_l5', dof }, coefficient: (shares[dof] ?? 0) / (base[dof] ?? 1) },
          ],
        },
        soft: false,
        source: myo(
          TORSO,
          `${source}_${axis}_con and L4_L5_${axis}_con (ratio of their coefficients)`,
        ),
      });
    });
  }
  return out;
}

function sideCouplings(s: 'l' | 'r'): ConstraintDef[] {
  const side = s === 'r' ? 'right' : 'left';
  const elevation = { joint: `glenohumeral_${s}`, dof: 1 };
  const rhythm = (
    joint: string,
    dof: number,
    coefficient: number,
    sourceName: string,
    displayName: string,
  ): ConstraintDef => ({
    id: `${joint}_dof${dof}_follows_elevation`,
    displayName: `${displayName}, ${side}`,
    kind: {
      type: 'jointCoupling',
      dependent: { joint, dof },
      drivers: [{ dof: elevation, coefficient }],
    },
    soft: false,
    source: myo(
      ARM,
      `${sourceName}_con_r (the source arm model is right-sided; the left mirrors it)`,
    ),
  });
  return [
    {
      id: `patellofemoral_${s}_follows_knee`,
      displayName: `Patella tracks knee flexion, ${side}`,
      kind: {
        type: 'jointCoupling',
        dependent: { joint: `patellofemoral_${s}`, dof: 0 },
        drivers: [
          {
            dof: { joint: `knee_${s}`, dof: 0 },
            coefficient: 0.0247615,
            higher: [-1.31647, 0.716337, -0.138302],
          },
        ],
        offset: 0.010506,
      },
      soft: false,
      source: myo(LEG, `knee_angle_beta_rotation1_constraint_${s}`),
    },
    rhythm(
      `sternoclavicular_${s}`,
      0,
      -0.242,
      'sternoclavicular_r2',
      'Sternoclavicular protraction with elevation',
    ),
    rhythm(
      `sternoclavicular_${s}`,
      1,
      0.1025,
      'sternoclavicular_r3',
      'Sternoclavicular elevation with elevation',
    ),
    rhythm(
      `acromioclavicular_${s}`,
      0,
      -0.049,
      'acromioclavicular_r2',
      'Acromioclavicular protraction with elevation',
    ),
    rhythm(
      `acromioclavicular_${s}`,
      1,
      0.178,
      'acromioclavicular_r1',
      'Acromioclavicular tilt with elevation',
    ),
    rhythm(
      `acromioclavicular_${s}`,
      2,
      0.396,
      'acromioclavicular_r3',
      'Acromioclavicular upward rotation with elevation',
    ),
  ];
}

export function buildConstraints(): ConstraintDef[] {
  return [...lumbarCouplings(), ...sideCouplings('r'), ...sideCouplings('l')];
}
