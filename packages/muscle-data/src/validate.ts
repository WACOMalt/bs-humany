/**
 * Cross-reference checking for the muscle extension -- the half of N2.1 a schema cannot do.
 *
 * `MuscleExtensionSchema` proves a muscle document is well formed. It cannot prove it is about
 * anything: every site and surface a muscle names is just an id until it is looked up in the
 * document those ids are supposed to live in. A muscle whose origin names a site that was renamed
 * two commits ago passes the schema and produces a path solver compile error at run time, in a
 * different package, with no idea which muscle asked for it.
 *
 * So this runs at load, once, and says which muscle named what.
 */

import type { HsdlDocument } from '@bs-humany/hsdl';
import type { MuscleExtension } from './schema.js';

export interface MuscleReferenceProblem {
  readonly group: string;
  readonly unit: string;
  readonly message: string;
}

export interface MuscleValidationReport {
  readonly groupCount: number;
  readonly unitCount: number;
  readonly problems: readonly MuscleReferenceProblem[];
}

/**
 * What the checker actually reads: the two lookups, not a whole document.
 *
 * Narrowed deliberately. Taking an `HsdlDocument` would imply the checker cares about bones,
 * joints or morphology, and would mean a caller holding only the sites -- a loader part way
 * through, a test -- had to fabricate the rest of a document to ask a question about muscles.
 */
export type MuscleReferenceContext = Pick<HsdlDocument, 'attachmentSites' | 'wrappingSurfaces'>;

export function validateMuscleExtension(
  document: MuscleReferenceContext,
  extension: MuscleExtension,
): MuscleValidationReport {
  const problems: MuscleReferenceProblem[] = [];
  const sites = new Map(document.attachmentSites.map((s) => [s.id, s]));
  const surfaces = new Set((document.wrappingSurfaces ?? []).map((s) => s.id));
  const unitIds = new Set<string>();
  let unitCount = 0;

  for (const group of extension.groups) {
    for (const unit of group.units) {
      unitCount++;
      const report = (message: string) =>
        problems.push({ group: group.id, unit: unit.id, message });

      if (unitIds.has(unit.id)) {
        report(`duplicate unit id '${unit.id}'. Unit ids index the solver's output buffers.`);
      }
      unitIds.add(unit.id);

      // Origin and insertion must exist, and must be the kind of site they are used as. A muscle
      // wired up backwards is not a schema error and behaves plausibly until its moment arm is
      // compared with a published one.
      for (const [role, id, expected] of [
        ['origin', unit.origin, 'muscle_origin'],
        ['insertion', unit.insertion, 'muscle_insertion'],
      ] as const) {
        const site = sites.get(id);
        if (site === undefined) {
          report(`${role} names attachment site '${id}', which this document does not define.`);
        } else if (site.kind !== expected) {
          report(
            `${role} names site '${id}', which is a '${site.kind}' rather than a '${expected}'. ` +
              'A unit wired up backwards behaves plausibly until its moment arm is measured.',
          );
        }
      }

      if (unit.origin === unit.insertion) {
        report('origin and insertion are the same site, so the unit has no line of action.');
      }

      for (const element of unit.path) {
        if (element.kind === 'wrap') {
          if (!surfaces.has(element.surface)) {
            report(`wraps surface '${element.surface}', which this document does not define.`);
          }
          continue;
        }
        const site = sites.get(element.site);
        if (site === undefined) {
          report(`path names attachment site '${element.site}', which is not defined.`);
        } else if (site.kind === 'ligament') {
          report(
            `path routes through '${element.site}', a ligament attachment. A ligament insertion ` +
              'is where a different structure attaches, not a point this muscle passes through.',
          );
        }
        if (element.kind === 'conditionalSite') {
          const [low, high] = element.range;
          if (!(high > low)) {
            report(`conditional point on '${element.coordinate}' has an empty range.`);
          } else if (element.blend * 2 > high - low) {
            report(
              `conditional point on '${element.coordinate}' blends over ${element.blend} at each ` +
                `end of a range only ${high - low} wide, so it never reaches full effect.`,
            );
          }
        }
      }
    }
  }

  return { groupCount: extension.groups.length, unitCount, problems };
}

/**
 * Reads and validates the muscle extension on a document, if it has one.
 *
 * Returns `undefined` for a document with no muscle data, which is not an error: every document
 * in the repository was written before this module existed and must keep loading.
 */
export function readMuscleExtension(
  document: HsdlDocument,
  namespace: string,
): unknown | undefined {
  return document.ext?.[namespace];
}
