/**
 * The whole body's muscle paths, compiled the way a running session compiles them.
 *
 * The region tests each prove their own muscles bind to the skeleton, and `muscleModules.test.ts`
 * drives the elbow set through a kernel. Neither says whether every muscle at once compiles
 * cleanly under the path solver the module actually owns: the wraps from one region against the
 * surfaces from another, at the reference profile the studio runs. That is the question the
 * studio's report asks of `compileReport.problems`, so it is answered here first, where an empty
 * list is a claim and not merely what the studio happened to show.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import { compileArticulation } from '@bs-humany/compiler';
import type { WrappingSurfaceDef } from '@bs-humany/hsdl';
import {
  ALL_MUSCLES,
  MUSCLE_SCHEMA_VERSION,
  validateMuscleExtension,
} from '@bs-humany/muscle-data';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { compileMuscleSet } from './compile.js';
import { MusclePathModule } from './musclePathModule.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
// L3 is the reference profile; the lower ones are derived from it and carry fewer bodies, so a
// muscle that compiles here is the strictest statement the data can make.
const articulation = compileArticulation(document, 'l3_anatomical', morphology).articulation;
const surfaces = document.wrappingSurfaces ?? [];

function pathModule(wrappingSurfaces: readonly WrappingSurfaceDef[]) {
  const muscles = compileMuscleSet(
    [...ALL_MUSCLES],
    document.attachmentSites,
    articulation,
    morphology.context,
    wrappingSurfaces,
  );
  return { muscles, module: new MusclePathModule(articulation, muscles) };
}

describe('every muscle path, compiled at L3', () => {
  it('compiles every unit with nothing the path solver could not represent', () => {
    const { muscles, module } = pathModule(surfaces);
    expect(module.compileReport.pathCount).toBe(muscles.units.length);
    // Not even a warning: a conditional via point would be one, and none is authored yet.
    expect(module.compileReport.problems).toEqual([]);
  });

  it('passes the load-time cross-reference check as a whole body', () => {
    const report = validateMuscleExtension(
      { attachmentSites: document.attachmentSites, wrappingSurfaces: surfaces },
      { version: MUSCLE_SCHEMA_VERSION, groups: [...ALL_MUSCLES] },
    );
    expect(report.problems).toEqual([]);
  });

  it('reports, at load and at compile, a muscle whose surface became an ellipsoid', () => {
    // No shipped surface is an ellipsoid, so the refusal is exercised by turning a real one into
    // one: the same bone, the same place, the same muscles wrapping it. Both checks must name
    // it -- the loader against the muscle that asked, the solver against the path it had to
    // straighten -- because the two run at different times and either may be the one a reader
    // is looking at.
    const wrapped = new Set(
      ALL_MUSCLES.flatMap((g) => g.units).flatMap((u) =>
        u.path.flatMap((e) => (e.kind === 'wrap' ? [e.surface] : [])),
      ),
    );
    const target = surfaces.find((s) => wrapped.has(s.id));
    expect(target, 'some shipped muscle wraps a declared surface').toBeDefined();
    if (target === undefined) return;
    const altered = surfaces.map((s) =>
      s === target
        ? { ...s, shape: { kind: 'ellipsoid' as const, radii: { x: 0.02, y: 0.02, z: 0.02 } } }
        : s,
    );

    const loaded = validateMuscleExtension(
      { attachmentSites: document.attachmentSites, wrappingSurfaces: altered },
      { version: MUSCLE_SCHEMA_VERSION, groups: [...ALL_MUSCLES] },
    );
    expect(loaded.problems.length).toBeGreaterThan(0);
    expect(loaded.problems.every((p) => p.message.includes('ellipsoid'))).toBe(true);

    const { module } = pathModule(altered);
    const errors = module.compileReport.problems.filter((p) => p.severity === 'error');
    expect(errors.some((p) => p.message.includes('OQ-016'))).toBe(true);
    expect(errors.some((p) => p.message.includes('runs straight'))).toBe(true);
  });
});
