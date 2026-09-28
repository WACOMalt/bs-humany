#!/usr/bin/env node
/**
 * Show the learner: the best policy so far, standing in a body the headset can watch.
 *
 *   pnpm train:showcase            # follows <data>/policies/balance.json as it changes
 *   pnpm train:showcase --recipe <data>/runs/<name>-recipe.json   # a named checkpoint, in its scenario
 *   pnpm train:showcase --help     # every flag, and its default
 *
 * A rig like the trainer's, but paced to the wall clock and publishing its bones to the pose
 * bridge every output frame, so `bs-humany-xr-viewer view --follow` shows the current best
 * attempt. When the body falls the episode restarts; when the policy file changes, the next
 * episode uses it. The status file names the generation, so the panel says what is being
 * watched, and the policy's layers go to `<data>/runs/<task>-activity.json` ten times a
 * second for the dashboard's picture of the brain.
 *
 * The rig is built from the policy it plays, not from a guess at it: the hidden widths are the
 * policy file's, and the episode length -- which decides where in an episode the twitch lands --
 * is the one the policy was trained at. Until there is a policy there is nothing to build, so the
 * showcase waits for one first. It used to build a 32 x 32 network with 30 s episodes whatever had
 * been trained: a run trained 64 x 64 threw a RangeError the moment its first policy arrived, and
 * a run trained at 6 s met its twitch anywhere in half a minute, mostly long after the moment it
 * had learned to meet one. An episode on screen still runs for up to `SHOWCASE_SECONDS`, because
 * watching a body keep standing is the point; only the twitch keeps to the trained window.
 *
 * The status is a `PanelStatus` (`packages/pose-bridge/src/panel.ts`), the contract every
 * publisher and the viewer keep, built in `src/showcaseStatus.ts` where it is typechecked.
 */

import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { formatHelp, parse } from './flags.mjs';
import { policiesDir as policiesHome, runFile, runsDir as runsHome } from './home.mjs';

// When the dashboard pipes this process and goes first, a write to the closed pipe raises EPIPE
// on the stream, and an unhandled stream error would kill the showcase -- and the headset with it
// -- over a log line nobody can read any more. What cannot be printed is simply not printed.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const jiti = createJiti(import.meta.url);
/** Refuse to start, with a sentence, before the bridge or the body has been touched. */
const refuse = (text) => {
  console.error(`showcase: ${text}`);
  process.exit(1);
};

/**
 * How long an episode on screen may run before it starts again, in seconds of the body's time.
 *
 * Only the loop's cap, and deliberately not the rig's episode length: that one places the twitch,
 * and is the trained one. Half a minute lets a policy that has learned to stand be seen standing,
 * where the six seconds a run is usually scored over would restart a body that is doing fine.
 */
const SHOWCASE_SECONDS = 30;
/** How often, in wall milliseconds, the episodes since the last summary are summed up in a line. */
const SUMMARY_MS = 30_000;

// The recipe module and the codec: every task, body and limit a recipe is held to, and where the
// bridge lives. Neither loads anything that runs, so a flag that is wrong is refused at once,
// before MuJoCo or the skeleton is loaded.
const {
  AUTHORITY_LIMIT,
  DEFAULT_AUTHORITY,
  DEFAULT_PROFILE,
  DEFAULT_TASK,
  PROFILES,
  SEARCH_DEFAULTS,
  TASKS,
  behaviourRecipe,
  checkRecipe,
  rigOptionsFor,
  upgradeRecipe,
} = await jiti.import(join(ROOT, 'tools/train/src/recipe.ts'));
const { DEFAULT_PATH } = await jiti.import(join(ROOT, 'packages/pose-bridge/src/codec.ts'));

/**
 * Every flag the showcase takes, read once, before anything else happens.
 *
 * It used to read its flags one at a time and take whatever followed each: `--polcy x` was
 * ignored and the showcase played the default checkpoint, `--fps fast` paced it at NaN, and
 * `--task sit` ended in a stack trace. The table is the trainer's kind, and the tasks and bodies
 * in it are the recipe module's, so the showcase accepts exactly what the trainer can train.
 */
const SHOWCASE_FLAGS = [
  {
    name: 'recipe',
    kind: 'string',
    help: 'a recipe file: the checkpoint it names, played in its scenario and body',
  },
  {
    name: 'task',
    kind: 'choice',
    choices: [...TASKS],
    default: DEFAULT_TASK,
    help: 'without a recipe: what was scored; also the checkpoint name',
  },
  {
    name: 'profile',
    kind: 'choice',
    choices: [...PROFILES],
    default: DEFAULT_PROFILE,
    help: 'without a recipe: the body',
  },
  {
    name: 'authority',
    kind: 'number',
    min: AUTHORITY_LIMIT.min,
    max: AUTHORITY_LIMIT.max,
    default: DEFAULT_AUTHORITY,
    help: "how much of the drive is the brain; with a recipe, in place of the recipe's",
  },
  {
    name: 'policy',
    kind: 'string',
    help: 'the policy file to play (default <data>/policies/<name>.json)',
  },
  { name: 'path', kind: 'string', help: `where the pose bridge is (default ${DEFAULT_PATH})` },
  { name: 'fps', kind: 'positive', default: 90, help: 'poses published a second' },
  { name: 'help', kind: 'bool', help: 'this' },
];

const { values: flags, given, errors, unknown } = parse(process.argv.slice(2), SHOWCASE_FLAGS);
/** A flag's value as given, or `fallback` when it was not. */
const flag = (name, fallback) => (given.has(name) ? flags[name] : fallback);
const known = `  known options: ${SHOWCASE_FLAGS.map((f) => `--${f.name}`).join(' ')}`;
if (unknown.length > 0) {
  refuse(
    `no such option${unknown.length > 1 ? 's' : ''}: ${unknown.map((a) => `--${a}`).join(', ')}\n${known}`,
  );
}
if (errors.length > 0) refuse(`${errors.join('\n  ')}\n${known}`);
if (flags.help) {
  console.log(
    formatHelp(
      SHOWCASE_FLAGS,
      'showcase: play the best policy so far on the pose bridge, for the headset to watch.\n' +
        'It waits for the policy, then builds the body at the network size and episode length it was trained at.',
    ),
  );
  process.exit(0);
}

/**
 * What is played, in what: the recipe file, checked by the same rules the trainer and the
 * dashboard read one by -- which hold its task to the task table -- or the default behaviour's
 * body the flags describe (`behaviourRecipe`), whose task and body the table has already held to
 * the recipe module's lists.
 */
let recipe;
if (flags.recipe !== undefined) {
  // A recipe says these; a flag beside it would be one or the other, silently.
  for (const flag of ['task', 'profile']) {
    if (given.has(flag)) refuse(`--${flag} is set by the recipe (${flags.recipe}); edit it there`);
  }
  let text;
  try {
    text = readFileSync(flags.recipe, 'utf8');
  } catch {
    refuse(`no recipe at ${flags.recipe}`);
  }
  try {
    recipe = JSON.parse(text);
  } catch (error) {
    refuse(`${flags.recipe} is not JSON: ${error instanceof Error ? error.message : error}`);
  }
  const wrong = checkRecipe(recipe);
  if (wrong.length) refuse(`${flags.recipe} is not a recipe:\n  ${wrong.join('\n  ')}`);
  // A recipe from before 2026-09-28 may name a scenario deleted then, or the scenario's own
  // muscle script under the brain; it plays in what stands in for each, and says so once.
  const upgraded = upgradeRecipe(recipe);
  recipe = upgraded.recipe;
  for (const note of upgraded.notes) console.log(`showcase: ${note}`);
  // The trainer's rule, so the command line a run was trained with plays what it trained.
  if (given.has('authority')) recipe = { ...recipe, authority: flags.authority };
} else {
  try {
    recipe = behaviourRecipe(flags.task, flags.profile, flags.authority);
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }
}
const task = recipe.task;
const name = recipe.name;
const fps = flags.fps;
const policyPath = flags.policy ?? join(policiesHome(), `${name}.json`);
const activityPath = join(runsHome(), `${name}-activity.json`);
const posePath = join(runsHome(), `${name}-pose.json`);

const { StandRig } = await jiti.import(join(ROOT, 'tools/train/src/rig.ts'));
const { MlpPolicy } = await jiti.import(join(ROOT, 'packages/modules-nerves/src/index.ts'));
const { computeWorldTransforms, buildDocument } = await jiti.import(
  join(ROOT, 'packages/skeleton/src/index.ts'),
);
const { loadSkeletonAssetsFromDisk } = await jiti.import(
  join(ROOT, 'packages/assets-anatomical/src/index.ts'),
);
const { evaluate, param } = await jiti.import(join(ROOT, 'packages/hsdl/src/index.ts'));
const { tissueTable } = await jiti.import('@bs-humany/session');
const { showcaseStatus } = await jiti.import(join(ROOT, 'tools/train/src/showcaseStatus.ts'));
const {
  openPoseBridge,
  openMuscleBridge,
  claimBridge,
  temporaryName,
  STATUS_SUFFIX,
  COMMANDS_SUFFIX,
} = await jiti.import(join(ROOT, 'packages/pose-bridge/src/index.ts'));
// The codec states where the bridge lives, once; --path only says otherwise.
const path = flag('path', DEFAULT_PATH);
// Unique to this run, so a viewer that followed the last showcase -- or `pnpm publish:pose`, or
// the studio -- sees a generation it has not seen and reopens the bridges. A constant 1 here
// froze the headset on the old files whenever one showcase replaced another. The wall clock only
// names the run; nothing simulated reads it.
const bridgeGeneration = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Lines said once a run, by their text. A showcase goes round the same few states for hours --
 * waiting, a policy for another task, a policy of another size -- and a line repeated every two
 * seconds, or every episode, buries the one line that says something new. The same thing said
 * again is not news; a different thing is.
 */
const said = new Set();
const sayOnce = (text) => {
  if (said.has(text)) return;
  said.add(text);
  console.log(text);
};

/** Whole numbers above zero, the only thing a layer width can be. */
const isWidths = (v) =>
  Array.isArray(v) && v.length >= 2 && v.every((n) => Number.isInteger(n) && n > 0);

/** The modification time of the policy file last read through, played or not. */
let seenAt = 0;
/**
 * The policy file, when it has changed since it was last read and is one this showcase can play
 * the task of; `undefined` otherwise.
 *
 * A file that is not JSON is taken to be mid-write and read again next time, without remembering
 * its time. Every other answer is remembered by the file's modification time, so a policy for
 * another task is read, and said, once rather than every two seconds until it changes.
 */
function readPolicy() {
  let mtime;
  try {
    if (!existsSync(policyPath)) return undefined;
    mtime = statSync(policyPath).mtimeMs;
  } catch {
    return undefined;
  }
  if (mtime === seenAt) return undefined;
  let file;
  try {
    file = JSON.parse(readFileSync(policyPath, 'utf8'));
  } catch {
    return undefined; // mid-write; next time
  }
  seenAt = mtime;
  if (file?.task !== task) {
    sayOnce(
      `policy at ${policyPath} is for ${file?.task}; this showcase plays ${task} (use --policy or --recipe)`,
    );
    return undefined;
  }
  if (!isWidths(file.sizes)) {
    sayOnce(`policy at ${policyPath} has no layer sizes to build a network from`);
    return undefined;
  }
  return file;
}

/**
 * How long the episodes that trained this policy were, and where that was read: the policy file,
 * which says since the trainer began writing it; else the run's progress record beside it, when
 * that record is of the same task and network; else the search's own default, which is what a run
 * that said nothing trained at.
 */
function trainedSeconds(file) {
  const positive = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  const fromPolicy = positive(file.trained?.seconds);
  if (fromPolicy !== undefined) return { seconds: fromPolicy, from: 'the policy' };
  // The checkpoint's name: the recipe it was saved with names it, and an older file is named by
  // its file, as `<data>/policies/<name>.json`.
  const checkpoint =
    typeof file.recipe?.name === 'string' ? file.recipe.name : basename(policyPath, '.json');
  const latestPath = runFile(checkpoint, 'latest');
  try {
    const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
    const fromRun = positive(latest.seconds);
    // A record of another network is of another run under the same name -- one begun afresh that
    // has not yet written a policy -- and says nothing about this one.
    const same =
      (latest.task === undefined || latest.task === task) &&
      (!Array.isArray(latest.sizes) || latest.sizes.join('x') === file.sizes.join('x'));
    if (fromRun !== undefined && same) return { seconds: fromRun, from: basename(latestPath) };
  } catch {
    // No record, or not one that reads: the default below.
  }
  return { seconds: SEARCH_DEFAULTS.seconds, from: "the search's default" };
}

console.log(`showcasing ${name} from ${policyPath} -> ${path} at ${fps} poses/s; Ctrl-C to stop`);
// One publisher a path, claimed before the wait, so a bridge another publisher holds is refused
// now rather than after the first policy of a long run, and nothing takes it while this waits.
try {
  claimBridge(path, 'The studio, a showcase or a publisher');
} catch (error) {
  refuse(error instanceof Error ? error.message : String(error));
}

// The policy first: it says how wide a network to build and how long the episodes were.
let first = readPolicy();
while (first === undefined) {
  sayOnce('  waiting for a policy file');
  await sleep(2000);
  first = readPolicy();
}
const hidden = first.sizes.slice(1, -1);
const builtFor = hidden.join(' x ');
const { seconds, from: secondsFrom } = trainedSeconds(first);

let rig;
try {
  rig = await StandRig.build(rigOptionsFor(recipe, { hidden, seconds, poseBones: true }));
} catch (error) {
  refuse(
    `cannot build ${recipe.profile} for ${name}: ${error instanceof Error ? error.message : error}`,
  );
}
console.log(
  `  built for hidden ${builtFor} and ${seconds} s episodes (from ${secondsFrom}), so the twitch lands where training put it`,
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
// The last publisher's files go only now, with this body ready to take their place.
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
/**
 * The body the recipe built, as the flat numbers the studio's sliders hold, for the status's
 * `morphology`. A studio following the showcase builds its skeleton from these, so the bones it
 * draws are the size of the bones being simulated: without them it drew the recipe's body on
 * whatever its own sliders said, and a 1.60 m studio following a 1.70 m policy showed bones that
 * did not meet at the joints. Read from the resolved body, so the proportions the recipe leaves to
 * the resolver's defaults are the ones it filled in.
 */
const body = Object.fromEntries(
  [
    ['sex', 'sex'],
    ['stature', 'stature'],
    ['mass', 'mass'],
    ['crural', 'crural'],
    ['brachial', 'brachial'],
    ['legLength', 'relativeLegLength'],
  ].map(([key, name]) => [key, evaluate(param(name), rig.restContext)]),
);

const posePartial = temporaryName(posePath);
const activityPartial = temporaryName(activityPath);

let weights = null;
let meta = {};

/**
 * The episodes since the last summary: which, and the shortest and longest time up. A line an
 * episode was a line every two seconds for a policy that falls at once, and from the dashboard,
 * which relays this output beside the trainer's, the trainer's lines went by unread.
 */
let recent = null;
let windowStarted = performance.now();
function summarise() {
  if (recent !== null) {
    const episodes =
      recent.from === recent.to ? `episode ${recent.from}` : `episodes ${recent.from}-${recent.to}`;
    const low = recent.low.toFixed(1);
    const high = recent.high.toFixed(1);
    console.log(
      `  ${episodes}, generation ${meta.generations ?? 0}: up ${low === high ? low : `${low}-${high}`} s`,
    );
  }
  recent = null;
  windowStarted = performance.now();
}
function tally(episode, upFor) {
  recent =
    recent === null
      ? { from: episode, to: episode, low: upFor, high: upFor }
      : {
          from: recent.from,
          to: episode,
          low: Math.min(recent.low, upFor),
          high: Math.max(recent.high, upFor),
        };
  if (performance.now() - windowStarted >= SUMMARY_MS) summarise();
}

/**
 * Play this policy from the next episode, if this body can; say why not, once, if it cannot.
 *
 * The widths are checked before anything is fitted: a policy's hidden layers are copied whole,
 * so one of another size cannot be played by this network, and fitting it anyway handed the rig
 * weights of the wrong length and a RangeError that ended the showcase. The body keeps playing
 * the policy it has, and the line says what to do.
 */
function adopt(file) {
  const widths = file.sizes.slice(1, -1).join(' x ');
  if (widths !== builtFor) {
    sayOnce(`policy has hidden ${widths}; this showcase was built for ${builtFor}; restart it`);
    return false;
  }
  let fitted;
  try {
    // Fitted by name: a policy from a coarser body plays on this one with what it learned.
    fitted = MlpPolicy.fit(file, rig.inputNames, rig.outputNames);
  } catch (error) {
    sayOnce(
      `policy at ${policyPath} cannot be played: ${error instanceof Error ? error.message : error}`,
    );
    return false;
  }
  // The episodes so far were the last policy's, and are summed up under its generation.
  summarise();
  weights = fitted.policy.weights;
  meta = file.trained ?? {};
  if (fitted.carried.inputs !== rig.inputNames.length) {
    sayOnce(
      `  policy from ${file.profile ?? 'another body'}: ${fitted.carried.inputs} of ${rig.inputNames.length} senses carried`,
    );
  }
  console.log(
    `policy: generation ${meta.generations ?? '?'}, fitness ${(meta.fitness ?? 0).toFixed(3)}, ${meta.episodes ?? 0} episodes`,
  );
  return true;
}
/** A policy that has changed since the last look, played if it can be. */
function reload() {
  const file = readPolicy();
  return file !== undefined && adopt(file);
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
  // Past the contract's fields, as publish:pose's `resets` is: a reader that does not know it --
  // the headset, which skins from the bridge's own rest table and scale -- ignores it.
  status.morphology = body;
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

// The first policy was read to build the body; it is played now, unless even it cannot be (a
// file whose weights do not add up), in which case the wait goes on for one that can.
adopt(first);
while (weights === null) {
  sayOnce('  waiting for a policy file this showcase can play');
  await sleep(2000);
  reload();
}
const started = performance.now();
// The rig's own step: an L3 body runs at a thousand a second, an L1 at five hundred.
const dt = rig.stepSeconds;
const ticksPerFrame = Math.max(1, Math.round(1 / dt / fps));
let episode = 0;
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
    if (!result.up || result.time > SHOWCASE_SECONDS) break;
    await sleep(ran === 0 ? 1 : 0);
  }
  writePose(result.time, false);
  tally(episode, result.time);
  // A moment on the floor, so the fall can be seen, then again from the top.
  await sleep(1200);
}
