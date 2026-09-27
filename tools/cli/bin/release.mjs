#!/usr/bin/env node
/**
 * Builds a Linux release: the tarball and the AppImage, their checksums, and nothing published.
 *
 *   pnpm release:linux                              # the whole release, into dist-release/
 *   node tools/cli/bin/release.mjs --check-versions # only that every file agrees on the version
 *
 * A release used to be assembled by hand from whatever the builds left behind, and a hand-made
 * one is whatever its maker remembered: the v0.2.0 tarball held the studio, its licence and a
 * README saying the mesh pack was built in -- true of the studio, not of the viewer Connect VR
 * launches, which reads the pack from disk -- and neither the viewer, nor the pack, nor the pack's
 * own CC BY-SA licence and notice. This script is the one way to make the two files, so every
 * release has the same layout.
 *
 * The version is written in six places: the root package.json, tauri.conf.json (which names the
 * binary and the AppImage), both crates' Cargo.toml and both Cargo.lock files, whose entry for the
 * crate itself cargo rewrites only when it next resolves. Nothing makes them agree, and a bump
 * that misses one ships an AppImage named for one release carrying a viewer that reports another.
 * `--check-versions` reads all six and names every file that differs from package.json; CI runs
 * it on every push, because it is cheap and the mistake is easy.
 *
 * The full run refuses a working tree with uncommitted changes, because a release is a commit and
 * a build of edits nobody committed cannot be rebuilt or traced. It warns, and carries on, when
 * HEAD is not tagged v<version>: building before tagging is how a release is checked. Then:
 *
 * 1. `pnpm desktop:build`. The binary, the viewer sidecar beside it (desktop-sidecar.mjs builds it
 *    and asks rustc for the triple Tauri wants) and the bundle resources beside that, in
 *    apps/studio/src-tauri/target/release. The studio's dist is built fresh by Tauri's
 *    beforeBuildCommand, and the Align tab's reference meshes go into it from the vite plugin.
 * 2. The tarball is staged and packed from that, before step 3, because step 3 changes it: the
 *    AppImage bundler patches the binary in target/release in place, to record that it is an
 *    AppImage. Staged after it, the tarball's studio would say it was an AppImage too.
 * 3. `pnpm desktop:appimage`, and the AppImage is copied beside the tarball.
 * 4. SHA256SUMS beside them, printed as well.
 *
 * The tarball holds the studio and the viewer; every file tauri.conf.json's bundle.resources
 * carries, at the path it gives there (the mesh pack in assets-anatomical/data, and the pack's own
 * LICENSE and NOTICE in assets-anatomical/), so the tarball and the AppImage carry the same data;
 * the repository's LICENSE and NOTICE; and a README.txt from desktop-tarball-readme.txt. Every
 * input is checked before anything is written, so a missing one stops the run with the whole list
 * rather than producing a tarball short of a file nobody notices until Connect VR is pressed.
 *
 * Publishing is not here. Tagging, pushing and uploading are done by hand from what this prints.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const tauri = join(root, 'apps/studio/src-tauri');
const release = join(tauri, 'target/release');
const out = join(root, 'dist-release');

function fail(message) {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
}

function warn(message) {
  process.stderr.write(`release: warning: ${message}\n`);
}

function readText(relative) {
  const path = join(root, relative);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8');
}

/**
 * The `version` of a Cargo.toml's [package] table, and its `name`, read by line rather than by a
 * TOML parser, which the repository does not carry: the table starts at `[package]` and ends at
 * the next table header, and cargo writes both keys as plain `key = "value"` lines.
 */
function cargoPackage(text) {
  const found = {};
  let inPackage = false;
  for (const line of text.split('\n')) {
    const header = /^\s*\[([^\]]*)\]/.exec(line);
    if (header) {
      inPackage = header[1].trim() === 'package';
      continue;
    }
    if (!inPackage) continue;
    const pair = /^\s*(name|version)\s*=\s*"([^"]*)"/.exec(line);
    if (pair) found[pair[1]] = pair[2];
  }
  return found;
}

/**
 * The version a Cargo.lock records for one crate. Every entry is a `[[package]]` block that opens
 * with its name and then its version, which is the one shape cargo writes.
 */
function lockedVersion(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\[\\[package\\]\\]\\s*name = "${escaped}"\\s*version = "([^"]*)"`).exec(
    text,
  )?.[1];
}

/**
 * Every file that carries the version, with what it says. `undefined` where the file or the
 * entry is missing, which is a mismatch like any other: a lock file with no entry for its own
 * crate says nothing about the release, and that is worth knowing too.
 */
function versionsOnDisk() {
  const found = [];
  const pkg = readText('package.json');
  found.push(['package.json', pkg === undefined ? undefined : JSON.parse(pkg).version]);
  const conf = readText('apps/studio/src-tauri/tauri.conf.json');
  found.push([
    'apps/studio/src-tauri/tauri.conf.json',
    conf === undefined ? undefined : JSON.parse(conf).version,
  ]);
  for (const crate of ['apps/studio/src-tauri', 'apps/xr-viewer']) {
    const manifest = readText(`${crate}/Cargo.toml`);
    const { name, version } = manifest === undefined ? {} : cargoPackage(manifest);
    found.push([`${crate}/Cargo.toml`, version]);
    const lock = readText(`${crate}/Cargo.lock`);
    found.push([
      `${crate}/Cargo.lock`,
      lock === undefined || name === undefined ? undefined : lockedVersion(lock, name),
    ]);
  }
  return found;
}

/** The root package.json's version, after checking every other file says the same. */
function checkVersions() {
  const found = versionsOnDisk();
  const [, version] = found[0];
  if (typeof version !== 'string' || version === '') fail('package.json has no version');
  const wrong = found.filter(([, said]) => said !== version);
  if (wrong.length > 0) {
    fail(
      `package.json says ${version}, and ${wrong.length === 1 ? 'one file does' : `${wrong.length} files do`} not:\n` +
        wrong
          .map(([file, said]) => `  ${file}: ${said === undefined ? 'no version found' : said}`)
          .join('\n') +
        '\nSet every one to the same version. A Cargo.lock follows its Cargo.toml the next time' +
        ' cargo builds that crate.',
    );
  }
  return version;
}

function run(command, args) {
  process.stdout.write(`release: ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status}`);
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) fail(`could not run git: ${result.error.message}`);
  if (result.status !== 0) fail(`git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const version = checkVersions();
if (process.argv.includes('--check-versions')) {
  process.stdout.write(`release: every file says ${version}\n`);
  process.exit(0);
}

// The binaries are built for the machine this runs on, and the file names say which one that is:
// `uname -m`'s spelling in the tarball, as Linux archives are usually named. Tauri names the
// AppImage in Debian's spelling (amd64) itself, and that name is taken as Tauri writes it.
const ARCH = { x64: 'x86_64', arm64: 'aarch64' };
const arch = ARCH[process.arch];
if (process.platform !== 'linux' || arch === undefined) {
  fail(`this builds the Linux release, and this is ${process.platform}-${process.arch}`);
}

// Tauri and desktop-sidecar.mjs both build into each crate's own target/ unless this is set, and
// this script and the sidecar step read from there. With it set, the fresh build lands elsewhere
// and a binary left in target/release by an older build would be what got packed.
if (process.env.CARGO_TARGET_DIR) {
  fail(
    "CARGO_TARGET_DIR is set, and a release is read from each crate's own target/ directory. " +
      'Unset it for this run.',
  );
}

const dirty = git(['status', '--porcelain']);
if (dirty.trim() !== '') {
  fail(
    `the working tree has changes that are not committed, so the build would not be the commit:\n${dirty}` +
      'Commit or set them aside first.',
  );
}
const tag = `v${version}`;
if (!git(['tag', '--points-at', 'HEAD']).split('\n').includes(tag)) {
  warn(`HEAD is not tagged ${tag}: this is a build of ${version} that no tag points at yet`);
}

const conf = JSON.parse(readFileSync(join(tauri, 'tauri.conf.json'), 'utf8'));
const product = conf.productName;
const resources = conf.bundle?.resources;
if (resources === null || typeof resources !== 'object' || Array.isArray(resources)) {
  // The list form of bundle.resources keeps each file's relative path, which for these files
  // outside the crate is `_up_/_up_/...`; the map form is the one that says where each one goes.
  fail('tauri.conf.json bundle.resources is not a map of source to destination');
}

const name = `${product}-${version}-linux-${arch}`;
const stage = join(out, 'stage', name);
const archive = join(out, `${name}.tar.gz`);
const sums = join(out, 'SHA256SUMS');
const appImageDir = join(release, 'bundle/appimage');
const appImagePrefix = `${product}_${version}_`;

// This release's files go before anything is built, so a run that fails leaves none of them
// rather than an older build under the same names looking like the result. Other releases' files
// in dist-release/ are left alone.
mkdirSync(out, { recursive: true });
rmSync(archive, { force: true });
rmSync(sums, { force: true });
for (const file of readdirSync(out)) {
  if (file.startsWith(appImagePrefix) && file.endsWith('.AppImage')) rmSync(join(out, file));
}
rmSync(join(out, 'stage'), { recursive: true, force: true });

run('pnpm', ['desktop:build']);

// [source, path inside the tarball]. The viewer and the resources are taken from where `tauri
// build` copied them beside the studio, the same sidecar and resources the AppImage carries,
// rather than from their own packages, so the tarball holds what was built with this binary.
const files = [
  [join(release, product), product],
  [join(release, 'bs-humany-xr-viewer'), 'bs-humany-xr-viewer'],
  ...Object.values(resources).map((inside) => [join(release, inside), inside]),
  [join(root, 'LICENSE'), 'LICENSE'],
  [join(root, 'NOTICE'), 'NOTICE'],
];
const readme = join(root, 'tools/cli/bin/desktop-tarball-readme.txt');

// The pack is CC BY-SA, and passing its licence and notice on is the condition of passing the pack
// on, so a resources map that stopped carrying them is a release that must not be built.
for (const required of ['assets-anatomical/LICENSE', 'assets-anatomical/NOTICE']) {
  if (!files.some(([, inside]) => inside === required)) {
    fail(`tauri.conf.json bundle.resources no longer carries ${required}, which the pack needs`);
  }
}

const missing = [...files.map(([source]) => source), readme].filter((path) => !existsSync(path));
if (missing.length > 0) {
  fail(
    `desktop:build finished, but ${missing.length === 1 ? 'an input is' : `${missing.length} inputs are`} ` +
      `missing, so no tarball was written:\n${missing.map((path) => `  ${path}`).join('\n')}`,
  );
}

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
// unpacked on, and unpacked as root it would hand the files to whoever has that id there. Sorted,
// and dated to the commit rather than to the build, so two builds of one commit list the same
// entries in the same order with the same dates.
const committed = git(['log', '-1', '--format=%ct']).trim();
const tar = spawnSync(
  'tar',
  [
    'czf',
    archive,
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--sort=name',
    `--mtime=@${committed}`,
    '-C',
    dirname(stage),
    name,
  ],
  { stdio: 'inherit' },
);
if (tar.error) fail(`could not run tar: ${tar.error.message}`);
if (tar.status !== 0) fail(`tar exited with ${tar.status}`);

// The staged tree goes once the archive holds it, and stays only when tar failed, for looking at.
// Left in the working copy it is a second copy of the pack's JSON that `pnpm lint` walks into and
// fails on -- biome does not read .gitignore here -- and `tar tzf` shows the same thing.
rmSync(join(out, 'stage'), { recursive: true, force: true });

run('pnpm', ['desktop:appimage']);

const built = existsSync(appImageDir)
  ? readdirSync(appImageDir).filter(
      (file) => file.startsWith(appImagePrefix) && file.endsWith('.AppImage'),
    )
  : [];
if (built.length !== 1) {
  fail(
    `desktop:appimage finished, but ${appImageDir} holds ${built.length} AppImages named ` +
      `${appImagePrefix}*.AppImage where one was expected`,
  );
}
const appImage = join(out, built[0]);
copyFileSync(join(appImageDir, built[0]), appImage);

// In `sha256sum` format, with the bare file names, so `sha256sum -c SHA256SUMS` checks both from
// the directory they are downloaded into.
const lines = [archive, appImage].map((path) => `${sha256(path)}  ${basename(path)}`);
writeFileSync(sums, `${lines.join('\n')}\n`);
process.stdout.write(
  `release: ${product} ${version}, in ${out}\n${lines.map((line) => `  ${line}`).join('\n')}\n` +
    'Nothing was published. Tag, push and upload these by hand.\n',
);
