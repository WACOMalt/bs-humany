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
      units.push({
        id: unit.id,
        displayName: unit.displayName,
        group: group.id,
        parameters: {
          maxIsometricForce: scalar(p.maxIsometricForce, context),
          optimalFiberLength: scalar(p.optimalFiberLength, context),
          tendonSlackLength: scalar(p.tendonSlackLength, context),
          pennationAngle: scalar(p.pennationAngle, context),
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
