import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { ROOT_NV, compileArticulation } from '@bs-humany/compiler';
import { Kernel } from '@bs-humany/kernel';
import { BODY_JOINT_STATE, PhysicsModule } from '@bs-humany/modules-mechanics';
import {
  DIAGNOSTICS_MOMENT_ARM,
  MUSCLE_STATE,
  MuscleDynamicsModule,
  MuscleMomentModule,
  MusclePathModule,
  MuscleTestDriveModule,
  compileMuscleSet,
} from '@bs-humany/modules-muscle';
import { ELBOW_MUSCLES } from '@bs-humany/muscle-data';
import { REFERENCE_MORPHOLOGY, REFERENCE_PROFILE, buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';

/**
 * Muscle spec N3.5, base spec section 14.5 item 4 as the muscle module consumes it: realized
 * per-DoF force "validates that applied muscle forces produce the expected joint torque".
 *
 * The two sides of the comparison come by routes that share nothing. The expected torque is each
 * unit's tendon force times its moment arm, and `muscle.moment` takes the arm by virtual work off
 * the published path -- it is output only, and nothing on the force path reads it (M-ADR-003).
 * The realized torque is what the solver reports at the joint, having been handed only the
 * wrenches `muscle.dynamics` pushed at every point along each path. If the path solver, the
 * spreading of tension along the path, or the backend's handling of body wrenches were wrong, the
 * two would part.
 *
 * Every unit is driven, so flexors and extensors pull against each other on the same coordinate
 * and the comparison is of a sum with both signs in it. Gravity is off, so nothing but the
 * muscles loads the arm, and the window is short enough that the elbow, flexing freely, never
 * reaches a stop: the realized force also carries a stop's constraint torque, which is right but
 * is not the muscles'. The shoulder is left out for that reason -- the hanging arm rests on its
 * elevation stop throughout.
 */

/** Joints that move freely in this window, by articulation joint id. */
const FREE = ['elbow_r', 'radioulnar_r', 'elbow_l', 'radioulnar_l'];
/** Ticks to run. At 1 kHz under full drive the elbow is still well short of its flexion stop. */
const TICKS = 51;

describe('muscle forces through the realized per-DoF readout', () => {
  it('equal each unit’s tension times its moment arm, summed, at every free joint', async () => {
    const document = buildDocument();
    const morphology = resolveMorphology(REFERENCE_MORPHOLOGY);
    const { articulation } = compileArticulation(document, REFERENCE_PROFILE, morphology);
    const muscles = compileMuscleSet(
      [...ELBOW_MUSCLES],
      document.attachmentSites,
      articulation,
      morphology.context,
      document.wrappingSurfaces ?? [],
    );
    const kernel = new Kernel({ rateHz: 1000, seed: 1, preferShared: false, audit: false });
    kernel.register(
      new PhysicsModule(new MujocoBackend(), articulation, { gravity: { x: 0, y: 0, z: 0 } }),
    );
    kernel.register(
      new MuscleTestDriveModule(muscles, [
        { units: 'all', pattern: { kind: 'constant', level: 1 } },
      ]),
    );
    kernel.register(new MusclePathModule(articulation, muscles));
    kernel.register(new MuscleDynamicsModule(articulation, muscles));
    kernel.register(new MuscleMomentModule(articulation, muscles));
    await kernel.init();

    const joint = kernel.channels.storage(BODY_JOINT_STATE).fields;
    const realized = joint.force as Float64Array;
    const qdot = joint.qdot as Float64Array;
    const tendonForce = kernel.channels.storage(MUSCLE_STATE).fields.tendonForce as Float64Array;
    const arms = kernel.channels.storage(DIAGNOSTICS_MOMENT_ARM);
    const unit = arms.fields.unit as Int32Array;
    const dof = arms.fields.dof as Int32Array;
    const arm = arms.fields.arm as Float64Array;

    const free = articulation.dofs
      .map((d, i) => ({ i, joint: articulation.joints[d.joint]?.id ?? '' }))
      .filter((d) => FREE.includes(d.joint));
    expect(free.map((d) => d.joint).sort()).toEqual([...FREE].sort());

    const expected = new Float64Array(articulation.dofs.length);
    let compared = 0;
    let fastest = 0;
    for (let tick = 0; tick < TICKS; tick++) {
      kernel.step();
      // `muscle.moment` publishes at a tenth of the rate; compare on the ticks it does.
      if (tick % 10 !== 0) continue;
      expected.fill(0);
      for (let k = 0; k < arms.count; k++) {
        const d = dof[k] as number;
        expected[d] =
          (expected[d] as number) + (tendonForce[unit[k] as number] as number) * (arm[k] as number);
      }
      for (const { i, joint: id } of free) {
        const want = expected[i] as number;
        const got = realized[ROOT_NV + i] as number;
        expect(Math.abs(got - want), `${id} at tick ${tick}: ${got} against ${want}`).toBeLessThan(
          1e-6 * Math.max(1, Math.abs(want)),
        );
        compared++;
      }
      fastest = Math.max(fastest, Math.abs(qdot[ROOT_NV + (free[0]?.i ?? 0)] as number));
    }
    expect(compared).toBe(free.length * Math.ceil(TICKS / 10));
    // The comparison is made with the elbow moving, not only from rest, so a torque that leaked
    // into a velocity-dependent term would have shown.
    expect(fastest).toBeGreaterThan(1);
    // And the muscles were genuinely pulling: a few newton metres at the elbow, not a residue.
    const elbow = free.find((d) => d.joint === 'elbow_r')?.i ?? -1;
    expect(Math.abs(expected[elbow] as number)).toBeGreaterThan(1);
  });
});
