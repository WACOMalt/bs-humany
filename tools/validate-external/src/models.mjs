/**
 * The vendored MyoSuite models: where they are, and which file of each says what.
 *
 * Every tool that reads the reference comes through here for its file names. They used to be
 * written out in each tool that needed them -- the root path six times, the arm's chain five, the
 * torso's head splice in the one tool that happened to need the torso first -- and a copy that
 * falls behind a re-pin is a tool reading a file that is not there, or worse, one that still is
 * and has stopped being the one meant.
 *
 * `tools/cli` may import this; this directory never imports `tools/cli`. The reference is the
 * thing being compared against, and it does not know who compares against it.
 *
 * ## An entry
 *
 * Each model names the files it has and nothing it has not: the head is a chain and nothing else.
 *
 *   - `assets`: the class defaults, the joint equalities and the mesh declarations.
 *   - `chain`: the body tree, with its joints and sites.
 *   - `tendon` and `muscle`: the spatial tendons and the actuators on them.
 *   - `defaults`: where that assets file's class defaults begin. The models do not agree about it:
 *     the arm and the torso open their tree with a named root class and the legs with an anonymous
 *     one.
 *   - `upstream`: the directory the files sit in upstream, which is what a citation names, so a
 *     number carried from here can be found in the repository it came from.
 *   - `rewrite`: a fix-up the chain needs before it can stand alone, where there is one.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The vendored files, flat, as `README.md` beside this directory describes them. */
export const MYO_SIM = fileURLToPath(new URL('../myo_sim', import.meta.url));

/** The upstream commit the files are byte-identical to. `README.md` pins it; change both together. */
export const MYO_SIM_COMMIT = 'eb327acbae0fad12279495040607f5235d962328';

/** Where a model's file sits upstream, as a citation names it. */
export const upstreamPath = (model, file) => `${model.upstream}/${model[file]}`;

/**
 * An included fragment, with its wrapper taken off so it can be spliced in, and everything a
 * standalone load does not need removed with it.
 *
 * Geoms go entirely: they name collision and mesh classes defined in that fragment's own
 * defaults, which are not spliced in beside it, and MuJoCo refuses a class it cannot resolve.
 * `childclass` and `class` go for the same reason -- without them the bodies still nest exactly
 * as stated and inherit the including model's defaults instead. Sites, joints and body transforms
 * are what the tools read, and none of them depends on any of it.
 */
const unwrapInclude = (xml) =>
  xml
    .replace(/<\/?mujocoinclude[^>]*>/g, '')
    .replace(/<geom[\s\S]*?\/>/g, '')
    .replace(/ childclass="[^"]*"/g, '')
    .replace(/ class="[^"]*"/g, '');

const HEAD = Object.freeze({
  chain: 'myohead_rigid_chain.xml',
  upstream: 'myo_sim/models/head/assets',
});

/**
 * The torso's chain, with the head spliced in where it includes it.
 *
 * The chain includes the head from a path relative to the layout of the upstream repository, not
 * to how it is vendored here. The file itself is vendored, beside the others, so the include is
 * pointed at where it actually is rather than dropped -- the head hangs off the top of the
 * cervical spine and several neck muscles end on it.
 */
const spliceHead = (chain) =>
  chain.replace(/<include file="[^"]*myohead_rigid_chain\.xml"\s*\/>/g, () =>
    unwrapInclude(readFileSync(join(MYO_SIM, HEAD.chain), 'utf8')),
  );

/**
 * The torso's two tendon sets share one skeleton.
 *
 * `torso` is the abdomen model: six actuators lumping erector spinae and the two obliques into one
 * line a side, which is the level of detail this project wants for a trunk. `torso_lumbar` is the
 * full one, 210 fascicles of multifidus, longissimus, iliocostalis, quadratus lumborum and psoas
 * attaching to individual lumbar vertebrae.
 */
const TORSO_SKELETON = {
  assets: 'myotorso_assets.xml',
  chain: 'myotorso_chain.xml',
  defaults: '<default class="main">',
  upstream: 'myo_sim/models/torso/assets',
  rewrite: spliceHead,
};

/** Every reference model, by the name the tools and the Align tab know it by. */
export const MODELS = Object.freeze({
  arm: Object.freeze({
    assets: 'myoarm_r_assets.xml',
    chain: 'myoarm_r_chain.xml',
    tendon: 'myoarm_r_tendon.xml',
    muscle: 'myoarm_r_muscle.xml',
    defaults: '<default class="main">',
    upstream: 'myo_sim/models/arm/assets',
  }),
  legs: Object.freeze({
    assets: 'myolegs_assets.xml',
    chain: 'myolegs_chain.xml',
    tendon: 'myolegs_tendon.xml',
    muscle: 'myolegs_muscle.xml',
    defaults: '<default>',
    upstream: 'myo_sim/models/leg/assets',
  }),
  torso: Object.freeze({
    ...TORSO_SKELETON,
    tendon: 'myotorso_abdomen_tendon.xml',
    muscle: 'myotorso_abdomen_muscle.xml',
  }),
  torso_lumbar: Object.freeze({
    ...TORSO_SKELETON,
    tendon: 'myotorso_tendon.xml',
    muscle: 'myotorso_muscle.xml',
  }),
  head: HEAD,
});
