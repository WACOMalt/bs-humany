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
 *   morphology, rates, gravity, floor, grab strength, and `scenario.<id>` for one of the chosen
 *   scenario's own parameters, its drop height among them. Settings that change the
 *   articulation rebuild the simulation and every bridge file and bump `generation` in the
 *   status so the renderer knows to reopen them; the rest apply in place.
 *
 * Both shapes are `PanelStatus` and `PanelCommand` in `packages/pose-bridge/src/panel.ts`, the
 * one contract every publisher and the viewer keep. The status is built by
 * `apps/studio/src/publisherStatus.ts`, where it is typechecked against that contract.
 *
 * ## Which body
 *
 * `--profile`, or L1 when it is not given, whatever profile the scenario was written on. The
 * publisher keeps a profile of its own rather than taking the scenario's, so a scenario written
 * on L3 runs here on L1 unless it is asked for; the panel's Body row changes it. Because that is
 * easy to miss, the startup line says which profile was chosen, why, and what the scenario was
 * written on when that differs.
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
const DEFAULT_PROFILE = 'l1_standard';
const profileId = flag('profile', DEFAULT_PROFILE);
const seconds = Number(flag('seconds', Number.POSITIVE_INFINITY));

const { resolveMorphology } = await jiti.import(join(ROOT, 'packages/anthropometry/src/index.ts'));
const { publisherStatus, publisherMorphology, scenarioDefinition } = await jiti.import(
  join(ROOT, 'apps/studio/src/publisherStatus.ts'),
);
const { buildDocument, computeWorldTransforms } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/index.ts'),
);
const { loadSkeletonAssetsFromDisk } = await jiti.import(
  join(ROOT, 'packages/assets-anatomical/src/index.ts'),
);
const { evaluate, param } = await jiti.import(join(ROOT, 'packages/hsdl/src/index.ts'));
const { Simulation } = await jiti.import(join(ROOT, 'apps/studio/src/simulation.ts'));
const { tissueTable } = await jiti.import(join(ROOT, 'apps/studio/src/tissue.ts'));
const { SCENARIO_DEFINITIONS, DEFAULT_SCENARIO, MUSCLE_GROUPS, driveForSlider } = await jiti.import(
  join(ROOT, 'packages/scenarios/src/index.ts'),
);
const {
  openPoseBridge,
  openMuscleBridge,
  GrabIntentReader,
  claimBridge,
  temporaryName,
  DEFAULT_PATH,
  STATUS_SUFFIX,
  COMMANDS_SUFFIX,
} = await jiti.import(join(ROOT, 'packages/pose-bridge/src/index.ts'));
// The codec states where the bridge lives, once; this only lets --path say otherwise.
const path = flag('path', DEFAULT_PATH);

const document = buildDocument();
const assets = await loadSkeletonAssetsFromDisk(join(ROOT, 'packages/assets-anatomical/data'));

const PROFILES = ['l0_ragdoll', 'l1_standard', 'l2_biomechanical', 'l3_anatomical'];

/**
 * Everything the panel can set; `PublisherSettings` in publisherStatus.ts says what each is.
 * `null` means "as the scenario says" -- its morphology, its passive joints, whether it wants
 * muscles -- which is what the studio's controls start at too. The profile is not one of those:
 * it is `--profile` or L1, whatever the scenario was written on (see the header). The ones marked
 * as rebuilding change the articulation and so take a fresh simulation; the others apply to the
 * running one.
 *
 * There is no drop height here. The studio's is for a free drop, and a run of this is always a
 * scenario, which places the body itself: the height a drop starts from is the scenario's own
 * `clearance` parameter, set with `scenario.clearance` like its others.
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
  passive: null, // rebuild
  redistribute: true, // rebuild
  fps, // rebuild
  stepsPerSecond: null, // rebuild; null = the profile's own
  gravity: true, // live
  floor: true, // live
};
/**
 * Each scenario's own parameters as the panel last set them, by scenario id, so switching to
 * another scenario and back finds them where they were left. A scenario not here runs at its
 * committed defaults.
 */
const scenarioValues = new Map();
/** The viewport overlays, as the headset's transport strip toggles them; nothing here draws. */
const overlays = {
  muscles: true,
  muscleVolumes: true,
  tissue: true,
  grid: true,
  proxies: false,
  axes: false,
  com: false,
  contacts: false,
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
  'passive',
  'redistribute',
  'fps',
  'stepsPerSecond',
]);
/** Slider positions, 0..100, one a muscle group; kept across rebuilds. */
const drives = MUSCLE_GROUPS.map(() => 0);

/** Build a simulation for the current settings and open the bridge files it publishes into. */
async function build() {
  // Built afresh from its definition at the panel's values, so a rebuild gets a script with no
  // history and the parameters as they were last set.
  const definition = scenarioDefinition(settings.scenario);
  const values = scenarioValues.get(definition.id) ?? {};
  const chosen = definition.build(values);
  const morphology = resolveMorphology(publisherMorphology(settings, chosen));
  const simulation = new Simulation(document, morphology, {
    profileId: settings.profile,
    backend: 'mujoco',
    passiveJoints: settings.passive ?? chosen.passiveJoints,
    redistribute: settings.redistribute,
    scenario: chosen,
    // Read only for a free drop. There is always a scenario here, and its own clearance places
    // the body, so this is not read; it is given the scenario's rather than a number of its own.
    dropHeight: chosen.clearance,
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
    definition,
    values,
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
  for (const suffix of ['', '.json', '-muscles', '-grab', STATUS_SUFFIX, COMMANDS_SUFFIX]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}
// One publisher a path: a showcase and this one on the same bridge wipe each other's files and
// race on the names a status is renamed through.
claimBridge(path, 'The studio, a showcase or a publisher');
clearBridgeFiles();

// Unique to this run rather than counted from one, so a viewer that followed the last run --
// this program's, a showcase's, the studio's -- sees a generation it has not seen and reopens,
// instead of taking the new files for the old ones because both said generation 1. The wall
// clock only names the run; nothing simulated reads it.
let generation = Date.now();
let live = await build();
{
  const written = live.chosen.profileId;
  const why = args.includes('--profile')
    ? 'from --profile'
    : 'the default; --profile picks another';
  console.log(
    `  profile ${settings.profile} (${why})` +
      (written !== settings.profile ? `; ${live.chosen.id} is written on ${written}` : ''),
  );
}
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
  const status = publisherStatus({
    generation,
    settings,
    profiles: PROFILES,
    definition: live.definition,
    scenario: live.chosen,
    values: live.values,
    simulation: live.simulation,
    muscles: Boolean(live.rings),
    tissue: tissueOf(live),
    wallSeconds: (performance.now() - started) / 1000,
    speed: lastSpeed,
    paused,
    holding: intents.holding(),
    grabStrength,
    drives,
    overlays,
  });
  const tmp = temporaryName(`${path}${STATUS_SUFFIX}`);
  writeFileSync(tmp, JSON.stringify(status));
  renameSync(tmp, `${path}${STATUS_SUFFIX}`);
}

/** The tissue table, once a build: it is the articulation's, and that lives as long as `live`. */
let tissueCache;
function tissueOf(built) {
  if (tissueCache?.built !== built) {
    tissueCache = { built, table: tissueTable(built.simulation.articulation) };
  }
  return tissueCache.table;
}

let commandsFd;
let commandsOffset = 0;
let commandsTail = '';
const commandsBuffer = Buffer.alloc(4096);

async function readCommands() {
  if (commandsFd === undefined) {
    try {
      commandsFd = openSync(`${path}${COMMANDS_SUFFIX}`, 'r');
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
      // The transport strip's keys: an overlay is remembered for the status; Play resumes, and
      // Live is where a headless run always is.
      const overlay = /^overlay\.(\w+)$/.exec(key)?.[1];
      if (overlay || key === 'grid') {
        overlays[overlay ?? 'grid'] = Boolean(value);
        break;
      }
      if (key === 'play') {
        await command(JSON.stringify({ kind: 'resume' }));
        return;
      }
      const parameter = /^scenario\.(.+)$/.exec(key)?.[1];
      if (parameter !== undefined) {
        await setScenarioParameter(parameter, value);
        break;
      }
      if (key === 'live' || key === 'percentile') {
        console.log(`  panel: ${key} is the studio's; nothing to do here`);
        break;
      }
      if (key === 'dropHeight') {
        console.log(
          `  panel: dropHeight is for the studio's free drop; ${live.chosen.id} places the body ` +
            'itself, so set its own parameter instead',
        );
        break;
      }
      if (!(key in settings)) {
        console.log(`  panel: no setting ${key}`);
        break;
      }
      if (key === 'scenario' && !SCENARIO_DEFINITIONS.some((d) => d.id === value)) {
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

/**
 * One of the running scenario's own parameters, from the panel: checked against that scenario's
 * definition, held to its range, remembered for the scenario, and built into a new run -- a
 * parameter is part of what the scenario builds, not something a running one can change.
 */
async function setScenarioParameter(id, value) {
  const { definition, values } = live;
  const parameter = definition.parameters.find((p) => p.id === id);
  if (!parameter) {
    console.log(`  panel: ${definition.id} has no parameter ${id}`);
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    console.log(`  panel: scenario.${id} wants a number, not ${JSON.stringify(value)}`);
    return;
  }
  const clamped = Math.min(parameter.max, Math.max(parameter.min, value));
  if ((values[id] ?? parameter.value) === clamped) return;
  scenarioValues.set(definition.id, { ...values, [id]: clamped });
  await rebuild(`${definition.id} ${id} = ${clamped}`);
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
