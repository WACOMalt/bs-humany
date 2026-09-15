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

const read = (file) => readFileSync(join(MYO_SIM, file), 'utf8');
const unwrap = (xml) => xml.replace(/<\/?mujocoinclude[^>]*>/g, '');

/**
 * Recombine the vendored fragments into one loadable model.
 *
 * Returned as text rather than written anywhere: the model is a derived thing, and a copy on
 * disk is a copy that can go stale against the fragments it came from.
 */
export function referenceArmXml(tendons = Object.keys(ELBOW_TENDONS)) {
  const assets = read('myoarm_r_assets.xml');
  // The class defaults, which is everything between the first `<default class="main">` and the
  // `<asset>` block that follows it. They carry no mesh or material of their own except in the
  // two collision classes, whose `material` attribute names a texture that is not vendored.
  const from = assets.indexOf('<default class="main">');
  const to = assets.indexOf('<asset>');
  const defaults = assets
    .slice(from, assets.lastIndexOf('</default>', to) + 10)
    .replace(/ material="[^"]*"/g, '');

  const chain = unwrap(read('myoarm_r_chain.xml'))
    .replace(/<geom[^>]*type="mesh"[^>]*\/>/g, '')
    .replace(/<geom[^>]*mesh="[^"]*"[^>]*\/>/g, '');

  const spatials = [...unwrap(read('myoarm_r_tendon.xml')).matchAll(/<spatial[\s\S]*?<\/spatial>/g)]
    .map((m) => m[0])
    .filter((s) => tendons.some((name) => s.includes(`name="${name}"`)));
  if (spatials.length !== tendons.length) {
    throw new Error(
      `referenceArm: found ${spatials.length} of ${tendons.length} tendons in ` +
        'myoarm_r_tendon.xml. The vendored model has moved; re-pin it before trusting this.',
    );
  }

  // The compiler flags are the reference's own, from its assets file. `balanceinertia` matters:
  // one thumb body upstream has an inertia that fails the triangle inequality, and the model is
  // authored expecting MuJoCo to fix it.
  return `<mujoco model="myoarm-reference-arm">
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
