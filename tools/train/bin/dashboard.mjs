#!/usr/bin/env node
import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
/**
 * Serve the training dashboard: `tools/train/dashboard.html`, and the run files it polls.
 *
 *   pnpm train:dashboard          # http://localhost:5280/
 *
 * Also the studio's way to the brain: `GET /policies` lists the saved checkpoints, and
 * `POST /train/start`, `POST /train/stop` and `GET /train/status` start, stop and watch a
 * training run -- the trainer and the showcase, as the terminal would start them -- so the
 * brain panel in a browser tab can do what a terminal does on this machine. Bound to
 * 127.0.0.1 only; the only things it will ever spawn are those two scripts, with numeric
 * arguments checked here, and one run at a time.
 */
import { createServer } from 'node:http';
import { join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataHome, runsDir as runsHome, seedFromRepository } from './home.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const dir = join(ROOT, 'tools/train');
const port = Number(process.argv[2] ?? 5280);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.jsonl': 'text/plain',
};
const BRIDGE = '/dev/shm/bs-humany-pose';
// The same directory the trainer and the studio binary use, so all three see one set of
// checkpoints rather than three. The repository's own are copied in once on a fresh machine.
const POLICIES = seedFromRepository(join(ROOT, 'packages/modules-nerves/policies'));
const RUNS = runsHome();
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };

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
  if (existsSync(POLICIES))
    for (const f of readdirSync(POLICIES)) if (f.endsWith('.json')) read(join(POLICIES, f), '');
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

function trainStatus() {
  const running = training !== null && !gone(training.trainer);
  // The showcase plays the run on the bridge and outlives the trainer, so it is said separately:
  // while it is up there is still something for Stop to stop.
  // The showcase plays the run on the bridge and outlives the trainer, so it is said
  // separately: while it is up there is still something for Stop to stop. `null` means it has
  // been asked for and not yet spawned, which counts as up.
  const showcase = training !== null && (training.showcase === null || !gone(training.showcase));
  let latest = null;
  try {
    latest = JSON.parse(
      readFileSync(join(RUNS, `${training?.name ?? 'stand'}-latest.json`), 'utf8'),
    );
  } catch {
    // No run has written yet.
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
    latest: latest
      ? {
          updated: latest.updated,
          episodes: latest.episodes,
          best: latest.best,
          profile: latest.profile ?? null,
          generations: latest.series?.length ?? 0,
          series: (latest.series ?? []).slice(-200),
        }
      : null,
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
/** A checkpoint's name: a file stem, nothing that could leave the policies folder. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const PROFILES = ['l0_ragdoll', 'l1_standard', 'l2_biomechanical', 'l3_anatomical'];
/**
 * The recipe from the studio's request, every field checked: strings that are names or ids,
 * numbers that are finite, booleans that are booleans. What is not checked here -- that the
 * scenario exists, that its script exists when asked to play -- the trainer refuses on start and
 * the status says so.
 */
function recipeFrom(body) {
  const task = body.task === 'walk' ? 'walk' : body.task === 'balance' ? 'balance' : 'stand';
  const name = typeof body.name === 'string' && NAME.test(body.name) ? body.name : task;
  const r = body.recipe && typeof body.recipe === 'object' ? body.recipe : {};
  const finite = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const parameters = {};
  if (r.parameters && typeof r.parameters === 'object')
    for (const [k, v] of Object.entries(r.parameters))
      if (/^[\w-]{1,40}$/.test(k) && Number.isFinite(Number(v))) parameters[k] = Number(v);
  const proportions = {};
  if (r.morphology?.proportions && typeof r.morphology.proportions === 'object')
    for (const [k, v] of Object.entries(r.morphology.proportions))
      if (/^\w{1,40}$/.test(k) && Number.isFinite(Number(v))) proportions[k] = Number(v);
  const kind = r.feedforward?.kind;
  const feedforward =
    kind === 'script'
      ? { kind: 'script' }
      : kind === 'clip'
        ? {
            kind: 'clip',
            clip: /^[\w-]{1,40}$/.test(String(r.feedforward.clip))
              ? String(r.feedforward.clip)
              : 'quiet-standing',
          }
        : { kind: 'none' };
  return {
    name,
    task,
    scenario: typeof r.scenario === 'string' && /^[\w-]{0,40}$/.test(r.scenario) ? r.scenario : '',
    parameters,
    profile: PROFILES.includes(r.profile) ? r.profile : 'l3_anatomical',
    morphology: {
      sex: Math.min(1, Math.max(0, finite(r.morphology?.sex, 0.5))),
      stature: Math.min(2.5, Math.max(1, finite(r.morphology?.stature, 1.7))),
      mass: Math.min(300, Math.max(20, finite(r.morphology?.mass, 70))),
      ...(Object.keys(proportions).length ? { proportions } : {}),
    },
    passive: r.passive !== false,
    redistribute: r.redistribute !== false,
    feedforward,
    authority: Math.min(1, Math.max(0, finite(body.authority, 0.3))),
    // The tremor on the muscles and the grain on the senses. Capped well below the authority a
    // policy has, because noise that drowns the controller is not a disturbance to ride, it is
    // a body that cannot be controlled at all.
    noise: {
      motor: Math.min(0.5, Math.max(0, finite(r.noise?.motor, 0.05))),
      sense: Math.min(0.5, Math.max(0, finite(r.noise?.sense, 0.01))),
      tau: Math.min(5, Math.max(0.01, finite(r.noise?.tau, 0.25))),
    },
    // The cord under the brain. A stretch gain of zero is the body every checkpoint before the
    // spinal module was trained in, so it stays reachable; the delay is capped at a fifth of a
    // second because past that the loop is not a reflex arc, it is a correspondence.
    reflex: {
      stretch: Math.min(0.2, Math.max(0, finite(r.reflex?.stretch, 0))),
      velocity: Math.min(10, Math.max(0, finite(r.reflex?.velocity, 1))),
      setPoint: Math.min(0.5, Math.max(-0.5, finite(r.reflex?.setPoint, -0.1))),
      inhibition: Math.min(1, Math.max(0, finite(r.reflex?.inhibition, 0.3))),
      forceCeiling: Math.min(5, Math.max(0, finite(r.reflex?.forceCeiling, 1.2))),
      forceInhibition: Math.min(5, Math.max(0, finite(r.reflex?.forceInhibition, 0.5))),
      delaySeconds: Math.min(0.2, Math.max(0, finite(r.reflex?.delaySeconds, 0.03))),
    },
    // Context units. Capped because every one of them is a row and a column of new weights, and
    // the search's cost grows with the length of the vector it is searching.
    memory: Math.min(64, Math.max(0, Math.round(finite(r.memory, 0)))),
  };
}
function trainStart(body) {
  // The same trap as everywhere else, and the one that bit hardest: a run stopped by a signal
  // left `exitCode` null, so this refused every later Start with "a run is already going" while
  // Stop refused to stop the thing that was not there. Both symptoms, one wrong question.
  if (training && !gone(training.trainer)) return { error: 'a run is already going' };
  if (trainerElsewhere())
    return { error: 'a trainer is already running on this machine, started from a terminal' };
  const recipe = recipeFrom(body);
  const { task, name } = recipe;
  // A name is a checkpoint: starting afresh under one that exists would overwrite it. Resume
  // continues it instead, with the recipe it was saved with.
  const policyPath = join(POLICIES, `${name}.json`);
  if (existsSync(policyPath) && !body.resume) {
    return {
      error: `a checkpoint named ${name} exists; tick Resume to continue it, or choose another name`,
    };
  }
  const recipePath = join(RUNS, `${name}-recipe.json`);
  writeFileSync(recipePath, `${JSON.stringify(recipe, null, 2)}\n`);
  const args = [
    join(ROOT, 'tools/train/bin/train-nerves.mjs'),
    '--recipe',
    recipePath,
    '--generations',
    String(number(body.generations, 600, 1, 100000)),
    '--population',
    String(number(body.population, 64, 2, 1024) & ~1),
    '--workers',
    String(number(body.workers, 16, 1, 128)),
    '--seconds',
    String(number(body.seconds, 6, 1, 60)),
    '--seeds',
    String(number(body.seeds, 2, 1, 16)),
  ];
  if (body.resume) args.push('--resume');
  const trainer = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  // The old showcase has to be gone before the new one starts, not merely asked to go: the two
  // publish to one bridge, and the new one's first act is to wipe the files the old one is still
  // writing. The bridge refuses a second publisher anyway, so overlapping them just means the
  // new one refuses to start.
  const previous = training?.showcase;
  if (previous && !gone(previous)) previous.kill('SIGINT');
  const showcase = () =>
    spawn(process.execPath, [join(ROOT, 'tools/train/bin/showcase.mjs'), '--recipe', recipePath], {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
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
  training = { task, name, recipe, trainer, showcase: null, startedAt: new Date().toISOString() };
  const mine = training;
  void started.then((child) => {
    // A run stopped while its showcase was still starting does not want it after all.
    if (training !== mine) {
      child.kill('SIGINT');
      return;
    }
    mine.showcase = child;
  });
  trainer.on('exit', () => {
    // The showcase keeps the last policy on the bridge; the studio can go on watching it.
  });
  return { started: true, task, name, recipe, args: args.slice(1) };
}
function trainStop() {
  if (!training) return { stopped: false };
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
createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const json = (status, value) => {
    response.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...CORS,
    });
    response.end(JSON.stringify(value));
  };
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET, POST' }).end();
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
      ...CORS,
    });
    response.end(readFileSync(full));
    return;
  }
  if (url.pathname === '/train/status') return json(200, trainStatus());
  if (url.pathname === '/train/stop' && request.method === 'POST') return json(200, trainStop());
  if (url.pathname === '/train/start' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10000) request.destroy();
    });
    request.on('end', () => {
      try {
        const result = trainStart(JSON.parse(body || '{}'));
        json(result.error ? 409 : 200, result);
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
      response.writeHead(404, { 'access-control-allow-origin': '*' }).end('no publisher');
      return;
    }
    response.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    response.end(readFileSync(`${BRIDGE}${suffix}`));
    return;
  }
  // The run files -- the activity the studio draws the brain from, the pose, the history --
  // live in the data directory now, not under the repository. This used to serve them from
  // `tools/train/runs`, which after the move held only what was there before it: a live run
  // 404ed, and a run whose name matched an old one served a picture of a brain from weeks ago.
  if (url.pathname.startsWith('/runs/')) {
    const name = normalize(url.pathname.slice('/runs/'.length)).replace(/^[/.]+/, '');
    const full = join(RUNS, name);
    if (!full.startsWith(RUNS) || !name.endsWith('.json') || !existsSync(full)) {
      response.writeHead(404, CORS).end('not here');
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...CORS,
    });
    response.end(readFileSync(full));
    return;
  }
  const file =
    url.pathname === '/' ? 'dashboard.html' : normalize(url.pathname).replace(/^\/+/, '');
  const full = join(dir, file);
  if (!full.startsWith(dir) || !existsSync(full)) {
    response.writeHead(404).end('not here');
    return;
  }
  const ext = file.slice(file.lastIndexOf('.'));
  // CORS on the run files too: the studio draws the showcase's brain from `runs/<name>-activity
  // .json`, and it is served from its own origin.
  response.writeHead(200, {
    'content-type': types[ext] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    ...CORS,
  });
  response.end(readFileSync(full));
}).listen(port, '127.0.0.1', () => console.log(`dashboard: http://localhost:${port}/`));
