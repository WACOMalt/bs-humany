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

  it('reads the length afferent as a strain, in the unit the channel publishes it in', async () => {
    // What the double-normalisation bug looked like from the outside, and nothing caught it for
    // want of a test on the *scale* of an afferent rather than its sign. `muscle.state` publishes
    // fibre length already in optimal fibre lengths, so subtracting one gives a strain that runs
    // from about -0.5 to +0.4 over everything a body does. It used to be divided by the optimal
    // length in metres as well, which put it between 2 and 41 -- so every muscle read as hugely
    // stretched at every instant, the reflex was a constant tone rather than an answer to a
    // stretch, and the gain had to be held three orders of magnitude below where it belongs.
    //
    // A gain of one is asserted here against a set point of one: a muscle at exactly its optimal
    // length is one strain unit *short* of that set point, so the reflex says nothing. Under the
    // old arithmetic the same muscle read about ten, was nine past the set point, and every unit
    // in the body pinned at full excitation.
    const { kernel, spine } = rig({ stretch: 1, velocity: 0, setPoint: 1, inhibition: 0 });
    await kernel.init();
    kernel.run(40);
    for (const drive of spine.lastDrive) {
      expect(drive, 'a muscle at its optimal length is not one whole strain unit past it').toBe(0);
    }
    kernel.dispose();
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

  describe('counts what it is doing, for the Spine panel', () => {
    it('counts nothing with the cord off', async () => {
      const { kernel, spine } = rig({ stretch: 0, velocity: 0, setPoint: -0.5 });
      await kernel.init();
      kernel.run(60);
      // A set point every unit is past, and still nothing: an off cord answers nothing.
      expect(spine.lastPastSetPoint).toBe(0);
      expect(spine.lastAtCeiling).toBe(0);
      kernel.dispose();
    });

    it('counts the units past the set point while the body falls', async () => {
      // The measured gain and a set point a little under optimal, on a body with nothing else
      // holding it up: some muscles are stretched past it, and never more than there are.
      const { kernel, spine } = rig({ stretch: 3.5, velocity: 0, setPoint: -0.2 });
      await kernel.init();
      kernel.run(150);
      expect(spine.lastPastSetPoint).toBeGreaterThan(0);
      expect(spine.lastPastSetPoint).toBeLessThanOrEqual(muscles.units.length);
      kernel.dispose();
    });

    it('counts the units the cord has put at the ceiling, and changes no excitation', async () => {
      const gains = { stretch: 8, velocity: 0, setPoint: -0.5, inhibition: 0 };
      const { kernel, spine } = rig(gains);
      await kernel.init();
      kernel.run(60);
      const excitation = kernel.channels.storage(EFFERENT_ALPHA_MOTOR).fields
        .excitation as Float64Array;
      expect(spine.lastAtCeiling).toBeGreaterThan(0);
      // The count is of what is on the efferent, exactly: an observation, not a second opinion.
      expect(spine.lastAtCeiling).toBe(Array.from(excitation).filter((e) => e >= 1).length);
      kernel.dispose();
    });
  });
});
