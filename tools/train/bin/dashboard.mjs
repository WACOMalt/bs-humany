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
createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
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
