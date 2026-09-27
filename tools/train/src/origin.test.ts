/**
 * Who the training dashboard answers.
 *
 * The dashboard starts and stops processes on this machine and hands out its checkpoints, and it
 * used to answer every web page with `access-control-allow-origin: *`. Listening on 127.0.0.1 did
 * not stop that: the browser that opens a stranger's page is on this machine too, so the page
 * could post to `localhost:5280/train/start` and read `/policies` like the studio does. What
 * stops it is the two checks held here -- the page's Origin, and the Host the request was sent
 * to -- so the cases that matter are pinned both ways: the studio's own origins pass, and the
 * look-alikes a hostile page could present do not.
 */

import { describe, expect, it } from 'vitest';
import { allowedHost, allowedOrigin, corsHeaders, refusal } from '../bin/origin.mjs';

describe('the origins the dashboard answers', () => {
  it.each([
    'http://localhost:5173', // the web studio under `pnpm dev`, and the desktop studio in dev
    'http://127.0.0.1:1420',
    'http://[::1]:4173',
    'https://localhost:8443',
    'http://localhost', // no port: the scheme's own
    'http://localhost:5280', // the dashboard's own page
    'tauri://localhost', // the desktop studio, built, on Linux and macOS
    'http://tauri.localhost', // ... and on Windows
    'https://tauri.localhost',
  ])('allows %s, and answers it with itself', (origin) => {
    expect(allowedOrigin(origin)).toBe(origin);
  });

  it.each([
    'https://evil.example',
    'http://localhost.evil.example', // starts like localhost, is not
    'http://evil.example:5173',
    'http://127.0.0.2:5173', // loopback, but not a name the studio is served on
    'null', // a sandboxed frame or a file:// page: not a place anyone can vouch for
    'file://',
    'ftp://localhost',
    'tauri://evil',
    'http://tauri.localhost.evil.example',
    'http://localhost:5173/', // an Origin is never a URL with a path
    'http://user@localhost:5173',
    'HTTP://LOCALHOST:5173', // browsers send the serialised form; anything else is not a browser
    '',
    'not a url',
  ])('refuses %s', (origin) => {
    expect(allowedOrigin(origin)).toBeNull();
  });

  it('treats a missing Origin as nothing to allow, which the request check lets through', () => {
    expect(allowedOrigin(undefined)).toBeNull();
    expect(allowedOrigin(null)).toBeNull();
  });
});

describe('the hosts the dashboard answers', () => {
  it.each(['localhost:5280', '127.0.0.1:5280', '[::1]:5280', 'LocalHost:5280'])(
    'allows %s on its own port',
    (host) => {
      expect(allowedHost(host, 5280)).toBe(true);
    },
  );

  it.each([
    'evil.example:5280', // a rebound name: resolves to 127.0.0.1, is not ours
    'localhost.evil.example:5280',
    'localhost:5281', // another port is another server
    'localhost', // no port on a port that is not 80
    '127.0.0.1',
    '',
    undefined,
  ])('refuses %s', (host) => {
    expect(allowedHost(host, 5280)).toBe(false);
  });

  it('takes a bare name only when the port is the scheme default', () => {
    expect(allowedHost('localhost', 80)).toBe(true);
    expect(allowedHost('localhost:80', 80)).toBe(true);
  });
});

describe('the check at the top of every request', () => {
  const port = 5280;

  it('lets a request with no Origin through, as curl and the command line send', () => {
    expect(refusal({ host: 'localhost:5280' }, port)).toBeNull();
    expect(refusal({ host: '127.0.0.1:5280', origin: undefined }, port)).toBeNull();
  });

  it('lets the studio through', () => {
    expect(refusal({ host: 'localhost:5280', origin: 'http://localhost:5173' }, port)).toBeNull();
    expect(refusal({ host: 'localhost:5280', origin: 'tauri://localhost' }, port)).toBeNull();
  });

  it('refuses another origin with 403, and says how the studio should be reached', () => {
    const r = refusal({ host: 'localhost:5280', origin: 'https://evil.example' }, port);
    expect(r?.status).toBe(403);
    expect(r?.error).toMatch(/origin/);
    expect(r?.hint).toBeTruthy();
  });

  it('refuses a rebound Host with 403 even when the Origin looks local', () => {
    // After a DNS rebinding the page's origin is its own name, which is refused anyway; the Host
    // check is the second lock, for a request whose Origin was stripped or never sent.
    const r = refusal({ host: 'evil.example:5280' }, port);
    expect(r?.status).toBe(403);
    expect(r?.error).toMatch(/host/);
    expect(
      refusal({ host: 'evil.example:5280', origin: 'http://localhost:5173' }, port)?.status,
    ).toBe(403);
  });

  it('refuses a request with no Host at all', () => {
    expect(refusal({}, port)?.status).toBe(403);
  });
});

describe('the CORS headers', () => {
  it('echoes an allowed origin and says the answer varies by origin', () => {
    const h = corsHeaders('http://localhost:5173');
    expect(h['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(h.vary).toBe('origin');
  });

  it('never answers with a wildcard, and names no origin when there is none to name', () => {
    for (const origin of [undefined, 'https://evil.example', 'null']) {
      const h = corsHeaders(origin);
      expect(h['access-control-allow-origin']).toBeUndefined();
      // Still `vary`: a cache must not hand the curl answer to a page, or the reverse.
      expect(h.vary).toBe('origin');
    }
  });
});
