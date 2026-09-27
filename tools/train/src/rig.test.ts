/**
 * The rig from a recipe: a scenario places the body, a morphology sizes it, and the brain can
 * stand alone with nothing played under it. A coarse body, because a rig is a whole simulation
 * and the point here is the wiring, not the standing.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_NOISE, StandRig, defaultRecipe, rigOptionsFor, twitchSchedule } from './rig.js';

describe('a training recipe', () => {
  it('turns into rig options, and the old flags into the reference recipe', () => {
    const recipe = defaultRecipe('stand', 'l1_standard', 0.3);
    expect(recipe.feedforward).toEqual({ kind: 'clip', clip: 'quiet-standing' });
    expect(recipe.scenario).toBe('');
    const options = rigOptionsFor(
      {
        ...recipe,
        scenario: 'drop-standing-collapse',
        parameters: { clearance: 0 },
        passive: false,
      },
      { hidden: [8], seconds: 2, poseBones: true },
    );
    expect(options.scenario).toEqual({
      id: 'drop-standing-collapse',
      parameters: { clearance: 0 },
    });
    expect(options.passiveJoints).toBe(false);
    expect(options.poseBones).toBe(true);
    expect(options.profileId).toBe('l1_standard');
    expect(rigOptionsFor(recipe, { hidden: [8], seconds: 2 }).scenario).toBeUndefined();
  });
});

describe('a rig built from a scenario with the brain alone', () => {
  it('stands the chosen body on the ground with every muscle slack, and plays a script only when asked', async () => {
    const rig = await StandRig.build({
      profileId: 'l1_standard',
      hidden: [8],
      seconds: 1,
      authority: 0.3,
      feedforward: { kind: 'none' },
      scenario: { id: 'drop-standing-collapse', parameters: { clearance: 0 } },
      morphology: { sex: 0.2, stature: 1.6, mass: 55 },
      passiveJoints: true,
    });
    expect(rig.profileId).toBe('l1_standard');
    expect(rig.stepSeconds).toBeCloseTo(1 / 500, 9);
    // Zero weights: the policy asks for nothing, nothing plays under it, and the body is still
    // up a few control steps in -- it starts on its feet, and a slack body takes a moment to go.
    const result = rig.episode(new Float32Array(rig.parameterCount), 1);
    expect(result.aliveSeconds).toBeGreaterThan(0);
    expect(result.fitness).toBeGreaterThan(0);
    // Ticked from the top, the head is where a 1.6 m body's head is, not the reference's.
    rig.begin(new Float32Array(rig.parameterCount));
    const first = rig.tick();
    expect(first.headHeight).toBeGreaterThan(1.3);
    expect(first.headHeight).toBeLessThan(1.6);

    // The scenario's own muscle script drives nothing with the brain alone; asked for, it does.
    const quiet = async (kind: 'none' | 'script') => {
      const r = await StandRig.build({
        profileId: 'l1_standard',
        hidden: [8],
        seconds: 1,
        authority: 0.3,
        feedforward: kind === 'script' ? { kind: 'script' } : { kind: 'none' },
        scenario: { id: 'quiet-standing', parameters: { settle: 0 } },
        // Silent, because what is measured here is the script gate and nothing else. A body
        // with its tremor on is not slack: a muscle cannot be pushed below rest, so a zero-mean
        // wander on a resting muscle comes out as a small tone. That is the muscles, not a bug,
        // and it is measured where it belongs, over in the noise tests.
        noise: { motor: 0, sense: 0, tau: 0.25 },
      });
      r.begin(new Float32Array(r.parameterCount));
      for (let i = 0; i < 100; i++) r.tick();
      // The activation senses of the last observation: what the muscles were told, as felt.
      const senses = r.activity().layers[0] as Float64Array;
      let activation = 0;
      r.inputNames.forEach((name, i) => {
        if (name.startsWith('activation:')) activation += senses[i] as number;
      });
      r.dispose();
      return activation;
    };
    // Not zero: the muscle model keeps a floor of activation; the script's tone is well above it.
    const alone = await quiet('none');
    expect(alone).toBeLessThan(0.2);
    expect(await quiet('script')).toBeGreaterThan(alone * 3);
  }, 120_000);
});

describe('the rig a showcase publishes from', () => {
  it('reports the timescale its recipe will carry', async () => {
    const rig = await StandRig.build({
      profileId: 'l3_anatomical',
      hidden: [8],
      seconds: 1,
      authority: 0.3,
      feedforward: { kind: 'none' },
      poseBones: true,
    });
    try {
      // What a checkpoint records, and what a run playing it has to match to be the same physics.
      expect(rig.stepsPerSecond).toBe(1000);
      expect(rig.controlDivisor).toBe(10);
      expect(rig.boneOrder.length).toBeGreaterThan(100);
    } finally {
      rig.dispose();
    }
  }, 180_000);
});

describe('a scenario with a seed of its own', () => {
  it('gives every episode its own floor, and a mirrored pair the same one', async () => {
    // The trainer hands out `1000 * generation + 7 * pair + k`, and both halves of a mirrored
    // pair share a `pair`. What the rig does with that seed decides whether a policy is scored
    // on the floor it learned or on one it has not seen.
    const rig = await StandRig.build({
      profileId: 'l1_standard',
      hidden: [8],
      seconds: 2,
      authority: 0.3,
      feedforward: { kind: 'none' },
      task: 'balance',
      scenario: { id: 'tilting-floor', parameters: { tilt: 8, every: 0.4, hold: 0.25 } },
    });
    try {
      // Where the body has got to is a fingerprint of the floor it was standing on: the same
      // weights and the same start, so anything that differs came from the floor.
      const fingerprint = (seed: number): string => {
        rig.begin(new Float32Array(rig.parameterCount), seed);
        for (let i = 0; i < 700; i++) rig.tick();
        const at = rig.segments();
        const pelvis = at.ids.indexOf('pelvis');
        return [0, 1, 2].map((k) => (at.position[3 * pelvis + k] as number).toFixed(6)).join(',');
      };
      const a = fingerprint(1000);
      const b = fingerprint(1001);
      const c = fingerprint(2000);
      expect(a).not.toBe(b);
      expect(a).not.toBe(c);
      // The same seed twice is the same floor twice: a run has to be repeatable.
      expect(fingerprint(1000)).toBe(a);
    } finally {
      rig.dispose();
    }
  }, 180_000);
});

describe('the noise in the loop', () => {
  /** Where the pelvis has got to after a second, which is what a disturbance changes. */
  const runFor = async (
    rig: Awaited<ReturnType<typeof StandRig.build>>,
    seed: number,
  ): Promise<[number, number, number]> => {
    rig.begin(new Float32Array(rig.parameterCount), seed);
    for (let i = 0; i < 200; i++) rig.tick();
    const { position } = rig.segments();
    const p = rig.segments().ids.indexOf('pelvis');
    return [
      position[3 * p] as number,
      position[3 * p + 1] as number,
      position[3 * p + 2] as number,
    ];
  };

  it('puts the same body in a different place for every seed, and the same place twice for one', async () => {
    const rig = await StandRig.build({
      profileId: 'l1_standard',
      hidden: [8],
      seconds: 1,
      authority: 0.3,
      feedforward: { kind: 'none' },
    });
    try {
      const first = await runFor(rig, 1);
      const again = await runFor(rig, 1);
      const other = await runFor(rig, 2);
      // A seed is the whole disturbance: the same one is the same run, to the last digit.
      expect(again).toEqual(first);
      // A different one is a different run, by more than a rounding -- which is what lets the
      // search tell two candidates apart instead of scoring them the same.
      const apart = Math.hypot(other[0] - first[0], other[1] - first[1], other[2] - first[2]);
      expect(apart).toBeGreaterThan(1e-4);
    } finally {
      rig.dispose();
    }
  }, 120_000);

  it('is silent when a recipe asks for silence, so a run can be made deterministic again', async () => {
    const rig = await StandRig.build({
      profileId: 'l1_standard',
      hidden: [8],
      seconds: 1,
      authority: 0.3,
      feedforward: { kind: 'none' },
      noise: { motor: 0, sense: 0, tau: DEFAULT_NOISE.tau },
    });
    try {
      // The twitch lands after half a second and is aimed by the seed; before it, a silent loop
      // is the same run whatever the seed.
      rig.begin(new Float32Array(rig.parameterCount), 1);
      for (let i = 0; i < 80; i++) rig.tick();
      const quiet = rig.segments().position.slice(0, 3);
      rig.begin(new Float32Array(rig.parameterCount), 99);
      for (let i = 0; i < 80; i++) rig.tick();
      expect(Array.from(rig.segments().position.slice(0, 3))).toEqual(Array.from(quiet));
    } finally {
      rig.dispose();
    }
  }, 120_000);
});

describe('the rig, pinned', () => {
  // What a do-nothing policy scored (`toBe` is `Object.is`), and where a do-nothing body had got to, before the rig was
  // restructured. Exact, because the restructuring was meant to move nothing: a reward term read
  // in a different order, or a reset that runs in one path and not the other, shows up here as a
  // last digit.
  const EPISODES = {
    stand: [
      [1.0499629850634415, 0.48],
      [0.7945004698924945, 0.38],
      [1.071827537196253, 0.49],
    ],
    balance: [
      [0.5224071405642816, 0.48],
      [0.32996978807724364, 0.38],
      [0.45100975367020996, 0.49],
    ],
  } as const;
  const TICKED = [
    0.5139209997253271, 0.2499798956822575, 0.05733216836234079, 0.5021773654160474,
    0.2938913365873815, 0.17037256659103928,
  ];

  for (const task of ['stand', 'balance'] as const) {
    it(`scores ${task} and plays it tick by tick exactly as it did`, async () => {
      const rig = await StandRig.build({
        profileId: 'l1_standard',
        hidden: [8],
        seconds: 2,
        authority: 0.3,
        feedforward: { kind: 'none' },
        task,
      });
      try {
        const zero = new Float32Array(rig.parameterCount);
        EPISODES[task].forEach(([fitness, alive], k) => {
          const result = rig.episode(zero, k + 1);
          expect(result.fitness).toBe(fitness);
          expect(result.aliveSeconds).toBe(alive);
        });
        // Straight after the episodes, so a reset that only one of the two paths does would
        // leave something behind here.
        rig.begin(zero, 7);
        let down = -1;
        for (let i = 0; i < 700; i++) {
          if (!rig.tick().up && down < 0) down = i;
        }
        // `toEqual` compares numbers exactly, not to a tolerance, so this is to the last bit.
        expect(Array.from(rig.segments().position.slice(0, 6))).toEqual(TICKED);
        expect(down).toBe(383);
      } finally {
        rig.dispose();
      }
    }, 180_000);
  }
});

describe('the feet the rig stands on', () => {
  it('are found at L2, so an L2 body starts on the ground and stays up past the airborne grace', async () => {
    // L2's root foot segment is `hindfoot_`, which the rig did not recognise as a foot: every
    // L2 episode read as airborne from the first control step and ended at the 0.05 s grace
    // with nothing scored, so no L2 policy could ever be trained.
    const rig = await StandRig.build({
      profileId: 'l2_biomechanical',
      hidden: [8],
      seconds: 1,
      authority: 0.3,
      feedforward: { kind: 'none' },
    });
    try {
      const zero = new Float32Array(rig.parameterCount);
      rig.begin(zero, 1);
      rig.tick();
      // Called with no time elapsed, so it advances neither clock: a look, not a step.
      const look = rig as unknown as { standing(sinceLast: number): { grounded: boolean } };
      expect(look.standing(0).grounded).toBe(true);
      const result = rig.episode(zero, 1);
      // Well past AIRBORNE_GRACE, and scored: time is only counted while a foot is down.
      expect(result.aliveSeconds).toBeGreaterThan(0.2);
      expect(result.fitness).toBeGreaterThan(0);
    } finally {
      rig.dispose();
    }
  }, 180_000);
});

describe('a task the rig does not score', () => {
  it('is refused before anything is built, rather than scored as a stand', async () => {
    await expect(
      StandRig.build({
        profileId: 'l1_standard',
        hidden: [8],
        seconds: 1,
        authority: 0.3,
        feedforward: { kind: 'none' },
        task: 'stnad',
      }),
    ).rejects.toThrow('unknown task "stnad"; known tasks: stand, balance');
  });
});

describe('the twitch', () => {
  it('lands with time left to answer it, and the same seed gives the same twitch', () => {
    for (const seed of [1, 2, 3, 17, 1000, 123456, 0xffffffff]) {
      const { output, at } = twitchSchedule(seed, 70, 6);
      expect(at).toBeGreaterThanOrEqual(0.5);
      expect(at).toBeLessThan(5);
      expect(Number.isInteger(output)).toBe(true);
      expect(output).toBeGreaterThanOrEqual(0);
      expect(output).toBeLessThan(70);
      expect(twitchSchedule(seed, 70, 6)).toEqual({ output, at });
    }
    // What these seeds drew before the rig's private xorshift32 became the nerves' stream, exactly:
    // a recorded score replays only if its twitch lands on the same output at the same moment.
    // Seeds 0 and 1 are one stream.
    expect(twitchSchedule(0, 70, 6)).toEqual({ output: 0, at: 0.5708634273032658 });
    expect(twitchSchedule(1, 70, 6)).toEqual({ output: 0, at: 0.5708634273032658 });
    expect(twitchSchedule(7, 70, 6)).toEqual({ output: 0, at: 0.9928446490666829 });
    expect(twitchSchedule(0x9e3779b9, 70, 6)).toEqual({ output: 22, at: 4.440681433596183 });
    expect(twitchSchedule(0x9e3779b9, 7, 1)).toEqual({ output: 2, at: 0.5875706985243596 });
    // An episode too short for the margin still gets its twitch after the first half second.
    const short = twitchSchedule(5, 70, 1);
    expect(short.at).toBeGreaterThanOrEqual(0.5);
    expect(short.at).toBeLessThan(0.6);
  });
});
