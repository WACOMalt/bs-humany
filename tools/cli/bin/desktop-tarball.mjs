#!/usr/bin/env node
/**
 * Packs the release tarball out of what `pnpm desktop:build` left behind.
 *
 *   pnpm desktop:tarball      # desktop:build, then this
 *
 * The root README promises a tarball beside the AppImage on every release -- the studio, the VR
 * viewer, the mesh pack the viewer draws, and the attribution -- and until this there was no
 * script that made one. It was put together by hand, and a hand-made one is whatever its maker
 * remembered: the last held the studio, its licence and a README saying the mesh pack was built
 * in -- true of the studio, not of the viewer Connect VR launches, which reads the pack from disk
 * -- and neither the viewer, nor the pack, nor the pack's own CC BY-SA licence and notice.
 *
 * Everything staged is named in one list below and checked before anything is written, so a
 * missing input stops the script with the whole list of what is missing, rather than producing a
 * tarball that is short of a file nobody notices until a user presses Connect VR. The version is
 * the one `tauri.conf.json` gives the binary, which is what the AppImage is named after as well,
 * so the two files of a release cannot disagree about which release they are.
 *
 * The stage directory is emptied first. A file left over from an earlier release would otherwise
 * ride along in this one.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const tauri = join(root, 'apps/studio/src-tauri');
const release = join(tauri, 'target/release');

function fail(message) {
  process.stderr.write(`desktop:tarball: ${message}\n`);
  process.exit(1);
}

// The name says linux-x86_64 because that is what `desktop:build` produces on the machine these
// are built on. Built anywhere else it would be a correctly named archive of the wrong binaries.
if (process.platform !== 'linux' || process.arch !== 'x64') {
  fail(`the tarball is a linux-x86_64 build, and this is ${process.platform}-${process.arch}`);
}

const { version } = JSON.parse(readFileSync(join(tauri, 'tauri.conf.json'), 'utf8'));
if (typeof version !== 'string' || version === '') {
  fail('apps/studio/src-tauri/tauri.conf.json has no version');
}

const name = `bs-humany-studio-${version}-linux-x86_64`;
const out = join(root, 'dist-release');
const stage = join(out, 'stage', name);
const archive = join(out, `${name}.tar.gz`);

// [source, path inside the tarball]. The viewer and the pack are taken from where `tauri build`
// copied them beside the studio -- the same sidecar and resources the AppImage carries -- rather
// than from their own packages, so the tarball holds what was built with this binary.
const files = [
  [join(release, 'bs-humany-studio'), 'bs-humany-studio'],
  [join(release, 'bs-humany-xr-viewer'), 'bs-humany-xr-viewer'],
  [join(release, 'assets-anatomical/data/manifest.json'), 'assets-anatomical/data/manifest.json'],
  [join(release, 'assets-anatomical/data/skeleton.bin'), 'assets-anatomical/data/skeleton.bin'],
  [join(root, 'LICENSE'), 'LICENSE'],
  [join(root, 'NOTICE'), 'NOTICE'],
  [join(root, 'packages/assets-anatomical/LICENSE'), 'assets-anatomical/LICENSE'],
  [join(root, 'packages/assets-anatomical/NOTICE'), 'assets-anatomical/NOTICE'],
];
const readme = join(root, 'tools/cli/bin/desktop-tarball-readme.txt');

// The last run's archive goes before anything is checked, so a run that fails leaves no tarball
// rather than an older one under the same name looking like the result.
rmSync(archive, { force: true });

const missing = [...files.map(([source]) => source), readme].filter((path) => !existsSync(path));
if (missing.length > 0) {
  const unbuilt = missing.some((path) => path.startsWith(release));
  fail(
    `missing ${missing.length === 1 ? 'an input' : `${missing.length} inputs`}, ` +
      `so no tarball was written:\n${missing.map((path) => `  ${path}`).join('\n')}` +
      (unbuilt
        ? '\nRun `pnpm desktop:tarball` rather than this script alone: it builds those first.'
        : ''),
  );
}

rmSync(stage, { recursive: true, force: true });
for (const [source, inside] of files) {
  const target = join(stage, inside);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
writeFileSync(
  join(stage, 'README.txt'),
  readFileSync(readme, 'utf8').replaceAll('{{VERSION}}', version),
);

// Owned by nobody in particular: the build machine's user id means nothing on the machine it is
// unpacked on, and unpacked as root it would hand the files to whoever has that id there.
const tar = spawnSync(
  'tar',
  ['czf', archive, '--owner=0', '--group=0', '--numeric-owner', '-C', dirname(stage), name],
  { stdio: 'inherit' },
);
if (tar.error) fail(`could not run tar: ${tar.error.message}`);
if (tar.status !== 0) fail(`tar exited with ${tar.status}`);

// The staged tree goes once the archive holds it, and stays only when tar failed, for looking at.
// Left in the working copy it is a second copy of the pack's JSON that `pnpm lint` walks into and
// fails on -- biome does not read .gitignore here -- and `tar tzf` shows the same thing.
rmSync(join(out, 'stage'), { recursive: true, force: true });
process.stdout.write(`desktop:tarball: ${archive}\n`);
