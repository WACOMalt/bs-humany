import { join } from 'node:path';
import { resolveMorphology } from '@bs-humany/anthropometry';
import { MujocoBackend } from '@bs-humany/backend-mujoco';
import { compileArticulation } from '@bs-humany/compiler';
import { Kernel } from '@bs-humany/kernel';
import { PassiveJointModule, PhysicsModule } from '@bs-humany/modules-mechanics';
import {
  EFFERENT_ALPHA_MOTOR,
  MUSCLE_STATE,
  MuscleDynamicsModule,
  MusclePathModule,
  MuscleTestDriveModule,
  compileMuscleSet,
} from '@bs-humany/modules-muscle';
import { ANKLE_MUSCLES, KNEE_MUSCLES } from '@bs-humany/muscle-data';
import { buildDocument } from '@bs-humany/skeleton';
import { describe, expect, it } from 'vitest';
import { type DriveOutput, NERVES_MODULE_ID, NervesModule } from './nervesModule.js';
import { MOTOR_NOISE_MODULE_ID, MotorNoiseModule } from './noise.js';
import { MlpPolicy } from './policy.js';
import {
  DEFAULT_SPINAL_GAINS,
  MEASURED_SPINAL_GAINS,
  SPINAL_CONDUCTION_DELAY_S,
  SPINAL_MODULE_ID,
  SPINAL_OFF,
  type SpinalGains,
  SpinalModule,
} from './spinalModule.js';

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
const onSide = (units: readonly string[], side: 'r' | 'l'): string[] =>
  units.filter((u) => u.endsWith(`_${side}`));

/**
 * The ankle's two groups a side, paired on their own side, the way `reflexGroups()` builds the
 * body's seventy. The right plantarflexors are first, so `lastDrive[0]` is theirs.
 */
const ANKLE_GROUPS = (['r', 'l'] as const).flatMap((side) => [
  {
    id: `anklePlantarflexorDrive:${side}`,
    units: onSide(plantar, side),
    antagonist: `ankleDorsiflexorDrive:${side}`,
  },
  {
    id: `ankleDorsiflexorDrive:${side}`,
    units: onSide(dorsi, side),
    antagonist: `anklePlantarflexorDrive:${side}`,
  },
]);

/** A body with the cord in it and nothing else driving, so what moves is the reflex. */
function rig(
  gains: Partial<SpinalGains>,
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
    groups: ANKLE_GROUPS,
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

  it('answers the body as it is when switched back on, not as it was when switched off', async () => {
    // An off cord takes nothing into its delay line, so the ring still holds the afferents of the
    // moment it went off. Switched on again, it used to read those back for a whole conduction
    // delay and answer a body that had long since moved -- here, a body that has spent a hundred
    // ticks falling with nothing driving it. On again, the line starts empty, and a line with one
    // push in it hands back that push: the first tick answers the body as the muscles now stand.
    const { kernel, spine } = rig({ stretch: 2, velocity: 0, setPoint: -0.5, inhibition: 0 });
    await kernel.init();
    kernel.run(40);
    spine.adjust({ stretch: 0, velocity: 0 });
    kernel.run(100);
    spine.adjust({ stretch: 2 });

    // What the cord reads on the next tick is `muscle.state` as it stands now: it runs in the
    // control phase, and the muscles publish their state later in the tick.
    const state = kernel.channels.storage(MUSCLE_STATE).fields;
    const fibre = Float64Array.from(state.fiberLength as Float64Array);
    const pull = Float64Array.from(state.tendonForce as Float64Array);
    const index = new Map(muscles.units.map((u, i) => [u.id, i]));
    const g = spine.gains;
    const plantarR = onSide(plantar, 'r');
    let sum = 0;
    for (const id of plantarR) {
      const u = index.get(id) as number;
      const unit = muscles.units[u];
      const stretch = (fibre[u] as number) - 1 - g.setPoint;
      const load = (pull[u] as number) / (unit?.parameters.maxIsometricForce as number);
      let drive = stretch > 0 ? g.stretch * stretch : 0;
      if (load > g.forceCeiling) drive -= g.forceInhibition * (load - g.forceCeiling);
      sum += drive;
    }

    kernel.run(1);
    expect(spine.lastDrive[0] as number).toBeCloseTo(sum / plantarR.length, 12);
    kernel.dispose();
  });

  it('runs after the tremor and the nerves in the control phase, by module id', async () => {
    // The three writers of `efferent.alphaMotor` in the loop each add and then clamp to [0, 1],
    // so the order they run in decides what a clamp eats. None of them declares a dependency on
    // another; the kernel breaks the tie by id, which puts the cord last. The documents that
    // describe the loop (this module's header, ADR-014's amendment) say so, and this holds them to
    // it: a renamed module or a new `order` on one of them changes what they describe.
    const { kernel } = rig({ stretch: 3.5, velocity: 0.25 });
    const outputs: DriveOutput[] = [
      { id: 'plantar', units: plantar.map((id) => ({ id, weight: 1 })) },
      { id: 'dorsi', units: dorsi.map((id) => ({ id, weight: 1 })) },
    ];
    kernel.register(
      new NervesModule(articulation, muscles, {
        policy: (inputs, count) => new MlpPolicy([inputs, 4, count]),
        outputs,
        feet: { left: ['foot_l', 'toes_l'], right: ['foot_r', 'toes_r'] },
        goalSize: 0,
        controlDivisor: 5,
        authority: 0.3,
      }),
    );
    kernel.register(new MotorNoiseModule(muscles, { outputs, level: 0.05, tau: 0.25 }));
    await kernel.init();
    const loop = [MOTOR_NOISE_MODULE_ID, NERVES_MODULE_ID, SPINAL_MODULE_ID];
    expect(kernel.order().filter((id) => loop.includes(id))).toEqual(loop);
    kernel.dispose();
  });
});

describe('a stretched right soleus, one tick of the cord with nothing in the way', () => {
  // The module on its own, with `muscle.state` and the efferent as plain arrays, no delay, and one
  // step: what the cord does with one stretched unit, and nothing else to muddy it. Every fibre is
  // at its optimal length, so on the measured cord's set point of 0 only the right soleus is past
  // it, and nothing is moving or loaded.
  const index = new Map(muscles.units.map((u, i) => [u.id, i]));
  const at = (id: string): number => {
    const u = index.get(id);
    if (u === undefined) throw new Error(`no unit ${id}`);
    return u;
  };
  // A twentieth past optimal: enough to excite, and little enough that half excitation plus the
  // answer stays under the ceiling at the measured gain, so what is asserted is the reflex and not
  // the clamp. It was a tenth until the gain went from 3.5 to 8.5, which put the answer past 1.
  const STRETCH = 0.05;

  function tick(before: number): { excitation: Float64Array; spine: SpinalModule } {
    const n = muscles.units.length;
    const fiberLength = new Float64Array(n).fill(1);
    fiberLength[at('soleus_r')] = 1 + STRETCH;
    const excitation = new Float64Array(n).fill(before);
    const spine = new SpinalModule(muscles, {
      groups: ANKLE_GROUPS,
      gains: { ...MEASURED_SPINAL_GAINS, delaySeconds: 0 },
      stepSeconds: 1 / 500,
    });
    const fake = {
      read: () => ({
        fields: {
          fiberLength,
          fiberVelocity: new Float64Array(n),
          tendonForce: new Float64Array(n),
        },
        spec: {},
        count: n,
      }),
      accumulate: () => ({ fields: { excitation }, spec: {}, count: n }),
      write: () => {
        throw new Error('unexpected');
      },
      random: undefined as never,
      dt: 1 / 500,
      config: {},
    };
    spine.init(fake as never);
    spine.step({} as never);
    return { excitation, spine };
  }

  it('excites the right soleus and no other unit, on either side', () => {
    // Per side: a group holding both legs let the right soleus's stretch excite the left leg. Per
    // unit: a group's mean applied to all of it let the soleus's stretch excite the gastrocnemii
    // beside it, which were not stretched at all. A real stretch reflex does neither, and this cord
    // now does neither: the one stretched spindle drives the one muscle it is in.
    const { excitation } = tick(0);
    const soleus = at('soleus_r');
    expect(excitation[soleus]).toBeCloseTo(MEASURED_SPINAL_GAINS.stretch * STRETCH, 12);
    for (const unit of muscles.units) {
      if (unit.id === 'soleus_r') continue;
      expect(excitation[at(unit.id)], `${unit.id} was not stretched`).toBe(0);
    }
    for (const id of muscles.units.map((u) => u.id).filter((u) => u.endsWith('_l'))) {
      expect(excitation[at(id)], `${id} is on the other leg`).toBe(0);
    }
  });

  it('inhibits the right shin through its interneuron, and leaves the left leg alone', () => {
    // Every unit starts at half excitation, as if the brain were holding the body, so inhibition
    // has something to take off. The right plantarflexors' drive is the soleus's alone, shared over
    // the group, and a share of it (`inhibition`) comes off every right dorsiflexor. Nothing on the
    // left is stretched, and nothing on the left is inhibited by the right: it stays where the
    // brain put it.
    const { excitation, spine } = tick(0.5);
    const g = MEASURED_SPINAL_GAINS;
    const plantarR = onSide(plantar, 'r');
    const groupDrive = (g.stretch * STRETCH) / plantarR.length;
    expect(spine.lastDrive[0]).toBeCloseTo(groupDrive, 12);
    expect(excitation[at('soleus_r')]).toBeCloseTo(0.5 + g.stretch * STRETCH, 12);
    for (const id of onSide(dorsi, 'r')) {
      expect(excitation[at(id)]).toBeLessThan(0.5);
      expect(excitation[at(id)]).toBeCloseTo(0.5 - g.inhibition * groupDrive, 12);
    }
    for (const id of [...onSide(plantar, 'l'), ...onSide(dorsi, 'l')]) {
      expect(excitation[at(id)], `${id} is on the other leg`).toBe(0.5);
    }
  });
});

describe('the cord its gains describe', () => {
  it('is off unless asked, and the measured cord is the off one with the reflexes turned up', () => {
    expect(DEFAULT_SPINAL_GAINS).toBe(SPINAL_OFF);
    expect(SPINAL_OFF.stretch).toBe(0);
    expect(SPINAL_OFF.velocity).toBe(0);
    expect(SPINAL_OFF).toEqual({ ...MEASURED_SPINAL_GAINS, stretch: 0, velocity: 0 });
    expect(MEASURED_SPINAL_GAINS.delaySeconds).toBe(SPINAL_CONDUCTION_DELAY_S);
    expect(SPINAL_OFF.delaySeconds).toBe(SPINAL_CONDUCTION_DELAY_S);
  });

  it("agrees with the training recipe's, number for number", async () => {
    // The recipe module (`tools/train/src/recipe.ts`) keeps its own copy of the measured cord and
    // the off one, on purpose: it imports nothing that runs from any package, so the dashboard and
    // the command line can load it without the kernel. Two copies of seven numbers are held
    // together only by a test, and this one sits here so that a change to the cord's numbers fails
    // in the package where it was made, not only when someone next runs the trainer's tests.
    // Loaded by path at run time rather than imported, because a package does not depend on a
    // tool; nothing but this test reads it.
    const at = join(import.meta.dirname, '../../../tools/train/src/recipe.ts');
    const recipe = (await import(/* @vite-ignore */ at)) as {
      DEFAULT_REFLEX: SpinalGains;
      NO_REFLEX: SpinalGains;
    };
    expect(recipe.DEFAULT_REFLEX).toEqual(MEASURED_SPINAL_GAINS);
    expect(recipe.NO_REFLEX).toEqual(SPINAL_OFF);
  });
});
