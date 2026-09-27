#!/usr/bin/env node
/**
 * Fetch the reference models' bone meshes from the pinned commit.
 *
 *   node tools/validate-external/fetch-meshes.mjs          # fetch what is missing
 *   node tools/validate-external/fetch-meshes.mjs --check  # verify, fetch nothing
 *
 * The XML alone says where every bone is and how the tree hangs together, which is enough to
 * measure with. It is not enough to *look* at: pairing our bones to theirs by eye wants their
 * bones on screen, not a stick figure standing in for them.
 *
 * Only the meshes the vendored models actually reference are taken -- 67 files, seven and a half
 * megabytes. The repository also carries prosthetic and exoskeleton parts, and a scene with a
 * logo in it, which come to four times as much and have nothing to do with a skeleton.
 *
 * Every file is verified against the commit rather than trusted: GitHub's blob id and git's
 * `hash-object` are the same hash, so a mismatch means the upstream file moved and the pin is
 * stale. A file that does not match is refused rather than written.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cliFlags } from '../cli/lib/args.mjs';
import { MYO_SIM_COMMIT as COMMIT, MODELS, MYO_SIM } from './src/models.mjs';

const MESHES = join(MYO_SIM, 'meshes');
const { check } = cliFlags('fetch-meshes');

/** Git's blob id for these bytes: `sha1("blob <length>\0" + content)`. */
const blobId = (bytes) =>
  createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest('hex');

// What the models ask for, read from their own asset files rather than listed here, so a model
// that starts using another bone is followed without anyone remembering to edit this. Which files
// those are is the registry's to say, and the two torso models share one.
const wanted = new Set();
for (const file of new Set(Object.values(MODELS).flatMap((m) => m.assets ?? []))) {
  const xml = readFileSync(join(MYO_SIM, file), 'utf8');
  for (const m of xml.matchAll(/file="([^"]+\.(?:stl|obj|msh))"/gi)) {
    wanted.add(basename(m[1]));
  }
}
console.log(`the vendored models reference ${wanted.size} meshes`);

const tree = await (
  await fetch(`https://api.github.com/repos/MyoHub/myo_sim/git/trees/${COMMIT}?recursive=1`)
).json();
if (!tree.tree) throw new Error(`could not read the tree at ${COMMIT}: ${tree.message ?? '?'}`);
const upstream = new Map();
for (const entry of tree.tree) {
  if (/\.(stl|obj|msh)$/i.test(entry.path)) upstream.set(basename(entry.path), entry);
}

mkdirSync(MESHES, { recursive: true });
let fetched = 0;
let verified = 0;
const problems = [];
for (const name of [...wanted].sort()) {
  const entry = upstream.get(name);
  if (!entry) {
    problems.push(`${name}: not in the repository at this commit`);
    continue;
  }
  const to = join(MESHES, name);
  if (existsSync(to)) {
    const id = blobId(readFileSync(to));
    if (id === entry.sha) verified += 1;
    else problems.push(`${name}: on disk but not the pinned commit's (${id} vs ${entry.sha})`);
    continue;
  }
  if (check) {
    problems.push(`${name}: missing`);
    continue;
  }
  const response = await fetch(
    `https://raw.githubusercontent.com/MyoHub/myo_sim/${COMMIT}/${entry.path}`,
  );
  if (!response.ok) {
    problems.push(`${name}: ${response.status}`);
    continue;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const id = blobId(bytes);
  if (id !== entry.sha) {
    problems.push(`${name}: fetched bytes are not the commit's (${id} vs ${entry.sha})`);
    continue;
  }
  writeFileSync(to, bytes);
  fetched += 1;
}

const total = readdirSync(MESHES).reduce((sum, f) => sum + readFileSync(join(MESHES, f)).length, 0);
console.log(
  `  ${fetched} fetched, ${verified} already here and byte-identical, ` +
    `${(total / 1048576).toFixed(1)} MB in meshes/`,
);
if (problems.length > 0) {
  console.log(`\n${problems.length} problems:`);
  for (const p of problems.slice(0, 12)) console.log(`  ${p}`);
  process.exit(1);
}
