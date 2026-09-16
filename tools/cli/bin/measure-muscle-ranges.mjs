#!/usr/bin/env node
/**
 * How long each muscle gets, over the range of the joints it crosses.
 *
 *   pnpm measure:muscle-ranges          # rewrite packages/muscle-data/src/ranges.ts
 *   pnpm measure:muscle-ranges --check  # fail if the file is not what this would write
 *
 * A muscle's tendon is fitted at compile time so the fibers sit in a usable part of their own
 * force-length curve (`fittedTendonSlack`). Fitting needs to know what part of the curve the
 * muscle will actually use, and that is this: the shortest and longest its path gets as the joints
 * it crosses go through their range.
 *
 * ## Why it is measured here rather than worked out there
 *
 * The length of a path at a pose is a question for the path solver, which needs a physics backend
 * to place the bones. A compile step has neither, and giving it both to answer one question per
 * muscle would be the wrong shape entirely. So it is measured once, offline, against the same
 * skeleton the muscles are authored on, and written down with the rule beside it -- the same
 * arrangement as the wrap radii and the articular centres.
 *
 * ## What is measured, and what it costs
 *
 * Each crossed coordinate is swept through its own range with the others at neutral, except the
 * ones the skeleton couples to it, which follow. The extremes over all of them are taken. For a muscle crossing one joint that is exact. For one
 * crossing two -- rectus femoris over the hip and the knee, gastrocnemius over the knee and the
 * ankle -- the true extremes are at a *combination* of angles, and sweeping one at a time finds a
 * narrower range than the muscle really has. The error is in the safe direction: a narrower range
 * fits the fibers into a smaller band than they need, which costs a little of the curve rather
 * than putting the muscle outside it.
 *
 * ## Coupled coordinates follow the one being swept
 *
 * A shoulder does not elevate with its scapula held still. The skeleton says so -- the girdle's
 * angles are fixed fractions of glenohumeral elevation, the shoulder rhythm, and the patella's
 * angle is a polynomial in knee flexion -- and those couplings are constraints the physics solves
 * rather than kinematics the pose carries, so writing one coordinate and leaving the rest at
 * neutral quietly asks for a pose no body holds.
 *
 * What that cost was measurable. Swept with the scapula pinned, the anterior deltoid travelled
 * 77 mm against the 46 the same muscle travels on the model its parameters come from, and the
 * fibre translation that reads this asked for a 164 mm fibre in a 190 mm muscle. The two models
 * have the *same* shoulder ranges to the degree -- ours were taken from that one -- so the
 * difference was never range of motion. It was 180 degrees of elevation carried entirely by the
 * glenohumeral joint.
 *
 * So each coupling whose driver is the coordinate being swept is applied as the sweep goes.
 *
 * Lengths are stored as ratios of the muscle's own length at the rest pose, not in metres, so
 * they carry across a change of stature: every path in this skeleton scales with it, so the ratio
 * does not.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(ROOT, 'packages/muscle-data/src/ranges.ts');
const check = process.argv.includes('--check');

/** Angles sampled across each coordinate's range, ends included. */
const SAMPLES = 9;

const jiti = createJiti(import.meta.url);
const { resolveMorphology } = await jiti.import(join(ROOT, 'packages/anthropometry/src/index.ts'));
const { MujocoBackend } = await jiti.import(join(ROOT, 'packages/backend-mujoco/src/index.ts'));
const { compileArticulation, allocateBuffers } = await jiti.import(
  join(ROOT, 'packages/compiler/src/index.ts'),
);
const { Kernel } = await jiti.import(join(ROOT, 'packages/kernel/src/index.ts'));
const mechanics = await jiti.import(join(ROOT, 'packages/modules-mechanics/src/index.ts'));
const muscleData = await jiti.import(join(ROOT, 'packages/muscle-data/src/index.ts'));
const { buildDocument } = await jiti.import(join(ROOT, 'packages/skeleton/src/index.ts'));
const modules = await jiti.import(join(ROOT, 'packages/modules-muscle/src/index.ts'));

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l3_anatomical', morphology);
const groups = [
  ...muscleData.ELBOW_MUSCLES,
  ...muscleData.SHOULDER_MUSCLES,
  ...muscleData.KNEE_MUSCLES,
  ...muscleData.HIP_MUSCLES,
];
const muscles = modules.compileMuscleSet(
  groups,
  document.attachmentSites,
  articulation,
  morphology.context,
  document.wrappingSurfaces ?? [],
);

const backend = new MujocoBackend();
const kernel = new Kernel({ rateHz: 500, seed: 1 });
// Gravity off and the pose imposed every tick: what is wanted is the length of a path at a pose,
// not what a body would do if left at it.
//
// No dynamics module either, and that is the point rather than an economy. A path's length at a
// pose is geometry, and geometry is all this may depend on: the tendon fit reads what is measured
// here, so a measurement that moved when a muscle's force changed would be a loop -- fit, measure,
// refit -- with a different answer every time round. Without the dynamics module no muscle exerts
// anything, the imposed pose is the pose that is measured, and the same skeleton gives the same
// numbers whatever the force parameters say.
kernel.register(
  new mechanics.PhysicsModule(backend, articulation, { gravity: { x: 0, y: 0, z: 0 } }),
);
kernel.register(new modules.MusclePathModule(articulation, muscles));
const moment = new modules.MuscleMomentModule(articulation, muscles);
kernel.register(moment);
await kernel.init();

const buffers = allocateBuffers(articulation);
backend.readJointState(buffers.jointState);
const q = buffers.jointState.q;
const qdot = buffers.jointState.qdot;
qdot.fill(0);
const neutral = Float64Array.from(q);
const ROOT_NQ = 7;
const path = kernel.channels.storage(modules.MUSCLE_PATH).fields;

/** Hold the current pose for long enough that the path module has solved at it. */
function settle() {
  for (let tick = 0; tick < 4; tick++) {
    backend.writeJointState(q, qdot);
    kernel.run(1);
  }
}

// Which coordinates each unit crosses: the moment module already works this out, and works it out
// the same way the moment arms are reported, so the two cannot disagree about what a muscle spans.
const crossed = new Map();
for (const pair of moment.pairs) {
  if (!crossed.has(pair.unitId)) crossed.set(pair.unitId, []);
  crossed.get(pair.unitId).push(pair.dof);
}

settle();
const rest = Float64Array.from(path.length);
const minimum = Float64Array.from(rest);
const maximum = Float64Array.from(rest);

/**
 * Every coordinate that follows another, and the polynomial it follows it by.
 *
 * `offset + c1 x + c2 x^2 + c3 x^3 + c4 x^4`, which is how the compiler carries a coupling: one
 * coefficient and up to three higher powers. Only single-driver couplings are here, which is all
 * this skeleton has.
 */
const followers = [];
for (const constraint of articulation.constraints) {
  const { kind } = constraint;
  if (kind.type !== 'jointCoupling') continue;
  const driver = kind.drivers[0];
  if (kind.drivers.length !== 1 || driver === undefined) continue;
  followers.push({ dependent: kind.dependent, driver: driver.dof, ...driver, offset: kind.offset });
}

/** Put every coordinate that follows this one where the coupling puts it. */
function follow(dof, value) {
  for (const f of followers) {
    if (f.driver !== dof) continue;
    const [a, b, c] = f.higher ?? [0, 0, 0];
    q[ROOT_NQ + f.dependent] =
      f.offset + f.coefficient * value + a * value ** 2 + b * value ** 3 + c * value ** 4;
  }
}

const dofs = [...new Set([...crossed.values()].flat())].sort((a, b) => a - b);
for (const dof of dofs) {
  const range = articulation.dofs[dof]?.range;
  if (!range) continue;
  for (let i = 0; i < SAMPLES; i++) {
    q.set(neutral);
    const value = range[0] + ((range[1] - range[0]) * i) / (SAMPLES - 1);
    q[ROOT_NQ + dof] = value;
    follow(dof, value);
    settle();
    for (let unit = 0; unit < muscles.units.length; unit++) {
      // Only for the muscles that cross this coordinate: another muscle's length at this pose is
      // the same as at neutral, and recording it would be recording nothing.
      if (!(crossed.get(muscles.units[unit].id) ?? []).includes(dof)) continue;
      const length = path.length[unit];
      if (length < minimum[unit]) minimum[unit] = length;
      if (length > maximum[unit]) maximum[unit] = length;
    }
  }
}
q.set(neutral);
settle();
kernel.dispose();

const round = (v) => Number(v.toPrecision(6));
const rows = muscles.units.map((unit, i) => ({
  id: unit.id,
  shortest: round(minimum[i] / rest[i]),
  longest: round(maximum[i] / rest[i]),
  joints: (crossed.get(unit.id) ?? [])
    .map((dof) => {
      const d = articulation.dofs[dof];
      return `${articulation.joints[d.joint].id}/${d.axisName}`;
    })
    .join(', '),
}));

/**
 * One `crosses:` line, wrapped where the formatter would wrap it.
 *
 * The generated file has to be what `biome format` would leave behind, or the lint gate and the
 * `--check` gate disagree forever: one rewrites the file and the other then says the measurement
 * is stale. A shoulder muscle crossing five coordinates names them all, which runs past the
 * hundred columns biome is configured for, and biome breaks after the key when it does.
 */
const LINE_WIDTH = 100;
const crossesLine = (joints) => {
  const single = `    crosses: '${joints}',`;
  return single.length <= LINE_WIDTH ? single : `    crosses:\n      '${joints}',`;
};

const body = rows
  .map(
    (r) => `  {
    unit: '${r.id}',
    shortest: ${r.shortest},
    longest: ${r.longest},
${crossesLine(r.joints)}
  },`,
  )
  .join('\n');

const rendered = `/**
 * How long each muscle gets over the range of the joints it crosses.
 *
 * **Generated by \`pnpm measure:muscle-ranges\`. Do not edit.**
 *
 * Measured on this skeleton with the path solver, by sweeping each crossed coordinate through its
 * own range with the others at neutral and taking the extremes. What it is for is the tendon fit
 * in \`compileMuscleSet\`: a tendon slack length decides which part of its force-length curve a
 * muscle's fibers work over, and fitting that without knowing how far the muscle travels leaves
 * it against one end of the curve. The knee flexors were the case that showed it -- fitted to the
 * rest pose, which is the one where they are longest, their fibers ran down to a third of optimal
 * by deep flexion and made almost no force there, so a fully driven leg stopped bending at 84
 * degrees.
 *
 * Ratios of each muscle's own length at the rest pose, not metres, so they survive a change of
 * stature: every path here scales with it and the ratio does not.
 *
 * A muscle crossing two joints has its true extremes at a combination of angles, and sweeping one
 * coordinate at a time finds a narrower range than it really has. The error is in the safe
 * direction -- a narrower range fits the fibers into a smaller band than they need, which costs a
 * little of the curve rather than putting the muscle outside it.
 */

export interface MuscleLengthRange {
  readonly unit: string;
  /** Shortest the path gets, as a fraction of its length at the rest pose. */
  readonly shortest: number;
  /** Longest it gets, likewise. */
  readonly longest: number;
  /** The coordinates it crosses, as the moment module names them. */
  readonly crosses: string;
}

export const MUSCLE_LENGTH_RANGES: readonly MuscleLengthRange[] = [
${body}
];

/** One unit's range, or undefined for a unit nothing has measured. */
export function muscleLengthRange(unit: string): MuscleLengthRange | undefined {
  return MUSCLE_LENGTH_RANGES.find((r) => r.unit === unit);
}
`;

const existing = (() => {
  try {
    return readFileSync(OUT, 'utf8');
  } catch {
    return undefined;
  }
})();

if (check) {
  if (existing !== rendered) {
    console.error(
      `measure-muscle-ranges: ${relative(ROOT, OUT)} is not what the measurement would write.\n` +
        '  Run `pnpm measure:muscle-ranges`. If the geometry changed, say so in the commit.',
    );
    process.exit(1);
  }
  console.log(`measure-muscle-ranges: ok. ${rows.length} units match this skeleton.`);
} else {
  writeFileSync(OUT, rendered);
  console.log(
    `measure-muscle-ranges: wrote ${relative(ROOT, OUT)} -- ${rows.length} units over ` +
      `${dofs.length} coordinates.`,
  );
  const widest = [...rows].sort((a, b) => b.longest - b.shortest - (a.longest - a.shortest))[0];
  if (widest) {
    console.log(
      `  widest: ${widest.id} from ${(widest.shortest * 100).toFixed(1)}% to ` +
        `${(widest.longest * 100).toFixed(1)}% of its rest length`,
    );
  }
}
