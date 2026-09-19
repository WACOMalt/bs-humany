#!/usr/bin/env node
/**
 * Show the learner: the best policy so far, standing in a body the headset can watch.
 *
 *   pnpm train:showcase            # follows packages/modules-nerves/policies/stand.json as it changes
 *
 * A rig like the trainer's, but paced to the wall clock and publishing its bones to the pose
 * bridge every output frame, so `bs-humany-xr-viewer view --follow` shows the current best
 * attempt. When the body falls the episode restarts; when the policy file changes, the next
 * episode uses it. The status file names the generation, so the panel says what is being
 * watched, and the policy's layers go to `tools/train/runs/<task>-activity.json` ten times a
 * second for the dashboard's picture of the brain.
 */

import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const jiti = createJiti(import.meta.url);
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const task = flag('task', 'stand');
const path = flag('path', '/dev/shm/bs-humany-pose');
const fps = Number(flag('fps', 90));
const policyPath = flag('policy', join(ROOT, 'packages/modules-nerves/policies', `${task}.json`));
const activityPath = join(ROOT, 'tools/train/runs', `${task}-activity.json`);
const posePath = join(ROOT, 'tools/train/runs', `${task}-pose.json`);

const { StandRig } = await jiti.import(join(ROOT, 'tools/train/src/rig.ts'));
const { MlpPolicy } = await jiti.import(join(ROOT, 'packages/modules-nerves/src/index.ts'));
const { computeWorldTransforms, buildDocument } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/index.ts'),
);
const { loadSkeletonAssetsFromDisk } = await jiti.import(
  join(ROOT, 'packages/assets-anatomical/src/index.ts'),
);
const { evaluate, param } = await jiti.import(join(ROOT, 'packages/hsdl/src/index.ts'));
const { openPoseBridge } = await jiti.import(join(ROOT, 'packages/pose-bridge/src/index.ts'));

const rig = await StandRig.build({
  profileId: 'l1_standard',
  hidden: [32, 32],
  seconds: 30,
  controlDivisor: 5,
  authority: 0.5,
  clip: task === 'walk' ? 'walk-normal' : 'quiet-standing',
  poseBones: true,
});
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
for (const suffix of ['', '.json', '-muscles', '-grab', '-status.json', '-commands.jsonl'])
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

let loadedAt = 0;
let weights = null;
let meta = {};
function reload() {
  if (!existsSync(policyPath)) return false;
  const mtime = statSync(policyPath).mtimeMs;
  if (mtime === loadedAt) return false;
  try {
    const file = JSON.parse(readFileSync(policyPath, 'utf8'));
    if (file.sizes.join('x') !== rig.sizes.join('x')) {
      console.log(`policy ${file.sizes.join('x')} does not fit this rig ${rig.sizes.join('x')}`);
      return false;
    }
    weights = MlpPolicy.fromFile(file).weights;
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
  const status = {
    generation: 1,
    scenario: {
      id: `training-${task}`,
      title: `Training: ${task}, generation ${meta.generations ?? 0}`,
    },
    scenarios: [],
    profiles: [],
    profile: 'l1_standard',
    simSeconds: upFor,
    wallSeconds: (performance.now() - started) / 1000,
    speed: 1,
    paused: false,
    muscles: false,
    holding: [],
    grabStrength: 1,
    settings: {},
    driveGroups: [],
    diagnostics: {
      kinetic: 0,
      potential: 0,
      driftMm: 0,
      limitsWorst: 0,
      violations: 0,
      contacts: 0,
      costMs: 0,
    },
    groundHeight: 0,
    staticBoxes: [],
    training: { task, episode, generation: meta.generations ?? 0, fitness: meta.fitness ?? 0 },
  };
  writeFileSync(`${path}-status.json.tmp`, JSON.stringify(status));
  renameSync(`${path}-status.json.tmp`, `${path}-status.json`);
}
function writePose(time, up) {
  const s = rig.segments();
  writeFileSync(
    `${posePath}.tmp`,
    JSON.stringify({
      time,
      up,
      parents: s.parents,
      ids: s.ids,
      position: Array.from(s.position, (v) => Number(v.toFixed(3))),
    }),
  );
  renameSync(`${posePath}.tmp`, posePath);
}
function writeActivity(time, up) {
  const a = rig.activity();
  writeFileSync(
    `${activityPath}.tmp`,
    JSON.stringify({
      task,
      time,
      up,
      generation: meta.generations ?? 0,
      layers: a.layers.map((l) => Array.from(l, (v) => Number(v.toFixed(3)))),
      outputs: a.outputs,
    }),
  );
  renameSync(`${activityPath}.tmp`, activityPath);
}

console.log(`showcasing ${task} from ${policyPath} -> ${path} at ${fps} poses/s; Ctrl-C to stop`);
while (!reload()) {
  console.log('  waiting for a policy file');
  await new Promise((r) => setTimeout(r, 2000));
}
const started = performance.now();
const dt = 1 / 500;
const ticksPerFrame = Math.max(1, Math.round(500 / fps));
let episode = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (;;) {
  reload();
  episode += 1;
  rig.begin(weights);
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
    }
    const now = performance.now();
    if (now - lastStatus > 250) {
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
