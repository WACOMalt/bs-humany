/**
 * Per-bone geometry recipes and rest transforms.
 *
 * Milestone M1.8. Every entry is parametric: dimensions and offsets are expressions over
 * morphology parameters, so the whole skeleton reshapes when a slider moves. That is the point of
 * ADR-005 choosing procedural geometry over a fixed mesh set.
 *
 * ## Conventions
 *
 * A long bone's local origin sits at its **distal** joint centre with `+Y` pointing proximally, so
 * the femur's origin is the knee and the tibia's is the ankle. That matches the ISB-style frame
 * construction in `@bs-humany/frames`, where the primary axis runs from the distal landmark to the
 * proximal one, and it means a bone's rest transform relative to its parent is simply "one segment
 * length down".
 *
 * Rest transforms are relative to the **anatomical** parent from the taxonomy, which is not
 * necessarily the dynamic parent.
 *
 * ## Coverage
 *
 * Bones without an explicit entry fall back to a small region-appropriate shape (see
 * `fallbackShape`). That covers the auditory ossicles and some of the carpals and phalanges, where
 * a simple form meets the Phase 1 quality bar -- a person familiar with anatomy should recognize
 * each bone and judge the proportions credible, which for a stapes at this scale is a very low
 * bar. It is recorded as a known limitation rather than presented as modelled.
 *
 * ## Provenance
 *
 * ADR-009, CONTRIBUTING rule 5. Proportions come from Drillis & Contini (1966) via the layout
 * module, from published anatomical description, or are declared simplifications. **Nothing here
 * is measured off mesh geometry.**
 */

import type { GeometryRecipe, ScalarExpr, TransformExpr } from '@bs-humany/hsdl';
import { mul } from '@bs-humany/hsdl';
import type { BoneRegion } from '@bs-humany/hsdl';
import {
  NO_ROTATION,
  arc,
  longBone,
  placed,
  placedRotated,
  placedRotated2,
  plate,
  shortBone,
  times,
  vaultWedge,
  vertebra,
} from './helpers.js';
import {
  H,
  HEIGHT,
  SEGMENT,
  VERTEBRA_HEIGHT,
  halfPelvis,
  halfShoulders,
  vertebraWidth,
} from './layout.js';

export interface BoneShape {
  readonly restTransform: TransformExpr;
  readonly geometry: GeometryRecipe;
  readonly dimensions: Record<string, ScalarExpr>;
}

const shapes = new Map<string, BoneShape>();

function shape(
  id: string,
  restTransform: TransformExpr,
  geometry: GeometryRecipe,
  dimensions: Record<string, ScalarExpr> = {},
): void {
  shapes.set(id, { restTransform, geometry, dimensions });
}

/** Register the same shape for both sides, mirroring the X component of the rest translation. */
function shapePair(baseId: string, build: (side: 'l' | 'r', sign: 1 | -1) => BoneShape): void {
  shapes.set(`${baseId}_r`, build('r', 1));
  shapes.set(`${baseId}_l`, build('l', -1));
}

/** Signed expression: positive on the right, negative on the left. */
const side = (sign: 1 | -1, expr: ScalarExpr): ScalarExpr => (sign === 1 ? expr : mul(-1, expr));

// =============================================================================================
// Vertebral column
// =============================================================================================

// The sacrum is the root, so its rest transform places the whole skeleton in the world.
shape(
  'sacrum',
  placed(0, H(HEIGHT.sacralPromontory), H(0.015)),
  {
    kind: 'loft',
    capped: true,
    sections: [
      { at: H(-0.075), profile: { kind: 'ellipse', radiusA: H(0.016), radiusB: H(0.01) } },
      { at: H(-0.04), profile: { kind: 'ellipse', radiusA: H(0.032), radiusB: H(0.014) } },
      { at: H(-0.01), profile: { kind: 'ellipse', radiusA: H(0.045), radiusB: H(0.016) } },
      { at: 0, profile: { kind: 'ellipse', radiusA: H(0.038), radiusB: H(0.018) } },
    ],
  },
  { height: H(0.075), width: H(0.09) },
);

shape('coccyx', placed(0, H(-0.082), H(0.012)), shortBone(H(0.022), H(0.007), H(0.004)), {
  length: H(0.022),
});

/**
 * Per-level tilt, producing the three sagittal curves.
 *
 * Rotation about `+X` takes `+Y` toward `+Z`, which is posterior, so a positive tilt is extension.
 * Lumbar lordosis and cervical lordosis are extension; thoracic kyphosis is flexion. A spine built
 * without these reads as a broomstick, and the curves are most of what makes a rendered skeleton
 * look like a person rather than a diagram.
 */
const CURVE_TILT = Object.freeze({ lumbar: 0.042, thoracic: -0.036, cervical: 0.031 });

for (let level = 5; level >= 1; level--) {
  const index = 6 - level; // L5 is index 1, L1 is index 5.
  const width = H(vertebraWidth('lumbar', 6 - index));
  shape(
    `vertebra_l${level}`,
    placedRotated(
      0,
      H(level === 5 ? 0.026 : VERTEBRA_HEIGHT.lumbar),
      0,
      [1, 0, 0],
      CURVE_TILT.lumbar,
    ),
    vertebra({
      bodyWidth: width,
      bodyHeight: H(VERTEBRA_HEIGHT.lumbar * 0.85),
      bodyDepth: times(0.82, width),
      spinousLength: H(0.032),
      transverseLength: H(0.026),
      spinousTilt: 0.1,
    }),
    { bodyWidth: width, bodyHeight: H(VERTEBRA_HEIGHT.lumbar) },
  );
}

for (let level = 12; level >= 1; level--) {
  const width = H(vertebraWidth('thoracic', level));
  shape(
    `vertebra_t${level}`,
    placedRotated(0, H(VERTEBRA_HEIGHT.thoracic), 0, [1, 0, 0], CURVE_TILT.thoracic),
    vertebra({
      bodyWidth: width,
      bodyHeight: H(VERTEBRA_HEIGHT.thoracic * 0.85),
      bodyDepth: times(0.85, width),
      spinousLength: H(0.036),
      transverseLength: H(0.022),
      // Thoracic spinous processes overlap like roof tiles, angling steeply downward.
      spinousTilt: 0.75,
    }),
    { bodyWidth: width, bodyHeight: H(VERTEBRA_HEIGHT.thoracic) },
  );
}

for (let level = 7; level >= 1; level--) {
  const width = H(vertebraWidth('cervical', level));
  const isAtlas = level === 1;
  const isAxis = level === 2;
  shape(
    `vertebra_c${level}`,
    placedRotated(0, H(VERTEBRA_HEIGHT.cervical), 0, [1, 0, 0], CURVE_TILT.cervical),
    isAtlas
      ? // The atlas has no body at all -- it is a ring. Spec section 7.2 warns that C1 and C2 must
        // not be treated as generic vertebrae, and the geometry says so too.
        {
          kind: 'composite',
          parts: [
            {
              name: 'arcus_anterior',
              recipe: arc({
                radius: times(0.5, width),
                startAngle: Math.PI * 0.15,
                endAngle: Math.PI * 1.85,
                segments: 8,
                thickness: H(0.004),
              }),
            },
          ],
        }
      : vertebra({
          bodyWidth: width,
          bodyHeight: H(VERTEBRA_HEIGHT.cervical * 0.8),
          bodyDepth: times(0.75, width),
          // The axis carries the dens, and C7 the long vertebra prominens.
          spinousLength: isAxis ? H(0.024) : level === 7 ? H(0.03) : H(0.018),
          transverseLength: H(0.016),
          spinousTilt: 0.3,
        }),
    { bodyWidth: width, bodyHeight: H(VERTEBRA_HEIGHT.cervical) },
  );
}

// =============================================================================================
// Thoracic cage
// =============================================================================================

/**
 * Rib geometry.
 *
 * Ribs 1 to 7 reach the sternum, 8 to 10 join the cartilage above, and 11 and 12 float. Length and
 * sweep grow to about rib 8 then shrink, which is what gives the thorax its barrel shape.
 */
for (let index = 1; index <= 12; index++) {
  // Peak breadth around rib 8.
  const taper = 1 - ((index - 8) / 8) ** 2 * 0.55;
  const radius = H(0.072 * Math.max(0.35, taper));
  const floating = index >= 11;
  const sweep = floating ? Math.PI * 0.55 : Math.PI * (0.78 + index * 0.02);

  for (const suffix of ['l', 'r'] as const) {
    const sign = suffix === 'r' ? 1 : -1;
    shape(
      `rib_${index}_${suffix}`,
      placed(side(sign, H(0.012)), H(-0.002), H(0.012)),
      arc({
        radius,
        // Sweep from the costovertebral joint posteriorly round to the front. Mirrored for the
        // left side by reversing the sweep direction.
        startAngle: sign === 1 ? Math.PI * 0.42 : Math.PI * 0.58,
        endAngle: sign === 1 ? Math.PI * 0.42 - sweep : Math.PI * 0.58 + sweep,
        segments: 10,
        thickness: H(0.0055),
        drop: H(0.055),
        flatten: 0.82,
      }),
      { arcRadius: radius },
    );
  }
}

shape(
  'sternum',
  // Anterior and slightly inferior to the first rib's vertebral end.
  //
  // The parent is `rib_1_l`, which sits left of the midline by H(0.012) -- the taxonomy has to
  // pick one side for a bilaterally-articulating bone. The offset is therefore **positive**, to
  // bring the sternum back onto the midline. Getting this sign wrong puts the sternum off-centre
  // and drags both clavicles, both scapulae and both arms with it.
  placed(H(0.012), H(-0.03), H(-0.115)),
  {
    kind: 'composite',
    parts: [
      {
        name: 'manubrium',
        recipe: plate(H(0.05), H(0.032), H(0.011)),
        transform: placed(0, H(0.016), 0),
      },
      {
        name: 'corpus',
        recipe: plate(H(0.032), H(0.062), H(0.009)),
        transform: placed(0, H(-0.031), 0),
      },
      {
        name: 'processus_xiphoideus',
        recipe: shortBone(H(0.018), H(0.006), H(0.003)),
        transform: placedRotated(0, H(-0.062), 0, [1, 0, 0], Math.PI),
      },
    ],
  },
  { length: H(0.11) },
);

// =============================================================================================
// Pelvic girdle
// =============================================================================================

shapePair('hip', (_s, sign) => ({
  // Origin at the acetabulum, which is the hip joint centre.
  restTransform: placed(side(sign, halfPelvis), H(HEIGHT.hip - HEIGHT.sacralPromontory), H(-0.01)),
  dimensions: { iliacBreadth: mul(0.5, { param: 'biiliacBreadth' }) },
  geometry: {
    kind: 'composite',
    parts: [
      {
        name: 'ala_ossis_ilii',
        // The iliac blade: broad, thin, flaring up and back from the acetabulum.
        recipe: {
          kind: 'loft',
          capped: true,
          sections: [
            { at: 0, profile: { kind: 'ellipse', radiusA: H(0.016), radiusB: H(0.022) } },
            { at: H(0.045), profile: { kind: 'ellipse', radiusA: H(0.012), radiusB: H(0.042) } },
            { at: H(0.085), profile: { kind: 'ellipse', radiusA: H(0.009), radiusB: H(0.05) } },
            { at: H(0.105), profile: { kind: 'ellipse', radiusA: H(0.007), radiusB: H(0.036) } },
          ],
        },
        transform: placedRotated(side(sign, H(0.004)), H(0.01), H(0.012), [0, 0, 1], sign * 0.22),
      },
      {
        name: 'corpus_ossis_ischii',
        recipe: shortBone(H(0.055), H(0.013), H(0.016)),
        transform: placedRotated(
          side(sign, H(-0.004)),
          H(-0.012),
          H(0.015),
          [1, 0, 0],
          Math.PI * 0.86,
        ),
      },
      {
        name: 'ramus_superior_ossis_pubis',
        recipe: shortBone(H(0.052), H(0.009), H(0.008)),
        transform: placedRotated(
          side(sign, H(-0.01)),
          H(-0.012),
          H(-0.012),
          [0, 1, 0],
          sign * Math.PI * 0.42,
        ),
      },
      {
        name: 'acetabulum',
        recipe: { kind: 'sphere', radius: H(0.0155) },
        transform: placed(0, 0, 0),
      },
    ],
  },
}));

// =============================================================================================
// Lower limb
// =============================================================================================

shapePair('femur', (_s, sign) => ({
  // Origin at the knee joint centre; +Y runs to the hip.
  restTransform: placed(0, mul(-1, SEGMENT.thigh), 0),
  dimensions: { length: SEGMENT.thigh },
  geometry: {
    kind: 'composite',
    parts: [
      {
        name: 'corpus_femoris',
        recipe: longBone({
          length: SEGMENT.thigh,
          shaftRadius: H(0.0155),
          proximalRadius: H(0.026),
          distalRadius: H(0.032),
          // The femoral shaft bows anteriorly. It is the classic example of the feature.
          bow: H(0.009),
          flatten: 0.92,
        }),
      },
      {
        name: 'collum_et_caput_femoris',
        // The neck angles medially and superiorly from the shaft to the head, which sits at the
        // acetabulum. This offset is what produces the femoral valgus that follows from pelvic
        // width, and it is why a wide pelvis gives a larger Q-angle.
        recipe: shortBone(H(0.045), H(0.012)),
        transform: placedRotated(
          side(sign, H(-0.002)),
          times(0.97, SEGMENT.thigh),
          0,
          [0, 0, 1],
          sign * 0.92,
        ),
      },
      {
        name: 'caput_femoris',
        recipe: { kind: 'sphere', radius: H(0.0145) },
        transform: placed(side(sign, H(-0.036)), times(1.0, SEGMENT.thigh), 0),
      },
    ],
  },
}));

shapePair('patella', (_s, sign) => ({
  restTransform: placed(side(sign, H(0.002)), H(0.022), H(-0.036)),
  dimensions: { width: H(0.029) },
  geometry: {
    kind: 'loft',
    capped: true,
    sections: [
      { at: H(-0.018), profile: { kind: 'ellipse', radiusA: H(0.008), radiusB: H(0.006) } },
      { at: 0, profile: { kind: 'ellipse', radiusA: H(0.0145), radiusB: H(0.008) } },
      { at: H(0.014), profile: { kind: 'ellipse', radiusA: H(0.012), radiusB: H(0.007) } },
    ],
  },
}));

shapePair('tibia', () => ({
  // Origin at the ankle joint centre; +Y runs to the knee.
  restTransform: placed(0, mul(-1, SEGMENT.shank), 0),
  dimensions: { length: SEGMENT.shank },
  geometry: longBone({
    length: SEGMENT.shank,
    shaftRadius: H(0.013),
    // The tibial plateau is much broader than the distal end.
    proximalRadius: H(0.028),
    distalRadius: H(0.019),
    flatten: 0.9,
  }),
}));

shapePair('fibula', (_s, sign) => ({
  restTransform: placed(side(sign, H(0.024)), H(-0.012), H(0.004)),
  dimensions: { length: times(0.98, SEGMENT.shank) },
  geometry: longBone({
    length: times(0.98, SEGMENT.shank),
    // The fibula is a slender strut: it carries almost no axial load.
    shaftRadius: H(0.0058),
    proximalRadius: H(0.0105),
    distalRadius: H(0.011),
  }),
}));

// =============================================================================================
// Foot
// =============================================================================================

shapePair('talus', () => ({
  restTransform: placed(0, H(-0.006), 0),
  dimensions: { length: H(0.038) },
  geometry: {
    kind: 'composite',
    parts: [
      { name: 'corpus_tali', recipe: { kind: 'sphere', radius: H(0.018) } },
      {
        name: 'caput_tali',
        recipe: shortBone(H(0.018), H(0.011), H(0.009)),
        transform: placedRotated(0, H(-0.004), H(-0.012), [1, 0, 0], -Math.PI / 2),
      },
    ],
  },
}));

shapePair('calcaneus', () => ({
  restTransform: placed(0, H(-0.02), H(0.022)),
  dimensions: { length: H(0.05) },
  geometry: {
    kind: 'loft',
    capped: true,
    axis: 'z',
    sections: [
      { at: H(-0.026), profile: { kind: 'ellipse', radiusA: H(0.013), radiusB: H(0.013) } },
      { at: 0, profile: { kind: 'ellipse', radiusA: H(0.017), radiusB: H(0.018) } },
      { at: H(0.026), profile: { kind: 'ellipse', radiusA: H(0.015), radiusB: H(0.016) } },
    ],
  },
}));

shapePair('navicular', () => ({
  restTransform: placed(0, H(-0.004), H(-0.03)),
  dimensions: { width: H(0.022) },
  geometry: plate(H(0.024), H(0.016), H(0.009)),
}));

shapePair('cuboid', (_s, sign) => ({
  restTransform: placed(side(sign, H(0.02)), H(-0.006), H(-0.03)),
  dimensions: { width: H(0.019) },
  geometry: plate(H(0.018), H(0.016), H(0.019)),
}));

const CUNEIFORMS = [
  ['cuneiform_medial', -0.014, 0.013],
  ['cuneiform_intermediate', 0, 0.01],
  ['cuneiform_lateral', 0.013, 0.011],
] as const;

for (const [id, offset, width] of CUNEIFORMS) {
  shapePair(id, (_s, sign) => ({
    restTransform: placed(side(sign, H(offset)), H(-0.002), H(-0.018)),
    dimensions: { width: H(width) },
    geometry: plate(H(width), H(0.014), H(0.014)),
  }));
}

// Metatarsals: the first is short and stout, the rest slimmer and longer.
const METATARSAL_LENGTH = [0.052, 0.056, 0.054, 0.05, 0.046] as const;
const METATARSAL_SPREAD = [-0.023, -0.009, 0.004, 0.016, 0.027] as const;

for (let digit = 1; digit <= 5; digit++) {
  const length = METATARSAL_LENGTH[digit - 1] ?? 0.05;
  const spread = METATARSAL_SPREAD[digit - 1] ?? 0;
  shapePair(`metatarsal_${digit}`, (_s, sign) => ({
    restTransform: placedRotated(
      side(sign, H(spread)),
      H(-0.004),
      H(-0.012),
      [1, 0, 0],
      -Math.PI / 2,
    ),
    dimensions: { length: H(length) },
    geometry: longBone({
      length: H(length),
      shaftRadius: H(digit === 1 ? 0.0068 : 0.0045),
      proximalRadius: H(digit === 1 ? 0.0105 : 0.0072),
      distalRadius: H(digit === 1 ? 0.0095 : 0.0062),
    }),
  }));
}

// Toe phalanges. The hallux has two, the others three, matching the taxonomy.
for (let digit = 1; digit <= 5; digit++) {
  const segments =
    digit === 1
      ? ([['proximal', 0.022, 0.0075]] as const)
      : ([
          ['proximal', 0.016, 0.005],
          ['middle', 0.008, 0.0042],
        ] as const);

  for (const [segment, length, radius] of segments) {
    shapePair(`phalanx_pedis_${segment}_${digit}`, () => ({
      restTransform: placed(0, 0, 0),
      dimensions: { length: H(length) },
      geometry: shortBone(H(length), H(radius), H(radius * 0.85)),
    }));
  }

  const distalLength = digit === 1 ? 0.014 : 0.007;
  shapePair(`phalanx_pedis_distal_${digit}`, () => ({
    restTransform: placed(0, H(digit === 1 ? 0.022 : 0.008), 0),
    dimensions: { length: H(distalLength) },
    geometry: shortBone(H(distalLength), H(digit === 1 ? 0.007 : 0.0038), H(0.003)),
  }));
}

// The proximal and middle toe phalanges chain onto the metatarsal head, so they are offset up the
// parent's long axis rather than sitting at its origin.
for (let digit = 2; digit <= 5; digit++) {
  for (const suffix of ['l', 'r'] as const) {
    const proximal = shapes.get(`phalanx_pedis_proximal_${digit}_${suffix}`);
    const middle = shapes.get(`phalanx_pedis_middle_${digit}_${suffix}`);
    const metatarsalLength = METATARSAL_LENGTH[digit - 1] ?? 0.05;
    if (proximal) {
      shapes.set(`phalanx_pedis_proximal_${digit}_${suffix}`, {
        ...proximal,
        restTransform: placed(0, H(metatarsalLength), 0),
      });
    }
    if (middle) {
      shapes.set(`phalanx_pedis_middle_${digit}_${suffix}`, {
        ...middle,
        restTransform: placed(0, H(0.016), 0),
      });
    }
  }
}
for (const suffix of ['l', 'r'] as const) {
  const hallux = shapes.get(`phalanx_pedis_proximal_1_${suffix}`);
  if (hallux) {
    shapes.set(`phalanx_pedis_proximal_1_${suffix}`, {
      ...hallux,
      restTransform: placed(0, H(METATARSAL_LENGTH[0] ?? 0.052), 0),
    });
  }
}

// =============================================================================================
// Shoulder girdle
// =============================================================================================

/** Rotation of the clavicle's long axis from vertical, radians. Close to a right angle. */
const CLAVICLE_TILT = Math.PI * 0.47;
/** Posterior sweep of the clavicle, radians. */
const CLAVICLE_SWEEP = 0.44;

shapePair('clavicle', (_s, sign) => ({
  // Sternal end, running laterally and slightly posteriorly to the acromion.
  // Two rotations. About Z, so the loft's +Y runs laterally; then about Y, so it sweeps
  // posteriorly by about 25 degrees on its way to the acromion -- without that the shoulder joint
  // sits level with the sternum instead of near the coronal plane.
  restTransform: placedRotated2(
    side(sign, H(0.018)),
    H(0.042),
    H(-0.004),
    { axis: [0, 1, 0], angle: -sign * CLAVICLE_SWEEP },
    { axis: [0, 0, 1], angle: -sign * CLAVICLE_TILT },
  ),
  dimensions: { length: mul(0.82, halfShoulders) },
  geometry: {
    kind: 'loft',
    capped: true,
    sections: [
      { at: 0, profile: { kind: 'ellipse', radiusA: H(0.009), radiusB: H(0.008) } },
      {
        at: times(0.35, mul(0.82, halfShoulders)),
        profile: { kind: 'ellipse', radiusA: H(0.0055), radiusB: H(0.006) },
        // The clavicle is S-shaped: convex anteriorly at the medial end, concave laterally.
        offset: { u: 0, v: H(-0.012) },
      },
      {
        at: times(0.72, mul(0.82, halfShoulders)),
        profile: { kind: 'ellipse', radiusA: H(0.0055), radiusB: H(0.006) },
        offset: { u: 0, v: H(0.008) },
      },
      {
        at: mul(0.82, halfShoulders),
        profile: { kind: 'ellipse', radiusA: H(0.009), radiusB: H(0.006) },
      },
    ],
  },
}));

shapePair('scapula', (_s, sign) => ({
  // At the acromion, the clavicle's lateral end.
  //
  // The rotation here **undoes** the clavicle's. The clavicle is rotated roughly 85 degrees about
  // Z so that its own geometry, which is lofted along local +Y, runs laterally. Everything
  // parented to it inherits that rotation, and without this counter-rotation the whole arm chain
  // hangs sideways across the body instead of down. Anything else attached to the clavicle needs
  // the same treatment.
  restTransform: placedRotated2(
    side(sign, H(0.004)),
    mul(0.82, halfShoulders),
    H(0.006),
    { axis: [0, 0, 1], angle: sign * CLAVICLE_TILT },
    { axis: [0, 1, 0], angle: sign * CLAVICLE_SWEEP },
  ),
  dimensions: { width: H(0.09) },
  geometry: {
    kind: 'composite',
    parts: [
      {
        name: 'corpus_scapulae',
        // A thin triangular blade, lying on the posterior thorax.
        recipe: {
          kind: 'loft',
          capped: true,
          axis: 'y',
          sections: [
            { at: H(-0.075), profile: { kind: 'ellipse', radiusA: H(0.008), radiusB: H(0.005) } },
            { at: H(-0.04), profile: { kind: 'ellipse', radiusA: H(0.026), radiusB: H(0.006) } },
            { at: H(-0.006), profile: { kind: 'ellipse', radiusA: H(0.032), radiusB: H(0.0065) } },
          ],
        },
        // Lying flat against the back of the rib cage, angled to follow its curve.
        transform: placedRotated(
          side(sign, H(-0.022)),
          H(-0.012),
          H(0.062),
          [0, 1, 0],
          sign * 0.34,
        ),
      },
      {
        name: 'spina_scapulae',
        recipe: shortBone(H(0.058), H(0.006), H(0.004)),
        transform: placedRotated(
          side(sign, H(-0.022)),
          H(-0.014),
          H(0.05),
          [0, 0, 1],
          sign * Math.PI * 0.52,
        ),
      },
      {
        name: 'acromion',
        recipe: plate(H(0.026), H(0.009), H(0.018)),
        transform: placed(0, H(-0.002), H(0.008)),
      },
      {
        name: 'cavitas_glenoidalis',
        recipe: { kind: 'sphere', radius: H(0.0095) },
        transform: placed(side(sign, H(-0.004)), H(-0.024), H(0.004)),
      },
      {
        name: 'processus_coracoideus',
        recipe: shortBone(H(0.022), H(0.006), H(0.005)),
        transform: placedRotated(
          side(sign, H(-0.02)),
          H(-0.014),
          H(-0.012),
          [1, 0, 0],
          -Math.PI * 0.4,
        ),
      },
    ],
  },
}));

// =============================================================================================
// Upper limb
// =============================================================================================

shapePair('humerus', () => ({
  // Origin at the elbow joint centre; +Y runs to the glenohumeral joint.
  restTransform: placed(0, mul(-1, SEGMENT.upperArm), H(0.004)),
  dimensions: { length: SEGMENT.upperArm },
  geometry: {
    kind: 'composite',
    parts: [
      {
        name: 'corpus_humeri',
        recipe: longBone({
          length: SEGMENT.upperArm,
          shaftRadius: H(0.0125),
          proximalRadius: H(0.0205),
          distalRadius: H(0.0235),
          flatten: 0.94,
        }),
      },
      {
        name: 'caput_humeri',
        recipe: { kind: 'sphere', radius: H(0.0135) },
        transform: placed(0, times(1.0, SEGMENT.upperArm), H(0.004)),
      },
    ],
  },
}));

shapePair('ulna', () => ({
  // Origin at the wrist; +Y runs to the elbow. The olecranon overhangs the elbow joint centre,
  // which is why the proximal end is much the larger.
  restTransform: placed(0, mul(-1, SEGMENT.forearm), 0),
  dimensions: { length: SEGMENT.forearm },
  geometry: longBone({
    length: SEGMENT.forearm,
    shaftRadius: H(0.008),
    proximalRadius: H(0.017),
    distalRadius: H(0.0085),
  }),
}));

shapePair('radius', (_s, sign) => ({
  // Lateral to the ulna. In the anatomical neutral pose the palms face anteriorly, so the radius
  // lies lateral and the forearm is supinated.
  restTransform: placed(side(sign, H(0.019)), H(0.006), 0),
  dimensions: { length: times(0.96, SEGMENT.forearm) },
  geometry: longBone({
    length: times(0.96, SEGMENT.forearm),
    shaftRadius: H(0.0072),
    // The radius is the reverse of the ulna: small head, broad distal end carrying the wrist.
    proximalRadius: H(0.0092),
    distalRadius: H(0.0155),
    bow: H(0.004),
  }),
}));

// --- Carpals ---------------------------------------------------------------------------------
// Eight small blocks in two rows. At the scale a whole skeleton is viewed these read as a wrist
// mass; individually modelling their articular facets is well beyond the Phase 1 quality bar.

const CARPAL_LAYOUT: ReadonlyArray<readonly [string, number, number, number]> = [
  // id, mediolateral offset, vertical offset, size
  ['scaphoid', -0.008, 0.004, 0.0085],
  ['lunate', 0.001, 0.005, 0.0075],
  ['triquetrum', 0.009, 0.004, 0.0065],
  ['pisiform', 0.011, -0.001, 0.0045],
  ['trapezium', -0.012, -0.006, 0.007],
  ['trapezoid', -0.005, -0.005, 0.006],
  ['capitate', 0.002, -0.005, 0.008],
  ['hamate', 0.011, -0.006, 0.0075],
];

for (const [id, lateral, vertical, size] of CARPAL_LAYOUT) {
  shapePair(id, (_s, sign) => ({
    restTransform: placed(side(sign, H(-lateral)), H(vertical - 0.012), 0),
    dimensions: { size: H(size) },
    geometry: plate(H(size), H(size * 0.85), H(size * 0.8)),
  }));
}

// --- Metacarpals and phalanges ---------------------------------------------------------------

const METACARPAL_LENGTH = [0.04, 0.058, 0.056, 0.05, 0.045] as const;
const METACARPAL_SPREAD = [-0.019, -0.009, 0.0, 0.009, 0.018] as const;

for (let digit = 1; digit <= 5; digit++) {
  const length = METACARPAL_LENGTH[digit - 1] ?? 0.05;
  const spread = METACARPAL_SPREAD[digit - 1] ?? 0;
  shapePair(`metacarpal_${digit}`, (_s, sign) => ({
    // Flipped a half turn about X so the hand hangs **downward**.
    //
    // Long bones are authored running from their origin along +Y, which for the arm chain points
    // proximally -- correct for humerus, ulna and radius, whose origins are distal. The hand
    // chains the other way: it continues distally from the wrist, so without this flip the fingers
    // point at the ceiling. Phalanges inherit the flip through the parent chain.
    //
    // The thumb additionally rotates out of the plane of the other four at the saddle joint, which
    // is what makes opposition possible, so it composes two rotations.
    restTransform: placedRotated2(
      side(sign, H(-spread)),
      H(-0.014),
      0,
      { axis: [1, 0, 0], angle: Math.PI },
      { axis: [0, 1, 0], angle: digit === 1 ? sign * 0.55 : 0 },
    ),
    dimensions: { length: H(length) },
    geometry: longBone({
      length: H(length),
      shaftRadius: H(digit === 1 ? 0.0052 : 0.0038),
      proximalRadius: H(0.0068),
      distalRadius: H(0.0062),
    }),
  }));
}

const FINGER_PHALANX: Record<string, readonly [number, number]> = {
  proximal: [0.028, 0.0042],
  middle: [0.017, 0.0036],
  distal: [0.012, 0.003],
};

for (let digit = 1; digit <= 5; digit++) {
  const scale = digit === 1 ? 1.25 : digit === 3 ? 1.05 : digit === 5 ? 0.82 : 1;
  const segments =
    digit === 1 ? (['proximal', 'distal'] as const) : (['proximal', 'middle', 'distal'] as const);

  let offset: ScalarExpr = H(METACARPAL_LENGTH[digit - 1] ?? 0.05);
  for (const segment of segments) {
    const entry = FINGER_PHALANX[segment];
    const length = H((entry?.[0] ?? 0.02) * scale);
    const radius = H((entry?.[1] ?? 0.004) * scale);
    const capturedOffset = offset;
    shapePair(`phalanx_${segment}_${digit}`, () => ({
      restTransform: placed(0, capturedOffset, 0),
      dimensions: { length },
      geometry: shortBone(length, radius, times(0.82, radius)),
    }));
    offset = length;
  }
}

// =============================================================================================
// Skull
// =============================================================================================

/**
 * The cranial vault.
 *
 * Built as four wedges of one ellipsoid -- frontal, two parietals, occipital -- each occupying its
 * own region of the surface. `VAULT` is the shared ellipsoid, expressed relative to the occipital
 * bone's origin, which sits at roughly the foramen magnum.
 */
const VAULT = Object.freeze({
  semiAxes: [H(0.046), H(0.05), H(0.055)] as const,
  centreY: H(0.042),
  centreZ: H(0.012),
});

shape(
  'occipital',
  placed(0, H(0.022), H(0.012)),
  {
    kind: 'composite',
    parts: [
      {
        name: 'squama_occipitalis',
        // The posterior-inferior quarter of the vault.
        recipe: vaultWedge({
          semiAxes: VAULT.semiAxes,
          yFrom: -0.75,
          yTo: 0.25,
          widthScale: 0.96,
          depthScale: 0.5,
          offsetV: H(0.026),
        }),
        transform: placed(0, VAULT.centreY, VAULT.centreZ),
      },
      {
        name: 'pars_basilaris',
        recipe: plate(H(0.03), H(0.008), H(0.026)),
        transform: placed(0, H(0.004), H(-0.016)),
      },
    ],
  },
  { width: H(0.09) },
);

shapePair('parietal', (_s, sign) => ({
  // Upper lateral quadrant of the vault, one each side.
  restTransform: placed(0, 0, 0),
  dimensions: { width: H(0.05) },
  geometry: {
    kind: 'composite',
    parts: [
      {
        name: 'os_parietale',
        recipe: vaultWedge({
          semiAxes: VAULT.semiAxes,
          yFrom: -0.15,
          yTo: 0.98,
          widthScale: 0.56,
          depthScale: 0.94,
          offsetU: side(sign, H(0.019)),
        }),
        transform: placed(0, VAULT.centreY, VAULT.centreZ),
      },
    ],
  },
}));

shapePair('temporal', (_s, sign) => ({
  // Lower lateral wall, below the parietal, carrying the mastoid process and the mandibular fossa.
  restTransform: placed(0, 0, 0),
  dimensions: { width: H(0.034) },
  geometry: {
    kind: 'composite',
    parts: [
      {
        name: 'pars_squamosa',
        recipe: vaultWedge({
          semiAxes: VAULT.semiAxes,
          yFrom: -0.62,
          yTo: -0.05,
          widthScale: 0.36,
          depthScale: 0.62,
          offsetU: side(sign, H(0.026)),
        }),
        transform: placed(0, VAULT.centreY, VAULT.centreZ),
      },
      {
        name: 'processus_mastoideus',
        recipe: shortBone(H(0.018), H(0.008), H(0.005)),
        transform: placedRotated(side(sign, H(0.036)), H(0.014), H(0.018), [1, 0, 0], Math.PI),
      },
    ],
  },
}));

shape(
  'sphenoid',
  placed(0, H(0.018), H(-0.018)),
  {
    kind: 'composite',
    parts: [
      { name: 'corpus', recipe: plate(H(0.03), H(0.016), H(0.018)) },
      {
        name: 'ala_major_r',
        recipe: plate(H(0.026), H(0.026), H(0.006)),
        transform: placed(H(0.026), H(0.006), H(0.002)),
      },
      {
        name: 'ala_major_l',
        recipe: plate(H(0.026), H(0.026), H(0.006)),
        transform: placed(H(-0.026), H(0.006), H(0.002)),
      },
    ],
  },
  { width: H(0.07) },
);

shape(
  'frontal',
  placed(0, 0, 0),
  {
    kind: 'composite',
    parts: [
      {
        name: 'squama_frontalis',
        // The anterior wedge of the vault: the forehead.
        recipe: vaultWedge({
          semiAxes: VAULT.semiAxes,
          yFrom: -0.5,
          yTo: 0.85,
          widthScale: 0.92,
          depthScale: 0.45,
          offsetV: H(-0.03),
        }),
        transform: placed(0, VAULT.centreY, VAULT.centreZ),
      },
      {
        // The supraorbital ridge, one of the more visibly dimorphic skull features: heavier at
        // the male-typical endpoint.
        name: 'arcus_superciliaris',
        recipe: shortBone(H(0.072), { blend: [H(0.006), H(0.0085)] }),
        transform: placedRotated(H(-0.036), H(-0.002), H(-0.04), [0, 0, 1], -Math.PI / 2),
      },
    ],
  },
  { width: H(0.1) },
);

shape('ethmoid', placed(0, H(0.002), H(-0.026)), plate(H(0.018), H(0.02), H(0.022)), {});
shape('vomer', placed(0, H(-0.016), H(0.004)), plate(H(0.004), H(0.018), H(0.02)), {});

shapePair('nasal', (_s, sign) => ({
  restTransform: placed(side(sign, H(0.005)), H(0.002), H(-0.034)),
  dimensions: {},
  geometry: plate(H(0.009), H(0.02), H(0.005)),
}));

shapePair('lacrimal', (_s, sign) => ({
  restTransform: placed(side(sign, H(0.016)), H(0.004), H(-0.028)),
  dimensions: {},
  geometry: plate(H(0.008), H(0.012), H(0.005)),
}));

shapePair('maxilla', (_s, sign) => ({
  restTransform: placed(side(sign, H(0.017)), H(-0.02), H(-0.028)),
  dimensions: { height: H(0.036) },
  geometry: {
    kind: 'composite',
    parts: [
      { name: 'corpus_maxillae', recipe: plate(H(0.026), H(0.032), H(0.028)) },
      {
        name: 'processus_alveolaris',
        recipe: plate(H(0.022), H(0.01), H(0.024)),
        transform: placed(0, H(-0.02), H(0.002)),
      },
    ],
  },
}));

shapePair('zygomatic', (_s, sign) => ({
  restTransform: placed(side(sign, H(0.022)), H(0.012), H(0.008)),
  dimensions: {},
  geometry: plate(H(0.022), H(0.018), H(0.012)),
}));

shapePair('palatine', (_s, sign) => ({
  restTransform: placed(side(sign, H(-0.006)), H(-0.014), H(0.014)),
  dimensions: {},
  geometry: plate(H(0.012), H(0.006), H(0.014)),
}));

shapePair('concha_nasalis_inferior', (_s, sign) => ({
  restTransform: placed(side(sign, H(0.007)), H(-0.018), H(-0.008)),
  dimensions: {},
  geometry: plate(H(0.005), H(0.009), H(0.016)),
}));

shape(
  'mandible',
  // Parented to `temporal_l` by taxonomy convention, since the temporomandibular joints are
  // bilateral. The temporal bone's origin sits on the midline (its geometry is what is offset
  // laterally), so the mandible needs no lateral correction and is built symmetrically about
  // x = 0 rather than about one joint. Its origin is at the level of the temporomandibular joints.
  placed(0, H(0.015), H(0.004)),
  {
    kind: 'composite',
    parts: [
      {
        name: 'corpus_mandibulae',
        // Negative angles: the arc helper puts positive angles at +Z, which is posterior, and
        // the body of the mandible bows forward.
        recipe: arc({
          radius: H(0.05),
          startAngle: -Math.PI * 0.94,
          endAngle: -Math.PI * 0.06,
          segments: 10,
          thickness: H(0.008),
          flatten: 0.86,
        }),
        transform: placed(0, H(-0.03), H(0.012)),
      },
      {
        name: 'ramus_r',
        recipe: plate(H(0.008), H(0.032), H(0.018)),
        transform: placed(H(0.044), H(-0.016), H(0.002)),
      },
      {
        name: 'ramus_l',
        recipe: plate(H(0.008), H(0.032), H(0.018)),
        transform: placed(H(-0.044), H(-0.016), H(0.002)),
      },
      {
        // The chin. Its prominence is another visibly dimorphic feature.
        name: 'protuberantia_mentalis',
        recipe: plate(H(0.02), H(0.014), { blend: [H(0.008), H(0.011)] }),
        transform: placed(0, H(-0.032), H(-0.042)),
      },
    ],
  },
  { width: H(0.09) },
);

// The mandible's origin sits on the midline, so the hyoid needs no lateral offset of its own.
shape('hyoid', placed(0, H(-0.048), H(-0.016)), {
  kind: 'composite',
  parts: [
    {
      name: 'corpus',
      recipe: arc({
        radius: H(0.016),
        startAngle: -Math.PI * 0.85,
        endAngle: -Math.PI * 0.15,
        segments: 6,
        thickness: H(0.003),
      }),
    },
  ],
});

/**
 * Fallback shape for bones with no explicit entry.
 *
 * Currently the auditory ossicles only. At their real size -- the stapes is about three
 * millimetres -- a simple form meets the Phase 1 quality bar comfortably. Recorded as a known
 * limitation rather than presented as modelled.
 */
export function fallbackShape(region: BoneRegion): BoneShape {
  const size = region === 'skull' ? 0.0025 : 0.006;
  return {
    restTransform: placed(0, 0, 0),
    geometry: { kind: 'sphere', radius: H(size) },
    dimensions: { size: H(size) },
  };
}

/** Bones deliberately left to `fallbackShape`, surfaced as a model limitation. */
export const FALLBACK_BONES: readonly string[] = Object.freeze([
  'malleus_l',
  'malleus_r',
  'incus_l',
  'incus_r',
  'stapes_l',
  'stapes_r',
]);

export const BONE_SHAPES: ReadonlyMap<string, BoneShape> = shapes;

export { NO_ROTATION };
