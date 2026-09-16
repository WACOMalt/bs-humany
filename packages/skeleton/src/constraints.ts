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

import { type ConstraintDef, cite, provisional } from '@bs-humany/hsdl';

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
    // The two counter-rotations carry the sternoclavicular coefficients negated, which is what
    // the source's unrotscap joint does; without them the scapula inherits the clavicle's swing
    // and lifts off the rib cage as the arm rises.
    rhythm(
      `acromioclavicular_${s}`,
      0,
      -0.1025,
      'unrotscap_r3',
      'Scapula released from clavicular elevation',
    ),
    rhythm(
      `acromioclavicular_${s}`,
      1,
      0.242,
      'unrotscap_r2',
      'Scapula released from clavicular protraction',
    ),
    rhythm(
      `acromioclavicular_${s}`,
      2,
      -0.049,
      'acromioclavicular_r2',
      'Acromioclavicular protraction with elevation',
    ),
    rhythm(
      `acromioclavicular_${s}`,
      3,
      0.396,
      'acromioclavicular_r3',
      'Acromioclavicular upward rotation with elevation',
    ),
    rhythm(
      `acromioclavicular_${s}`,
      4,
      0.178,
      'acromioclavicular_r1',
      'Acromioclavicular tilt with elevation',
    ),
  ];
}

/**
 * The costal cartilage, as weld constraints closing the rib cage.
 *
 * A kinematic tree cannot close a loop: each rib hangs from its own vertebra and, below the
 * first, its anterior end is joined to nothing. The seventh rib's tip then wanders 138 mm from
 * the sternum over a three-second fall, because six thoracic levels bend between the vertebra it
 * hangs from and the one the sternum follows, and the cage opens like a set of blinds.
 *
 * In life the first seven ribs are bound to the sternum by costal cartilage, and that binding is
 * most of why the thoracic spine is stiffer than the lumbar. A weld per true rib closes the
 * loop, which stops the cage opening and braces the thorax at the same time. Cartilage is
 * compliant, not rigid, so this overstates the stiffness a little; what it replaces understated
 * it entirely.
 */
function ribCageWelds(): ConstraintDef[] {
  const out: ConstraintDef[] = [];
  for (const s of ['r', 'l'] as const) {
    const side = s === 'r' ? 'right' : 'left';
    for (let n = 1; n <= TRUE_RIBS; n++) {
      // The first right rib already carries the sternum as a fixed joint.
      if (n === 1 && s === 'r') continue;
      out.push({
        id: `sternocostal_${n}_${s}`,
        displayName: `Costal cartilage, rib ${n} to sternum, ${side}`,
        kind: { type: 'weld', bodyA: 'sternum', bodyB: `rib_${n}_${s}` },
        soft: false,
        source: provisional(
          'gray1918',
          'OQ-011',
          'The true ribs articulate with the sternum through costal cartilage. Held rigid here ' +
            'because no cited stiffness for the cartilage is in hand; the alternative in place ' +
            'before this was no connection at all.',
        ),
      });
    }
  }
  return out;
}

/**
 * The costal margin: ribs eight to ten bound to the rib above rather than to the sternum.
 *
 * Gray has the cartilages of the eighth, ninth and tenth ribs reaching the sternum only
 * indirectly -- each joins the lower border of the cartilage above it, and the chain of them is
 * the costal margin you can feel under the ribs. `ribCageWelds` closes the loop for the seven
 * true ribs and stops there, which leaves these three hanging from their vertebrae by one
 * pump-handle hinge each and joined to nothing in front: the same open-blind failure the true
 * ribs had, three levels lower and with a longer lever.
 *
 * Bound to the rib above and not to the sternum, because that is the joint that exists. The
 * eleventh and twelfth are left alone: they end in the muscle of the abdominal wall and are free
 * in life, so a model that lets them move is right about them.
 */
function costalMarginWelds(): ConstraintDef[] {
  const out: ConstraintDef[] = [];
  for (const s of ['r', 'l'] as const) {
    const side = s === 'r' ? 'right' : 'left';
    for (let n = TRUE_RIBS + 1; n <= FALSE_RIBS; n++) {
      out.push({
        id: `interchondral_${n}_${s}`,
        displayName: `Costal cartilage, rib ${n} to rib ${n - 1}, ${side}`,
        kind: { type: 'weld', bodyA: `rib_${n - 1}_${s}`, bodyB: `rib_${n}_${s}` },
        // Soft, where the sternocostal welds are rigid, and the difference is not a preference.
        // Each of these ribs already hangs from its own thoracic vertebra, and the vertebrae move
        // relative to one another, so a rigid weld to the rib above closes a loop the spine can
        // pull on: the solver cannot satisfy both and the cage ends a settling scenario still
        // buzzing, four joules of kinetic energy that will not go away. A compliant weld is what
        // cartilage is anyway, and it settles.
        soft: true,
        source: provisional(
          'gray1918',
          'OQ-011',
          'The cartilages of the eighth, ninth and tenth ribs articulate with the cartilage of ' +
            'the rib above. Compliant rather than rigid, because the rib also hangs from its own ' +
            'vertebra and the pair of them over-constrains a moving spine; no cited stiffness ' +
            'for the cartilage is in hand, and the alternative in place before this was no ' +
            'connection at all.',
        ),
      });
    }
  }
  return out;
}

/** Ribs bound directly to the sternum by their own cartilage. */
export const TRUE_RIBS = 7;

/** The last rib whose cartilage reaches the costal margin; the eleventh and twelfth float. */
export const FALSE_RIBS = 10;

export function buildConstraints(): ConstraintDef[] {
  return [
    ...lumbarCouplings(),
    ...sideCouplings('r'),
    ...sideCouplings('l'),
    ...ribCageWelds(),
    ...costalMarginWelds(),
  ];
}
