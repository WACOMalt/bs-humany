/**
 * The reference arm, made to run.
 *
 * `mjcf.mjs` reads the vendored model as text, which answers questions about what it *says*. This
 * one loads it into MuJoCo and asks what it *does* -- specifically, what moment arm each elbow
 * muscle has at each joint angle, which is the comparison muscle spec 13.2 calls the most
 * important test in the module.
 *
 * ## Why the model has to be rebuilt to load it
 *
 * The vendored files are `<mujocoinclude>` fragments meant to be pulled into a model that also
 * supplies meshes, and the meshes are not vendored: they are large, they are not needed for any
 * comparison here, and the licence terms differ from the XML's. So the fragments are recombined
 * into one model with the mesh geoms dropped. Nothing a moment arm depends on is lost by that --
 * a spatial tendon is defined by its sites and its wrap geoms, and those are stated inline with
 * explicit positions, sizes and orientations. The bodies all carry explicit `<inertial>`, so
 * removing their visual geometry leaves the kinematics untouched.
 *
 * What is dropped: mesh geoms, the `<asset>` block, and every muscle actuator (the tendons are
 * kept; only their actuators go). What is kept: the whole body tree, every joint, every site,
 * every wrap geom, the class defaults that give those elements their attributes, and the seven
 * elbow tendons this project has units for.
 *
 * ## Why the moment arms are differenced rather than read off
 *
 * MuJoCo computes a tendon Jacobian, `ten_J`, whose entry for a coordinate is exactly `dL/dq`.
 * The binding exposes it at the wrong size -- 108 numbers where the model calls for `ntendon *
 * nv` -- so reading a row of it reads across into the next tendon's. `ten_length` is correct, so
 * the arm is taken as a central difference of it instead. That is a numerical answer to a
 * question with a closed form, which would be a poor trade in the simulation and is a fine one
 * here: it runs once per angle in a validation tool, and it depends on nothing but the quantity
 * the model is definitive about.
 *
 * Sign: `r = -dL/dq`, the same convention as `MuscleMomentModule`, so a flexor is positive at a
 * coordinate that counts flexion positive.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const MYO_SIM = join(HERE, '..', 'myo_sim');

/** The tendons this project has units for, and the unit each one corresponds to. */
export const ELBOW_TENDONS = Object.freeze({
  BIClong_tendon: 'biceps_brachii_long_r',
  BICshort_tendon: 'biceps_brachii_short_r',
  BRA_tendon: 'brachialis_r',
  BRD_tendon: 'brachioradialis_r',
  TRIlong_tendon: 'triceps_brachii_long_r',
  TRIlat_tendon: 'triceps_brachii_lateral_r',
  TRImed_tendon: 'triceps_brachii_medial_r',
});

/** The forearm's, which share the arm's files with the elbow's. */
export const FOREARM_TENDONS = Object.freeze({
  PT_tendon: 'pronator_teres_r',
  PQ_tendon: 'pronator_quadratus_r',
  SUP_tendon: 'supinator_r',
  ANC_tendon: 'anconeus_r',
  FCR_tendon: 'flexor_carpi_radialis_r',
  FCU_tendon: 'flexor_carpi_ulnaris_r',
  PL_tendon: 'palmaris_longus_r',
  ECRL_tendon: 'extensor_carpi_radialis_longus_r',
  ECRB_tendon: 'extensor_carpi_radialis_brevis_r',
});

/** The shoulder's tendons, which share the arm's files with the elbow's. */
export const SHOULDER_TENDONS = Object.freeze({
  DELT1_tendon: 'deltoid_anterior_r',
  DELT2_tendon: 'deltoid_middle_r',
  DELT3_tendon: 'deltoid_posterior_r',
  SUPSP_tendon: 'supraspinatus_r',
  INFSP_tendon: 'infraspinatus_r',
  SUBSC_tendon: 'subscapularis_r',
  TMIN_tendon: 'teres_minor_r',
  TMAJ_tendon: 'teres_major_r',
});

/**
 * Why latissimus dorsi and pectoralis major are not here.
 *
 * Their paths end on the trunk, and the trunk is in `myotorso_chain.xml`, which this file does not
 * build from -- the reference model assembled here is the arm, rooted at the clavicle. Loading
 * them fails outright: `site 'PECM2_PECM2-P3_r' not found in wrap 4`.
 *
 * Combining the two chains is a piece of work rather than a line: the arm nests inside the torso
 * at a place the fragments state and this file would have to honour, and getting it subtly wrong
 * would put every trunk moment arm somewhere plausible and false. Until it is done those two
 * muscles have no source travel measured, which `deriveOptimalFiberLength` already handles the
 * right way -- a unit nothing has measured keeps the fiber length the source states, rather than
 * being scaled by a ratio taken from nowhere.
 */
export const TRUNK_TENDONS_NEED_THE_TORSO_CHAIN = Object.freeze([
  'LAT1_tendon',
  'LAT3_tendon',
  'PECM2_tendon',
  'PECM3_tendon',
]);

/** The knee's, which come from the leg model instead. */
export const LEG_TENDONS = Object.freeze({
  recfem_r_tendon: 'rectus_femoris_r',
  vaslat_r_tendon: 'vastus_lateralis_r',
  vasmed_r_tendon: 'vastus_medialis_r',
  vasint_r_tendon: 'vastus_intermedius_r',
  bflh_r_tendon: 'biceps_femoris_long_r',
  bfsh_r_tendon: 'biceps_femoris_short_r',
  semiten_r_tendon: 'semitendinosus_r',
  semimem_r_tendon: 'semimembranosus_r',
  gaslat_r_tendon: 'gastrocnemius_lateral_r',
  gasmed_r_tendon: 'gastrocnemius_medial_r',
  glmax1_r_tendon: 'gluteus_maximus_superior_r',
  glmax2_r_tendon: 'gluteus_maximus_middle_r',
  glmed1_r_tendon: 'gluteus_medius_anterior_r',
  glmed2_r_tendon: 'gluteus_medius_middle_r',
  glmed3_r_tendon: 'gluteus_medius_posterior_r',
  glmin1_r_tendon: 'gluteus_minimus_anterior_r',
  glmin2_r_tendon: 'gluteus_minimus_middle_r',
  glmin3_r_tendon: 'gluteus_minimus_posterior_r',
  iliacus_r_tendon: 'iliacus_r',
  psoas_r_tendon: 'psoas_major_r',
  addlong_r_tendon: 'adductor_longus_r',
  addbrev_r_tendon: 'adductor_brevis_r',
  addmagProx_r_tendon: 'adductor_magnus_proximal_r',
  addmagMid_r_tendon: 'adductor_magnus_middle_r',
  addmagDist_r_tendon: 'adductor_magnus_distal_r',
  addmagIsch_r_tendon: 'adductor_magnus_ischiocondylar_r',
  piri_r_tendon: 'piriformis_r',
  tfl_r_tendon: 'tensor_fasciae_latae_r',
  grac_r_tendon: 'gracilis_r',
  sart_r_tendon: 'sartorius_r',
  soleus_r_tendon: 'soleus_r',
  tibant_r_tendon: 'tibialis_anterior_r',
  tibpost_r_tendon: 'tibialis_posterior_r',
  perlong_r_tendon: 'fibularis_longus_r',
  perbrev_r_tendon: 'fibularis_brevis_r',
  edl_r_tendon: 'extensor_digitorum_longus_r',
  ehl_r_tendon: 'extensor_hallucis_longus_r',
  fdl_r_tendon: 'flexor_digitorum_longus_r',
  fhl_r_tendon: 'flexor_hallucis_longus_r',
});

/**
 * Which files describe each reference limb.
 *
 * `defaults` is where that file's class defaults begin, and the two models do not agree about it:
 * the arm opens its tree with a named root class and the legs with an anonymous one.
 */
export const MODELS = Object.freeze({
  arm: {
    assets: 'myoarm_r_assets.xml',
    chain: 'myoarm_r_chain.xml',
    tendon: 'myoarm_r_tendon.xml',
    defaults: '<default class="main">',
  },
  legs: {
    assets: 'myolegs_assets.xml',
    chain: 'myolegs_chain.xml',
    tendon: 'myolegs_tendon.xml',
    defaults: '<default>',
  },
});

const read = (file) => readFileSync(join(MYO_SIM, file), 'utf8');
const unwrap = (xml) => xml.replace(/<\/?mujocoinclude[^>]*>/g, '');

/**
 * The model's own joint couplings: which coordinate follows which, and by what polynomial.
 *
 * MyoSuite states these as MuJoCo joint equalities, in the assets file rather than the chain, and
 * they are what makes the model's shoulder a shoulder: 180 degrees of elevation is not 180 degrees
 * at the glenohumeral joint, it is that joint and the girdle turning together in fixed proportion,
 * which is the shoulder rhythm. The knee's are the patella's, a polynomial in flexion.
 *
 * They matter to anything that poses the model by writing coordinates. `mj_forward` does not
 * project an equality -- the solver satisfies it during a step, from forces -- so a coordinate
 * written and read back straight away leaves its followers wherever they were. A sweep that does
 * that is asking about poses the model does not have: the arm overhead with the scapula flat.
 *
 * `polycoef` is MuJoCo's own order, constant first.
 */
export function couplings(model = MODELS.arm) {
  const block = read(model.assets).match(/<equality>[\s\S]*?<\/equality>/);
  if (!block) return [];
  return [...block[0].matchAll(/<joint\b[^>]*\/>/g)].flatMap((element) => {
    const attribute = (key) => element[0].match(new RegExp(`${key}="([^"]+)"`))?.[1];
    const dependent = attribute('joint1');
    const driver = attribute('joint2');
    const polycoef = attribute('polycoef');
    if (!dependent || !driver || !polycoef) return [];
    return [{ dependent, driver, polycoef: polycoef.trim().split(/\s+/).map(Number) }];
  });
}

/**
 * Recombine the vendored fragments into one loadable model.
 *
 * Returned as text rather than written anywhere: the model is a derived thing, and a copy on
 * disk is a copy that can go stale against the fragments it came from.
 */
export function referenceArmXml(tendons = Object.keys(ELBOW_TENDONS), model = MODELS.arm) {
  const assets = read(model.assets);
  // The class defaults, which is everything between the first `<default class="main">` and the
  // `<asset>` block that follows it. They carry no mesh or material of their own except in the
  // two collision classes, whose `material` attribute names a texture that is not vendored.
  const from = assets.indexOf(model.defaults);
  if (from < 0) throw new Error(`referenceArm: no '${model.defaults}' in ${model.assets}.`);
  const to = assets.indexOf('<asset>');
  const defaults = assets
    .slice(from, assets.lastIndexOf('</default>', to) + 10)
    .replace(/ material="[^"]*"/g, '');

  const chain = unwrap(read(model.chain))
    .replace(/<geom[^>]*type="mesh"[^>]*\/>/g, '')
    .replace(/<geom[^>]*mesh="[^"]*"[^>]*\/>/g, '');

  const spatials = [...unwrap(read(model.tendon)).matchAll(/<spatial[\s\S]*?<\/spatial>/g)]
    .map((m) => m[0])
    .filter((s) => tendons.some((name) => s.includes(`name="${name}"`)));
  if (spatials.length !== tendons.length) {
    throw new Error(
      `referenceArm: found ${spatials.length} of ${tendons.length} tendons in ` +
        `${model.tendon}. The vendored model has moved; re-pin it before trusting this.`,
    );
  }

  // The compiler flags are the reference's own, from its assets file. `balanceinertia` matters:
  // one thumb body upstream has an inertia that fails the triangle inequality, and the model is
  // authored expecting MuJoCo to fix it.
  return `<mujoco model="myosuite-reference">
<compiler angle="radian" balanceinertia="true" boundmass="0.001" boundinertia=".0001" inertiafromgeom="auto"/>
<option gravity="0 0 0"/>
${defaults}
<worldbody>${chain}</worldbody>
<tendon>${spatials.join('\n')}</tendon>
</mujoco>`;
}

/**
 * Load the reference arm and hand back a way to measure it.
 *
 * `mujoco` is the loaded module; the caller owns it, because loading it is slow and a caller
 * measuring two things should do it once.
 */
export function loadReferenceArm(mujoco) {
  const model = mujoco.MjModel.from_xml_string(referenceArmXml());
  const data = new mujoco.MjData(model);
  const jointId = (name) => mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, name);
  const names = [];
  for (let t = 0; t < model.ntendon; t++) {
    names.push(mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_TENDON.value, t));
  }

  const elbow = jointId('elbow_flexion_r');
  const forearm = jointId('pro_sup_r');
  if (elbow < 0) throw new Error('referenceArm: no elbow_flexion_r joint in the reference model.');
  const qposAdr = model.jnt_qposadr;

  /** Tendon lengths at one pose, metres, indexed the way `names` is. */
  const lengthsAt = (flexion, rotation) => {
    data.qpos[qposAdr[elbow]] = flexion;
    if (forearm >= 0) data.qpos[qposAdr[forearm]] = rotation;
    mujoco.mj_forward(model, data);
    return Array.from(data.ten_length);
  };

  /**
   * Central difference in the elbow coordinate. A ten-thousandth of a radian is small enough
   * that the second-order term is far below the millimetre this is reported to, and large enough
   * that the difference of two lengths keeps its significant figures in double precision.
   */
  const STEP = 1e-4;

  return {
    model,
    data,
    tendonNames: names,
    lengthsAt,
    /** Moment arm per tendon at one pose, metres, sign `-dL/dq`. */
    momentArms(flexion, rotation = 0) {
      const plus = lengthsAt(flexion + STEP, rotation);
      const minus = lengthsAt(flexion - STEP, rotation);
      const out = new Map();
      for (let t = 0; t < names.length; t++) {
        out.set(names[t], -(plus[t] - minus[t]) / (2 * STEP));
      }
      return out;
    },
    dispose() {
      data.delete();
      model.delete();
    },
  };
}
