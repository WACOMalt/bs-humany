import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { compileArticulation } from '@bs-humany/compiler';
import { Kernel } from '@bs-humany/kernel';
import { PassiveJointModule, PhysicsModule } from '@bs-humany/modules-mechanics';
import {
  EFFERENT_ALPHA_MOTOR,
  MuscleDynamicsModule,
  MusclePathModule,
  MuscleTestDriveModule,
  compileMuscleSet,
} from '@bs-humany/modules-muscle';
import { ANKLE_MUSCLES, KNEE_MUSCLES } from '@bs-humany/muscle-data';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { type DEFAULT_SPINAL_GAINS, SpinalModule } from './spinalModule.js';

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

const plantar = muscles.units.filter((u) => /soleus|gastrocnemius/.test(u.id)).map((u) => u.id);
const dorsi = muscles.units.filter((u) => /tibialis_anterior/.test(u.id)).map((u) => u.id);

/** A body with the cord in it and nothing else driving, so what moves is the reflex. */
function rig(
  gains: Partial<typeof DEFAULT_SPINAL_GAINS>,
  level = 0,
): {
  kernel: Kernel;
  spine: SpinalModule;
} {
  const kernel = new Kernel({ rateHz: 500, seed: 1 });
  kernel.register(new PhysicsModule(new MujocoBackend(), articulation, { ground: { height: 0 } }));
  kernel.register(new PassiveJointModule(articulation));
  kernel.register(
    new MuscleTestDriveModule(muscles, [{ units: 'all', pattern: { kind: 'constant', level } }]),
  );
  kernel.register(new MusclePathModule(articulation, muscles));
  const spine = new SpinalModule(muscles, {
    groups: [
      { id: 'anklePlantarflexorDrive', units: plantar, antagonist: 'ankleDorsiflexorDrive' },
      { id: 'ankleDorsiflexorDrive', units: dorsi, antagonist: 'anklePlantarflexorDrive' },
    ],
    gains,
    stepSeconds: 1 / 500,
  });
  kernel.register(spine);
  kernel.register(new MuscleDynamicsModule(articulation, muscles));
  return { kernel, spine };
}

describe('SpinalModule', () => {
  it('is silent when its gains are zero, so adding the cord changes nothing', async () => {
    const { kernel, spine } = rig({ stretch: 0, velocity: 0 });
    await kernel.init();
    kernel.run(50);
    const excitation = kernel.channels.storage(EFFERENT_ALPHA_MOTOR).fields
      .excitation as Float64Array;
    expect(Array.from(excitation).every((e) => e === 0)).toBe(true);
    expect(Array.from(spine.lastDrive).every((d) => d === 0)).toBe(true);
  });

  it('excites a muscle the body has stretched past its set point', async () => {
    // A set point well under the resting fibre length, so every unit reads as stretched.
    const { kernel, spine } = rig({ stretch: 2, velocity: 0, setPoint: -0.5, inhibition: 0 });
    await kernel.init();
    kernel.run(50);
    const drive = spine.lastDrive;
    expect(drive[0] as number).toBeGreaterThan(0);
  });

  it('holds its answer back by the conduction delay', async () => {
    // Fifty milliseconds at 500 Hz is twenty-five ticks. Before that the line hands back the
    // oldest afferent it has, so the cord answers the body as it was when the episode began.
    const slow = rig({
      stretch: 2,
      velocity: 0,
      setPoint: -0.5,
      inhibition: 0,
      delaySeconds: 0.05,
    });
    const fast = rig({ stretch: 2, velocity: 0, setPoint: -0.5, inhibition: 0, delaySeconds: 0 });
    await slow.kernel.init();
    await fast.kernel.init();
    slow.kernel.run(4);
    fast.kernel.run(4);
    // Four ticks in, the undelayed cord is answering a body that has already moved and the
    // delayed one is still answering the body it started as. They cannot agree.
    expect(slow.spine.lastDrive[0]).not.toBeCloseTo(fast.spine.lastDrive[0] as number, 9);
  });

  it('inhibits the antagonist of a group the cord is driving', async () => {
    const free = rig({ stretch: 2, velocity: 0, setPoint: -0.5, inhibition: 0 });
    const paired = rig({ stretch: 2, velocity: 0, setPoint: -0.5, inhibition: 1 });
    await free.kernel.init();
    await paired.kernel.init();
    free.kernel.run(40);
    paired.kernel.run(40);
    const readExcitation = (k: Kernel): Float64Array =>
      k.channels.storage(EFFERENT_ALPHA_MOTOR).fields.excitation as Float64Array;
    const sum = (a: Float64Array): number => Array.from(a).reduce((x, y) => x + y, 0);
    // Both groups are stretched, so with inhibition on, each takes the other's drive back off
    // and the body ends up less excited overall than the same cord with no interneuron.
    expect(sum(readExcitation(paired.kernel))).toBeLessThan(sum(readExcitation(free.kernel)));
  });

  it('takes drive back off a unit whose tendon is loaded past the ceiling', async () => {
    const loose = rig({ stretch: 2, velocity: 0, setPoint: -0.5, inhibition: 0, forceCeiling: 10 });
    const tight = rig({
      stretch: 2,
      velocity: 0,
      setPoint: -0.5,
      inhibition: 0,
      forceCeiling: 0,
      forceInhibition: 5,
    });
    await loose.kernel.init();
    await tight.kernel.init();
    loose.kernel.run(60);
    tight.kernel.run(60);
    expect(tight.spine.lastDrive[0] as number).toBeLessThan(loose.spine.lastDrive[0] as number);
  });
});
