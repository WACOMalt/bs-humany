#!/usr/bin/env node
/**
 * Benchmark suite -- milestones M3.19 and M5.11.
 *
 * Milliseconds per kernel tick for the bodies this project actually runs, on MuJoCo, written into
 * the marked region of docs/validation/benchmarks.md. The skeleton-only rows are what fed the
 * ADR-003 reassessment of 2026-09-13, which made MuJoCo the only enabled backend; Rapier was
 * deleted outright on 2026-09-26 and its last figures are kept in the report as history, outside
 * the region this script writes.
 *
 * Run: pnpm bench
 *
 * What is measured, and why each body is built the way it is:
 *
 * - Skeleton only: the golden runner (`runScenario`) on the drop-standing-collapse scenario, at
 *   each profile and at that profile's own solver rate. It used to build its own kernel and lift
 *   the body by hand, which made it a fourth copy of the scenario assembly and one that nothing
 *   else ran; the runner is the copy the goldens and the plausibility suite use.
 * - Full body: the runner again on the two L3 muscle scenarios, and the training rig
 *   (`StandRig`) with the recipe module's default cord, with and without the posed bones and the
 *   swept bellies. Without them it is what the trainer and the dashboard run; with them it is
 *   what the studio and the showcase run. The rig is built from its own code rather than copied,
 *   so this is not a third hand-written registration list that can drift from the other two.
 * - Where the time goes: every module's own `step`, timed inside every tick of every full-body
 *   row, so the breakdown is of the same run as the whole-tick figure beside it.
 * - Recompile and restore (M5.6, spec 14.5 item 9).
 *
 * The report is hand-written except between `<!-- bench:start -->` and `<!-- bench:end -->`, and
 * this script writes only there. It used to rewrite the whole top of the file, which is how the
 * analysis kept below it came to be at risk every time somebody reran it; with the markers the
 * prose on either side is never touched. A report without both markers, in order, is refused
 * rather than guessed at.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const REPORT = join(ROOT, 'docs/validation/benchmarks.md');
const START = '<!-- bench:start -->';
const END = '<!-- bench:end -->';

// Checked before anything is measured: the full run takes a minute or two, and finding out at the
// end of it that there is nowhere to put the result would waste all of it.
const previous = readFileSync(REPORT, 'utf8');
const startAt = previous.indexOf(START);
const endAt = previous.indexOf(END);
if (
  startAt < 0 ||
  endAt < 0 ||
  endAt < startAt ||
  previous.indexOf(START, startAt + 1) >= 0 ||
  previous.indexOf(END, endAt + 1) >= 0
) {
  console.error(
    `bench: docs/validation/benchmarks.md must hold exactly one ${START} followed by exactly one ${END}.\n` +
      'The script writes only between them, so that the analysis around them is never overwritten. ' +
      'Restore the markers (git checkout docs/validation/benchmarks.md) and run it again.',
  );
  process.exit(1);
}

const jiti = createJiti(import.meta.url);

const { resolveMorphology } = await jiti.import(join(ROOT, 'packages/anthropometry/src/index.ts'));
const { compileArticulation, transferJointState, allocateBuffers } = await jiti.import(
  join(ROOT, 'packages/compiler/src/index.ts'),
);
const { buildDocument } = await jiti.import(join(ROOT, 'packages/skeleton/src/index.ts'));
const { Kernel } = await jiti.import(join(ROOT, 'packages/kernel/src/index.ts'));
const { MujocoBackend } = await jiti.import(join(ROOT, 'packages/backend-mujoco/src/index.ts'));
const { scenario } = await jiti.import(join(ROOT, 'packages/scenarios/src/index.ts'));
const { runScenario } = await jiti.import(join(ROOT, 'packages/testkit/src/index.ts'));
const { StandRig, defaultRecipe, rigOptionsFor, DEFAULT_AUTHORITY } = await jiti.import(
  join(ROOT, 'tools/train/src/rig.ts'),
);

// ---------------------------------------------------------------------------------------------
// The clocks

/**
 * Each module's time, kept by wrapping its `step` as it is registered.
 *
 * Patched onto the kernel here, in the bench, and nowhere else: simulation code may not read a
 * wall clock (CONTRIBUTING rule 3), and a timer that shipped in the kernel would be one every
 * caller paid for. Every rig, scenario run and studio-shaped body in this process registers
 * through this one `Kernel` class -- jiti loads each source file once, and every package imports
 * the kernel from the same file -- so wrapping the prototype catches all of them without any of
 * them knowing. Each registration gets its own slot, which the wrapper closes over, so a tick
 * looks nothing up and allocates nothing.
 */
let slots = [];
const register = Kernel.prototype.register;
Kernel.prototype.register = function timedRegister(module) {
  const slot = { id: module.manifest.id, ms: 0 };
  const step = module.step;
  module.step = function timedStep(ctx) {
    const started = performance.now();
    step.call(this, ctx);
    slot.ms += performance.now() - started;
  };
  slots.push(slot);
  return register.call(this, module);
};

/** The whole tick, for the rows the runner does not time itself. */
const tick = { ms: 0, count: 0 };
const kernelStep = Kernel.prototype.step;
Kernel.prototype.step = function timedKernelStep() {
  const started = performance.now();
  kernelStep.call(this);
  tick.ms += performance.now() - started;
  tick.count += 1;
};

/** Start a new body: the slots of the last one are dropped rather than added to. */
function freshSlots() {
  slots = [];
}

/** Zero every clock after a warm-up, so the timed ticks are the only ones counted. */
function zeroClocks() {
  for (const slot of slots) slot.ms = 0;
  tick.ms = 0;
  tick.count = 0;
}

/** Each module's ms per tick, summed over modules registered under the same id. */
function perModule(ticks) {
  const out = new Map();
  for (const slot of slots) out.set(slot.id, (out.get(slot.id) ?? 0) + slot.ms / ticks);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Skeleton only

const PROFILES = ['l0_ragdoll', 'l1_standard', 'l2_biomechanical', 'l3_anatomical'];

/**
 * One run through the golden runner: the scenario at its own duration and its profile's own
 * solver rate. The runner times `kernel.step` and nothing else -- not the scenario's script and
 * not its sampling -- which is the number wanted.
 */
async function runnerRow(label, built) {
  freshSlots();
  const trajectory = await runScenario(new MujocoBackend(), built);
  const rate = Math.round(1 / trajectory.dt);
  const perTick = trajectory.stepMs / trajectory.ticks;
  return {
    label,
    profile: trajectory.profileId,
    rate,
    bodies: trajectory.articulation.segments.length,
    nv: trajectory.articulation.nv,
    ticks: trajectory.ticks,
    perTick,
    realtime: 1000 / (perTick * rate),
    modules: perModule(trajectory.ticks),
  };
}

// The first body built in a process pays for loading MuJoCo's wasm and for the JIT's first look
// at every module; a short throwaway run of each kind puts that cost where no row sees it.
await runScenario(new MujocoBackend(), scenario('drop-standing-collapse'), { maxTicks: 200 });
await runScenario(new MujocoBackend(), scenario('quiet-standing'), { maxTicks: 200 });

const skeletonRows = [];
for (const profileId of PROFILES) {
  const row = await runnerRow(profileId, {
    ...scenario('drop-standing-collapse'),
    profileId,
  });
  skeletonRows.push(row);
  console.log(
    `skeleton ${profileId} ${row.rate} Hz: ${row.perTick.toFixed(3)} ms/tick, ${row.realtime.toFixed(1)}x real time`,
  );
}

// ---------------------------------------------------------------------------------------------
// Full body

/** Simulated seconds each rig row is timed for, after a tenth of a second's warm-up. */
const SECONDS = 2;

/**
 * The rig as the trainer or the studio builds it, from the recipe module's own default recipe --
 * which carries the measured cord, `DEFAULT_REFLEX`, and the quiet-standing clip under the brain
 * -- so the cord here is the one every run gets unless it asks for another (owner decision of
 * 2026-09-26: the measured cord everywhere).
 *
 * The weights are zero, which is the studio's brain before one is handed over: the policy is
 * evaluated at its control rate like a trained one, so it costs what a trained one costs, but it
 * commands nothing, so what the body does is the clip and the cord rather than a random brain.
 */
async function rigRow(label, profileId, poseBones) {
  freshSlots();
  const recipe = defaultRecipe('stand', profileId, DEFAULT_AUTHORITY);
  const rig = await StandRig.build(
    rigOptionsFor(recipe, { hidden: [32, 32], seconds: SECONDS, poseBones }),
  );
  rig.begin(new Float32Array(rig.parameterCount), 1);
  const rate = rig.stepsPerSecond;
  for (let i = 0; i < Math.round(rate / 10); i++) rig.tick();
  zeroClocks();
  const ticks = SECONDS * rate;
  for (let i = 0; i < ticks; i++) rig.tick();
  const perTick = tick.ms / tick.count;
  const row = {
    label,
    profile: profileId,
    rate,
    bodies: rig.articulation.segments.length,
    nv: rig.articulation.nv,
    ticks,
    perTick,
    realtime: 1000 / (perTick * rate),
    modules: perModule(tick.count),
  };
  rig.dispose();
  return row;
}

const fullRows = [];
const report = (row) => {
  fullRows.push(row);
  console.log(
    `full ${row.label} ${row.profile} ${row.rate} Hz: ${row.perTick.toFixed(3)} ms/tick, ${row.realtime.toFixed(2)}x real time`,
  );
};
report(await rigRow('Studio', 'l3_anatomical', true));
report(await rigRow('Trainer', 'l3_anatomical', false));
report(await runnerRow('quiet-standing', scenario('quiet-standing')));
report(await runnerRow('clip-flail-arms', scenario('clip-flail-arms')));
report(await rigRow('Studio', 'l2_biomechanical', true));
report(await rigRow('Studio', 'l1_standard', true));

// The breakdown has to add up to the tick it breaks down, or it is describing some other run.
// What lies between them is the kernel's own work -- zeroing the accumulators, walking the
// schedule -- and the timer's, which should both be a few per cent at most.
for (const row of fullRows) {
  let sum = 0;
  for (const ms of row.modules.values()) sum += ms;
  row.moduleSum = sum;
  const gap = Math.abs(row.perTick - sum) / row.perTick;
  if (gap > 0.05) {
    console.warn(
      `bench: ${row.label} ${row.profile}: the modules sum to ${sum.toFixed(3)} ms of a ${row.perTick.toFixed(3)} ms tick (${(gap * 100).toFixed(1)}% apart)`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Recompile and restore (M5.6): compile the same profile at a new stature, and place a fresh
// backend at the running one's joint state.

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const restoreRows = [];
for (const profileId of ['l1_standard', 'l2_biomechanical']) {
  const from = compileArticulation(document, profileId, morphology).articulation;
  const to = compileArticulation(
    document,
    profileId,
    resolveMorphology({ sex: 0.5, stature: 1.8, mass: 75 }),
  ).articulation;
  const running = new MujocoBackend();
  await running.init({ dt: 1 / 500, iterations: 8, ground: { height: 0 } });
  await running.compile(from);
  for (let i = 0; i < 200; i++) running.step(1);
  const buffers = allocateBuffers(from);
  running.readJointState(buffers.jointState);
  const started = performance.now();
  const fresh = new MujocoBackend();
  await fresh.init({ dt: 1 / 500, iterations: 8, ground: { height: 0 } });
  await fresh.compile(to);
  const { q, qdot } = transferJointState(
    { model: from, q: buffers.jointState.q, qdot: buffers.jointState.qdot },
    to,
  );
  fresh.writeJointState(q, qdot);
  const ms = performance.now() - started;
  running.dispose();
  fresh.dispose();
  restoreRows.push({ profile: profileId, ms });
  console.log(`recompile-and-restore ${profileId}: ${ms.toFixed(1)} ms`);
}

// ---------------------------------------------------------------------------------------------
// The report

/** Milliseconds as the tables print them: to the microsecond. */
const fixed3 = (x) => x.toFixed(3);

/** Module ids, first seen first, with the studio's L3 body leading so its order is the table's. */
const moduleIds = [];
for (const row of fullRows) {
  for (const id of row.modules.keys()) if (!moduleIds.includes(id)) moduleIds.push(id);
}
/** Every module id carries the project's reverse-DNS prefix; the table leaves it off. */
const MODULE_PREFIX = 'bsums.xyz.bs-humany.';
const columnName = (r) => `${r.label}, ${r.profile.slice(0, 2).toUpperCase()}`;
const baseline = fullRows[0];

const lines = [
  START,
  '',
  `Generated ${new Date().toISOString().slice(0, 10)} on ${process.platform}-${process.arch}, Node ${process.version}.`,
  '',
  '## Skeleton only',
  '',
  'The golden runner on `drop-standing-collapse` at each profile and its own solver rate: physics,',
  'grab, metrics, coupling and passive joints, no muscles.',
  '',
  '| Profile | Rate (Hz) | Bodies | nv | Ticks | ms / tick | Real time |',
  '|---|---|---|---|---|---|---|',
  ...skeletonRows.map(
    (r) =>
      `| ${r.profile} | ${r.rate} | ${r.bodies} | ${r.nv} | ${r.ticks} | ${fixed3(r.perTick)} | ${r.realtime.toFixed(1)}x |`,
  ),
  '',
  '## Full body',
  '',
  '`Studio` is the training rig with the bones posed and the bellies swept, as the studio and the',
  'showcase run it; `Trainer` is the same rig without them, as training and the dashboard run it.',
  "Both carry the recipe module's default cord and a zero policy under the quiet-standing clip.",
  "The two scenario rows are the golden runner: muscles and the scenario's own script, no cord.",
  '',
  '| Body | Profile | Rate (Hz) | Bodies | nv | Ticks | ms / tick | Real time |',
  '|---|---|---|---|---|---|---|---|',
  ...fullRows.map(
    (r) =>
      `| ${r.label} | ${r.profile} | ${r.rate} | ${r.bodies} | ${r.nv} | ${r.ticks} | ${fixed3(r.perTick)} | ${r.realtime.toFixed(2)}x |`,
  ),
  '',
  `Headless baseline for the studio's frame cost: ${fixed3(baseline.perTick)} ms per tick at L3 (${baseline.rate} Hz), the first row.`,
  '',
  '## Where the time goes, by module',
  '',
  "Milliseconds per tick of each module's own `step`, in the same runs as the table above, by",
  `module id less its \`${MODULE_PREFIX}\` prefix. A module that runs one tick in several is`,
  'averaged over all of them, so its cost here is what it adds to the average tick.',
  '',
  `| Module | ${fullRows.map(columnName).join(' | ')} |`,
  `|---|${fullRows.map(() => '---').join('|')}|`,
  ...moduleIds.map(
    (id) =>
      `| \`${id.replace(MODULE_PREFIX, '')}\` | ${fullRows.map((r) => (r.modules.has(id) ? fixed3(r.modules.get(id)) : '')).join(' | ')} |`,
  ),
  `| Sum of the modules | ${fullRows.map((r) => fixed3(r.moduleSum)).join(' | ')} |`,
  `| Whole tick | ${fullRows.map((r) => fixed3(r.perTick)).join(' | ')} |`,
  '',
  '## Recompile and restore',
  '',
  'Spec 14.5 item 9. Milliseconds to compile the same profile at a new morphology, build a fresh',
  'backend, transfer the running joint state by joint id and place the new body there (M5.6).',
  'Excludes the WASM module load, which happens once per session.',
  '',
  '| Profile | ms |',
  '|---|---|',
  ...restoreRows.map((r) => `| ${r.profile} | ${r.ms.toFixed(1)} |`),
  '',
  END,
];

writeFileSync(
  REPORT,
  `${previous.slice(0, startAt)}${lines.join('\n')}${previous.slice(endAt + END.length)}`,
);
console.log('wrote the marked region of docs/validation/benchmarks.md');
