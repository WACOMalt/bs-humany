#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
/**
 * Serve the training dashboard: `tools/train/dashboard.html`, and the run files it polls.
 *
 *   pnpm train:dashboard          # http://localhost:5280/
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
const bridgeFiles = {
  '/bridge/pose': ['', 'application/octet-stream'],
  '/bridge/pose.json': ['.json', 'application/json'],
  '/bridge/muscles': ['-muscles', 'application/octet-stream'],
  '/bridge/status': ['-status.json', 'application/json'],
};
createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
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
