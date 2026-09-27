import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Plugin, defineConfig } from 'vite';

/**
 * The vendored MyoSuite model the Align tab shows beside our own skeleton. Its bone meshes and its
 * licence are tracked here, byte-identical to the pinned commit (see that directory's README).
 */
const MYO_SIM = fileURLToPath(new URL('../../tools/validate-external/myo_sim', import.meta.url));

/** The URL prefix the Align tab fetches the meshes under, relative to the page. */
const PREFIX = '/refMeshes/';

/**
 * A mesh file name and nothing else: no directory, no separator, no `..` that could climb out.
 * The Align tab only ever asks for the names the reference models give their meshes.
 */
const MESH_NAME = /^[\w.-]+\.stl$/;

/**
 * Serves the Align tab's reference meshes from the tracked originals, and ships them with their
 * licence in every build.
 *
 * They used to be copied into `public/refMeshes` by hand, a copy that was ignored by git. Whether
 * a build carried the meshes then depended on whether whoever built it had remembered to make the
 * copy, so two builds of one commit could differ by 7.9 MB and the Align tab's bones, and the
 * copy carried no licence at all. Serving from the originals in development means there is no
 * copy to go stale, and copying them into every build from the same place means the desktop
 * app, the container and a plain `vite build` all ship the same files.
 *
 * The build copy includes MyoSuite's LICENSE. The meshes are Apache-2.0, which permits
 * redistribution on the condition that the licence goes with them; beside the files is where
 * somebody who finds them will look. On the web they are fetched only when somebody chooses a
 * reference model in the Align tab, so a studio nobody aligns anything in never loads them.
 */
function refMeshes(): Plugin {
  const meshes = join(MYO_SIM, 'meshes');
  let outDir = '';
  return {
    name: 'bs-humany:ref-meshes',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      // Registered directly rather than returned, so it runs before Vite's own static serving:
      // an old copy left in `public/refMeshes` would otherwise shadow the tracked originals.
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0] ?? '';
        if (!pathname.startsWith(PREFIX)) {
          next();
          return;
        }
        // The server's headers are applied by each of Vite's own middlewares, not to every
        // response, so a middleware of ours has to add them itself. The cross-origin isolation
        // headers matter here: a page that is isolated may not load a resource without them.
        for (const [key, value] of Object.entries(server.config.server.headers ?? {})) {
          if (value !== undefined) res.setHeader(key, value);
        }
        const file = meshFile(meshes, pathname.slice(PREFIX.length));
        if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
          // Anything else under the prefix is an answer of its own, never the app's index.html:
          // a page parsed as a mesh is how a missing file used to look like a present one.
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not a reference mesh.\n');
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'model/stl');
        res.setHeader('Content-Length', String(statSync(file).size));
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        createReadStream(file).pipe(res);
      });
    },
    writeBundle() {
      // A build ships what is tracked and nothing else. Vite has already copied `public/` in, so
      // any local copy of the meshes there is cleared first: the directory the build writes is
      // then the same on every machine, whatever was left lying in anybody's `public/`.
      const target = join(outDir, 'refMeshes');
      const files = readdirSync(meshes).filter((name) => MESH_NAME.test(name));
      const licence = join(MYO_SIM, 'LICENSE');
      if (files.length === 0 || !existsSync(licence)) {
        // The meshes and the licence are both in git, so either being absent is a broken
        // checkout. Failing here is better than shipping an Align tab without bones, or bones
        // without the licence they may only be redistributed with.
        throw new Error(
          `The Align tab's reference meshes or their LICENSE are missing from ${MYO_SIM}.`,
        );
      }
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      for (const name of files) copyFileSync(join(meshes, name), join(target, name));
      copyFileSync(licence, join(target, 'LICENSE'));
    },
  };
}

/**
 * The file a request under the prefix names, or null when it names no reference mesh. The name is
 * decoded first, so an encoded separator is held to the same pattern as a plain one.
 */
function meshFile(meshes: string, encoded: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (!MESH_NAME.test(name)) return null;
  const file = join(meshes, name);
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

/**
 * Dev server configuration.
 *
 * The cross-origin isolation headers are served even though nothing needs them yet. ADR-008
 * requires `SharedArrayBuffer` and MuJoCo's multi-threaded build to be *available*, and ADR-010
 * records that they cannot be *assumed*, because the platform floor is that `L0` runs on mobile.
 *
 * Serving the headers in development means the isolated path is the one being exercised daily, so
 * it cannot quietly rot; the non-isolated fallback is a first-class path that gets its own tests.
 * Discovering a missing header after the worker boundary is built is the expensive order to do
 * this in, and the specification calls it out as an easy thing to find far too late.
 */
export default defineConfig({
  plugins: [refMeshes()],
  server: {
    // Fixed, and it fails rather than moving. The desktop shell's `devUrl` names this port, and
    // a dev server that quietly moves to 5174 when 5173 is busy leaves `tauri dev` showing an
    // empty window with nothing to say why. A port already in use is the better error.
    port: 5173,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'es2022',
  },
  optimizeDeps: {
    // MuJoCo locates its .wasm next to its own module file; pre-bundling moves the module and
    // leaves the wasm behind. Served as-is, both stay together.
    exclude: ['@mujoco/mujoco'],
  },
});
