#!/usr/bin/env node
import { execSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
/**
 * Serve the training dashboard: `tools/train/dashboard.html`, and the run files it polls.
 *
 *   pnpm train:dashboard          # http://localhost:5280/
 *
 * Also the studio's way to the brain: `GET /policies` lists the saved checkpoints, and
 * `POST /train/start`, `POST /train/stop` and `GET /train/status` start, stop and watch a
 * training run -- the trainer and the showcase, as the terminal would start them -- so the
 * brain panel in a browser tab can do what a terminal does on this machine. The only things it
 * will ever spawn are those two scripts, with numeric arguments checked here, and one run at a
 * time. Their output is relayed here, each line labelled `[train]` or `[showcase]`, and the
 * trainer's last lines are kept, so the status can say why a run it started stopped. `GET /runs`
 * lists every run the data directory has a record of, whoever started it, newest first.
 *
 * It says which checkout it serves when it starts and in every status: what it trains is that
 * tree's code, and a dashboard left running in another worktree is easy to forget.
 *
 * Who may ask is decided by `origin.mjs`, at the top of every request. Listening on 127.0.0.1
 * is not what protects it: that keeps other machines out, but a page from anywhere, opened in a
 * browser on this machine, can still send requests to localhost. This used to answer them all
 * with `access-control-allow-origin: *`, so any page could start and stop runs and read the
 * checkpoints. Now a request is answered only when its Host is a loopback name on this port --
 * which a DNS-rebinding page cannot give -- and its Origin, when it has one, is a page served
 * from this machine or the desktop studio. A request with no Origin, such as curl or the command
 * line, passes. An allowed origin is echoed back rather than `*`, which also satisfies the
 * studio's `require-corp` embedder policy, whose fetches here are CORS-mode. Nothing is served
 * from disk but this page, the run files, the bridge and the checkpoints. The studio container
 * runs no dashboard, and a studio served from a public name is refused like any other page: only
 * a studio served from this machine, the container's included, can drive one.
 */
import { createServer } from 'node:http';
import { join, normalize, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { CHECKPOINT_NAME } from '../src/checkpointName.mjs';
import { dataHome, runsDir as runsHome, seedFromRepository } from './home.mjs';
import { corsHeaders, refusal } from './origin.mjs';
import { SEARCH_DEFAULTS, UI_RUN_DEFAULTS, recipeFrom, resumePreflight } from './recipe.mjs';

// The dashboard relays its children's output to its own, and a terminal that goes away -- a
// closed pipe, `pnpm train:dashboard | head` -- raises EPIPE on the stream. Unhandled, that takes
// the server down, and with it the run's supervision. What cannot be printed is not printed.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// The recipe module's one-line description, through the same jiti `recipe.mjs` loads it with:
// that module imports nothing that runs, so the dashboard still starts without MuJoCo.
const { describeRecipe } = await createJiti(import.meta.url).import(
  fileURLToPath(new URL('../src/recipe.ts', import.meta.url)),
);

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/**
 * Which checkout this server runs from, said when it starts and in every status. A dashboard left
 * running in one worktree goes on training that worktree's code for a studio opened from another,
 * and nothing said so: the only symptom was a run that did not do what the code in front of you
 * says it does. The branch and commit are read once, at start, which is when the code was loaded.
 */
const CHECKOUT = (() => {
  const git = (args) => {
    try {
      return execSync(`git ${args}`, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // Not a git checkout -- a copied tree, an unpacked release -- or no git: the root still says
      // where it is.
      return null;
    }
  };
  return {
    root: ROOT.replace(/[/\\]+$/, ''),
    branch: git('rev-parse --abbrev-ref HEAD'),
    commit: git('rev-parse --short HEAD'),
  };
})();
const PAGE = join(ROOT, 'tools/train/dashboard.html');
const port = Number(process.argv[2] ?? 5280);
const BRIDGE = '/dev/shm/bs-humany-pose';
// The same directory the trainer and the studio binary use, so all three see one set of
// checkpoints rather than three. The repository's own are copied in once on a fresh machine.
const POLICIES = seedFromRepository(join(ROOT, 'packages/modules-nerves/policies'));
const RUNS = runsHome();

/** Every saved policy and every run's record and centre, with what their files say of them. */
function listPolicies() {
  const out = [];
  const read = (path, kind) => {
    try {
      const file = JSON.parse(readFileSync(path, 'utf8'));
      if (file.format !== 'bs-humany.policy/1') return;
      out.push({
        // Relative to the data directory, which is where both of these live now. It used to be
        // relative to the repository, which is no longer above them.
        id: relative(dataHome(), path),
        name: `${path.slice(path.lastIndexOf('/') + 1)}${kind ? ` (${kind})` : ''}`,
        task: file.task,
        profile: file.profile ?? null,
        sizes: file.sizes,
        trained: file.trained ?? null,
        // What it was trained in, when the file says: the studio sets itself up from it.
        recipe: file.recipe ?? null,
        modified: statSync(path).mtimeMs,
      });
    } catch {
      // Half-written or not a policy: skipped.
    }
  };
  // A centre and a record used to be kept beside the policies, and a data directory from then
  // still has them there. The record is not a policy and is left out. The centre is one, and is
  // labelled a search centre as the ones in runs/ are -- the studio's name rules read that label,
  // so it is not offered as a checkpoint called `<name>-centre` -- while its id, under
  // `policies/`, says where it was left.
  if (existsSync(POLICIES))
    for (const f of readdirSync(POLICIES)) {
      if (!f.endsWith('.json') || f.endsWith('-latest.json')) continue;
      read(join(POLICIES, f), f.endsWith('-centre.json') ? 'search centre' : '');
    }
  if (existsSync(RUNS))
    for (const f of readdirSync(RUNS)) {
      if (f.endsWith('-centre.json')) read(join(RUNS, f), 'search centre');
    }
  out.sort((a, b) => b.modified - a.modified);
  return out;
}

/** The training run this server started, if any. */
let training = null;
const isPid = (p) => {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
};
/**
 * Whether a child process has gone, for any reason.
 *
 * Not `exitCode === null`, which is what this asked before and is a trap: Node leaves `exitCode`
 * null when a child is killed by a signal and puts the signal in `signalCode` instead. Stop
 * kills by signal. So a stopped run reported itself as still running for ever, the studio went
 * on offering a Stop button, and pressing it signalled a process that was already dead -- which
 * looks exactly like a button that does nothing.
 */
const gone = (child) => child === null || child.exitCode !== null || child.signalCode !== null;

/** A run's file in the runs directory: `<name>-latest.json`, `<name>-centre.json`, ... */
const runFile = (name, kind) => join(RUNS, `${name}-${kind}.json`);

/** A JSON file, parsed, or null when it is not there or not whole. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * A recipe in one line, from the recipe module the trainer and the studio describe it with. A
 * record from before recipes were kept, or one in a shape this code no longer reads, is
 * 'unknown' rather than a line that guesses.
 */
function recipeSummary(recipe) {
  if (recipe === null || typeof recipe !== 'object') return 'unknown';
  try {
    return describeRecipe(recipe);
  } catch {
    return 'unknown';
  }
}

/** The first line of a file, read without reading the rest: a run's history can be long. */
function firstLine(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString('utf8', 0, read);
    const end = text.indexOf('\n');
    return end < 0 ? (read < buffer.length ? text : null) : text.slice(0, end);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** `<name>-<started>.jsonl`, the history a trainer appends, by the checkpoint it is for. */
const LOG_NAME = /^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.jsonl$/;
const LATEST_NAME = /^(.+)-latest\.json$/;

/** The last generation a record has written: its last row's, which a resume does not count from 1. */
const lastGeneration = (latest) => {
  const series = Array.isArray(latest?.series) ? latest.series : [];
  const row = series[series.length - 1];
  return Array.isArray(row) && typeof row[0] === 'number' ? row[0] : 0;
};

/**
 * Every run the runs directory has a record or a history of, newest first: what `GET /runs`
 * answers, and what the page's run picker lists. Any name, not only the server's own run or
 * `stand`, which was all the page could see, so a run started from a terminal under a name of its
 * own was invisible here however long it trained.
 *
 * A run is known by its record, `<name>-latest.json`, whose stem must be a checkpoint name, and
 * by its histories, one `<name>-<started>.jsonl` a start. The recipe is the record's; a run with
 * none -- the record is written after the first generation, so a run that died on start has only
 * its history -- takes it from its newest history's header line.
 */
function listRuns() {
  if (!existsSync(RUNS)) return [];
  const runs = new Map();
  const run = (name) => {
    let r = runs.get(name);
    if (!r) {
      r = { name, latest: null, logs: [] };
      runs.set(name, r);
    }
    return r;
  };
  for (const f of readdirSync(RUNS)) {
    const latestName = LATEST_NAME.exec(f)?.[1];
    if (latestName !== undefined && CHECKPOINT_NAME.test(latestName)) {
      const latest = readJson(join(RUNS, f));
      if (latest) run(latestName).latest = latest;
      continue;
    }
    const log = LOG_NAME.exec(f);
    if (log && CHECKPOINT_NAME.test(log[1])) {
      let modified = 0;
      try {
        modified = statSync(join(RUNS, f)).mtimeMs;
      } catch {
        continue; // Gone between the listing and the look.
      }
      run(log[1]).logs.push({ file: f, modified });
    }
  }
  const out = [];
  for (const r of runs.values()) {
    // Newest first; the name carries the start time, which sorts as it reads.
    r.logs.sort((a, b) => (a.file < b.file ? 1 : a.file > b.file ? -1 : 0));
    const latest = r.latest;
    let summary = latest?.recipe ? recipeSummary(latest.recipe) : 'unknown';
    if (!latest?.recipe && r.logs.length > 0) {
      const line = firstLine(join(RUNS, r.logs[0].file));
      try {
        const header = line ? JSON.parse(line) : null;
        if (header?.kind === 'header') summary = recipeSummary(header.recipe);
      } catch {
        // A history with no header -- written before there were headers -- says nothing of it.
      }
    }
    const logged = r.logs.length > 0 ? Math.max(...r.logs.map((l) => l.modified)) : null;
    out.push({
      name: r.name,
      /** Whether it has a progress record yet, which it writes after its first generation. */
      record: latest !== null,
      task: latest?.task ?? null,
      updated: latest?.updated ?? (logged === null ? null : new Date(logged).toISOString()),
      best: latest?.best ?? null,
      generation: latest ? lastGeneration(latest) : 0,
      target: latest?.target ?? null,
      state: latest?.state ?? null,
      secondsPerGeneration: latest?.secondsPerGeneration ?? null,
      startedAt: latest?.startedAt ?? null,
      recipeSummary: summary,
      logs: r.logs.map((l) => l.file),
    });
  }
  const at = (r) => (r.updated ? Date.parse(r.updated) || 0 : 0);
  out.sort((a, b) => at(b) - at(a));
  return out;
}

/**
 * The run whose record was written last, or undefined when no run has one: the same order `GET
 * /runs` lists them in, so the page's 'follow' and the studio's "Last run of ..." name the same
 * run. A run with only a history -- one that died before its first generation -- has no progress
 * to show, and is passed over for the last one that has.
 */
const newestRun = () => listRuns().find((r) => r.record)?.name;

/** How many of the trainer's last lines are kept, for the status and for the reason it stopped. */
const TAIL_LINES = 20;
/** What a stderr line is marked with in the kept tail, so it can be told from the trainer's news. */
const STDERR_MARK = 'stderr: ';
/** The longest a reason is said in: a line for a status, not a stack. */
const REASON_LENGTH = 200;

/**
 * Print a child's output as the dashboard's own, a line at a time, each line labelled with whose
 * it is. The trainer and the showcase used to write straight to this terminal, their lines
 * interleaved and unlabelled, so a failure in one read as the other's. `keep` is given every line
 * too, and whether it came from stderr, for the trainer's tail.
 */
function relay(child, tag, keep) {
  const streams = [
    [child.stdout, process.stdout, false],
    [child.stderr, process.stderr, true],
  ];
  for (const [stream, out, fromStderr] of streams) {
    if (!stream) continue;
    createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY }).on('line', (line) => {
      out.write(`[${tag}] ${line}\n`);
      keep?.(line, fromStderr);
    });
  }
}

/**
 * Keep a trainer's last lines, and the lines that would say why it stopped: the trainer's own
 * sentence (`train-nerves: ...`, which is how it refuses a recipe and how it reports a failed
 * run), else the message line of an exception it did not catch, else its last word on stderr.
 * Kept as they come rather than looked for in the tail afterwards, because a failure with a long
 * cause printed under it would push the sentence out of twenty lines.
 */
function keepTrainerLine(run, line, fromStderr) {
  run.tail.push(fromStderr ? `${STDERR_MARK}${line}` : line);
  if (run.tail.length > TAIL_LINES) run.tail.shift();
  if (!fromStderr || line.trim() === '') return;
  run.lastStderr = line.trim();
  if (/^train-nerves: /.test(line)) run.said = line.trim();
  else if (/^(\w*Error\b|FATAL ERROR)/.test(line)) run.thrown = line.trim();
}

/**
 * Why the server's trainer is not running, in a line, or null when there is nothing to explain:
 * it is running, it was asked to stop, or it finished cleanly. A stop somebody asked for ends in
 * a signal or in 130, and is not an error however it ended.
 *
 * This is what makes "the trainer refuses on start and the status says so" true. A recipe the
 * dashboard cannot check -- a scenario that is not there -- used to start a trainer that refused it
 * at once, into a terminal nobody was watching, while the studio said "Not training".
 */
function stopReason(run) {
  if (!gone(run.trainer) || run.stopRequested) return null;
  const { exitCode, signalCode } = run.trainer;
  if (exitCode === 0) return null;
  // A signal nobody here sent -- `kill -9`, the out-of-memory killer -- is itself the reason:
  // whatever the trainer last wrote to stderr was written before it, and is not why it went.
  const reason =
    run.said ??
    run.thrown ??
    (signalCode
      ? `was killed by ${signalCode}`
      : (run.lastStderr ?? `exited with code ${exitCode}`));
  return reason.length > REASON_LENGTH ? `${reason.slice(0, REASON_LENGTH - 1)}…` : reason;
}

/**
 * The progress record `GET /train/status` passes on, with what the page and the studio need to
 * say how far along a run is: its last generation, the one it means to stop at, its pace, what it
 * last said of itself, and its recipe in a line. A record from before these were kept sends
 * nulls, and the readers say the plain generation, as they did.
 */
function latestProjection(name, latest) {
  const generation = lastGeneration(latest);
  return {
    name: latest.name ?? name,
    updated: latest.updated,
    episodes: latest.episodes,
    best: latest.best,
    profile: latest.profile ?? null,
    generation,
    // What this field has always been called, now the last generation rather than the number of
    // rows -- which, for a run resumed at 500, read 1 at generation 501.
    generations: generation,
    series: (latest.series ?? []).slice(-200),
    target: latest.target ?? null,
    secondsPerGeneration: latest.secondsPerGeneration ?? null,
    state: latest.state ?? null,
    startedAt: latest.startedAt ?? null,
    recipeSummary: recipeSummary(latest.recipe),
  };
}

function trainStatus() {
  const running = training !== null && !gone(training.trainer);
  // The showcase plays the run on the bridge and outlives the trainer, so it is said
  // separately: while it is up there is still something for Stop to stop. `null` means it has
  // been asked for and not yet spawned, which counts as up.
  const showcase = training !== null && (training.showcase === null || !gone(training.showcase));
  const error = training ? stopReason(training) : null;
  // Whose record to show: this server's run while there is anything of it to say -- it is going,
  // its showcase is, or it stopped with an error -- and otherwise whichever run wrote last, which
  // is a run started from a terminal as readily as one of this server's. This used to read
  // `stand` whenever the server had started nothing, whatever had actually been training.
  const ours = training !== null && (running || showcase || error !== null);
  const name = ours ? training.name : newestRun();
  let latest = name ? readJson(runFile(name, 'latest')) : null;
  // A record from before this run started is the last run's under the same name, not this one's:
  // shown as this run's, a run that died on start looked as if it had trained for hours.
  if (ours && latest && !(Date.parse(latest.startedAt ?? '') >= Date.parse(training.startedAt))) {
    latest = null;
  }
  return {
    running,
    showcase,
    elsewhere: !running && trainerElsewhere(),
    startedAt: training?.startedAt ?? null,
    task: training?.task ?? null,
    name: training?.name ?? null,
    // What it exited with, or the signal that took it: either answers "why is it not running".
    exit:
      training && !running
        ? (training.trainer.exitCode ?? training.trainer.signalCode ?? null)
        : null,
    error,
    tail: training ? [...training.tail] : [],
    checkout: CHECKOUT,
    latest: latest && name ? latestProjection(name, latest) : null,
  };
}
const number = (v, fallback, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
};
/** Whether any trainer is running on this machine, this server's or a terminal's. */
function trainerElsewhere() {
  try {
    const out = execSync('pgrep -f tools/train/bin/train-nerves.mjs', { encoding: 'utf8' });
    return (
      out
        .split('\n')
        .filter((line) => line.trim() !== '' && Number(line) !== process.pid)
        .filter((line) => Number(line) !== training?.trainer.pid).length > 0
    );
  } catch {
    return false; // pgrep found nothing.
  }
}
/** A file under a checkpoint's name, parsed; undefined when there is none. Throws when there is
 * one that cannot be read, which the request is then refused with rather than guessed around. */
function readSaved(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path} is there and cannot be read: ${e instanceof Error ? e.message : e}`);
  }
}
function trainStart(body) {
  // The same trap as everywhere else, and the one that bit hardest: a run stopped by a signal
  // left `exitCode` null, so this refused every later Start with "a run is already going" while
  // Stop refused to stop the thing that was not there. Both symptoms, one wrong question.
  if (training && !gone(training.trainer)) return { status: 409, error: 'a run is already going' };
  if (trainerElsewhere())
    return {
      status: 409,
      error: 'a trainer is already running on this machine, started from a terminal',
    };
  // Everything is checked before anything is written: a refused request leaves every file under
  // its name as it found it, the recipe file included.
  const asked = recipeFrom(body);
  if ('error' in asked) return asked;
  const { recipe, clamped } = asked;
  const { task, name } = recipe;
  // A name is a checkpoint: starting afresh under one that exists would overwrite it. Resume
  // continues it instead -- its weights, under the recipe this request sends, which is how a
  // policy is carried from one body to another -- and the response lists every way that recipe
  // differs from the one the checkpoint was saved with, so nobody does that without seeing it.
  const policyPath = join(POLICIES, `${name}.json`);
  if (existsSync(policyPath) && !body.resume) {
    return {
      status: 409,
      error: `a checkpoint named ${name} exists; tick Resume to continue it, or choose another name`,
    };
  }
  let recipeChanges;
  if (body.resume) {
    const preflight = resumePreflight(recipe, {
      policy: readSaved(policyPath),
      centre: readSaved(join(RUNS, `${name}-centre.json`)),
    });
    if ('error' in preflight) return preflight;
    recipeChanges = preflight.recipeChanges;
  }
  const recipePath = join(RUNS, `${name}-recipe.json`);
  writeFileSync(recipePath, `${JSON.stringify(recipe, null, 2)}\n`);
  const args = [
    join(ROOT, 'tools/train/bin/train-nerves.mjs'),
    '--recipe',
    recipePath,
    '--generations',
    String(number(body.generations, UI_RUN_DEFAULTS.generations, 1, 100000)),
    '--population',
    String(number(body.population, UI_RUN_DEFAULTS.population, 2, 1024) & ~1),
    '--workers',
    String(number(body.workers, 16, 1, 128)),
    '--seconds',
    String(number(body.seconds, SEARCH_DEFAULTS.seconds, 1, 60)),
    '--seeds',
    String(number(body.seeds, SEARCH_DEFAULTS.seeds, 1, 16)),
  ];
  if (body.resume) args.push('--resume');
  // Piped rather than inherited, so every line is labelled with whose it is and the trainer's last
  // lines are kept for the status. The trainer ignores a closed pipe (EPIPE) rather than dying of
  // it, so a dashboard stopped mid-run does not take the centre of the generation in progress
  // with it.
  const trainer = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The old showcase has to be gone before the new one starts, not merely asked to go: the two
  // publish to one bridge, and the new one's first act is to wipe the files the old one is still
  // writing. The bridge refuses a second publisher anyway, so overlapping them just means the
  // new one refuses to start.
  const previous = training?.showcase;
  if (previous && !gone(previous)) previous.kill('SIGINT');
  const showcase = () => {
    const child = spawn(
      process.execPath,
      [join(ROOT, 'tools/train/bin/showcase.mjs'), '--recipe', recipePath],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    relay(child, 'showcase');
    return child;
  };
  const started =
    previous && !gone(previous)
      ? new Promise((resolve) => {
          const go = () => resolve(showcase());
          previous.once('exit', go);
          // It is being asked to save what it has; a showcase that will not go is killed outright
          // rather than left to fight the new one for the bridge.
          setTimeout(() => {
            if (!gone(previous)) previous.kill('SIGKILL');
          }, 3000).unref?.();
        })
      : Promise.resolve(showcase());
  training = {
    task,
    name,
    recipe,
    trainer,
    showcase: null,
    startedAt: new Date().toISOString(),
    /** Set by Stop, so a run somebody stopped is not reported as one that failed. */
    stopRequested: false,
    /** The trainer's last lines, stderr marked, and the ones that would say why it stopped. */
    tail: [],
    said: undefined,
    thrown: undefined,
    lastStderr: undefined,
  };
  const mine = training;
  relay(trainer, 'train', (line, fromStderr) => keepTrainerLine(mine, line, fromStderr));
  void started.then((child) => {
    // A run stopped while its showcase was still starting does not want it after all.
    if (training !== mine) {
      child.kill('SIGINT');
      return;
    }
    mine.showcase = child;
  });
  return { started: true, task, name, recipe, clamped, recipeChanges, args: args.slice(1) };
}
function trainStop() {
  if (!training) return { stopped: false };
  // Before any signal: however the trainer then ends -- 130 from the second interrupt, SIGKILL
  // from the third -- it ended because it was asked to, and the status says no error.
  training.stopRequested = true;
  // SIGINT, so the trainer saves its centre and record on the way out. The showcase is stopped
  // whether or not the trainer is still up: it is what keeps publishing, and what a studio that
  // is following the bridge is following.
  let stopped = false;
  const ask = (child) => {
    if (gone(child)) return;
    child.kill('SIGINT');
    stopped = true;
    // Three lines, softest first. The first interrupt asks the trainer to finish the generation
    // it is in and write its centre, which is seconds. The second tells it to go now, losing
    // that generation but still leaving on its own terms. The third is for a process that has
    // wedged: a run nobody can stop is worse than a run that lost its last generation.
    setTimeout(() => {
      if (!gone(child)) child.kill('SIGINT');
    }, 8000).unref?.();
    setTimeout(() => {
      if (!gone(child)) child.kill('SIGKILL');
    }, 15000).unref?.();
  };
  ask(training.trainer);
  if (training.showcase) ask(training.showcase);
  return { stopped };
}
process.on('exit', () => {
  if (training) trainStop();
});

const bridgeFiles = {
  '/bridge/pose': ['', 'application/octet-stream'],
  '/bridge/pose.json': ['.json', 'application/json'],
  '/bridge/muscles': ['-muscles', 'application/octet-stream'],
  '/bridge/status': ['-status.json', 'application/json'],
};
/**
 * Answer one request. Everything a request can make this server do is in here, behind the Host
 * and Origin check at the top, and nothing in here is allowed to throw out of it: an exception
 * that escaped the handler used to take the whole server down, and with it a run's showcase.
 */
function serve(request, response) {
  // Only the Origin the browser sent is echoed, and only when it is allowed; a request from no
  // page gets no allow-origin at all, because it has no use for one.
  const origin = request.headers.origin;
  const cors = corsHeaders(origin);
  const json = (status, value) => {
    response.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...cors,
    });
    response.end(JSON.stringify(value));
  };
  const refused = refusal({ host: request.headers.host, origin }, port);
  if (refused) {
    const { status, ...body } = refused;
    return json(status, body);
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, POST' }).end();
    return;
  }
  if (url.pathname === '/policies') return json(200, { policies: listPolicies() });
  if (url.pathname.startsWith('/policies/')) {
    // One policy file, by the id the list gave.
    const rel = decodeURIComponent(url.pathname.slice('/policies/'.length));
    const full = join(dataHome(), normalize(rel));
    const allowed = full.startsWith(POLICIES) || full.startsWith(RUNS);
    if (!allowed || !existsSync(full) || !full.endsWith('.json'))
      return json(404, { error: 'no such policy' });
    response.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...cors,
    });
    response.end(readFileSync(full));
    return;
  }
  if (url.pathname === '/train/status') return json(200, trainStatus());
  // No content type is asked of Stop: the studio's Stop posts nothing, and the Origin check above
  // is what keeps other pages from posting it.
  if (url.pathname === '/train/stop' && request.method === 'POST') return json(200, trainStop());
  if (url.pathname === '/train/start' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10000) request.destroy();
    });
    request.on('end', () => {
      try {
        // A refusal carries its own status: 400 for a request that is not a run -- a name that is
        // not a checkpoint name, a task the rig does not score -- and 409 for one that is, but
        // cannot start now or cannot continue what it names. The status is for the reply's line,
        // not its body.
        const { status, ...result } = trainStart(JSON.parse(body || '{}'));
        json(status ?? (result.error ? 409 : 200), result);
      } catch (e) {
        json(400, { error: String(e) });
      }
    });
    return;
  }
  // The bridge files, for a studio that follows a publisher from a browser tab: the same bytes
  // the headset reads, over localhost, with the seqlock's checks done by the reader.
  const bridge = bridgeFiles[url.pathname];
  if (bridge) {
    const [suffix, type] = bridge;
    if (!existsSync(`${BRIDGE}${suffix}`)) {
      response.writeHead(404, cors).end('no publisher');
      return;
    }
    response.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      ...cors,
    });
    response.end(readFileSync(`${BRIDGE}${suffix}`));
    return;
  }
  // The run files -- the activity the studio draws the brain from, the pose, the history --
  // live in the data directory now, not under the repository. This used to serve them from
  // `tools/train/runs`, which after the move held only what was there before it: a live run
  // 404ed, and a run whose name matched an old one served a picture of a brain from weeks ago.
  //
  // `/runs` itself is the list of them, asked before the files so the one path cannot be read as
  // the other. A run's history, `<name>-<started>.jsonl`, is served beside its other files, as
  // newline-delimited JSON: the list names them, and a history read a month later says what
  // produced it in its first line.
  if (url.pathname === '/runs') return json(200, listRuns());
  if (url.pathname.startsWith('/runs/')) {
    const name = normalize(url.pathname.slice('/runs/'.length)).replace(/^[/.]+/, '');
    const full = join(RUNS, name);
    const history = name.endsWith('.jsonl');
    if (!full.startsWith(RUNS) || !(history || name.endsWith('.json')) || !existsSync(full)) {
      response.writeHead(404, cors).end('not here');
      return;
    }
    response.writeHead(200, {
      'content-type': history ? 'application/x-ndjson' : 'application/json',
      'cache-control': 'no-store',
      ...cors,
    });
    response.end(readFileSync(full));
    return;
  }
  // The page itself, and nothing else. This used to serve whatever lay under `tools/train` by
  // path -- its package.json, its sources -- and the path of a directory there threw EISDIR out
  // of the handler, which stopped the server.
  if (url.pathname === '/' || url.pathname === '/dashboard.html') {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...cors,
    });
    response.end(readFileSync(PAGE));
    return;
  }
  response.writeHead(404, cors).end('not here');
}

const server = createServer((request, response) => {
  try {
    serve(request, response);
  } catch (e) {
    // A request the handler could not answer -- a malformed escape in a policy id, a file gone
    // between the check and the read -- is that request's failure, not the server's.
    if (response.headersSent) response.destroy();
    else
      response
        .writeHead(500, {
          'content-type': 'application/json',
          ...corsHeaders(request.headers.origin),
        })
        .end(JSON.stringify({ error: String(e) }));
  }
});
// A second dashboard -- from another worktree, most often -- used to die here with a stack trace
// about EADDRINUSE, and the one already listening went on serving the other checkout's code to a
// studio that thought it was talking to this one. Said in one line, with the two ways out.
server.on('error', (e) => {
  if (e?.code !== 'EADDRINUSE') throw e;
  console.error(
    `port ${port} is taken, probably by a dashboard from another checkout ` +
      `(see http://localhost:${port}/train/status); stop it, or pass a port: ` +
      `pnpm train:dashboard ${port + 1}`,
  );
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  const at = CHECKOUT.branch || CHECKOUT.commit ? ` (${CHECKOUT.branch}@${CHECKOUT.commit})` : '';
  console.log(`dashboard: http://localhost:${port}/ -- serving ${CHECKOUT.root}${at}`);
});
