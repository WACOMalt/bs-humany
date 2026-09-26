#!/usr/bin/env node
/**
 * Builds the VR viewer and puts it where the desktop shell's build expects to find it.
 *
 *   pnpm desktop:sidecar
 *
 * `tauri.conf.json` lists the viewer under `bundle.externalBin`, and Tauri resolves that entry to
 * `binaries/bs-humany-xr-viewer-<host triple>` and refuses to build without it -- in `tauri dev`
 * as much as in a release, because the check is in `tauri-build`, which every build of the crate
 * runs. The directory is gitignored, since it holds a build product, so on a fresh clone it does
 * not exist and `pnpm desktop:dev` stopped in `build.rs` with `resource path ... doesn't exist`
 * before a window ever opened. Every desktop script runs this first for that reason.
 *
 * The triple is asked of `rustc` rather than written down, because it is the host compiler's
 * triple that Tauri appends and a name spelled for one machine is a missing file on the next.
 * A placeholder file would satisfy the check as well, and is deliberately not what this does:
 * the shell looks beside its own executable first when it is asked to launch the viewer, Tauri
 * copies the sidecar there, and a placeholder would be what it launched.
 *
 * The copy goes through a temporary file and a rename. A viewer still running from the last
 * session has the old file open for execution, and writing into that file fails with ETXTBSY;
 * replacing the directory entry does not touch the running one.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const exe = process.platform === 'win32' ? '.exe' : '';

const build = spawnSync(
  'cargo',
  ['build', '--release', '--manifest-path', join(root, 'apps/xr-viewer/Cargo.toml')],
  { cwd: root, stdio: 'inherit' },
);
if (build.error) {
  process.stderr.write(`desktop:sidecar: could not run cargo: ${build.error.message}\n`);
  process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);

const rustc = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
const host = /^host:\s*(\S+)\s*$/m.exec(rustc.stdout ?? '')?.[1];
if (!host) {
  process.stderr.write('desktop:sidecar: `rustc -vV` did not report a host triple\n');
  process.exit(1);
}

const built = join(root, 'apps/xr-viewer/target/release', `bs-humany-xr-viewer${exe}`);
if (!existsSync(built)) {
  process.stderr.write(`desktop:sidecar: cargo finished but ${built} is not there\n`);
  process.exit(1);
}

const dir = join(root, 'apps/studio/src-tauri/binaries');
const target = join(dir, `bs-humany-xr-viewer-${host}${exe}`);
const temporary = `${target}.tmp`;
mkdirSync(dir, { recursive: true });
copyFileSync(built, temporary);
renameSync(temporary, target);
process.stdout.write(`desktop:sidecar: ${target}\n`);
