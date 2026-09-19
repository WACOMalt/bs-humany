#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const dir = join(ROOT, 'tools/train');
const port = Number(process.argv[2] ?? 5280);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.jsonl': 'text/plain',
};
const BRIDGE = '/dev/shm/bs-humany-pose';
const POLICIES = join(ROOT, 'packages/modules-nerves/policies');
const RUNS = join(ROOT, 'tools/train/runs');
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };

/** Every saved policy and every run's record and centre, with what their files say of them. */
function listPolicies() {
  const out = [];
  const read = (path, kind) => {
    try {
      const file = JSON.parse(readFileSync(path, 'utf8'));
      if (file.format !== 'bs-humany.policy/1') return;
      out.push({
        id: path.slice(ROOT.length),
        name: `${path.slice(path.lastIndexOf('/') + 1)}${kind ? ` (${kind})` : ''}`,
        task: file.task,
        profile: file.profile ?? null,
        sizes: file.sizes,
        trained: file.trained ?? null,
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
function trainStatus() {
  const running = training !== null && training.trainer.exitCode === null;
  let latest = null;
  try {
    latest = JSON.parse(
      readFileSync(join(RUNS, `${training?.task ?? 'stand'}-latest.json`), 'utf8'),
    );
  } catch {
    // No run has written yet.
  }
  return {
    running,
    startedAt: training?.startedAt ?? null,
    task: training?.task ?? null,
    exit: training && !running ? training.trainer.exitCode : null,
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
function trainStart(body) {
  if (training && training.trainer.exitCode === null) return { error: 'a run is already going' };
  const task = body.task === 'walk' ? 'walk' : 'stand';
  const args = [
    join(ROOT, 'tools/train/bin/train-nerves.mjs'),
    '--task',
    task,
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
    '--authority',
    String(Math.min(1, Math.max(0, Number(body.authority) || 0.3))),
  ];
  if (body.resume) args.push('--resume');
  const trainer = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const showcase = spawn(
    process.execPath,
    [join(ROOT, 'tools/train/bin/showcase.mjs'), '--task', task],
    {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  training = { task, trainer, showcase, startedAt: new Date().toISOString() };
  trainer.on('exit', () => {
    // The showcase keeps the last policy on the bridge; the studio can go on watching it.
  });
  return { started: true, task, args: args.slice(1) };
}
function trainStop() {
  if (!training) return { stopped: false };
  // SIGINT, so the trainer saves its centre and record on the way out.
  if (training.trainer.exitCode === null) training.trainer.kill('SIGINT');
  if (training.showcase.exitCode === null) training.showcase.kill('SIGINT');
  return { stopped: true };
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
    const full = join(ROOT, normalize(rel));
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
  const file =
    url.pathname === '/' ? 'dashboard.html' : normalize(url.pathname).replace(/^\/+/, '');
  const full = join(dir, file);
  if (!full.startsWith(dir) || !existsSync(full)) {
    response.writeHead(404).end('not here');
    return;
  }
  const ext = file.slice(file.lastIndexOf('.'));
  response.writeHead(200, {
    'content-type': types[ext] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  response.end(readFileSync(full));
}).listen(port, '127.0.0.1', () => console.log(`dashboard: http://localhost:${port}/`));
