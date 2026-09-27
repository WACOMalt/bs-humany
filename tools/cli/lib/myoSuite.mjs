/**
 * Reading the vendored MyoSuite models: the parts more than one generator needs.
 *
 * The nine region generators that read MyoSuite, and measure-source-travel, all come through
 * here -- the same derivations for every set, and the only things that differ are which model they
 * read, which actuators they name, and what prose goes at the top of the file they write. So the
 * derivations live here and the tables live with the generator that owns them.
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
import { MODELS, MYO_SIM } from '../../validate-external/src/models.mjs';
import { renderMuscleGroups } from './renderMuscles.mjs';

export { MYO_SIM };

/**
 * The models the generators read, under the names they have always used here. The file names are
 * declared once, in `tools/validate-external/src/models.mjs`; these are those same entries, so a
 * comparison by identity -- `renderGroups` asks `model === LEGS` -- still holds for a caller that
 * imported either.
 */
export const ARM = MODELS.arm;
export const LEGS = MODELS.legs;

/**
 * The torso, which the reference splits in two.
 *
 * `TORSO` is the abdomen model: six actuators lumping erector spinae and the two obliques into one
 * line a side, which is the level of detail this project wants for a trunk. `TORSO_LUMBAR` is the
 * full one, 210 fascicles of multifidus, longissimus, iliocostalis, quadratus lumborum and psoas
 * attaching to individual lumbar vertebrae -- far finer than anything here, and read only for the
 * two actuators the abdomen model leaves out.
 */
export const TORSO = MODELS.torso;
export const TORSO_LUMBAR = MODELS.torso_lumbar;

/**
 * How much of its own optimal fiber length a muscle typically travels over its joints' range.
 *
 * Two thirds, and it is measured rather than chosen: it is the median normalised travel of the
 * fifty-four units whose architecture the source *does* state, swept on the source's own model.
 * The quartiles are 0.50 and 0.90, so it is a middling muscle and not a tight one.
 *
 * What it is for is the actuators the source leaves silent -- see `readActuators`. Given a travel,
 * it says how long the fibers covering it would be. Checked back against those fifty-four it is
 * unbiased, median ratio 1.010, with 32 of 54 within a factor of 1.5 and 47 within 2: a stand-in
 * good to about half, which is what it is described as everywhere it is used.
 *
 * It sits just above the band this model fits tendons to -- `TENDON_FIT_FIBER_CEILING -
 * TENDON_FIT_FIBER_FLOOR` in modules-muscle's compile.ts is 0.6 -- which is corroboration rather
 * than coincidence: both are saying a muscle works over roughly two thirds of its optimal length.
 */
export const TYPICAL_NORMALISED_TRAVEL = 0.667;

/**
 * Hill-type parameters per actuator name, derived from what MuJoCo states.
 *
 * The file writes actuators two ways and they do not say the same things. A `<general>` element
 * carries an operating range of its own in `gainprm`, and that range with `lengthrange` determines
 * optimal fiber length and tendon slack length exactly -- the derivation above. A `<muscle>`
 * element states `force` and `lengthrange` and no range at all, so MuJoCo's own default of 0.75 to
 * 1.05 applies, and that default is not a statement about any muscle: derived from it the forearm's
 * fiber lengths come out 1.1 to 5.6 times published and pronator quadratus lands on a tendon of
 * minus 16 mm. So `architecture` says which kind an actuator is, and a caller that needs a fiber
 * length has to ask. OQ-022.
 */
export function readActuators(model = ARM) {
  const xml = readFileSync(join(MYO_SIM, model.muscle), 'utf8');
  const found = new Map();
  // Each actuator element, then its attributes by name: the two models write them in different
  // orders -- the arm leads with `name`, the legs with `biasprm` -- and a pattern that assumed
  // either would silently find nothing in the other.
  // Spaces are allowed around the equals sign and the forearm's actuators use them --
  // `force = "479.8"` -- so a pattern that assumed none read the upper arm and missed the rest.
  const attribute = (element, key) => element.match(new RegExp(`${key}\\s*=\\s*"([^"]+)"`))?.[1];
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
      architecture: 'stated',
      maxIsometricForce: force,
      optimalFiberLength,
      tendonSlackLength,
      maxContractionVelocity: vmax,
      // The two halves fail independently, and only one of them matters now.
      //
      // `L0` comes from the *width* of the two ranges and `LT` from the *offset*. A width at or
      // below zero means the two statements are not describing the same muscle at all, and there
      // is nothing to salvage. A negative offset means they disagree about where along the muscle
      // the fibers sit -- coracobrachialis implies a 312 mm fiber on a tendon 45 mm shorter than
      // nothing -- and that used to be fatal too, because the slack length was carried into the
      // model, which divides by it.
      //
      // It no longer is. Every tendon is refitted to this skeleton at compile, because a slack
      // length is a length measured on the source's bones and means nothing on ours; the source's
      // value is kept as provenance and never enters an equation. So a negative offset is now
      // evidence rather than a fault, the width beside it is untouched by it, and the fiber length
      // is capped at compile anyway by the share of its own path a fiber may be. OQ-023.
      // Whether the two lengths this actuator implies are both usable. The fiber length comes
      // from the *width* of the two ranges and the tendon from the *offset*, and they fail
      // independently: see `requirePhysical`, which now only refuses the width.
      physical: optimalFiberLength > 0,
      tendonImplied: tendonSlackLength > 0,
    });
  }

  // The other kind. `force` is stated and is the peak force along the tendon; `lengthrange` is
  // stated and is the length range the model gives the muscle. Neither length can be derived,
  // because the operating range that would divide them is MuJoCo's default rather than the file's,
  // so what is recorded is the range itself and the fact that the architecture is missing.
  for (const element of xml.match(/<muscle\b[^>]*\/>/g) ?? []) {
    const name = attribute(element, 'name');
    const force = attribute(element, 'force');
    const lengthrange = attribute(element, 'lengthrange');
    if (!name || !force || !lengthrange) continue;
    if (found.has(name)) continue;
    const [lrmin, lrmax] = lengthrange.trim().split(/\s+/).map(Number);
    found.set(name, {
      architecture: 'not stated',
      maxIsometricForce: Number(force),
      // What the source's own length range implies, at the travel a muscle typically has. It is a
      // stand-in and the name says where it came from rather than what it is.
      optimalFiberLength: (lrmax - lrmin) / TYPICAL_NORMALISED_TRAVEL,
      lengthRange: [lrmin, lrmax],
      // Not derivable, and not used: the compiler fits every tendon to this skeleton anyway. What
      // is put here is the tendon that would leave the fibers at the bottom of their usable band
      // at the muscle's shortest, which is the least surprising thing to carry.
      tendonSlackLength: lrmin - ((lrmax - lrmin) / TYPICAL_NORMALISED_TRAVEL) * 0.6,
      maxContractionVelocity: undefined,
      physical: true,
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
 * The via points `generate:via-points` carried for one unit, or none for a unit that says why.
 *
 * The two tables are joined by unit id and nothing else, and a join that misses used to be
 * silent: a unit renamed in a region generator but not in the via-point table, or the other way
 * round, found no points, took a straight chord from origin to insertion, and every check still
 * passed. `VIA_PATH_DIRECTION` has an entry for every unit the via-point generator handled,
 * including the ones it found no points for, so a unit missing from it is a unit the join missed.
 *
 * Some units take no carried points on purpose -- the reference has none for them, or has ones
 * this skeleton does not trust. Each of those declares `carried: false` with the reason in
 * `because`, which is what lets this tell a decision from a miss.
 */
function carriedPoints(unit, viaPointsFor, direction) {
  if (unit.carried === false) {
    if (typeof unit.because !== 'string' || unit.because.trim() === '') {
      throw new Error(
        `${unit.id} declares carried: false without saying why. Put the reason in 'because'.`,
      );
    }
    return [];
  }
  if (direction?.[unit.id] === undefined) {
    throw new Error(
      `${unit.id} has no entry in VIA_PATH_DIRECTION, so generate:via-points carried nothing for ` +
        'it and its path would silently lose every via point. If the unit was renamed, rename it ' +
        'in generate-muscle-via-points.mjs too; if it deliberately takes none, say so with ' +
        "carried: false and a reason in 'because'.",
    );
  }
  return viaPointsFor(unit.id);
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
  const via = carriedPoints(unit, viaPointsFor, direction).map((p) => ({
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
 * The parameters `readActuators` found for one actuator, or an error naming the file it is not in.
 *
 * Every generator maps its units to actuators by name, and the name is the whole of the join: a
 * vendored commit that renamed an actuator would otherwise hand a generator `undefined` to render.
 * Nine generators used to carry this refusal each, word for word; it is here so that what they
 * tell someone who meets it -- that the pin may have moved, and where the pin is described -- is
 * said once.
 */
export function actuatorFor(actuators, name, model = ARM) {
  const parameters = actuators.get(name);
  if (parameters !== undefined) return parameters;
  throw new Error(
    `${model.muscle} has no actuator named '${name}'. The vendored commit may have moved; check ` +
      'tools/validate-external/README.md before changing this mapping.',
  );
}

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
      `${(parameters.optimalFiberLength * 1000).toFixed(1)} mm, which is not a length. Its ` +
      'lengthrange and its operating range are the same interval in different units, so a width ' +
      'that comes out at or below zero means they are not describing the same muscle. Leave it ' +
      'out of the set and say so, rather than carrying the number.',
  );
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
        ...(unit.via === undefined ? {} : { via: unit.via.map((id) => put(id)) }),
        ...(unit.viaAfter === undefined ? {} : { viaAfter: unit.viaAfter.map((id) => put(id)) }),
        name: `${unit.name}, ${word}`,
        ...(unit.groupName === undefined ? {} : { groupName: `${unit.groupName}, ${word}` }),
        side_: s,
      });
    }
  }
  return out;
}

/**
 * Render one group's worth of units as the muscle-data literal they become.
 *
 * The shape is HSDL's `MuscleGroup`, and every generator writes the same shape; what differs is
 * which units go in it and the prose around it. This builds the groups and their paths from the
 * MyoSuite units and hands the writing to `renderMuscleGroups`, the writer the landmark-style sets
 * use too, so the two kinds of set cannot lay a file out differently.
 */
export function renderGroups(units, viaPointsFor, direction, model = ARM) {
  const groups = new Map();
  for (const unit of units) {
    if (!groups.has(unit.group)) groups.set(unit.group, []);
    groups.get(unit.group).push(unit);
  }
  return renderMuscleGroups(
    [...groups].map(([groupId, members]) => {
      const head = members[0];
      return {
        id: groupId,
        displayName: head.groupName,
        taTerm: head.taTerm,
        innervation: head.innervation,
        source: `gray('${head.groupName.split(',')[0]}')`,
        units: members.map((unit) => ({
          id: unit.id,
          displayName: unit.name,
          origin: unit.origin,
          insertion: unit.insertion,
          path: unitPath(unit, viaPointsFor, direction, model),
          // The MuJoCo muscle model has no pennation angle: the conversion folded it into the peak
          // force, so zero is a faithful transcription rather than a missing value. OQ-014.
          parameters: { ...unit.parameters, pennationAngle: 0 },
          source: `${unit.cite ?? (model === LEGS ? 'myoLegs' : 'myoArm')}('${unit.actuator}')`,
        })),
      };
    }),
  );
}

/**
 * One unit's path, in order, as the elements `renderPath` takes.
 *
 * A unit may name path points of its own, ahead of whatever the reference contributes. Two
 * reasons, and both are about a chord cutting through a body it should be lying against. The
 * torso's are the reference's problem: it anchors its trunk muscles to bodies this skeleton has no
 * counterpart for, so erector spinae gets none of them and would run from the sacrum to the sixth
 * rib straight through the ribcage. The iliopsoas's is ours: the reference holds it over the
 * pelvic brim with a point in its pelvis frame, and this package carries no pelvis frame
 * correspondence, so only the femoral point survived and the path lost the one bend that keeps it
 * in front of the hip.
 */
function unitPath(unit, viaPointsFor, direction, model) {
  return [
    ...(unit.via ?? []).map((id) => ({ kind: 'site', id })),
    ...pathElements(unit, viaPointsFor, direction, unit.model ?? model),
    // And points of its own *after* them, for a muscle whose own points are the distal ones. The
    // long toe tendons are the case: the reference holds them at the ankle and this package holds
    // them along the toe, and a toe point ahead of an ankle point sends the tendon down to the
    // toe, back to the ankle and out to the toe again.
    ...(unit.viaAfter ?? []).map((id) => ({ kind: 'site', id })),
  ].map((e) =>
    e.kind === 'site'
      ? e
      : {
          kind: 'wrap',
          surface: unit.wrap,
          preferredSide: unit.preferredSide,
          source: `gray('${unit.name.split(',')[0]}')`,
        },
  );
}
