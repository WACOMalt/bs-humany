#!/usr/bin/env node
/**
 * Run a scenario headlessly and publish its body pose for a renderer to pick up.
 *
 *   pnpm publish:pose                       # the default scenario, 144 poses a second
 *   pnpm publish:pose quiet-standing --fps 90 --profile l3_anatomical --seconds 30
 *
 * This is the simulation end of ADR-012. It ticks the simulation at its own pace -- life speed
 * when the machine can manage it, slower when it cannot -- and writes a pose to the bridge every
 * output frame's worth of *simulated* time. It never waits for anybody to read one. A renderer
 * that is faster than this redraws the pose it has; one that is slower skips some. Neither is
 * this process's concern, and that is the design.
 *
 * ## Pacing
 *
 * The loop keeps simulated time up with the wall clock when it can, and falls behind without
 * complaint when it cannot: each turn it ticks until it has caught up or has done one output
 * frame's worth, publishes if a frame boundary was crossed, and yields. So a fast profile runs at
 * life speed with idle time to spare, and a slow one runs in slow motion at whatever rate it can
 * sustain -- which a headset shows as a slow body in a perfectly tracked room, per ADR-012.
 *
 * The status line says which of those is happening: simulated seconds against wall seconds, and
 * their ratio, which is 1.00 when it is keeping up.
 */

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
const scenarioId = args.find(
  (a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'),
);
const fps = Number(flag('fps', 144));
const profileId = flag('profile', 'l1_standard');
const seconds = Number(flag('seconds', Number.POSITIVE_INFINITY));
const path = flag('path', '/dev/shm/bs-humany-pose');

const { resolveMorphology } = await jiti.import(join(ROOT, 'packages/anthropometry/src/index.ts'));
const { buildDocument, computeWorldTransforms } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/index.ts'),
);
const { loadSkeletonAssetsFromDisk } = await jiti.import(
  join(ROOT, 'packages/assets-anatomical/src/index.ts'),
);
const { evaluate, param } = await jiti.import(join(ROOT, 'packages/hsdl/src/index.ts'));
const { Simulation } = await jiti.import(join(ROOT, 'apps/studio/src/simulation.ts'));
const { scenario, DEFAULT_SCENARIO } = await jiti.import(
  join(ROOT, 'packages/scenarios/src/index.ts'),
);
const { PoseBridgeWriter, GrabIntentReader } = await jiti.import(
  join(ROOT, 'packages/pose-bridge/src/index.ts'),
);

const document = buildDocument();
const assets = await loadSkeletonAssetsFromDisk(join(ROOT, 'packages/assets-anatomical/data'));
const chosen = scenario(scenarioId ?? DEFAULT_SCENARIO);
const morphology = resolveMorphology(chosen.morphology);

const simulation = new Simulation(document, morphology, {
  profileId,
  backend: 'mujoco',
  passiveJoints: chosen.passiveJoints,
  redistribute: true,
  scenario: chosen,
  dropHeight: chosen.clearance,
  groundHeight: chosen.ground.height,
  muscles: chosen.muscles === true,
  outputFramerate: fps,
});
await simulation.start();

// The rest pose the pack's vertices are relative to, in the order the pose channel uses.
const order = simulation.boneOrder();
const rests = computeWorldTransforms(document, simulation.resolved.context);
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
const stature = evaluate(param('stature'), simulation.resolved.context);
const writer = PoseBridgeWriter.open(
  {
    bones: order,
    position: restPosition,
    orientation: restOrientation,
    datasetScale: stature / assets.manifest.subjectStature,
  },
  { path },
);

console.log(
  `publishing ${chosen.id} on ${profileId} at ${simulation.stepsPerSecond} steps/s, ` +
    `${fps} poses/s, ${order.length} bones -> ${path}`,
);
console.log(`  muscles ${simulation.muscles ? 'on' : 'off'}; Ctrl-C to stop`);

// Per bone, in `boneOrder()` -- what the studio skins from. Not `body.pose`, which is per rigid
// segment in the segment order: the same numbers, differently arranged, and a skeleton that was
// fed them came out as a scatter of vertebrae.
const pose = simulation.boneTransforms();
if (pose.position.length !== order.length * 3 || pose.orientation.length !== order.length * 4) {
  throw new Error(
    `bone transforms hold ${pose.position.length / 3} bones and the order names ${order.length}`,
  );
}
const ticksPerFrame = simulation.ticksPerOutputFrame;

// Grabs, coming the other way. The renderer writes a slot per hand beside the pose bridge; this
// reads both every tick and does what the studio's Ctrl-click does: find the segment the bone
// belongs to, express the grabbed point in that segment's own frame, and hold it toward wherever
// the hand is now. One grab at a time, because the grab module holds one; a second hand that
// squeezes while the first is holding is ignored until the first lets go.
let grabs = GrabIntentReader.open(`${path}-grab`);
let held = null;
let grabsSeen = 0;
function applyGrabs() {
  if (!grabs) {
    grabs = GrabIntentReader.open(`${path}-grab`);
    if (!grabs) return;
    console.log('  hands: a renderer is writing grab intents');
  }
  const hands = grabs.read();
  for (let hand = 0; hand < hands.length; hand++) {
    const intent = hands[hand];
    if (!intent) continue;
    if (intent.active) {
      if (held === null && intent.bone >= 0 && intent.bone < order.length) {
        const segment = simulation.segmentOfBone(order[intent.bone]);
        if (segment < 0) continue;
        const at = simulation.segmentPose(segment);
        const [px, py, pz] = intent.point;
        // The grabbed point in the segment's frame: its offset from the segment's position,
        // rotated back by the inverse of the segment's orientation -- what `beginGrab` does.
        const dx = px - at.position.x;
        const dy = py - at.position.y;
        const dz = pz - at.position.z;
        const { x, y, z, w } = at.rotation;
        // conj(q) * v * q, expanded.
        const ix = w * dx - y * dz + z * dy;
        const iy = w * dy - z * dx + x * dz;
        const iz = w * dz - x * dy + y * dx;
        const iw = x * dx + y * dy + z * dz;
        const local = {
          x: ix * w + iw * x - iy * z + iz * y,
          y: iy * w + iw * y - iz * x + ix * z,
          z: iz * w + iw * z - ix * y + iy * x,
        };
        const [tx, ty, tz] = intent.target;
        simulation.grab.grab(segment, local, { x: tx, y: ty, z: tz }, intent.strength || 1);
        held = { hand, segment, bone: order[intent.bone] };
        grabsSeen += 1;
      } else if (held !== null && held.hand === hand) {
        const [tx, ty, tz] = intent.target;
        simulation.grab.moveTo({ x: tx, y: ty, z: tz });
      }
    } else if (held !== null && held.hand === hand) {
      simulation.grab.release();
      held = null;
    }
  }
}
let nextPublishAt = 0;
const started = performance.now();
let lastReport = started;
let ticksAtReport = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

while (simulation.ticks * simulation.dt < seconds) {
  const wall = (performance.now() - started) / 1000;
  // Catch up with the clock, but by no more than one output frame per turn: if the machine
  // cannot keep up, this is what lets the loop fall behind gracefully rather than spin.
  let ran = 0;
  while (simulation.ticks * simulation.dt < wall && ran < ticksPerFrame) {
    applyGrabs();
    simulation.tick();
    ran += 1;
  }
  if (simulation.ticks >= nextPublishAt) {
    writer.publish(
      simulation.ticks,
      simulation.ticks * simulation.dt,
      pose.position,
      pose.orientation,
    );
    nextPublishAt += ticksPerFrame;
  }
  if (ran === 0) {
    // Ahead of the clock. A millisecond is the finest a timer reliably gives, and it is well
    // under a frame at any output rate anybody would choose.
    await sleep(1);
  } else {
    await new Promise(setImmediate);
  }

  const now = performance.now();
  if (now - lastReport >= 1000) {
    const simSeconds = simulation.ticks * simulation.dt;
    const wallSeconds = (now - started) / 1000;
    const speed =
      ((simulation.ticks - ticksAtReport) * simulation.dt) / ((now - lastReport) / 1000);
    console.log(
      `  sim ${simSeconds.toFixed(2)} s  wall ${wallSeconds.toFixed(2)} s  ` +
        `${speed.toFixed(2)}x life  ${writer.framesPublished} poses published` +
        (held ? `  holding ${held.bone}` : grabsSeen ? `  ${grabsSeen} grabs so far` : ''),
    );
    lastReport = now;
    ticksAtReport = simulation.ticks;
  }
}

writer.close();
simulation.dispose();
console.log(
  `done: ${writer.framesPublished} poses over ${(simulation.ticks * simulation.dt).toFixed(2)} s`,
);
