/**
 * Reading the vendored MyoSuite models: the parts more than one generator needs.
 *
 * Three sets come out of these files now -- the elbow, the shoulder and the knee -- by the same
 * two derivations, and the only things that differ are which model they read, which actuators they
 * name, and what prose goes at the top of the file they write. So the derivations live here and
 * the tables live with the generator that owns them.
 *
 * ## What MuJoCo states and what has to be derived
 *
 * A MuJoCo muscle actuator does not carry an optimal fiber length or a tendon slack length. It
 * carries `gainprm`, whose third entry is the peak active force, and an operating range in units
 * of optimal fiber length; and `lengthrange`, the musculotendon length at the two ends of that
 * range, in metres. Those four numbers determine the two lengths exactly, because the range and
 * the length range are the same interval measured in different units:
 *
 *     L0 = (LRmax - LRmin) / (rmax - rmin)
 *     LT = LRmin - L0 * rmin
 *
 * The derivation is MuJoCo's own, from its muscle actuator documentation, and it is the inverse
 * of the step its compiler takes when it fills `lengthrange` in. It is done here, once, in the
 * open, rather than left as a comment beside a hand-copied number.
 *
 * ## Where a wrap goes in a path
 *
 * A path is ordered, and a surface at the wrong point in it constrains the wrong span.
 * Brachioradialis is the case that showed it: its wrap written after every via point put the
 * obstacle on the stretch running down the forearm rather than the one crossing the elbow, and
 * its moment arm went negative at full extension. So the position is read from the reference path
 * -- the last wrap geom in a reference tendon is the one at the joint this project models, the
 * earlier ones being at the humeral head -- and ours goes where that one sits among the via points
 * carried over.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const MYO_SIM = join(ROOT, 'tools/validate-external/myo_sim');
export const ARM = {
  muscle: 'myoarm_r_muscle.xml',
  tendon: 'myoarm_r_tendon.xml',
  chain: 'myoarm_r_chain.xml',
};
export const LEGS = {
  muscle: 'myolegs_muscle.xml',
  tendon: 'myolegs_tendon.xml',
  chain: 'myolegs_chain.xml',
};

/** Hill-type parameters per actuator name, derived from what MuJoCo states. */
export function readActuators(model = ARM) {
  const xml = readFileSync(join(MYO_SIM, model.muscle), 'utf8');
  const found = new Map();
  // Each actuator element, then its attributes by name: the two models write them in different
  // orders -- the arm leads with `name`, the legs with `biasprm` -- and a pattern that assumed
  // either would silently find nothing in the other.
  const attribute = (element, key) => element.match(new RegExp(`${key}="([^"]+)"`))?.[1];
  for (const element of xml.match(/<general\b[^>]*\/>/g) ?? []) {
    const name = attribute(element, 'name');
    const gainprm = attribute(element, 'gainprm');
    const lengthrange = attribute(element, 'lengthrange');
    if (!name || !gainprm || !lengthrange) continue;
    const gain = gainprm.trim().split(/\s+/).map(Number);
    const range = lengthrange.trim().split(/\s+/).map(Number);
    const [rmin, rmax, force, , , , vmax] = gain;
    const [lrmin, lrmax] = range;
    if (!(rmax > rmin)) {
      throw new Error(`${name}: operating range is empty, so the lengths cannot be derived`);
    }
    const optimalFiberLength = (lrmax - lrmin) / (rmax - rmin);
    const tendonSlackLength = lrmin - optimalFiberLength * rmin;
    found.set(name, {
      maxIsometricForce: force,
      optimalFiberLength,
      tendonSlackLength,
      maxContractionVelocity: vmax,
      // Coracobrachialis is the case: its lengthrange and its operating range imply a 312 mm
      // fiber on a tendon 45 mm shorter than nothing. The derivation is MuJoCo's own and the
      // arithmetic is right, so what it says is that the source's two statements about that
      // actuator do not agree -- and a negative slack length is not a value to carry, because the
      // model divides tendon length by it.
      physical: tendonSlackLength > 0 && optimalFiberLength > 0,
    });
  }
  return found;
}

const TENDON_XML = new Map();
const tendonXml = (model) => {
  const cached = TENDON_XML.get(model.tendon);
  if (cached) return cached;
  const text = readFileSync(join(MYO_SIM, model.tendon), 'utf8');
  TENDON_XML.set(model.tendon, text);
  return text;
};

/**
 * One reference tendon's path: its elements in order, and where the last wrap geom sits in them.
 *
 * `lastGeom` is -1 for a tendon the reference wraps nothing with, which is a real answer rather
 * than a gap: several of the shoulder muscles run straight from the trunk to the humerus.
 */
export function referencePath(actuator, model = ARM) {
  const block = tendonXml(model).match(
    new RegExp(`<spatial[^>]*name="${actuator}_tendon"[\\s\\S]*?</spatial>`),
  );
  if (!block) {
    throw new Error(
      `${model.tendon} has no tendon named '${actuator}_tendon'. The vendored commit may have ` +
        'moved; check tools/validate-external/README.md before changing this mapping.',
    );
  }
  const elements = [...block[0].matchAll(/<(site|geom)\s+(?:site|geom)="([^"]+)"/g)].map((m) => ({
    kind: m[1],
    name: m[2],
  }));
  let lastGeom = -1;
  elements.forEach((e, i) => {
    if (e.kind === 'geom') lastGeom = i;
  });
  return { elements, lastGeom };
}

/**
 * The path elements for one unit: its via points, with the wrap where the reference puts it.
 *
 * A via point knows which reference site it came from, so its place in the reference path is a
 * lookup rather than a guess. A unit whose `wrap` is undefined gets no wrap element at all.
 */
export function pathElements(unit, viaPointsFor, direction, model = ARM) {
  const { elements, lastGeom } = referencePath(unit.actuator, model);
  const indexOf = (site) => elements.findIndex((e) => e.kind === 'site' && e.name === site);
  const via = viaPointsFor(unit.id).map((p) => ({
    kind: 'site',
    id: p.id,
    at: indexOf(p.referenceSite),
  }));
  if (!unit.wrap) return via;
  // The reference states the surface's position among its own elements, and the via points are
  // already in our order -- which for most of the shoulder is the reference's reversed. So "after
  // the surface" is a larger index one way round and a smaller one the other, and reading it the
  // wrong way puts the obstacle on the wrong span.
  const reversed = direction?.[unit.id] === 'reversed';
  const past = (at) => (reversed ? at < lastGeom : at > lastGeom);
  const out = [];
  let placed = false;
  for (const point of via) {
    if (!placed && lastGeom >= 0 && past(point.at)) {
      out.push({ kind: 'wrap' });
      placed = true;
    }
    out.push(point);
  }
  if (!placed) out.push({ kind: 'wrap' });
  return out;
}

/**
 * Every unit on both sides.
 *
 * The reference model is a right arm and there is no left one to take parameters from, so the
 * left side is the right side's parameters on the left side's geometry -- the ordinary assumption
 * of bilateral symmetry, whose only claim is that a person's two biceps are the same muscle.
 * Everything that is *geometry* stays bilateral and measured: attachment sites come from each
 * side's own markers, wrap surfaces from each side's own mesh, and via points are mirrored with
 * the dataset's symmetry checked.
 *
 * A `$` in an id takes the side. Names take ", right" or ", left".
 */
/**
 * Refuse an actuator whose derived lengths are not a muscle.
 *
 * Called by each generator for the actuators it names, rather than when they are read, so that a
 * set which does not use an unphysical actuator is not stopped by it.
 */
export function requirePhysical(actuator, parameters, model = ARM) {
  if (parameters.physical) return parameters;
  throw new Error(
    `${model.muscle} actuator '${actuator}' derives an optimal fiber length of ` +
      `${(parameters.optimalFiberLength * 1000).toFixed(1)} mm and a tendon slack length of ` +
      `${(parameters.tendonSlackLength * 1000).toFixed(1)} mm, which is not a muscle. Its ` +
      'lengthrange and its operating range disagree in the source; leave it out of the set and ' +
      'say so, rather than carrying the number.',
  );
}

export function sided(units) {
  const out = [];
  for (const s of ['r', 'l']) {
    const word = s === 'r' ? 'right' : 'left';
    for (const unit of units) {
      const put = (value) => (value === undefined ? undefined : value.replaceAll('$', s));
      out.push({
        ...unit,
        group: put(unit.group),
        id: put(unit.id),
        origin: put(unit.origin),
        insertion: put(unit.insertion),
        wrap: put(unit.wrap),
        name: `${unit.name}, ${word}`,
        ...(unit.groupName === undefined ? {} : { groupName: `${unit.groupName}, ${word}` }),
        side_: s,
      });
    }
  }
  return out;
}

/** Six significant figures: more than the source states, and enough to round-trip it. */
export const num = (v) => Number(v.toPrecision(6)).toString();

/**
 * Render one group's worth of units as the muscle-data literal they become.
 *
 * The shape is HSDL's `MuscleGroup`, and both generators write the same shape; what differs is
 * which units go in it and the prose around it.
 */
export function renderGroups(units, viaPointsFor, direction, model = ARM) {
  const groups = new Map();
  for (const unit of units) {
    if (!groups.has(unit.group)) groups.set(unit.group, []);
    groups.get(unit.group).push(unit);
  }
  const body = [];
  for (const [groupId, members] of groups) {
    const head = members[0];
    body.push(`  {
    id: '${groupId}',
    displayName: '${head.groupName}',
    taTerm: '${head.taTerm}',
    innervation: '${head.innervation}',
    source: gray('${head.groupName.split(',')[0]}'),
    units: [`);
    for (const unit of members) {
      const p = unit.parameters;
      const elements = pathElements(unit, viaPointsFor, direction, model)
        .map((e) =>
          e.kind === 'site'
            ? `          { kind: 'site', site: '${e.id}' },\n`
            : `          {
            kind: 'wrap',
            surface: '${unit.wrap}',
            preferredSide: { x: ${unit.preferredSide.x}, y: ${unit.preferredSide.y}, z: ${unit.preferredSide.z} },
            source: gray('${unit.name.split(',')[0]}'),
          },\n`,
        )
        .join('');
      // A single-element path on one line, which is how the formatter would write it: a
      // generator whose output has to be reformatted cannot check its own output.
      // One element on one line and none at all as an empty pair, which is how the formatter
      // would write them: a generator whose output has to be reformatted cannot check its own
      // output. A unit with no path at all is a straight line from origin to insertion, which
      // several of the knee flexors are.
      const lines = elements.split('\n').filter((line) => line.length > 0);
      const path =
        lines.length === 0
          ? '[]'
          : lines.length === 1
            ? `[${elements.trim().replace(/,$/, '')}]`
            : `[\n${elements}        ]`;
      body.push(`      {
        id: '${unit.id}',
        displayName: '${unit.name}',
        origin: '${unit.origin}',
        insertion: '${unit.insertion}',
        path: ${path},
        parameters: {
          maxIsometricForce: ${num(p.maxIsometricForce)},
          optimalFiberLength: ${num(p.optimalFiberLength)},
          tendonSlackLength: ${num(p.tendonSlackLength)},
          pennationAngle: 0,
          maxContractionVelocity: ${num(p.maxContractionVelocity)},
          source: ${model === LEGS ? 'myoLegs' : 'myoArm'}('${unit.actuator}'),
        },
      },`);
    }
    body.push('    ],\n  },');
  }
  return body.join('\n');
}
