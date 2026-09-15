import { cite } from '@bs-humany/hsdl';
import type { AttachmentSiteDef, WrappingSurfaceDef } from '@bs-humany/hsdl';
import { describe, expect, it } from 'vitest';
import {
  MUSCLE_NAMESPACE,
  MUSCLE_SCHEMA_VERSION,
  type MuscleExtension,
  MuscleExtensionSchema,
  type MuscleGroup,
} from './schema.js';
import { type MuscleReferenceContext, validateMuscleExtension } from './validate.js';

const source = cite('holzbaur2005', 'Table 1');

function site(id: string, kind: AttachmentSiteDef['kind'], bone: string): AttachmentSiteDef {
  return {
    id,
    bone,
    kind,
    displayName: id,
    position: { x: 0, y: 0, z: 0 },
    source: cite('gray1918', 'Part IV, Myology'),
  };
}

const SURFACE: WrappingSurfaceDef = {
  id: 'elbow_bic_cylinder',
  bone: 'humerus_r',
  displayName: 'Distal humerus, biceps',
  transform: { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  shape: { kind: 'cylinder', radius: 0.015, length: 0.1 },
  source: cite('gray1918', 'Part IV, Myology'),
};

function documentWith(sites: AttachmentSiteDef[]): MuscleReferenceContext {
  return { attachmentSites: sites, wrappingSurfaces: [SURFACE] };
}

const SITES = [
  site('biceps_origin', 'muscle_origin', 'scapula_r'),
  site('biceps_insertion', 'muscle_insertion', 'radius_r'),
  site('biceps_via', 'tendon_via_point', 'humerus_r'),
  site('a_ligament', 'ligament', 'ulna_r'),
];

function group(overrides: Partial<MuscleGroup['units'][number]> = {}): MuscleGroup {
  return {
    id: 'biceps_brachii_r',
    displayName: 'Biceps brachii, right',
    units: [
      {
        id: 'biceps_long_r',
        displayName: 'Biceps brachii, long head, right',
        origin: 'biceps_origin',
        insertion: 'biceps_insertion',
        path: [],
        parameters: {
          maxIsometricForce: 525.1,
          optimalFiberLength: 0.1157,
          tendonSlackLength: 0.2723,
          pennationAngle: 0,
          source,
        },
        ...overrides,
      },
    ],
    source,
  };
}

function extensionWith(g: MuscleGroup): MuscleExtension {
  return { version: MUSCLE_SCHEMA_VERSION, groups: [g] };
}

describe('the muscle extension schema', () => {
  it('lives under a reverse-DNS namespace rather than a new top-level section', () => {
    // Base spec 14.5 obligation 3, used for the first time. A document carrying muscle data has
    // to keep loading in a build that has no muscle module, which a top-level section would not.
    expect(MUSCLE_NAMESPACE).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    expect(MUSCLE_NAMESPACE.endsWith('.muscle')).toBe(true);
  });

  it('accepts a well-formed muscle', () => {
    expect(MuscleExtensionSchema.safeParse(extensionWith(group())).success).toBe(true);
  });

  it('refuses a parameter set with no citation', () => {
    // Section 6.5 requires every parameter to carry a source, in the same terms the base spec
    // requires it of joint ranges. Making the field required means an uncited parameter cannot be
    // represented at all, rather than being caught later by a lint that someone can skip.
    const parsed = MuscleExtensionSchema.safeParse(
      extensionWith(
        group({
          parameters: {
            maxIsometricForce: 525.1,
            optimalFiberLength: 0.1157,
            tendonSlackLength: 0.2723,
            pennationAngle: 0,
          } as never,
        }),
      ),
    );
    expect(parsed.success).toBe(false);
  });

  it('refuses a conditional via point with no blend band', () => {
    // A conditional point that switched at a threshold would step the path length, and the
    // velocity spike that follows becomes a force spike through the force-velocity curve. The
    // schema refuses to express the unblended case rather than trusting authors to remember.
    for (const blend of [0, -0.1]) {
      const parsed = MuscleExtensionSchema.safeParse(
        extensionWith(
          group({
            path: [
              {
                kind: 'conditionalSite',
                site: 'biceps_via',
                coordinate: 'elbow_r.flexion',
                range: [0.5, 2],
                blend,
                source,
              },
            ],
          }),
        ),
      );
      expect(parsed.success, `blend=${blend}`).toBe(false);
    }
  });

  it('refuses an unknown field rather than dropping it silently', () => {
    const parsed = MuscleExtensionSchema.safeParse(
      extensionWith(group({ maxIsometricForce: 500 } as never)),
    );
    expect(parsed.success).toBe(false);
  });

  it('lets the optional parameters fall back to the module’s cited defaults', () => {
    const parsed = MuscleExtensionSchema.safeParse(extensionWith(group()));
    expect(parsed.success).toBe(true);
    const unit = parsed.success ? parsed.data.groups[0]?.units[0] : undefined;
    expect(unit?.parameters.damping).toBeUndefined();
    expect(unit?.parameters.activationTime).toBeUndefined();
  });
});

describe('muscle cross-references', () => {
  it('passes a muscle whose sites and surfaces all exist', () => {
    const report = validateMuscleExtension(documentWith(SITES), extensionWith(group()));
    expect(report.problems).toEqual([]);
    expect(report.unitCount).toBe(1);
    expect(report.groupCount).toBe(1);
  });

  it('catches an origin that names a site the document does not have', () => {
    // The failure this exists for: a site renamed two commits ago passes the schema and surfaces
    // as a path-solver compile error in another package, with no way back to the muscle.
    const report = validateMuscleExtension(
      documentWith(SITES),
      extensionWith(group({ origin: 'renamed_last_week' })),
    );
    expect(report.problems[0]?.message).toContain('does not define');
    expect(report.problems[0]?.unit).toBe('biceps_long_r');
  });

  it('catches a muscle wired up backwards', () => {
    // An insertion used as an origin is not a schema error, and the muscle behaves plausibly
    // until someone measures its moment arm against a published one.
    const report = validateMuscleExtension(
      documentWith(SITES),
      extensionWith(group({ origin: 'biceps_insertion', insertion: 'biceps_origin' })),
    );
    expect(report.problems).toHaveLength(2);
    expect(report.problems[0]?.message).toContain('rather than');
  });

  it('catches a unit with the same site at both ends', () => {
    const report = validateMuscleExtension(
      documentWith(SITES),
      extensionWith(group({ insertion: 'biceps_origin' })),
    );
    expect(report.problems.some((p) => p.message.includes('no line of action'))).toBe(true);
  });

  it('catches a wrap around a surface nobody defined', () => {
    const report = validateMuscleExtension(
      documentWith(SITES),
      extensionWith(
        group({
          path: [
            { kind: 'wrap', surface: 'not_a_surface', preferredSide: { x: 0, y: 1, z: 0 }, source },
          ],
        }),
      ),
    );
    expect(report.problems[0]?.message).toContain('not_a_surface');
  });

  it('accepts a wrap around a surface the document does define', () => {
    const report = validateMuscleExtension(
      documentWith(SITES),
      extensionWith(
        group({
          path: [
            {
              kind: 'wrap',
              surface: SURFACE.id,
              preferredSide: { x: 0, y: 1, z: 0 },
              source,
            },
          ],
        }),
      ),
    );
    expect(report.problems).toEqual([]);
  });

  it('catches a path routed through a ligament attachment', () => {
    // A ligament site is where a different structure attaches. Routing a muscle through one is
    // the kind of mistake that comes from picking an id off a list by name.
    const report = validateMuscleExtension(
      documentWith(SITES),
      extensionWith(group({ path: [{ kind: 'site', site: 'a_ligament' }] })),
    );
    expect(report.problems[0]?.message).toContain('ligament');
  });

  it('catches a conditional point whose blend never reaches full effect', () => {
    const report = validateMuscleExtension(
      documentWith(SITES),
      extensionWith(
        group({
          path: [
            {
              kind: 'conditionalSite',
              site: 'biceps_via',
              coordinate: 'elbow_r.flexion',
              range: [1, 1.1],
              blend: 0.2,
              source,
            },
          ],
        }),
      ),
    );
    expect(report.problems[0]?.message).toContain('never reaches full effect');
  });

  it('catches two units sharing an id, because ids index the output buffers', () => {
    const duplicated = group();
    const extension: MuscleExtension = {
      version: MUSCLE_SCHEMA_VERSION,
      groups: [duplicated, { ...duplicated, id: 'other_group' }],
    };
    const report = validateMuscleExtension(documentWith(SITES), extension);
    expect(report.problems[0]?.message).toContain('duplicate unit id');
    expect(report.unitCount).toBe(2);
  });
});
