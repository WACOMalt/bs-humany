#!/usr/bin/env node
/**
 * Benchmark suite -- milestone M3.19.
 *
 * ms per step by profile x backend x physics rate, on the standing-collapse scenario, written as
 * a committed table to docs/validation/benchmarks.md. Feeds the ADR-003 reassessment: the numbers
 * say whether Rapier still earns its place as the interactive default.
 *
 * Run: pnpm bench
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const jiti = createJiti(import.meta.url);

const { resolveMorphology } = await jiti.import(join(ROOT, 'packages/anthropometry/src/index.ts'));
const { compileArticulation } = await jiti.import(join(ROOT, 'packages/compiler/src/index.ts'));
const { buildDocument } = await jiti.import(join(ROOT, 'packages/skeleton/src/index.ts'));
const { Kernel } = await jiti.import(join(ROOT, 'packages/kernel/src/index.ts'));
const { PhysicsModule, PassiveJointModule, SkeletonPoseModule, MetricsModule } = await jiti.import(
  join(ROOT, 'packages/modules-mechanics/src/index.ts'),
);
const { RapierBackend } = await jiti.import(join(ROOT, 'packages/backend-rapier/src/index.ts'));
const { MujocoBackend } = await jiti.import(join(ROOT, 'packages/backend-mujoco/src/index.ts'));

const PROFILES = ['l0_ragdoll', 'l1_standard', 'l2_biomechanical', 'l3_anatomical'];
const BACKENDS = { rapier: () => new RapierBackend(), mujoco: () => new MujocoBackend() };
const RATES = [240, 500, 1000];
const SECONDS = 2;

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const rows = [];

for (const profileId of PROFILES) {
  const { articulation } = compileArticulation(document, profileId, morphology);
  const lifted = {
    ...articulation,
    segments: articulation.segments.map((s) => ({
      ...s,
      restWorld: {
        translation: { ...s.restWorld.translation, y: s.restWorld.translation.y + 0.3 },
        rotation: s.restWorld.rotation,
      },
    })),
  };
  for (const [name, make] of Object.entries(BACKENDS)) {
    for (const rate of RATES) {
      const kernel = new Kernel({ rateHz: rate, seed: 1, preferShared: false });
      const physics = new PhysicsModule(make(), lifted, { ground: { height: 0 } });
      kernel.register(physics);
      kernel.register(new PassiveJointModule(lifted));
      kernel.register(new SkeletonPoseModule(document.bones, lifted));
      kernel.register(new MetricsModule(lifted));
      await kernel.init();
      const ticks = SECONDS * rate;
      // Warm up, then time.
      kernel.run(Math.round(rate / 10));
      const started = performance.now();
      kernel.run(ticks);
      const ms = performance.now() - started;
      kernel.dispose();
      const perStep = ms / ticks;
      rows.push({
        profile: profileId,
        backend: name,
        rate,
        segments: lifted.segments.length,
        nv: lifted.nv,
        perStep,
        realtime: 1000 / (perStep * rate),
      });
      console.log(
        `${profileId} ${name} ${rate} Hz: ${perStep.toFixed(3)} ms/step, ${(1000 / (perStep * rate)).toFixed(1)}x real time`,
      );
    }
  }
}

const lines = [
  '# Benchmarks',
  '',
  'Milestone M3.19. Milliseconds per kernel tick (physics, passive joints, skeleton pose and',
  'metrics modules) on the standing-collapse drop, two simulated seconds after a warm-up, by',
  'fidelity profile, backend and physics rate. "Real time" is how many times faster than wall',
  'clock the tick rate runs. Regenerate with `pnpm bench`; commit the result with the change that',
  'motivated it.',
  '',
  `Generated ${new Date().toISOString().slice(0, 10)} on ${process.platform}-${process.arch}, Node ${process.version}.`,
  '',
  '| Profile | Backend | Rate (Hz) | Bodies | nv | ms / step | Real time |',
  '|---|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.profile} | ${r.backend} | ${r.rate} | ${r.segments} | ${r.nv} | ${r.perStep.toFixed(3)} | ${r.realtime.toFixed(1)}x |`,
  ),
  '',
];
writeFileSync(join(ROOT, 'docs/validation/benchmarks.md'), `${lines.join('\n')}`);
console.log('wrote docs/validation/benchmarks.md');
