import { resolveMorphology } from '@bs-humany/anthropometry';
import { RapierBackend } from '@bs-humany/backend-rapier';
import { compileArticulation } from '@bs-humany/compiler';
import { Kernel } from '@bs-humany/kernel';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { DIAGNOSTICS_ENERGY, DIAGNOSTICS_LIMITS, MetricsModule } from './metricsModule.js';
import { PhysicsModule } from './physicsModule.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l1_standard', morphology);

async function session() {
  const kernel = new Kernel({ rateHz: 500, seed: 1 });
  const physics = new PhysicsModule(new RapierBackend(), articulation, { ground: { height: 0 } });
  const metrics = new MetricsModule(articulation);
  kernel.register(physics);
  kernel.register(metrics);
  await kernel.init();
  const energy = kernel.channels.storage(DIAGNOSTICS_ENERGY).fields;
  const limits = kernel.channels.storage(DIAGNOSTICS_LIMITS).fields;
  return { kernel, energy, limits };
}

describe('MetricsModule', () => {
  it('reports the rest pose as still, at the right potential energy, with no drift', async () => {
    const { kernel, energy, limits } = await session();
    expect((energy.kinetic as Float64Array)[0]).toBeCloseTo(0, 6);
    const expected = articulation.segments.reduce((sum, s) => {
      // CoM height at rest: segment origin plus the rotated local CoM; rest rotations are identity.
      return sum + s.mass * 9.80665 * (s.restWorld.translation.y + s.com.y);
    }, 0);
    expect((energy.potential as Float64Array)[0]).toBeCloseTo(expected, 2);
    expect((energy.drift as Float64Array)[0]).toBeLessThan(1e-4);
    const violation = limits.violation as Uint8Array;
    for (let i = 0; i < violation.length; i++) expect(violation[i], `dof ${i}`).toBe(0);
    // The knee's neutral sits on its lower stop: proximity 1 without violation.
    const knee = articulation.dofs.find((d) => articulation.joints[d.joint]?.id === 'knee_r');
    if (!knee) throw new Error('no knee');
    expect((limits.proximity as Float64Array)[knee.index]).toBeCloseTo(1, 9);
    kernel.dispose();
  });

  it('sees energy trade during the fall and settle afterwards, with bounded drift', async () => {
    const { kernel, energy } = await session();
    const potential0 = (energy.potential as Float64Array)[0] ?? 0;
    kernel.run(100);
    const kineticFalling = (energy.kinetic as Float64Array)[0] ?? 0;
    expect(kineticFalling).toBeGreaterThan(1);
    expect((energy.potential as Float64Array)[0]).toBeLessThan(potential0);
    expect((energy.linearMomentum as Float64Array)[1]).toBeLessThan(0);
    kernel.run(1400);
    const kineticSettled = (energy.kinetic as Float64Array)[0] ?? 0;
    expect(kineticSettled).toBeLessThan(kineticFalling);
    expect((energy.drift as Float64Array)[0]).toBeLessThan(0.05);
    kernel.dispose();
  });
});
