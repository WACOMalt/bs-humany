#!/usr/bin/env node
/**
 * Where every muscle of the reference models runs, in that model's own world.
 *
 *   pnpm extract:source-sites          # rewrite apps/studio/public/sourceSites.json
 *   pnpm extract:source-sites --check  # fail if the file is not what this would write
 *
 * ## What this is for
 *
 * The parameters come from MyoSuite and the geometry from Z-Anatomy, and nothing says which of
 * their muscles is which of ours. The names do not match -- their torso calls the external
 * obliques `EO1` to `EO6` where we have one `external_oblique` -- and the correspondence is not
 * one to one, so it cannot be computed. It has to be decided by someone looking at both.
 *
 * This is the half a machine can do: run each vendored model, and write out where every muscle
 * actually runs, as a polyline of world points in that model's own frame. The alignment tool
 * draws those beside ours so the pairing can be made by eye.
 *
 * Their bone meshes are vendored beside the XML, under `tools/validate-external/myo_sim/meshes`,
 * and this tool records which mesh each body wears and where; it does not copy them. The studio
 * serves them from `apps/studio/public/refMeshes`, which `pnpm sync:ref-meshes` fills with the
 * STLs, so the reference's bones can be drawn under its sites and paths.
 *
 * Positions are read from the loaded model rather than composed out of the XML by hand, because
 * the body tree nests and MuJoCo already knows how. The pose is the model's own neutral.
 *
 * ## Checked like every other generated file
 *
 * The file is committed, so it can fall behind the vendored models the same way generated muscle
 * data can fall behind its source; `pnpm check:generated` runs this with `--check` to catch it.
 * The output goes through Biome before it is written or compared: the committed file is held to
 * `pnpm lint`, and Biome lays JSON out differently from JSON.stringify, so formatting here makes a
 * write lint-clean as it stands and lets the check compare the exact bytes a write would produce.
 * A model that will not load fails the check outright rather than being left out of the
 * comparison, since a check that skipped it would pass on a file it never reproduced.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { MODELS, referenceArmXml } from '../../validate-external/src/referenceArm.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MYO_SIM = join(ROOT, 'tools/validate-external/myo_sim');
// Served rather than bundled: only the Align tab reads it, and it is a hundred kilobytes.
const OUT = join(ROOT, 'apps/studio/public/sourceSites.json');
const check = process.argv.includes('--check');

/**
 * The torso, which `referenceArm.mjs` does not list because nothing needed it until now. It is
 * rooted at the sacrum and stands on its own, unlike the four arm muscles whose paths end on a
 * trunk the arm model does not contain.
 */
const TORSO = {
  assets: 'myotorso_assets.xml',
  chain: 'myotorso_chain.xml',
  tendon: 'myotorso_tendon.xml',
  defaults: '<default class="main">',
  /**
   * The torso chain includes the head from a path that is relative to the layout of the upstream
   * repository, not to how it is vendored here. The file itself is vendored, beside the others,
   * so the include is pointed at where it actually is rather than dropped -- the head hangs off
   * the top of the cervical spine and several neck muscles end on it.
   */
  rewrite: (chain) =>
    chain.replace(/<include file="[^"]*myohead_rigid_chain\.xml"\s*\/>/g, () =>
      unwrapInclude(readFileSync(join(MYO_SIM, 'myohead_rigid_chain.xml'), 'utf8')),
    ),
};

/**
 * An included fragment, with its wrapper taken off so it can be spliced in, and everything this
 * tool does not read removed with it.
 *
 * Geoms go entirely: they name collision and mesh classes defined in that fragment's own
 * defaults, which are not spliced in beside it, and MuJoCo refuses a class it cannot resolve.
 * `childclass` goes for the same reason -- without it the bodies still nest exactly as stated
 * and inherit the including model's defaults instead. Sites and body transforms are what is
 * read here, and neither depends on any of it.
 */
const unwrapInclude = (xml) =>
  xml
    .replace(/<\/?mujocoinclude[^>]*>/g, '')
    .replace(/<geom[\s\S]*?\/>/g, '')
    .replace(/ childclass="[^"]*"/g, '')
    .replace(/ class="[^"]*"/g, '');
const ALL = { arm: MODELS.arm, legs: MODELS.legs, torso: TORSO };

const jiti = createJiti(
  new URL('../../../packages/backend-mujoco/src/index.ts', import.meta.url).href,
);
const mujoco = await (await jiti.import('@mujoco/mujoco')).default();

/** Every spatial tendon in a file, with the sites it runs through, in order. */
function tendonsOf(file) {
  const xml = readFileSync(join(MYO_SIM, file), 'utf8');
  const out = [];
  for (const block of xml.matchAll(/<spatial[\s\S]*?<\/spatial>/g)) {
    const name = /name="([^"]+)"/.exec(block[0])?.[1];
    if (!name) continue;
    const sites = [...block[0].matchAll(/<site site="([^"]+)"/g)].map((m) => m[1]);
    if (sites.length >= 2) out.push({ name, sites });
  }
  return out;
}

/**
 * Which mesh each body wears, and where.
 *
 * The chain says `<geom mesh="r_femur" .../>` inside a body and the asset file says
 * `<mesh file="meshes/r_femur.stl" name="r_femur"/>`, so the two together give a body its
 * bones. Read from the raw XML rather than the loaded model, because the loader is handed a
 * chain with every mesh geom stripped out -- their meshes are large and MuJoCo does not need
 * them to tell us where anything is.
 */
function meshesOf(spec) {
  const assets = readFileSync(join(MYO_SIM, spec.assets), 'utf8');
  const file = new Map();
  for (const m of assets.matchAll(/<mesh\b[^>]*\/>/g)) {
    const name = /name="([^"]+)"/.exec(m[0])?.[1];
    const path = /file="([^"]+)"/.exec(m[0])?.[1];
    if (name && path) file.set(name, path.split('/').pop());
  }
  // Walk the chain body by body, keeping the mesh geoms that sit inside each.
  const chain = readFileSync(join(MYO_SIM, spec.chain), 'utf8');
  const byBody = new Map();
  const bodyAt = [];
  const token = /<body\b[^>]*>|<\/body>|<geom\b[^>]*\/>/g;
  for (const m of chain.matchAll(token)) {
    const text = m[0];
    if (text.startsWith('</body')) {
      bodyAt.pop();
      continue;
    }
    if (text.startsWith('<body')) {
      bodyAt.push(/name="([^"]+)"/.exec(text)?.[1] ?? '');
      continue;
    }
    const mesh = /mesh="([^"]+)"/.exec(text)?.[1];
    const body = bodyAt[bodyAt.length - 1];
    if (!mesh || !body || !file.has(mesh)) continue;
    const pos = /\bpos="([^"]+)"/.exec(text)?.[1];
    const quat = /\bquat="([^"]+)"/.exec(text)?.[1];
    const list = byBody.get(body) ?? [];
    list.push({
      file: file.get(mesh),
      pos: pos ? pos.trim().split(/\s+/).map(Number) : [0, 0, 0],
      quat: quat ? quat.trim().split(/\s+/).map(Number) : [1, 0, 0, 0],
    });
    byBody.set(body, list);
  }
  return byBody;
}

const models = {};
let total = 0;
const unloaded = [];
for (const [key, spec] of Object.entries(ALL)) {
  const wearing = meshesOf(spec);
  const stated = tendonsOf(spec.tendon);
  // Some muscles cross out of the model that states them -- the arm's latissimus and pectoralis
  // end on a trunk the arm chain does not contain, and `referenceArm.mjs` explains why joining
  // the two chains is a piece of work rather than a line. Rather than curate a list that goes
  // stale when the vendored model moves, the sites the assembled chain actually carries are
  // read off it, and a tendon that wants one it has not got is dropped and counted.
  const assembled = referenceArmXml([], spec);
  const present = new Set([...assembled.matchAll(/<site[^>]*name="([^"]+)"/g)].map((m) => m[1]));
  const tendons = stated.filter((t) => t.sites.every((site) => present.has(site)));
  const dropped = stated.length - tendons.length;
  let model;
  try {
    model = mujoco.MjModel.from_xml_string(
      referenceArmXml(
        tendons.map((t) => t.name),
        spec,
      ),
    );
  } catch (error) {
    // A model that will not load standalone says so and is skipped rather than guessed at.
    console.log(`  ${key}: will not load on its own -- ${String(error).slice(0, 140)}`);
    unloaded.push(key);
    continue;
  }
  const data = new mujoco.MjData(model);
  mujoco.mj_forward(model, data);
  const xpos = data.site_xpos;
  const siteId = (name) => mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, name);
  const bodyOf = (id) => {
    const b = model.site_bodyid?.[id];
    return b === undefined ? null : mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY.value, b);
  };
  // The joints, by their world anchor at the neutral pose. These are what a retarget is
  // actually built from: a muscle path is only comparable once the two bodies agree about where
  // the hip is, and one rigid transform over a whole model can never make a shoulder and a hip
  // agree at the same time, because the proportions differ. That difference is the thing being
  // measured.
  const joints = [];
  for (let j = 0; j < model.njnt; j++) {
    const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT.value, j);
    if (!name) continue;
    const body = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY.value, model.jnt_bodyid[j]);
    joints.push({
      name,
      body: body ?? null,
      anchor: [
        Number(data.xanchor[3 * j].toFixed(5)),
        Number(data.xanchor[3 * j + 1].toFixed(5)),
        Number(data.xanchor[3 * j + 2].toFixed(5)),
      ],
      axis: [
        Number(data.xaxis[3 * j].toFixed(4)),
        Number(data.xaxis[3 * j + 1].toFixed(4)),
        Number(data.xaxis[3 * j + 2].toFixed(4)),
      ],
    });
  }

  // The bodies, so a path point can be expressed in the body that carries it and follow that
  // body when it is retargeted, rather than riding on one transform for the whole model.
  const bodies = [];
  for (let b = 0; b < model.nbody; b++) {
    const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY.value, b);
    if (!name || name === 'world') continue;
    const parentId = model.body_parentid?.[b];
    const parent =
      parentId === undefined || parentId === 0
        ? null
        : mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY.value, parentId);
    bodies.push({
      name,
      // A joint in MuJoCo belongs to its child body, so a bone's own joints all sit at its
      // proximal end -- the three hip degrees of freedom share one anchor on the femur. Its
      // length is that anchor to the joints of the bodies hanging off it, which needs the tree.
      parent,
      meshes: wearing.get(name) ?? [],
      pos: [
        Number(data.xpos[3 * b].toFixed(5)),
        Number(data.xpos[3 * b + 1].toFixed(5)),
        Number(data.xpos[3 * b + 2].toFixed(5)),
      ],
      quat: [
        Number(data.xquat[4 * b].toFixed(5)),
        Number(data.xquat[4 * b + 1].toFixed(5)),
        Number(data.xquat[4 * b + 2].toFixed(5)),
        Number(data.xquat[4 * b + 3].toFixed(5)),
      ],
    });
  }

  const muscles = [];
  for (const t of tendons) {
    const path = [];
    const on = [];
    const spans = [];
    for (const s of t.sites) {
      const id = siteId(s);
      if (id < 0) continue;
      path.push(
        Number(xpos[3 * id].toFixed(5)),
        Number(xpos[3 * id + 1].toFixed(5)),
        Number(xpos[3 * id + 2].toFixed(5)),
      );
      // Which body carries each point, so a retarget can move it with that body rather than
      // with the model as a whole.
      const b = bodyOf(id);
      on.push(b ?? '');
      if (b && !spans.includes(b)) spans.push(b);
    }
    if (path.length >= 6) {
      muscles.push({ name: t.name.replace(/_tendon$/, ''), path, on, bodies: spans });
    }
  }
  models[key] = { muscles, joints, bodies };
  total += muscles.length;
  console.log(
    `  ${key}: ${muscles.length} muscles, ${joints.length} joints, ${bodies.length} bodies, ` +
      `${bodies.reduce((n, b) => n + b.meshes.length, 0)} meshes` +
      (dropped ? `  (${dropped} dropped: their path leaves this model)` : ''),
  );
}

const name = relative(ROOT, OUT);
const formatted = spawnSync(
  join(ROOT, 'node_modules/.bin/biome'),
  ['format', `--stdin-file-path=${name}`],
  {
    cwd: ROOT,
    input: `${JSON.stringify({ format: 'bs-humany.source-sites/1', models }, null, 1)}\n`,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  },
);
if (formatted.status !== 0) {
  console.error(`extract-source-sites: biome could not format the output:\n${formatted.stderr}`);
  process.exit(1);
}

if (check) {
  const committed = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
  if (unloaded.length > 0 || committed !== formatted.stdout) {
    console.error(
      `extract-source-sites: ${name} is not what the extraction would write` +
        (unloaded.length > 0 ? ` (${unloaded.join(', ')} would not load)` : '') +
        '.\n  Run `pnpm extract:source-sites`. If the vendored models changed, say so in the commit.',
    );
    process.exit(1);
  }
  console.log(`\nextract-source-sites: ok. ${total} muscles match the vendored models.`);
} else {
  writeFileSync(OUT, formatted.stdout);
  console.log(`\n${total} muscles written to ${name}`);
}
