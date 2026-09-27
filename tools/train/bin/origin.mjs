/**
 * Who the training dashboard answers: pages served from this machine, and requests from no page.
 *
 * The dashboard spawns processes, stops them and hands out checkpoints. Binding it to 127.0.0.1
 * keeps other machines out, but not other web pages: the browser a person reads a stranger's page
 * in runs on this machine as well, and will send that page's requests to localhost for it. So
 * what decides is what the browser says about who is asking.
 *
 *  - The Origin header names the page that made a request, and a page cannot forge it. The studio
 *    is served from a loopback address under `pnpm dev`, `vite preview`, the container run
 *    locally or the Tauri dev window, and from Tauri's own scheme once the desktop app is built,
 *    so those are the origins allowed. A request with no Origin at all is not from a page -- curl,
 *    the command line -- and is let through: those are already on the machine.
 *  - The Host header names the server the request was addressed to. A DNS-rebinding page gets
 *    its own name to resolve to 127.0.0.1, so its requests arrive here saying `Host: evil.example`.
 *    Only the loopback names on the dashboard's own port are answered, which closes that for a
 *    request whose Origin the check above could not see.
 *
 * Plain JavaScript, with no side effects, so the dashboard imports it as it is and a test can
 * hold it to the cases that matter.
 */

/** The loopback names a page, or a request, may use for this machine. `URL` keeps the brackets
 * on an IPv6 host, so `[::1]` is written with them. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The origins the built desktop studio is served from. Tauri 2 serves its pages under its own
 * scheme on Linux and macOS and under `http(s)://tauri.localhost` on Windows, where a custom
 * scheme cannot be registered with the webview; the https one is what `useHttpsScheme` gives.
 */
const TAURI = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);

/**
 * `origin` when it is one the dashboard answers, else null.
 *
 * It has to be exactly the serialised form a browser sends. Parsing and comparing the parsed
 * origin with the header refuses anything that only resembles one -- a path, a user, capitals --
 * because none of those comes from a browser, and `localhost.evil.example` is compared as the
 * whole host it is, not as a prefix.
 *
 * @param {string | null | undefined} origin
 * @returns {string | null}
 */
export function allowedOrigin(origin) {
  if (typeof origin !== 'string' || origin === '') return null;
  if (TAURI.has(origin)) return origin;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return null; // `null`, from a sandboxed frame or a file, is one of these.
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!LOOPBACK.has(url.hostname)) return null;
  return url.origin === origin ? origin : null;
}

/**
 * Whether a Host header is this dashboard on this machine: a loopback name with the port it
 * listens on. A bare name is taken only on port 80, the one case where a browser leaves the port
 * out. Names are compared without case, as DNS compares them.
 *
 * @param {string | undefined} host
 * @param {number} port
 * @returns {boolean}
 */
export function allowedHost(host, port) {
  if (typeof host !== 'string') return false;
  const lower = host.toLowerCase();
  for (const name of LOOPBACK) {
    if (lower === `${name}:${port}`) return true;
    if (port === 80 && lower === name) return true;
  }
  return false;
}

/**
 * Why a request is refused, or null to serve it. Checked before anything else a request does, so
 * that a refused page learns nothing and changes nothing: the Host first, then the Origin when
 * there is one.
 *
 * @param {{ host?: string, origin?: string }} request the two headers, as Node gives them
 * @param {number} port the port the dashboard listens on
 * @returns {{ status: number, error: string, hint: string } | null}
 */
export function refusal({ host, origin }, port) {
  if (!allowedHost(host, port)) {
    return {
      status: 403,
      error: `unexpected host ${JSON.stringify(host ?? '')}`,
      hint: `open the dashboard as http://localhost:${port} or http://127.0.0.1:${port}`,
    };
  }
  if (origin !== undefined && allowedOrigin(origin) === null) {
    return {
      status: 403,
      error: `origin ${JSON.stringify(origin)} not allowed`,
      hint: 'the dashboard answers pages served from localhost, 127.0.0.1 or [::1], and the desktop studio',
    };
  }
  return null;
}

/**
 * The CORS headers for a response to a request from `origin`.
 *
 * An allowed origin is echoed, never `*`: a wildcard is what let every page read the dashboard.
 * An echoed origin also satisfies a studio served with `Cross-Origin-Embedder-Policy:
 * require-corp`, whose fetches of the dashboard are CORS-mode. `vary: origin` goes on every
 * answer, including the ones that name no origin, so a cache can never hand one caller's answer
 * to another. `content-type` is allowed as a request header because the studio's Start posts JSON,
 * which a browser asks about in a preflight first.
 *
 * @param {string | undefined} origin
 * @returns {Record<string, string>}
 */
export function corsHeaders(origin) {
  const allowed = allowedOrigin(origin);
  return allowed === null
    ? { vary: 'origin' }
    : {
        'access-control-allow-origin': allowed,
        'access-control-allow-headers': 'content-type',
        vary: 'origin',
      };
}
