import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { compileArticulation } from '@bs-humany/compiler';
import { Kernel } from '@bs-humany/kernel';
import { BODY_JOINT_STATE, PassiveJointModule, PhysicsModule } from '@bs-humany/modules-mechanics';
import {
  MUSCLE_STATE,
  MuscleDynamicsModule,
  MusclePathModule,
  MuscleTestDriveModule,
  compileMuscleSet,
} from '@bs-humany/modules-muscle';
import { ANKLE_MUSCLES, KNEE_MUSCLES } from '@bs-humany/muscle-data';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { NervesModule } from './nervesModule.js';
import { MlpPolicy } from './policy.js';

const document = buildDocument();
const morphology = resolveMorphology({ sex: 0.5, stature: 1.7, mass: 70 });
const { articulation } = compileArticulation(document, 'l1_standard', morphology);
const muscles = compileMuscleSet(
  [...ANKLE_MUSCLES, ...KNEE_MUSCLES],
  document.attachmentSites,
  articulation,
  morphology.context,
  document.wrappingSurfaces ?? [],
);

describe('NervesModule', () => {
  it('reads the body, runs the policy at its own rate, and adds onto the drive', async () => {
    const kernel = new Kernel({ rateHz: 500, seed: 1 });
    kernel.register(
      new PhysicsModule(new MujocoBackend(), articulation, { ground: { height: 0 } }),
    );
    kernel.register(new PassiveJointModule(articulation));
    const drive = new MuscleTestDriveModule(muscles, [
      { units: 'all', pattern: { kind: 'constant', level: 0.1 } },
    ]);
    kernel.register(drive);
    kernel.register(new MusclePathModule(articulation, muscles));
    kernel.register(new MuscleDynamicsModule(articulation, muscles));
    const soleus = {
      id: 'soleus',
      units: [
        { id: 'soleus_r', weight: 1 },
        { id: 'soleus_l', weight: 1 },
      ],
    };
    const tibialis = { id: 'tibialis', units: [{ id: 'tibialis_anterior_r', weight: 1 }] };
    // A policy that says +1 on the first output and -1 on the second, whatever it sees: biases
    // saturating the tanh, weights zero. Made once the body says how much it observes.
    const nerves = new NervesModule(articulation, muscles, {
      policy: (inputs, outputs) => {
        const policy = new MlpPolicy([inputs, 4, outputs]);
        const biasAt = inputs * 4 + 4 + 4 * outputs;
        policy.weights[biasAt] = 20;
        policy.weights[biasAt + 1] = -20;
        return policy;
      },
      outputs: [soleus, tibialis],
      feet: { left: ['foot_l', 'toes_l'], right: ['foot_r', 'toes_r'] },
      goalSize: 2,
      goal: () => [1, 0],
      controlDivisor: 5,
      authority: 0.5,
    });
    kernel.register(nerves);
    await kernel.init();
    const inputs = nerves.observation.size;
    const nq = (kernel.channels.storage(BODY_JOINT_STATE).fields.q as Float64Array).length;
    const nv = (kernel.channels.storage(BODY_JOINT_STATE).fields.qdot as Float64Array).length;
    // Joints, the pelvis, the feet, a sense a group of activation and of stretch, the goal.
    expect(inputs).toBe(nq - 7 + (nv - 6) + 11 + 4 + 2 * 2 + 2);
    kernel.run(100);
    // Twenty evaluations in a hundred ticks at a divisor of five.
    expect(nerves.evaluationsSoFar).toBe(20);
    expect(nerves.lastCommand[0]).toBeCloseTo(1, 6);
    expect(nerves.lastCommand[1]).toBeCloseTo(-1, 6);
    // The soleus was driven at 0.1 by the pattern plus 0.5 by the nerves; the tibialis at 0.1
    // minus 0.5, clamped to nothing. Activation follows excitation within a few dozen ticks.
    const activation = kernel.channels.storage(MUSCLE_STATE).fields.activation as Float64Array;
    const at = (id: string) => muscles.units.findIndex((u) => u.id === id);
    expect(activation[at('soleus_r')]).toBeCloseTo(0.6, 2);
    expect(activation[at('tibialis_anterior_r')]).toBeLessThan(0.01);
    // A unit no output names stays at the pattern's level.
    expect(activation[at('gastrocnemius_medial_r')]).toBeCloseTo(0.1, 2);
    // The observation carries the goal at its end and a sensible sense of down.
    const obs = nerves.lastObservation;
    expect(obs[obs.length - 2]).toBe(1);
    expect(obs[obs.length - 1]).toBe(0);
    const downY = obs[nq - 7 + (nv - 6) + 1] as number;
    expect(downY).toBeLessThan(-0.8);
    kernel.dispose();
  });
});
