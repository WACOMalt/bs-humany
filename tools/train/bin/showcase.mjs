#!/usr/bin/env node
/**
 * Show the learner: the best policy so far, standing in a body the headset can watch.
 *
 *   pnpm train:showcase            # follows <data>/policies/stand.json as it changes
 *   pnpm train:showcase --recipe tools/train/runs/my-stand-recipe.json   # a named checkpoint, in its scenario
 *
 * A rig like the trainer's, but paced to the wall clock and publishing its bones to the pose
 * bridge every output frame, so `bs-humany-xr-viewer view --follow` shows the current best
 * attempt. When the body falls the episode restarts; when the policy file changes, the next
 * episode uses it. The status file names the generation, so the panel says what is being
 * watched, and the policy's layers go to `<data>/runs/<task>-activity.json` ten times a
 * second for the dashboard's picture of the brain.
 *
 * The status is a `PanelStatus` (`packages/pose-bridge/src/panel.ts`), the contract every
 * publisher and the viewer keep, built in `src/showcaseStatus.ts` where it is typechecked.
 */

import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { policiesDir as policiesHome, runsDir as runsHome } from './home.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const jiti = createJiti(import.meta.url);
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const fps = Number(flag('fps', 90));

const { StandRig, rigOptionsFor, defaultRecipe } = await jiti.import(
  join(ROOT, 'tools/train/src/rig.ts'),
);
const recipePath = flag('recipe', undefined);
const recipe = recipePath
  ? JSON.parse(readFileSync(recipePath, 'utf8'))
  : defaultRecipe(
      flag('task', 'stand'),
      flag('profile', 'l3_anatomical'),
      Number(flag('authority', 0.3)),
    );
const task = recipe.task;
const name = recipe.name;
const policyPath = flag('policy', join(policiesHome(), `${name}.json`));
const activityPath = join(runsHome(), `${name}-activity.json`);
const posePath = join(runsHome(), `${name}-pose.json`);
const { MlpPolicy } = await jiti.import(join(ROOT, 'packages/modules-nerves/src/index.ts'));
const { computeWorldTransforms, buildDocument } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/index.ts'),
);
const { loadSkeletonAssetsFromDisk } = await jiti.import(
  join(ROOT, 'packages/assets-anatomical/src/index.ts'),
);
const { evaluate, param } = await jiti.import(join(ROOT, 'packages/hsdl/src/index.ts'));
const { tissueTable } = await jiti.import(join(ROOT, 'apps/studio/src/tissue.ts'));
const { showcaseStatus } = await jiti.import(join(ROOT, 'tools/train/src/showcaseStatus.ts'));
const {
  openPoseBridge,
  openMuscleBridge,
  claimBridge,
  temporaryName,
  DEFAULT_PATH,
  STATUS_SUFFIX,
  COMMANDS_SUFFIX,
} = await jiti.import(join(ROOT, 'packages/pose-bridge/src/index.ts'));
// The codec states where the bridge lives, once; this only lets --path say otherwise.
const path = flag('path', DEFAULT_PATH);
// Unique to this run, so a viewer that followed the last showcase -- or `pnpm publish:pose`, or
// the studio -- sees a generation it has not seen and reopens the bridges. A constant 1 here
// froze the headset on the old files whenever one showcase replaced another. The wall clock only
// names the run; nothing simulated reads it.
const bridgeGeneration = Date.now();

const rig = await StandRig.build(
  rigOptionsFor(recipe, { hidden: [32, 32], seconds: 30, poseBones: true }),
);
const document = buildDocument();
const assets = await loadSkeletonAssetsFromDisk(join(ROOT, 'packages/assets-anatomical/data'));
const rests = computeWorldTransforms(document, rig.restContext);
const order = rig.boneOrder;
const restPosition = new Float64Array(order.length * 3);
const restOrientation = new Float64Array(order.length * 4);
order.forEach((id, i) => {
  const t = rests.get(id);
  restPosition.set(t ? [t.translation.x, t.translation.y, t.translation.z] : [0, 0, 0], i * 3);
  restOrientation.set(
    t ? [t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w] : [0, 0, 0, 1],
    i * 4,
  );
});
const stature = evaluate(param('stature'), rig.restContext);
// One publisher a path, claimed before anything of the last one is wiped.
claimBridge(path, 'The studio, a showcase or a publisher');
for (const suffix of ['', '.json', '-muscles', '-grab', STATUS_SUFFIX, COMMANDS_SUFFIX])
  rmSync(`${path}${suffix}`, { force: true });
const writer = openPoseBridge(
  {
    bones: order,
    position: restPosition,
    orientation: restOrientation,
    datasetScale: stature / assets.manifest.subjectStature,
  },
  { path },
);
const shape = rig.muscleRings();
const muscleWriter = shape
  ? openMuscleBridge(
      { units: shape.units, rings: shape.rings, segments: shape.segments },
      { path: `${path}-muscles` },
    )
  : undefined;

// Static for the run: the body does not change while a showcase is playing it.
const tissue = tissueTable(rig.articulation);

const posePartial = temporaryName(posePath);
const activityPartial = temporaryName(activityPath);

let loadedAt = 0;
let weights = null;
let meta = {};
function reload() {
  if (!existsSync(policyPath)) return false;
  const mtime = statSync(policyPath).mtimeMs;
  if (mtime === loadedAt) return false;
  try {
    const file = JSON.parse(readFileSync(policyPath, 'utf8'));
    if (file.task !== task) {
      console.log(`policy is for ${file.task}, not ${task}`);
      return false;
    }
    // Fitted by name: a policy from a coarser body plays on this one with what it learned.
    const fitted = MlpPolicy.fit(file, rig.inputNames, rig.outputNames);
    weights = fitted.policy.weights;
    if (fitted.carried.inputs !== rig.inputNames.length) {
      console.log(
        `policy from ${file.profile ?? 'another body'}: ${fitted.carried.inputs} of ${rig.inputNames.length} senses carried`,
      );
    }
    meta = file.trained ?? {};
    loadedAt = mtime;
    console.log(
      `policy: generation ${meta.generations ?? '?'}, fitness ${(meta.fitness ?? 0).toFixed(3)}, ${meta.episodes ?? 0} episodes`,
    );
    return true;
  } catch {
    return false; // mid-write; next time
  }
}
function writeStatus(episode, upFor) {
  const status = showcaseStatus({
    generation: bridgeGeneration,
    name,
    profile: rig.profileId,
    upFor,
    wallSeconds: (performance.now() - started) / 1000,
    stepsPerSecond: 1 / rig.stepSeconds,
    fps,
    training: {
      task: name,
      episode,
      generation: meta.generations ?? 0,
      fitness: meta.fitness ?? 0,
    },
    groundHeight: rig.groundHeight,
    scenery: rig.scenery,
    tissue,
    tension: rig.muscleTension(),
  });
  const tmp = temporaryName(`${path}${STATUS_SUFFIX}`);
  writeFileSync(tmp, JSON.stringify(status));
  renameSync(tmp, `${path}${STATUS_SUFFIX}`);
}
function writePose(time, up) {
  const s = rig.segments();
  writeFileSync(
    posePartial,
    JSON.stringify({
      time,
      up,
      parents: s.parents,
      ids: s.ids,
      position: Array.from(s.position, (v) => Number(v.toFixed(3))),
    }),
  );
  renameSync(posePartial, posePath);
}
function writeActivity(time, up) {
  const a = rig.activity();
  writeFileSync(
    activityPartial,
    JSON.stringify({
      task,
      time,
      up,
      generation: meta.generations ?? 0,
      layers: a.layers.map((l) => Array.from(l, (v) => Number(v.toFixed(3)))),
      outputs: a.outputs,
    }),
  );
  renameSync(activityPartial, activityPath);
}

console.log(`showcasing ${name} from ${policyPath} -> ${path} at ${fps} poses/s; Ctrl-C to stop`);
while (!reload()) {
  console.log('  waiting for a policy file');
  await new Promise((r) => setTimeout(r, 2000));
}
const started = performance.now();
// The rig's own step: an L3 body runs at a thousand a second, an L1 at five hundred.
const dt = rig.stepSeconds;
const ticksPerFrame = Math.max(1, Math.round(1 / dt / fps));
let episode = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (;;) {
  reload();
  episode += 1;
  // A different floor every episode, as training gets: watching one policy meet the same
  // disturbance over and over says less than watching it meet a new one.
  rig.begin(weights, episode);
  const episodeStart = performance.now();
  let ticks = 0;
  let lastStatus = 0;
  let lastActivity = 0;
  let lastPose = 0;
  let result = { time: 0, up: true };
  for (;;) {
    const wall = (performance.now() - episodeStart) / 1000;
    let ran = 0;
    while (ticks * dt < wall && ran < ticksPerFrame) {
      result = rig.tick();
      ticks += 1;
      ran += 1;
    }
    if (ran > 0 && ticks % ticksPerFrame < ran) {
      const bones = rig.boneTransforms();
      writer.publish(ticks, ticks * dt, bones.position, bones.orientation);
      const rings = muscleWriter ? rig.muscleRings() : undefined;
      if (rings && muscleWriter) {
        muscleWriter.publish(
          ticks,
          rings.buffers.position,
          rings.buffers.orientation,
          rings.buffers.radius,
        );
      }
    }
    const now = performance.now();
    if (now - lastStatus > 100) {
      writeStatus(episode, result.time);
      lastStatus = now;
    }
    if (now - lastActivity > 100) {
      writeActivity(result.time, result.up);
      lastActivity = now;
    }
    if (now - lastPose > 50) {
      writePose(result.time, result.up);
      lastPose = now;
    }
    if (!result.up || result.time > 30) break;
    await sleep(ran === 0 ? 1 : 0);
  }
  writePose(result.time, false);
  console.log(
    `  episode ${episode}: up for ${result.time.toFixed(2)} s (generation ${meta.generations ?? 0})`,
  );
  // A moment on the floor, so the fall can be seen, then again from the top.
  await sleep(1200);
}
