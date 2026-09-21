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
    // Joints, the pelvis, the head's vestibular six, the feet, four senses a group --
    // activation, stretch, shortening and load -- and the goal.
    expect(inputs).toBe(nq - 7 + (nv - 6) + 11 + 6 + 4 + 4 * 2 + 2);
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

    // A policy handed over live: fitted by name, in charge between one step and the next, and
    // released to silence without a restart.
    const file = new MlpPolicy([inputs, 4, 2]).toFile({
      task: 'stand',
      inputs: [...nerves.observation.names],
      outputs: ['soleus', 'tibialis'],
    });
    expect(nerves.adopt(file)).toEqual({ inputs, outputs: 2 });
    nerves.authorityLevel = 0.2;
    // Adopting forgets: the count starts again, and ten ticks at a divisor of five are two.
    kernel.run(10);
    expect(nerves.evaluationsSoFar).toBe(2);
    nerves.release();
    expect(nerves.authorityLevel).toBe(0);
    kernel.run(5);
    expect(nerves.lastCommand[0]).toBe(0);
    kernel.dispose();
  });
});

describe('NervesModule memory', () => {
  it('gives the policy context units it reads back from its own last answer', async () => {
    const kernel = new Kernel({ rateHz: 500, seed: 1 });
    kernel.register(
      new PhysicsModule(new MujocoBackend(), articulation, { ground: { height: 0 } }),
    );
    kernel.register(new PassiveJointModule(articulation));
    kernel.register(
      new MuscleTestDriveModule(muscles, [
        { units: 'all', pattern: { kind: 'constant', level: 0.1 } },
      ]),
    );
    kernel.register(new MusclePathModule(articulation, muscles));
    kernel.register(new MuscleDynamicsModule(articulation, muscles));
    const soleus = {
      id: 'soleus',
      units: muscles.units.filter((u) => /soleus/.test(u.id)).map((u) => ({ id: u.id, weight: 1 })),
    };
    const memory = 4;
    const nerves = new NervesModule(articulation, muscles, {
      policy: (inputs, outputs) => MlpPolicy.random([inputs, 8, outputs], () => 0.5),
      outputs: [soleus],
      goalSize: 0,
      memory,
    });
    kernel.register(nerves);
    await kernel.init();
    // The senses the body has, plus one input and one output per context unit.
    const names = nerves.policyNames;
    expect(names.inputs.length).toBe(nerves.observation.size + memory);
    expect(names.outputs.length).toBe(1 + memory);
    expect(names.inputs.at(-1)).toBe(`context[${memory - 1}]`);
    expect(nerves.policy.sizes[0]).toBe(nerves.observation.size + memory);
    expect(nerves.policy.sizes.at(-1)).toBe(1 + memory);
    kernel.run(20);
    // The command is the drive alone; the context is held out of it.
    expect(nerves.lastCommand.length).toBe(1);
  });

  it('carries a memoryless checkpoint into a body that has memory', async () => {
    const file = MlpPolicy.random([3, 4, 2], () => 0.5).toFile({
      task: 'stand',
      inputs: ['a', 'b', 'c'],
      outputs: ['soleusDrive', 'tibialisDrive'],
    });
    // The same file fitted to a body with two context units: the senses it knows keep their
    // weights and the context starts from nothing.
    const fitted = MlpPolicy.fit(
      file,
      ['a', 'b', 'c', 'context[0]', 'context[1]'],
      ['soleusDrive', 'tibialisDrive', 'context[0]', 'context[1]'],
    );
    expect(fitted.carried.inputs).toBe(3);
    expect(fitted.carried.outputs).toBe(2);
    expect(fitted.policy.sizes).toEqual([5, 4, 4]);
  });
});
