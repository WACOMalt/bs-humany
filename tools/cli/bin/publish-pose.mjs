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
 *
 * ## The files beside the poses
 *
 * `<path>` is the pose ring; `<path>-muscles` the belly rings; `<path>-grab` what the hands are
 * holding, written by the renderer. Two more make the renderer's panel possible:
 *
 * - `<path>-status.json`, rewritten here four times a second by writing a temporary file and
 *   renaming it, so a reader never sees half of one: which scenario, how far along, how fast,
 *   paused or not, what is held, and which scenarios there are to choose from.
 * - `<path>-commands.jsonl`, appended to by the renderer one JSON object a line, read from here
 *   from wherever the last read stopped: `pause`, `resume`, `reset`, `step` with `frames`,
 *   `scrub` with `seconds`, `drive` with a muscle `group` and a slider `value`, and `set` with a
 *   `key` and `value` for everything the studio's panel sets -- scenario, profile, muscles,
 *   morphology, drop height, rates, gravity, floor, grab strength. Settings that change the
 *   articulation rebuild the simulation and every bridge file and bump `generation` in the
 *   status so the renderer knows to reopen them; the rest apply in place.
 */

import { fstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
const scenarioArg = args.find(
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
const { scenario, SCENARIOS, DEFAULT_SCENARIO, MUSCLE_GROUPS, driveForSlider } = await jiti.import(
  join(ROOT, 'packages/scenarios/src/index.ts'),
);
const { openPoseBridge, openMuscleBridge, GrabIntentReader } = await jiti.import(
  join(ROOT, 'packages/pose-bridge/src/index.ts'),
);

const document = buildDocument();
const assets = await loadSkeletonAssetsFromDisk(join(ROOT, 'packages/assets-anatomical/data'));

const PROFILES = ['l0_ragdoll', 'l1_standard', 'l2_biomechanical', 'l3_anatomical'];
const DEFAULT_PROPORTIONS = { crural: 1.004, brachial: 0.785, relativeLegLength: 1 };

/**
 * Everything the panel can set. `null` means "the scenario's own", which is what the studio's
 * controls start at too. The ones marked as rebuilding change the articulation and so take a
 * fresh simulation; the others apply to the running one.
 */
const settings = {
  scenario: scenarioArg ?? DEFAULT_SCENARIO,
  profile: profileId,
  muscles: null, // rebuild; null = as the scenario says
  sex: null, // rebuild, the morphology
  stature: null,
  mass: null,
  crural: null,
  brachial: null,
  legLength: null,
  dropHeight: null, // rebuild
  passive: null, // rebuild
  redistribute: true, // rebuild
  fps, // rebuild
  stepsPerSecond: null, // rebuild; null = the profile's own
  gravity: true, // live
  floor: true, // live
};
const REBUILDS = new Set([
  'scenario',
  'profile',
  'muscles',
  'sex',
  'stature',
  'mass',
  'crural',
  'brachial',
  'legLength',
  'dropHeight',
  'passive',
  'redistribute',
  'fps',
  'stepsPerSecond',
]);
/** Slider positions, 0..100, one a muscle group; kept across rebuilds. */
const drives = MUSCLE_GROUPS.map(() => 0);
/** The studio's mapping: squared, so the first few per cent of drive get a usable stretch. */

/** The morphology a build uses: the scenario's, with whatever the panel overrode. */
function effectiveMorphology(chosen) {
  const base = chosen.morphology;
  const proportions = { ...DEFAULT_PROPORTIONS, ...(base.proportions ?? {}) };
  return {
    sex: settings.sex ?? base.sex,
    stature: settings.stature ?? base.stature,
    mass: settings.mass ?? base.mass,
    proportions: {
      crural: settings.crural ?? proportions.crural,
      brachial: settings.brachial ?? proportions.brachial,
      relativeLegLength: settings.legLength ?? proportions.relativeLegLength,
    },
  };
}

/** Build a simulation for the current settings and open the bridge files it publishes into. */
async function build() {
  const chosen = scenario(settings.scenario);
  const morphology = resolveMorphology(effectiveMorphology(chosen));
  const simulation = new Simulation(document, morphology, {
    profileId: settings.profile,
    backend: 'mujoco',
    passiveJoints: settings.passive ?? chosen.passiveJoints,
    redistribute: settings.redistribute,
    scenario: chosen,
    dropHeight: settings.dropHeight ?? chosen.clearance,
    groundHeight: chosen.ground.height,
    // As the studio does: a scenario that drives muscles gets them whatever the box says.
    muscles:
      settings.muscles === null
        ? chosen.muscles === true
        : settings.muscles || chosen.muscles === true,
    ...(settings.stepsPerSecond !== null ? { stepsPerSecond: settings.stepsPerSecond } : {}),
    outputFramerate: settings.fps,
  });
  await simulation.start();
  if (!settings.gravity) simulation.setGravity(false);
  if (!settings.floor) simulation.setGroundCollision(false);
  applyDrives(simulation);

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
  const writer = openPoseBridge(
    {
      bones: order,
      position: restPosition,
      orientation: restOrientation,
      datasetScale: stature / assets.manifest.subjectStature,
    },
    { path },
  );
  // The muscles go beside the bones as rings, when there are any: eight floats a ring, which the
  // viewer sweeps into tubes itself.
  const rings = simulation.muscleRings();
  const muscleWriter = rings
    ? openMuscleBridge(
        { units: rings.units, rings: rings.rings, segments: rings.segments },
        { path: `${path}-muscles` },
      )
    : undefined;
  // A scenario without muscles must not leave the last one's rings behind for a viewer that
  // reopens the files to find and draw, frozen.
  if (!rings) rmSync(`${path}-muscles`, { force: true });
  // Per bone, in `boneOrder()` -- what the studio skins from. Not `body.pose`, which is per rigid
  // segment in the segment order: the same numbers, differently arranged, and a skeleton that was
  // fed them came out as a scatter of vertebrae.
  const pose = simulation.boneTransforms();
  if (pose.position.length !== order.length * 3 || pose.orientation.length !== order.length * 4) {
    throw new Error(
      `bone transforms hold ${pose.position.length / 3} bones and the order names ${order.length}`,
    );
  }
  console.log(
    `publishing ${chosen.id} on ${settings.profile} at ${simulation.stepsPerSecond} steps/s, ` +
      `${settings.fps} poses/s, ${order.length} bones -> ${path}`,
  );
  console.log(
    rings
      ? `  muscles on: ${rings.units} bellies of ${rings.rings} rings -> ${path}-muscles`
      : '  muscles off',
  );
  return {
    chosen,
    simulation,
    order,
    writer,
    muscleWriter,
    rings,
    pose,
    ticksPerFrame: simulation.ticksPerOutputFrame,
  };
}

function applyDrives(simulation) {
  const drive = simulation.muscleDrive;
  if (!drive) return;
  MUSCLE_GROUPS.forEach((group, i) => {
    const level = driveForSlider(drives[i]);
    for (const unit of group.units) drive.setOverride(unit, level);
  });
}

/** Every file a session leaves on tmpfs: wiped at start and at the end, so nothing of the last
 * session is ever mistaken for this one. */
function clearBridgeFiles() {
  for (const suffix of ['', '.json', '-muscles', '-grab', '-status.json', '-commands.jsonl']) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}
clearBridgeFiles();

let generation = 1;
let live = await build();
console.log('  Ctrl-C to stop');

// ---------------------------------------------------------------------------------------------
// Grabs, coming the other way: read every tick, applied by the same code the studio uses.
// ---------------------------------------------------------------------------------------------
const { GrabIntents } = await jiti.import(join(ROOT, 'apps/studio/src/grabIntents.ts'));
let grabs = GrabIntentReader.open(`${path}-grab`);
const intents = new GrabIntents();
let grabStrength = 1;

function applyGrabs() {
  if (!grabs) {
    grabs = GrabIntentReader.open(`${path}-grab`);
    if (!grabs) return;
    console.log('  hands: a renderer is writing grab intents');
  }
  intents.apply(live.simulation, live.order, grabs.read(), grabStrength);
}

function letGo() {
  intents.letGo(live.simulation);
}

// ---------------------------------------------------------------------------------------------
// The panel's two files: status out, commands in.
// ---------------------------------------------------------------------------------------------
let paused = false;
let started = performance.now();
let nextPublishAt = 0;

function writeStatus() {
  const { simulation, chosen } = live;
  const simSeconds = simulation.ticks * simulation.dt;
  const status = {
    generation,
    scenario: { id: chosen.id, title: chosen.title },
    scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title })),
    profile: settings.profile,
    simSeconds,
    wallSeconds: (performance.now() - started) / 1000,
    speed: lastSpeed,
    paused,
    muscles: Boolean(live.rings),
    holding: intents.holding(),
    grabStrength,
    stepsPerSecond: simulation.stepsPerSecond,
    fps: settings.fps,
    profiles: PROFILES,
    settings: {
      ...settings,
      ...effectiveMorphologyFlat(chosen),
      muscles: Boolean(live.rings),
      musclesForced: settings.muscles === null,
      dropHeight: settings.dropHeight ?? chosen.clearance,
      passive: settings.passive ?? chosen.passiveJoints,
      stepsPerSecond: simulation.stepsPerSecond,
    },
    driveGroups: MUSCLE_GROUPS.map((g, i) => ({ title: g.title, level: drives[i] })),
    // The scenery, which the viewer has no other way to know: the ground's height and every
    // static box, in the simulation's frame.
    // Each unit's tendon force as a fraction of its maximum, for whatever tints muscles.
    tension: muscleTension(simulation),
    groundHeight: chosen.ground.height,
    staticBoxes: (chosen.staticBoxes ?? []).map((b) => ({
      halfExtents: [b.halfExtents.x, b.halfExtents.y, b.halfExtents.z],
      position: [b.position.x, b.position.y, b.position.z],
      rotation: b.rotation
        ? [b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w]
        : [0, 0, 0, 1],
    })),
    diagnostics: diagnostics(simulation),
  };
  const tmp = `${path}-status.json.tmp`;
  writeFileSync(tmp, JSON.stringify(status));
  renameSync(tmp, `${path}-status.json`);
}

function muscleTension(simulation) {
  const state = simulation.muscleState();
  const units = simulation.muscles?.units;
  if (!state || !units) return [];
  return units.map((u, i) => {
    const maximum = u.parameters.maxIsometricForce;
    return Number((maximum > 0 ? (state.tendonForce[i] ?? 0) / maximum : 0).toFixed(3));
  });
}

function effectiveMorphologyFlat(chosen) {
  const m = effectiveMorphology(chosen);
  return {
    sex: m.sex,
    stature: m.stature,
    mass: m.mass,
    crural: m.proportions.crural,
    brachial: m.proportions.brachial,
    legLength: m.proportions.relativeLegLength,
  };
}

/** The studio's diagnostics strip, as numbers. */
function diagnostics(simulation) {
  const energy = simulation.channel('diagnostics.energy').fields;
  const limits = simulation.channel('diagnostics.limits').fields;
  const contacts = simulation.channel('contact.manifolds');
  let worst = 0;
  let violations = 0;
  const proximity = limits.proximity;
  const violation = limits.violation;
  for (let i = 0; i < proximity.length; i++) {
    worst = Math.max(worst, proximity[i] ?? 0);
    violations += violation[i] ?? 0;
  }
  return {
    kinetic: energy.kinetic[0] ?? 0,
    potential: energy.potential[0] ?? 0,
    driftMm: (energy.drift[0] ?? 0) * 1000,
    limitsWorst: worst,
    violations,
    contacts: contacts.count,
    costMs: simulation.lastStepMs,
  };
}

let commandsFd;
let commandsOffset = 0;
let commandsTail = '';
const commandsBuffer = Buffer.alloc(4096);

async function readCommands() {
  if (commandsFd === undefined) {
    try {
      commandsFd = openSync(`${path}-commands.jsonl`, 'r');
      console.log('  panel: a renderer is sending commands');
    } catch {
      return;
    }
  }
  // A renderer that restarted truncated the file; start over from its beginning.
  if (fstatSync(commandsFd).size < commandsOffset) {
    commandsOffset = 0;
    commandsTail = '';
  }
  for (;;) {
    const got = readSync(commandsFd, commandsBuffer, 0, commandsBuffer.length, commandsOffset);
    if (got <= 0) break;
    commandsOffset += got;
    commandsTail += commandsBuffer.toString('utf8', 0, got);
    let newline = commandsTail.indexOf('\n');
    while (newline >= 0) {
      const line = commandsTail.slice(0, newline).trim();
      commandsTail = commandsTail.slice(newline + 1);
      if (line) await command(line);
      newline = commandsTail.indexOf('\n');
    }
  }
}

/** Line the pacing clock up with the simulation's time, after a jump. */
function realign() {
  const now = performance.now();
  started = now - live.simulation.ticks * live.simulation.dt * 1000;
  if (paused) pausedAt = now;
  nextPublishAt = live.simulation.ticks;
}

async function rebuild(why) {
  letGo();
  live.writer.close();
  live.muscleWriter?.close();
  live.simulation.dispose();
  console.log(`  panel: ${why}, rebuilding`);
  live = await build();
  generation += 1;
  realign();
}

/** One frame's worth of ticks, for stepping while paused. */
function stepForward() {
  const { simulation, ticksPerFrame } = live;
  for (let i = 0; i < ticksPerFrame; i++) {
    applyGrabs();
    simulation.tick();
  }
}

async function command(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    console.log(`  panel: not a command: ${line}`);
    return;
  }
  switch (parsed.kind) {
    case 'set': {
      const { key, value } = parsed;
      if (key === 'grabStrength') {
        if (Number.isFinite(Number(value)) && Number(value) > 0) grabStrength = Number(value);
        break;
      }
      if (!(key in settings)) {
        console.log(`  panel: no setting ${key}`);
        break;
      }
      if (key === 'scenario' && !SCENARIOS.some((s) => s.id === value)) {
        console.log(`  panel: no scenario ${value}`);
        break;
      }
      if (key === 'profile' && !PROFILES.includes(value)) {
        console.log(`  panel: no profile ${value}`);
        break;
      }
      if (settings[key] === value) break;
      settings[key] = value;
      if (REBUILDS.has(key)) {
        await rebuild(`${key} = ${JSON.stringify(value)}`);
      } else if (key === 'gravity') {
        live.simulation.setGravity(Boolean(value));
      } else if (key === 'floor') {
        live.simulation.setGroundCollision(Boolean(value));
      }
      break;
    }
    case 'drive': {
      const group = Number(parsed.group);
      const value = Math.max(0, Math.min(100, Number(parsed.value)));
      if (
        Number.isInteger(group) &&
        group >= 0 &&
        group < drives.length &&
        Number.isFinite(value)
      ) {
        drives[group] = value;
        applyDrives(live.simulation);
      }
      break;
    }
    case 'scrub': {
      const seconds = Number(parsed.seconds);
      if (!Number.isFinite(seconds)) break;
      // A scrub to where the run already is would restore a snapshot and drop every grab for
      // nothing; the panel's timeline lands here whenever it is merely looked at.
      if (Math.abs(seconds - live.simulation.ticks * live.simulation.dt) < 0.01) break;
      letGo();
      live.simulation.scrubTo(Math.max(0, seconds));
      realign();
      break;
    }
    case 'step': {
      const frames = Number(parsed.frames);
      if (!paused) {
        paused = true;
        pausedAt = performance.now();
      }
      if (frames > 0) {
        stepForward();
      } else {
        const { simulation, ticksPerFrame } = live;
        letGo();
        simulation.scrubTo(Math.max(0, (simulation.ticks - ticksPerFrame) * simulation.dt));
      }
      realign();
      break;
    }
    case 'pause':
      if (!paused) {
        paused = true;
        pausedAt = performance.now();
        console.log('  panel: paused');
      }
      break;
    case 'resume':
      if (paused) {
        paused = false;
        // The clock the pacing runs against skips the pause, so resuming does not race to
        // catch up on time that was never meant to pass.
        started += performance.now() - pausedAt;
        console.log('  panel: resumed');
      }
      break;
    case 'reset':
      letGo();
      live.simulation.reset();
      realign();
      console.log('  panel: reset to the start');
      break;
    case 'scenario':
      await command(JSON.stringify({ kind: 'set', key: 'scenario', value: parsed.id }));
      return;
    case 'strength':
      await command(JSON.stringify({ kind: 'set', key: 'grabStrength', value: parsed.value }));
      return;
    default:
      console.log(`  panel: unknown command ${parsed.kind}`);
  }
  writeStatus();
}

let pausedAt = started;
let lastReport = started;
let lastStatus = started;
let ticksAtReport = 0;
let lastSpeed = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

while (live.simulation.ticks * live.simulation.dt < seconds) {
  await readCommands();
  const { simulation, writer, muscleWriter, pose, ticksPerFrame } = live;
  const wall = (performance.now() - started) / 1000;
  // Catch up with the clock, but by no more than one output frame per turn: if the machine
  // cannot keep up, this is what lets the loop fall behind gracefully rather than spin.
  let ran = 0;
  while (!paused && simulation.ticks * simulation.dt < wall && ran < ticksPerFrame) {
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
    // Asked for afresh each time: the simulation allocates the ring arrays on its first tick,
    // so a reference taken before then is to arrays it no longer fills.
    const rings = muscleWriter ? simulation.muscleRings() : undefined;
    if (rings && rings.radius.length === rings.units * rings.rings) {
      muscleWriter.publish(simulation.ticks, rings.position, rings.orientation, rings.radius);
    }
    nextPublishAt += ticksPerFrame;
  }
  if (ran === 0) {
    // Ahead of the clock, or paused. A millisecond is the finest a timer reliably gives, and it
    // is well under a frame at any output rate anybody would choose.
    await sleep(1);
  } else {
    await new Promise(setImmediate);
  }

  const now = performance.now();
  if (now - lastStatus >= 100) {
    writeStatus();
    lastStatus = now;
  }
  if (now - lastReport >= 1000) {
    const simSeconds = simulation.ticks * simulation.dt;
    const wallSeconds = (now - started) / 1000;
    lastSpeed = paused
      ? 0
      : ((simulation.ticks - ticksAtReport) * simulation.dt) / ((now - lastReport) / 1000);
    console.log(
      `  sim ${simSeconds.toFixed(2)} s  wall ${wallSeconds.toFixed(2)} s  ` +
        `${lastSpeed.toFixed(2)}x life  ${writer.framesPublished} poses published` +
        (paused ? '  paused' : '') +
        (intents.holding().length > 0
          ? `  holding ${intents.holding().join(' and ')}`
          : intents.grabsSeen
            ? `  ${intents.grabsSeen} grabs so far`
            : ''),
    );
    lastReport = now;
    ticksAtReport = simulation.ticks;
  }
}

live.writer.close();
live.muscleWriter?.close();
live.simulation.dispose();
clearBridgeFiles();
console.log(
  `done: ${live.writer.framesPublished} poses over ${(live.simulation.ticks * live.simulation.dt).toFixed(2)} s`,
);
