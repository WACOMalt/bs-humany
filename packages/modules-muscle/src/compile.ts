/**
 * Binding muscle data to a compiled articulation.
 *
 * Muscle data names bones and attachment sites. The solver needs body indices and body-local
 * offsets in metres. Between the two sit three translations that all have to happen before a
 * single tick runs, and all of which are cheap once and ruinous per tick:
 *
 *   1. **A site id becomes a position.** Attachment sites live in the document, and their
 *      coordinates are expressions in the morphology parameters, because the skeleton is
 *      parametric. Evaluating them here means a muscle scales with stature for free.
 *   2. **A bone becomes a body.** Which bones are their own rigid bodies depends on the fidelity
 *      profile. A bone that is a follower resolves through its owning segment's follower
 *      transform, so a muscle authored once works at every profile -- which is what base spec
 *      ADR-009 made bone ids a stable interface for.
 *   3. **A bone-local point becomes a body-local one.** The follower transform again, applied to
 *      the point rather than to the bone.
 *
 * Nothing here runs in `step`. It allocates freely and it throws on anything it cannot resolve,
 * because a muscle that silently lost its insertion is worse than one that refused to load.
 */

import type { CompiledArticulation, CompiledSegment } from '@bs-humany/compiler';
import type { AttachmentSiteDef, ExprContext, WrappingSurfaceDef } from '@bs-humany/hsdl';
import { evaluate } from '@bs-humany/hsdl';
import type { ScalarExpr } from '@bs-humany/hsdl';
import type { MtuParameters, MuscleGroup } from '@bs-humany/muscle-data';
import { muscleLengthRange, sourceMuscleTravel } from '@bs-humany/muscle-data';
import {
  DEFAULT_ACTIVATION_PARAMETERS,
  DEFAULT_FIBER_DAMPING,
  DEFAULT_MAX_CONTRACTION_VELOCITY,
  type MusculotendonParameters,
} from '@bs-humany/muscle-model';
import type { BoneResolver, MusclePath, Vec3, WrapSurface } from '@bs-humany/muscle-path';

/** Everything the two modules need about one unit, resolved once. */
export interface CompiledMuscleUnit {
  readonly id: string;
  readonly displayName: string;
  readonly group: string;
  readonly parameters: MusculotendonParameters;
  readonly activationTime: number;
  readonly deactivationTime: number;
  /** The unit's path length at the rest pose, metres: what its tendon was fitted to. */
  readonly restLength: number;
  /** The tendon slack length the data states, before it was fitted to this skeleton. */
  readonly statedTendonSlackLength: number;
  /**
   * Optimal fiber length as the source states it, before it is translated to this skeleton.
   *
   * @see deriveOptimalFiberLength
   */
  readonly statedOptimalFiberLength: number;
  /**
   * Where the joints this muscle crosses lie along its path, as fractions from the origin.
   *
   * @see jointCrossings
   */
  readonly jointCrossings: readonly number[];
}

export interface CompiledMuscleSet {
  readonly units: readonly CompiledMuscleUnit[];
  /** Paths in the same order as `units`, ready for a path solver's `compile`. */
  readonly paths: readonly MusclePath[];
  /**
   * Wrap surfaces, one per unit that wraps one -- not one per surface in the document.
   *
   * The geometry is shared but the *side* is not. Two muscles crossing the same bone may lie on
   * opposite sides of it, and the side is what keeps each of them from swapping mid-motion, so it
   * belongs to the muscle's wrap element rather than to the surface. MuJoCo reaches the same
   * conclusion and puts its `sidesite` on the tendon rather than on the geom. So one surface in
   * the document becomes as many solver surfaces as there are muscles using it, each carrying its
   * own side and named for the pair.
   */
  readonly surfaces: readonly WrapSurface[];
  readonly resolver: BoneResolver;
}

/** How a per-muscle copy of a shared surface is named. */
export function wrapSurfaceId(unit: string, surface: string): string {
  return `${unit}__${surface}`;
}

/**
 * A bone resolver over a compiled articulation.
 *
 * Built once and captured in closures over two maps, because `toBodyLocal` is called for every
 * path point at compile time and a linear scan over segments for each would be quadratic in a
 * model with hundreds of units.
 */
export function articulationBoneResolver(articulation: CompiledArticulation): BoneResolver {
  const body = new Map<string, number>();
  const follower = new Map<string, CompiledSegment['followers'][number]['local']>();

  for (const segment of articulation.segments) {
    for (const bone of segment.bones) body.set(bone, segment.index);
    for (const f of segment.followers) follower.set(f.bone, f.local);
  }

  return {
    bodyOf: (bone) => body.get(bone) ?? -1,
    toBodyLocal: (bone, point) => {
      const local = follower.get(bone);
      // The anchor bone *is* the segment frame, so its points need no transform at all.
      if (local === undefined) return point;
      const { translation: t, rotation: q } = local;
      // Rotate by q, then translate. Written out rather than reached for, so this file depends on
      // nothing but arithmetic.
      const tx = 2 * (q.y * point.z - q.z * point.y);
      const ty = 2 * (q.z * point.x - q.x * point.z);
      const tz = 2 * (q.x * point.y - q.y * point.x);
      return {
        x: t.x + point.x + q.w * tx + (q.y * tz - q.z * ty),
        y: t.y + point.y + q.w * ty + (q.z * tx - q.x * tz),
        z: t.z + point.z + q.w * tz + (q.x * ty - q.y * tx),
      };
    },
  };
}

function scalar(value: MtuParameters[keyof MtuParameters], context: ExprContext): number {
  return evaluate(value as never, context);
}

function sitePosition(site: AttachmentSiteDef, context: ExprContext): Vec3 {
  return {
    x: evaluate(site.position.x, context),
    y: evaluate(site.position.y, context),
    z: evaluate(site.position.z, context),
  };
}

/**
 * Resolve muscle groups against a document's attachment sites and an articulation.
 *
 * Throws on a site that is not there or a bone the articulation does not have. Both are caught
 * earlier and more helpfully by `validateMuscleExtension`, which names the muscle; this is the
 * backstop for a caller that skipped it, and it says enough to find the problem.
 */
export function compileMuscleSet(
  groups: readonly MuscleGroup[],
  attachmentSites: readonly AttachmentSiteDef[],
  articulation: CompiledArticulation,
  context: ExprContext,
  wrappingSurfaces: readonly WrappingSurfaceDef[] = [],
): CompiledMuscleSet {
  const sites = new Map(attachmentSites.map((s) => [s.id, s]));
  const declared = new Map(wrappingSurfaces.map((s) => [s.id, s]));
  const resolver = articulationBoneResolver(articulation);
  const units: CompiledMuscleUnit[] = [];
  const paths: MusclePath[] = [];
  const surfaces: WrapSurface[] = [];

  const site = (id: string, unitId: string): AttachmentSiteDef => {
    const found = sites.get(id);
    if (found === undefined) {
      throw new Error(
        `Muscle unit '${unitId}' names attachment site '${id}', which the document does not ` +
          'define. Run validateMuscleExtension to see every such reference at once.',
      );
    }
    if (resolver.bodyOf(found.bone) < 0) {
      throw new Error(
        `Muscle unit '${unitId}' attaches to bone '${found.bone}', which this articulation does ` +
          'not contain. Check the fidelity profile.',
      );
    }
    return found;
  };

  for (const group of groups) {
    for (const unit of group.units) {
      const origin = site(unit.origin, unit.id);
      const insertion = site(unit.insertion, unit.id);

      const elements: MusclePath['elements'] = unit.path.map((element) => {
        if (element.kind === 'wrap') {
          const shared = declared.get(element.surface);
          if (shared === undefined) {
            throw new Error(
              `Muscle unit '${unit.id}' wraps surface '${element.surface}', which the document ` +
                'does not define. Run validateMuscleExtension to see every such reference at once.',
            );
          }
          const id = wrapSurfaceId(unit.id, element.surface);
          surfaces.push(toSolverSurface(id, shared, element.preferredSide, context));
          return { kind: 'wrap', surface: id } as const;
        }
        const via = site(element.site, unit.id);
        const at = { bone: via.bone, point: sitePosition(via, context) };
        return element.kind === 'conditionalSite'
          ? ({
              kind: 'conditionalViaPoint',
              site: at,
              coordinate: element.coordinate,
              range: element.range,
              blend: element.blend,
            } as const)
          : ({ kind: 'viaPoint', site: at } as const);
      });

      paths.push({
        id: unit.id,
        origin: { bone: origin.bone, point: sitePosition(origin, context) },
        elements,
        insertion: { bone: insertion.bone, point: sitePosition(insertion, context) },
      });

      const p = unit.parameters;
      const statedOptimalFiberLength = scalar(p.optimalFiberLength, context);
      const pennationAngle = scalar(p.pennationAngle, context);
      const statedTendonSlackLength = scalar(p.tendonSlackLength, context);
      const restLength = restPathLength(
        paths[paths.length - 1] as MusclePath,
        articulation,
        resolver,
      );
      const travel = muscleLengthRange(unit.id);
      const optimalFiberLength = deriveOptimalFiberLength(
        statedOptimalFiberLength,
        travel === undefined ? undefined : (travel.longest - travel.shortest) * restLength,
        sourceMuscleTravel(unit.id)?.travel,
        restLength,
      );
      units.push({
        id: unit.id,
        displayName: unit.displayName,
        group: group.id,
        restLength,
        statedTendonSlackLength,
        statedOptimalFiberLength,
        jointCrossings: jointCrossings(
          paths[paths.length - 1] as MusclePath,
          articulation,
          resolver,
        ),
        parameters: {
          maxIsometricForce: scalar(p.maxIsometricForce, context),
          optimalFiberLength,
          tendonSlackLength: fittedTendonSlack(
            restLength,
            optimalFiberLength,
            pennationAngle,
            travel,
          ),
          pennationAngle,
          maxContractionVelocity:
            p.maxContractionVelocity === undefined
              ? DEFAULT_MAX_CONTRACTION_VELOCITY
              : scalar(p.maxContractionVelocity, context),
          damping: p.damping ?? DEFAULT_FIBER_DAMPING,
        },
        activationTime: p.activationTime ?? DEFAULT_ACTIVATION_PARAMETERS.activationTime,
        deactivationTime: p.deactivationTime ?? DEFAULT_ACTIVATION_PARAMETERS.deactivationTime,
      });
    }
  }

  return { units, paths, surfaces, resolver };
}

/**
 * How far the translation of a fiber length is allowed to go before it is capped.
 *
 * A muscle whose path here travels twice what it travelled on the model it was measured on does
 * not have fibers twice as long. It has a path that is wrong, or a joint whose range is not the
 * range the source gave that joint, and scaling a parameter by the discrepancy would bury the
 * evidence in a number. Brachialis is the clearest case: ours travels 87 mm against the source's
 * 36 mm, because its straight run from the humeral shaft to the ulna cuts the corner as the elbow
 * closes -- it needs path geometry it has not got (OQ-015), not a fiber twice the size.
 *
 * So the ratio is capped, and a capped unit is a unit to go and look at rather than one that has
 * been fixed. `pnpm measure:source-travel` prints which ones they are.
 */
export const TRANSLATION_LIMIT = 2;

/**
 * The most of a muscle's rest length its fibers may be, with the rest left for tendon.
 *
 * Four fifths. Not a tuned number -- it is the loosest statement that is still true of a muscle,
 * which is that some of it is tendon. It exists because the travel ratio does not know what a
 * muscle is: scaled by its own travel, teres minor comes out with 228 mm of fiber on a 181 mm
 * path, and a tendon of minus 47 mm is not a short tendon.
 */
export const FIBER_SHARE_LIMIT = 0.8;

/**
 * Optimal fiber length on this skeleton, translated from the one the source measured it on.
 *
 * Of the four musculotendon parameters this is the second that does not simply cross over.
 * Tendon slack length is a length on the source's bones and is refitted here (`fittedTendonSlack`).
 * Optimal fiber length is not a length in that sense -- it is *architecture*, the length of the
 * fibers themselves -- but what makes a fiber length right for a muscle is the distance that
 * muscle has to cover, and the distance changed with the bones.
 *
 * What is carried across, then, is the ratio the source chose: fibers long enough to cover that
 * travel in the same proportion. A muscle that travels further here gets proportionally longer
 * fibers, which puts it on the same stretch of its force-length curve the source put it on, and
 * one whose travel matches -- or is shorter, see below -- keeps the number it was given. That is the standard translation when a
 * musculoskeletal model is taken to a different skeleton, and it is the half of OQ-020 that could
 * be settled without inventing a number: both models can be run here, so both travels are
 * measured rather than assumed.
 *
 * What it is *not* is a licence to make a fiber whatever length is convenient. Fiber length is the
 * parameter that sets how much force a muscle makes at a given length and how fast it can shorten,
 * and a muscle with fibers a third of a metre long is not a muscle. `TRANSLATION_LIMIT` caps it.
 *
 * The second cap is anatomy rather than evidence. Fibers are part of a muscle and tendon is the
 * rest of it, so a fiber cannot be most of the path and certainly cannot be longer than all of it
 * -- which the ratio alone will happily produce: teres minor travels 70 mm here against 42 mm
 * there, and 1.66 times its stated fiber length is 228 mm on a muscle whose whole path is 181.
 * `FIBER_SHARE_LIMIT` leaves a fifth of the path for the tendon. It binds where our paths are too
 * long, which is the same evidence the ratio gives, arriving from the other side.
 *
 * A unit with no measurement on one side or the other keeps the source's number, which is the
 * right answer for a muscle nothing has measured rather than a gap.
 */
export function deriveOptimalFiberLength(
  stated: number,
  travel: number | undefined,
  sourceTravel: number | undefined,
  restLength: number,
): number {
  const room = FIBER_SHARE_LIMIT * restLength;
  if (travel === undefined || sourceTravel === undefined || !(sourceTravel > 0)) {
    return stated > room ? room : stated;
  }
  // Longer only. The failure this repairs is a muscle covering more of its curve here than the
  // source meant it to, and longer fibers are what more travel asks for. Less travel than the
  // source's is not the same kind of evidence: it costs nothing to leave those fibers alone, and
  // shortening them on it makes things worse rather than better -- a shorter fiber spans a wider
  // band for the same travel, so it ends up further up its passive curve at the long end, which
  // is a stiffer brake on the joint. Rectus femoris is the case: ours travels 0.86 of what the
  // source's does, and scaling its fibers down by that turned the quadriceps back into the splint
  // this was fixing, stopping a fully driven knee at 83 degrees again.
  const ratio = travel / sourceTravel;
  if (!(ratio > 1)) return stated > room ? room : stated;
  const derived = stated * Math.min(TRANSLATION_LIMIT, ratio);
  return derived > room ? room : derived;
}

/**
 * The least tendon a unit may be given, metres.
 *
 * A millimetre. Not physical -- it is a floor under a division: the fiber model normalises tendon
 * length by the slack length, so a slack length of zero is not a stiff tendon but a NaN.
 */
export const MINIMUM_TENDON_SLACK = 0.001;

/**
 * How slack a muscle's tendon is left at the rest pose, as a fraction of its own slack length.
 *
 * One per cent: half a millimetre on the shortest tendon here and three on the longest, which is
 * several times the tenth of a millimetre a settling path moves in a tick and far less than the
 * five per cent of strain the tendon carries a whole isometric force at. Enough to be off the
 * knee of the curve, small enough that the muscle still takes up almost at once when the joint
 * moves.
 */
export const REST_SLACK = 0.01;

/**
 * How short and how long a fiber is allowed to get over the range of the joints its muscle
 * crosses, in units of its own optimal length.
 *
 * A muscle fitted only at the rest pose is fitted at *one* point of its travel, and for several
 * muscles the rest pose is one end of that travel rather than the middle of it. A hanging leg has
 * its knee straight, which is where the hamstrings are longest and the vasti shortest, so every
 * millimetre either of them travels goes the same way: fitted at rest, biceps femoris ran its
 * fibers down to a quarter of optimal by deep flexion and made almost no force there. A fully
 * driven leg stopped bending at 84 degrees of about 135.
 *
 * So the fit is given the travel as well -- `MUSCLE_LENGTH_RANGES`, measured on this skeleton --
 * and moves the tendon only as far as it must to keep the fibers inside this band. A muscle whose
 * travel already fits keeps the rest-pose fit exactly; nothing in the arm moves.
 *
 * Below 0.6 the active curve is under a third of peak and falling steeply, which is the muscle
 * that feels dead at one end of its range.
 *
 * The ceiling is the one that can be checked against a body rather than argued, because what it
 * sets is how hard a relaxed muscle resists its joint at the end of the range -- and for the knee
 * that is a quantity anatomists measure. Holding the flexors at full drive and reading the net
 * moment about the knee at each angle, with the pose imposed so nothing tumbles:
 *
 *     ceiling   passive extension moment at 120 deg   flexors still winning to
 *     1.5                  88 Nm                              75 deg
 *     1.4                  74                                 74
 *     1.3                  46                                 78
 *     1.2                  27                                 85
 *
 * A knee's own passive resistance near full flexion is on the order of 15 to 25 Nm, and the
 * quadriceps are not all of it -- the joint's own passive torque is modelled separately. So 1.2,
 * where the muscles contribute about that much and a driven leg gets furthest. Higher, and four
 * relaxed extensors splint the joint: at 1.4 they carry three times what a whole knee resists
 * with, which is the failure this band exists to stop.
 *
 * Not symmetric about optimal, so a muscle that travels further than the band is wide -- several
 * of the knee's do -- ends up centered on 0.9 rather than 1.0. That is the right side to err on:
 * short of optimal a fiber makes less force, past it a *relaxed* fiber makes force nobody asked
 * for, and only the second can stop a joint.
 */
export const FIBER_FLOOR = 0.6;
/** @see FIBER_FLOOR */
export const FIBER_CEILING = 1.2;

/**
 * The tendon slack length this skeleton implies, rather than the one the source model states.
 *
 * Of the four musculotendon parameters, three are properties of the *tissue* -- how much force
 * the fibers make, how long they are at their best, what angle they sit at -- and they cross from
 * one skeleton to another unchanged. Tendon slack length is not one of them. It is a length
 * measured on the model it came from: how far it is from that muscle's origin to its insertion on
 * *those* bones, less what the fibers take up. Carried onto different bones it is a statement
 * about the wrong body.
 *
 * Ours are different bones. Measured against the source model's own paths, this skeleton's are 25
 * to 75 mm longer through the rotator cuff and teres major and about 50 longer at the biceps, and
 * what that does with a transcribed tendon length is not subtle: the difference lands on the
 * tendon, which is the stiffest thing in the model. The posterior deltoid sat 34 mm past its own
 * resting length and pulled a kilonewton at rest, the arm twitched, and the rotation flipped.
 *
 * So the tendon is fitted here, to the one pose every model agrees on: at the rest pose the fiber
 * sits at its optimal length and the tendon just short of slack, carrying nothing. That is the
 * standard step when a musculoskeletal model is scaled to a new skeleton, and it is the same
 * quantity being computed -- the length of that tendon on this body.
 *
 * *Just* short of slack, by `REST_SLACK`, and the margin is not decoration. A tendon's force is
 * zero below its slack length and rises very steeply above it, so a muscle fitted to sit exactly
 * at slack is balanced on the one point where a tenth of a millimetre is the difference between
 * nothing and hundreds of newtons. A settling body moves a path by about that much per tick, so
 * every such muscle chattered: measured at rest, units crossed from zero force to a kilonewton
 * and back roughly every other tick, 260 times in 400 ticks. It barely moved the body, because
 * muscles on opposite sides chattered against each other, but it was plainly visible -- the
 * bellies flashed between slack and taut colours. A relaxed muscle is slack, not balanced on the
 * point where its tendon begins to pull.
 *
 * What is not fitted: peak force, optimal fiber length, pennation, maximum contraction velocity.
 * Those stay exactly as cited, which is what keeps the provenance honest -- the tissue is the
 * source's and the geometry is ours, which is the split this project already draws for
 * attachments.
 *
 * The rest length is taken along the straight path through the via points, without wrapping. A
 * wrap only ever lengthens a path, so a unit that wraps at rest is fitted slightly short and
 * begins with its tendon a little stretched; the alternative is running the geodesic solver
 * inside a compile step, which is a great deal of machinery for a millimetre.
 *
 * ## The rest pose is not always the middle of the travel
 *
 * Fitting at rest and stopping there suits a muscle whose joints sit mid-range when the body
 * hangs, and the elbow's do. The knee's do not: a hanging leg is straight, which is one end of
 * the knee's travel, so the vasti and the hamstrings both start at an extreme and go one way
 * only. `range` is how far the unit's path actually travels, as fractions of its own rest length,
 * and with it the tendon is moved as far as it must be -- and no further -- to keep the fibers
 * between `FIBER_FLOOR` and `FIBER_CEILING` over that travel. A unit whose travel already fits
 * inside the band keeps the rest-pose fit unchanged, so this costs the arm nothing.
 *
 * Passing no range asks for the rest-pose fit alone, which is what a unit nothing has measured
 * gets.
 */
export function fittedTendonSlack(
  restLength: number,
  optimalFiberLength: number,
  pennationAngle: number,
  range?: { readonly shortest: number; readonly longest: number },
): number {
  const fiberAlongTendon = optimalFiberLength * Math.cos(pennationAngle);
  // Longer than the length that would put the tendon exactly at slack, so at rest it is inside
  // its own slack length and carrying nothing at all.
  const atRest = (restLength - fiberAlongTendon) * (1 + REST_SLACK);
  let fitted = atRest;
  if (range !== undefined) {
    // A longer tendon leaves a shorter fiber, so the short end of the travel is what caps the
    // tendon and the long end is what floors it.
    const mostSlack = range.shortest * restLength - FIBER_FLOOR * fiberAlongTendon;
    const leastSlack = range.longest * restLength - FIBER_CEILING * fiberAlongTendon;
    const banded =
      leastSlack > mostSlack
        ? // Travels further than the band is wide: no tendon satisfies both ends, and the midpoint
          // of two symmetric bounds is the travel centered on optimal.
          (leastSlack + mostSlack) / 2
        : Math.min(Math.max(fitted, leastSlack), mostSlack);
    // Never shorter than the rest-pose fit, which is to say: never stretched at rest. A shorter
    // tendon puts the fiber past optimal at the pose the body holds when it is doing nothing, and
    // passive force there is force the body never asked for. Fitted to its travel alone,
    // gastrocnemius sat at 1.28 of optimal with the leg hanging straight and pulled 230 N a side;
    // an undriven knee folded to its stop. So the travel may lengthen a tendon and not shorten
    // one, and a muscle whose short end is out of reach on those terms is simply weak there --
    // which is what a muscle at the end of its travel is.
    fitted = banded > atRest ? banded : atRest;
  }
  // Shorter than its own fibers at rest: the muscle is bunched, and there is no tendon to speak
  // of. Keep the floor rather than the stated length, which would be longer than the whole unit.
  return fitted > MINIMUM_TENDON_SLACK ? fitted : MINIMUM_TENDON_SLACK;
}

/**
 * How long a path is at the rest pose, following it through its via points.
 *
 * Wrapping is not solved here: see `fittedTendonSlack` for why a straight run through the via
 * points is enough for what this is used for.
 */
/** A point of a bone, placed in the world at the rest pose. */
function restWorldPoint(
  bone: string,
  point: Vec3,
  articulation: CompiledArticulation,
  resolver: BoneResolver,
): Vec3 {
  const segment = articulation.segments[resolver.bodyOf(bone)];
  if (!segment) return point;
  const local = resolver.toBodyLocal(bone, point);
  const { translation: t, rotation: q } = segment.restWorld;
  const tx = 2 * (q.y * local.z - q.z * local.y);
  const ty = 2 * (q.z * local.x - q.x * local.z);
  const tz = 2 * (q.x * local.y - q.y * local.x);
  return {
    x: t.x + local.x + q.w * tx + (q.y * tz - q.z * ty),
    y: t.y + local.y + q.w * ty + (q.z * tx - q.x * tz),
    z: t.z + local.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** The path's points at the rest pose, origin first and insertion last. */
function restPathPoints(
  path: MusclePath,
  articulation: CompiledArticulation,
  resolver: BoneResolver,
): Vec3[] {
  const points: Vec3[] = [
    restWorldPoint(path.origin.bone, path.origin.point, articulation, resolver),
  ];
  for (const element of path.elements) {
    if (element.kind === 'viaPoint') {
      points.push(restWorldPoint(element.site.bone, element.site.point, articulation, resolver));
    }
  }
  points.push(restWorldPoint(path.insertion.bone, path.insertion.point, articulation, resolver));
  return points;
}

function restPathLength(
  path: MusclePath,
  articulation: CompiledArticulation,
  resolver: BoneResolver,
): number {
  const points = restPathPoints(path, articulation, resolver);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Vec3;
    const b = points[i] as Vec3;
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return total;
}

/** Every segment from `segment` up to the root, nearest first. */
function ancestry(articulation: CompiledArticulation, segment: number): number[] {
  const chain: number[] = [];
  for (let at = segment; at >= 0; at = articulation.segments[at]?.parent ?? -1) {
    chain.push(at);
    if (chain.length > articulation.segments.length) break;
  }
  return chain;
}

/**
 * Where along a muscle's path the joints it crosses lie, as fractions of the path.
 *
 * A muscle runs from one segment to another, and the joints between them are the ones it crosses:
 * the segments from each end up to their common ancestor, and the joint that carries each of them.
 * Each joint's rest position is its frame in its parent segment, placed in the world.
 */
function crossingFractions(
  path: MusclePath,
  articulation: CompiledArticulation,
  resolver: BoneResolver,
): number[] {
  const from = resolver.bodyOf(path.origin.bone);
  const to = resolver.bodyOf(path.insertion.bone);
  if (from < 0 || to < 0) return [];
  const up = ancestry(articulation, from);
  const down = ancestry(articulation, to);
  const shared = new Set(up);
  const common = down.find((segment) => shared.has(segment)) ?? -1;
  const spanned = new Set<number>();
  for (const chain of [up, down]) {
    for (const segment of chain) {
      if (segment === common) break;
      spanned.add(segment);
    }
  }
  // The joint that carries a segment is the one it is the child of.
  const centres: Vec3[] = [];
  for (const joint of articulation.joints) {
    if (!spanned.has(joint.childSegment)) continue;
    // A joint with no coordinates is a weld, and a belly may lie across a weld: the two bones do
    // not move against each other, so there is nothing for a tendon to accommodate. The foot is
    // full of them -- the midfoot and forefoot are segments of their own with no coordinates at
    // this profile -- and counting them chopped the sole into stretches that are not joints.
    if (joint.dofs.length === 0) continue;
    const parent = articulation.segments[joint.parentSegment];
    if (!parent) continue;
    const { translation: t, rotation: q } = parent.restWorld;
    const l = joint.frameInParent.translation;
    const tx = 2 * (q.y * l.z - q.z * l.y);
    const ty = 2 * (q.z * l.x - q.x * l.z);
    const tz = 2 * (q.x * l.y - q.y * l.x);
    centres.push({
      x: t.x + l.x + q.w * tx + (q.y * tz - q.z * ty),
      y: t.y + l.y + q.w * ty + (q.z * tx - q.x * tz),
      z: t.z + l.z + q.w * tz + (q.x * ty - q.y * tx),
    });
  }
  if (centres.length === 0) return [];

  const points = restPathPoints(path, articulation, resolver);
  const arc: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Vec3;
    const b = points[i] as Vec3;
    arc.push((arc[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  const total = arc[arc.length - 1] as number;
  if (!(total > 0)) return [];

  // Each joint, at the nearest point of the path to it.
  const fractions: number[] = [];
  for (const centre of centres) {
    let best = Number.POSITIVE_INFINITY;
    let at = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1] as Vec3;
      const b = points[i] as Vec3;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const span = dx * dx + dy * dy + dz * dz;
      const t =
        span > 0
          ? Math.min(
              1,
              Math.max(
                0,
                ((centre.x - a.x) * dx + (centre.y - a.y) * dy + (centre.z - a.z) * dz) / span,
              ),
            )
          : 0;
      const distance = Math.hypot(
        a.x + dx * t - centre.x,
        a.y + dy * t - centre.y,
        a.z + dz * t - centre.z,
      );
      if (distance < best) {
        best = distance;
        at = (arc[i - 1] as number) + Math.sqrt(span) * t;
      }
    }
    fractions.push(at / total);
  }
  return fractions.sort((a, b) => a - b);
}

/**
 * Where the joints a muscle crosses lie along its path, as fractions from the origin, in order.
 *
 * What this is for is drawing. A muscle belly does not lie across a joint -- tendon does, and that
 * is what tendon is for: it is why the fleshy part of a calf stops well above the heel and the
 * fleshy part of a forearm stops well above the wrist. `bellyPlacement` slides the belly clear of
 * these, and nothing else in the model reads them.
 *
 * Measured once, at the rest pose, and carried as fractions. The joints move as the body does and
 * the fractions do not follow, which is the approximation: a knee at four per cent of the path
 * with the leg straight is at five with it bent. It reaches a render channel only (M-ADR-004), and
 * no force depends on any of it.
 */
export function jointCrossings(
  path: MusclePath,
  articulation: CompiledArticulation,
  resolver: BoneResolver,
): number[] {
  return crossingFractions(path, articulation, resolver);
}

/**
 * One muscle's copy of a shared wrap surface, in the shape the path solver wants.
 *
 * The shape union differs between the two: HSDL states a cylinder's full length because that is
 * how anyone measures one, and the solver wants the half-length because that is what the geodesic
 * maths compares against. Converting here rather than at either end keeps both honest.
 */
function toSolverSurface(
  id: string,
  surface: WrappingSurfaceDef,
  side: { readonly x: ScalarExpr; readonly y: ScalarExpr; readonly z: ScalarExpr },
  context: ExprContext,
): WrapSurface {
  const shape = surface.shape;
  const rotation = surface.transform.rotation;
  const common = {
    id,
    bone: surface.bone,
    position: {
      x: evaluate(surface.transform.translation.x, context),
      y: evaluate(surface.transform.translation.y, context),
      z: evaluate(surface.transform.translation.z, context),
    },
    orientation: [rotation.x, rotation.y, rotation.z, rotation.w] as const,
    preferredSide: {
      x: evaluate(side.x, context),
      y: evaluate(side.y, context),
      z: evaluate(side.z, context),
    },
  };

  if (shape.kind === 'sphere') {
    return { ...common, type: 'sphere', radius: evaluate(shape.radius, context) };
  }
  if (shape.kind === 'cylinder') {
    return {
      ...common,
      type: 'cylinder',
      radius: evaluate(shape.radius, context),
      halfLength: evaluate(shape.length, context) / 2,
    };
  }
  return {
    ...common,
    type: 'ellipsoid',
    semiAxes: {
      x: evaluate(shape.radii.x, context),
      y: evaluate(shape.radii.y, context),
      z: evaluate(shape.radii.z, context),
    },
  };
}
