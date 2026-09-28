/**
 * The recipe module: one home for what a training run may be. What is held here is the set of
 * agreements that used to be kept by hand across four files -- the cord's off against the spinal
 * module's, the stretch cap against the slider that sends it, the name rule, the task list -- and
 * the helpers that turn a recipe into words a person reads before a run starts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SPINAL_GAINS, SPINAL_REGIONS, type SpinalGains } from '@bs-humany/modules-nerves';
import {
  DEFAULT_SCENARIO,
  RETIRED_SCENARIOS as SCENARIOS_RETIRED,
  SCENARIO_DEFINITIONS,
} from '@bs-humany/scenarios';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DEFAULT_AUTHORITY,
  DEFAULT_BEHAVIOUR,
  DEFAULT_BEHAVIOUR_MEMORY,
  DEFAULT_BEHAVIOUR_PARAMETERS,
  DEFAULT_BEHAVIOUR_SCENARIO,
  DEFAULT_NOISE,
  DEFAULT_PROFILE,
  DEFAULT_REFLEX,
  DEFAULT_TASK,
  MEMORY_LIMIT,
  NOISE_LIMITS,
  NO_REFLEX,
  REFLEX_FIELDS,
  REFLEX_LIMITS,
  REFLEX_REGIONS,
  RETIRED_SCENARIOS,
  type ReflexLevels,
  TASKS,
  type TrainingRecipe,
  behaviourRecipe,
  checkRecipe,
  clipStandRecipe,
  cordIsOff,
  describeRecipe,
  describeStretch,
  everyRegion,
  formatRecipeChanges,
  isCheckpointName,
  isTask,
  recipeChanges,
  reflexWithFlags,
  regionStretchOf,
  rigOptionsFor,
  upgradeRecipe,
} from './recipe.js';

const ROOT = join(import.meta.dirname, '../../..');
const STUDIO = readFileSync(join(ROOT, 'apps/studio/index.html'), 'utf8');

/** An `<input>` attribute from the studio's page, read as text. */
function inputAttribute(id: string, attribute: string): number {
  const tag = STUDIO.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
  const value = tag?.match(new RegExp(`\\b${attribute}="([^"]+)"`))?.[1];
  if (value === undefined) throw new Error(`#${id} has no ${attribute} in apps/studio/index.html`);
  return Number(value);
}

/**
 * A recipe as an old file has it: no noise, no cord, no memory, and no scenario -- the reference
 * body on the ground, which is what the flags described before 2026-09-28 named with an empty id.
 */
const bare: TrainingRecipe = (() => {
  const {
    noise: _n,
    reflex: _r,
    memory: _m,
    ...rest
  } = clipStandRecipe('stand', 'l1_standard', 0.3);
  return { ...rest, scenario: '', parameters: {} };
})();

describe('the cord', () => {
  it("is the spinal module's own gains, and its off is the module's off", () => {
    expectTypeOf<ReflexLevels>().toEqualTypeOf<SpinalGains>();
    const one: SpinalGains = DEFAULT_REFLEX;
    const other: ReflexLevels = DEFAULT_SPINAL_GAINS;
    expect(one).toBe(DEFAULT_REFLEX);
    expect(other).toBe(DEFAULT_SPINAL_GAINS);
    expect(NO_REFLEX).toEqual(DEFAULT_SPINAL_GAINS);
    for (const k of REFLEX_FIELDS) expect(NO_REFLEX[k], k).toBe(DEFAULT_SPINAL_GAINS[k]);
    expect(Object.keys(NO_REFLEX).sort()).toEqual([...REFLEX_FIELDS].sort());
  });

  it('has defaults inside its limits', () => {
    for (const k of REFLEX_FIELDS) {
      expect(DEFAULT_REFLEX[k], k).toBeGreaterThanOrEqual(REFLEX_LIMITS[k].min);
      expect(DEFAULT_REFLEX[k], k).toBeLessThanOrEqual(REFLEX_LIMITS[k].max);
    }
    for (const k of ['motor', 'sense', 'tau'] as const) {
      expect(DEFAULT_NOISE[k]).toBeGreaterThanOrEqual(NOISE_LIMITS[k].min);
      expect(DEFAULT_NOISE[k]).toBeLessThanOrEqual(NOISE_LIMITS[k].max);
    }
    expect(MEMORY_LIMIT).toEqual({ min: 0, max: 64 });
  });

  it("goes exactly as far as the studio's stretch slider", () => {
    expect(REFLEX_LIMITS.stretch.max).toBe(inputAttribute('spine-stretch', 'max'));
    expect(REFLEX_LIMITS.stretch.min).toBe(inputAttribute('spine-stretch', 'min'));
  });
});

describe('the stretch by region', () => {
  it("names the spinal module's regions, in its order", () => {
    expect([...REFLEX_REGIONS]).toEqual([...SPINAL_REGIONS]);
  });

  it('gives every region of the measured cord a stretch inside the slider range', () => {
    for (const r of REFLEX_REGIONS) {
      const v = DEFAULT_REFLEX.regionStretch?.[r];
      expect(v, r).toBeDefined();
      expect(v, r).toBeGreaterThanOrEqual(REFLEX_LIMITS.stretch.min);
      expect(v, r).toBeLessThanOrEqual(REFLEX_LIMITS.stretch.max);
    }
    // And the region sliders go exactly as far as the one for all regions.
    for (const r of REFLEX_REGIONS) {
      const id = `spine-stretch-${r.toLowerCase()}`;
      expect(inputAttribute(id, 'max'), id).toBe(inputAttribute('spine-stretch', 'max'));
      expect(inputAttribute(id, 'min'), id).toBe(inputAttribute('spine-stretch', 'min'));
      expect(inputAttribute(id, 'step'), id).toBe(inputAttribute('spine-stretch', 'step'));
    }
  });

  it('reads a recipe with only a stretch as that stretch in every region', () => {
    // Every recipe and checkpoint saved before 2026-09-27 has one stretch and no regions, and it
    // ran that stretch everywhere; so it loads that way, and it is no change from a cord that
    // names the same stretch in every region.
    const old: TrainingRecipe = { ...bare, reflex: { ...NO_REFLEX, stretch: 8.5, velocity: 0.25 } };
    const cord = rigOptionsFor(old, { hidden: [8], seconds: 1 }).reflex;
    expect(cord?.regionStretch).toBeUndefined();
    for (const r of REFLEX_REGIONS) {
      expect(regionStretchOf(old.reflex as ReflexLevels, r), r).toBe(8.5);
    }
    const everywhere = { ...old, reflex: everyRegion(old.reflex as ReflexLevels) };
    expect(Object.values(everywhere.reflex.regionStretch ?? {})).toEqual([8.5, 8.5, 8.5, 8.5, 8.5]);
    expect(recipeChanges(old, everywhere)).toEqual([]);
    // Against the measured cord, the difference is said region by region.
    const now = { ...old, reflex: DEFAULT_REFLEX };
    const fields = recipeChanges(old, now).map((c) => c.field);
    for (const r of REFLEX_REGIONS) {
      const moved = DEFAULT_REFLEX.regionStretch?.[r] !== 8.5;
      expect(fields.includes(`reflex.regionStretch.${r}`), r).toBe(moved);
    }
    expect(checkRecipe(old)).toEqual([]);
  });

  it('is checked in a recipe from a file: regions it knows, as numbers', () => {
    const cord = (regionStretch: unknown) => ({ ...bare, reflex: { ...NO_REFLEX, regionStretch } });
    expect(checkRecipe(cord({ Arm: 2, Leg: 8.5 }))).toEqual([]);
    expect(checkRecipe(cord({ Tail: 2 }))).toHaveLength(1);
    expect(checkRecipe(cord({ Arm: 'soft' }))).toHaveLength(1);
    expect(checkRecipe(cord([2]))).toHaveLength(1);
  });

  it('is described as one stretch when it is one, and region by region when not', () => {
    expect(describeStretch({ ...NO_REFLEX, stretch: 3.5 })).toBe('3.5');
    expect(
      describeStretch({ ...NO_REFLEX, stretch: 3.5, regionStretch: { Arm: 1, Neck: 5 } }),
    ).toBe('arm 1, hand 3.5, leg 3.5, trunk 3.5, neck 5');
    expect(describeRecipe({ ...bare, reflex: DEFAULT_REFLEX })).toContain(
      `cord stretch ${describeStretch(DEFAULT_REFLEX)}`,
    );
  });

  it('is on while any region has a stretch, and off only when all of it is zero', () => {
    expect(cordIsOff(NO_REFLEX)).toBe(true);
    expect(cordIsOff({ ...NO_REFLEX, regionStretch: { Arm: 0 } })).toBe(true);
    expect(cordIsOff({ ...NO_REFLEX, regionStretch: { Leg: 4 } })).toBe(false);
    expect(
      describeRecipe({ ...bare, reflex: { ...NO_REFLEX, regionStretch: { Leg: 4 } } }),
    ).toContain('cord stretch arm 0, hand 0, leg 4');
  });

  it('is set from the command line one region at a time, over --reflex or the recipe', () => {
    const recipeCord: ReflexLevels = {
      ...NO_REFLEX,
      stretch: 5,
      velocity: 0.25,
      regionStretch: { Leg: 9 },
    };
    // A region flag over the recipe's cord keeps the regions it does not name.
    const arm = reflexWithFlags(recipeCord, { regions: { Arm: 2 } });
    expect(arm.levels.regionStretch).toEqual({ Leg: 9, Arm: 2 });
    expect(arm.source).toBe("flags over the recipe's cord");
    // `--reflex` is the stretch everywhere, so it clears them; region flags then go over it.
    expect(reflexWithFlags(recipeCord, { stretch: 3 }).levels.regionStretch).toBeUndefined();
    const both = reflexWithFlags(recipeCord, { stretch: 3, regions: { Neck: 1 } });
    expect(both.levels).toMatchObject({ stretch: 3, regionStretch: { Neck: 1 } });
    expect(() => reflexWithFlags(recipeCord, { regions: { Tail: 1 } as never })).toThrow(/Tail/);
    expect(() => reflexWithFlags(recipeCord, { regions: { Arm: Number.NaN } })).toThrow(/Arm/);
    // The measured cord, flag by flag, is the measured cord.
    expect(reflexWithFlags(undefined, { preset: 'default' }).levels).toEqual(DEFAULT_REFLEX);
  });
});

describe('the cord from the command line', () => {
  it('moves one number of the recipe it is given, and no cord is no cord', () => {
    const delayOnly = reflexWithFlags(undefined, { delaySeconds: 0.04 });
    expect(delayOnly.levels).toEqual({ ...NO_REFLEX, delaySeconds: 0.04 });
    expect(delayOnly.levels.stretch).toBe(0);
    expect(delayOnly.levels.velocity).toBe(0);
    expect(delayOnly.source).toBe('flags over no cord');

    const preset = reflexWithFlags(undefined, { preset: 'default' });
    expect(preset.levels).toEqual(DEFAULT_REFLEX);
    expect(preset.source).toBe('default, from --reflex default');

    const recipeCord = { ...DEFAULT_REFLEX, stretch: 2 };
    const ceiling = reflexWithFlags(recipeCord, { forceCeiling: 2.5 });
    expect(ceiling.levels).toEqual({ ...recipeCord, forceCeiling: 2.5 });
    expect(ceiling.source).toBe("flags over the recipe's cord");

    expect(reflexWithFlags(recipeCord, {})).toEqual({ levels: recipeCord, source: 'recipe' });
    expect(reflexWithFlags(undefined, {})).toEqual({
      levels: NO_REFLEX,
      source: 'none: the recipe has no cord',
    });
    expect(reflexWithFlags(recipeCord, { preset: 'none' }).levels).toEqual(NO_REFLEX);
  });

  it('refuses a number that is not one, and says which', () => {
    expect(() => reflexWithFlags(undefined, { stretch: Number.NaN })).toThrow(/stretch/);
    expect(() => reflexWithFlags(undefined, { delaySeconds: Number.POSITIVE_INFINITY })).toThrow(
      /delaySeconds/,
    );
  });
});

describe('the name and the task', () => {
  it('takes a checkpoint name and nothing else', () => {
    for (const name of ['stand', 'my-stand_2', 'a'.repeat(40)]) {
      expect(isCheckpointName(name), name).toBe(true);
    }
    for (const name of ['My-Stand', 'stand 2', '../x', '', 'a'.repeat(41)]) {
      expect(isCheckpointName(name), name).toBe(false);
    }
  });

  it('takes a task the rig scores and refuses the rest', () => {
    expect(TASKS).toEqual(['stand', 'balance']);
    expect(isTask('balance')).toBe(true);
    expect(isTask('walk')).toBe(false);
    expect(() => clipStandRecipe('walk', 'l1_standard', 0.3)).toThrow(
      'unknown task "walk"; known tasks: stand, balance',
    );
    expect(clipStandRecipe('balance', 'l1_standard', 0.3).feedforward).toEqual({
      kind: 'clip',
      clip: 'quiet-standing',
    });
  });
});

describe('the default behaviour', () => {
  it("is balance, in Drop, standing at 0 m, on the module's own defaults", () => {
    // The owner's decision of 2026-09-27: one default behaviour, called balance, in the falling
    // standing scenario at no drop, with the cord and the training settings at their defaults.
    expect(DEFAULT_TASK).toBe('balance');
    expect(TASKS).toContain(DEFAULT_TASK);
    expect(DEFAULT_BEHAVIOUR).toEqual({
      name: 'balance',
      task: 'balance',
      scenario: 'drop-standing-collapse',
      parameters: { clearance: 0 },
      profile: DEFAULT_PROFILE,
      morphology: { sex: 0.5, stature: 1.7, mass: 70 },
      passive: true,
      redistribute: true,
      feedforward: { kind: 'none' },
      authority: DEFAULT_AUTHORITY,
      noise: DEFAULT_NOISE,
      reflex: DEFAULT_REFLEX,
      memory: DEFAULT_BEHAVIOUR_MEMORY,
    });
    // The cord by name, so a re-measured cord reaches it without a second edit.
    expect(DEFAULT_BEHAVIOUR.reflex).toBe(DEFAULT_REFLEX);
    expect(checkRecipe(DEFAULT_BEHAVIOUR)).toEqual([]);
    expect(() => behaviourRecipe('walk', DEFAULT_PROFILE, 0.3)).toThrow('unknown task "walk"');
    expect(behaviourRecipe('stand', 'l1_standard', 0.5)).toMatchObject({
      name: 'stand',
      task: 'stand',
      scenario: DEFAULT_BEHAVIOUR_SCENARIO,
      profile: 'l1_standard',
      authority: 0.5,
    });
  });

  it('is set in the scenario the studio opens on, whose drop height defaults to 0', () => {
    // Two copies of one id, because this module loads nothing that runs: held together here.
    expect(DEFAULT_BEHAVIOUR_SCENARIO).toBe(DEFAULT_SCENARIO);
    const drop = SCENARIO_DEFINITIONS.find((d) => d.id === DEFAULT_BEHAVIOUR_SCENARIO);
    const clearance = drop?.parameters.find((p) => p.id === 'clearance');
    expect(clearance?.value).toBe(0);
    expect(DEFAULT_BEHAVIOUR.parameters).toEqual({ clearance: clearance?.value });
  });

  it("has a memory the studio's Memory slider can show, and the slider opens on it", () => {
    const memory = DEFAULT_BEHAVIOUR.memory ?? 0;
    expect(memory).toBeGreaterThan(0);
    expect(memory % inputAttribute('train-memory', 'step')).toBe(0);
    expect(memory).toBeLessThanOrEqual(inputAttribute('train-memory', 'max'));
    expect(memory).toBeLessThanOrEqual(MEMORY_LIMIT.max);
    expect(inputAttribute('train-memory', 'value')).toBe(memory);
  });
});

describe('a recipe read from a file', () => {
  it('passes when whole, old files included', () => {
    expect(checkRecipe(clipStandRecipe('stand', 'l3_anatomical', 0.3))).toEqual([]);
    expect(checkRecipe(bare)).toEqual([]);
  });

  it('names every field that is missing or wrong', () => {
    const { feedforward: _f, ...noFeedforward } = bare;
    const problems = checkRecipe(noFeedforward);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/feedforward/);
    const worse = checkRecipe({ ...bare, name: 'My Stand', task: 'walk', authority: 'lots' });
    expect(worse).toHaveLength(3);
    expect(worse.join('\n')).toMatch(/'My Stand' is not a checkpoint name/);
    expect(worse.join('\n')).toMatch(/unknown task "walk"/);
    expect(worse.join('\n')).toMatch(/authority/);
    expect(checkRecipe(null)).toHaveLength(1);
  });
});

describe('what a Resume changes', () => {
  it('reads an old recipe as the body it was trained in', () => {
    const now = { ...bare, reflex: DEFAULT_REFLEX };
    const changes = recipeChanges(bare, now);
    // No cord against the measured one, which differs by region: each region whose stretch moved,
    // not a base stretch that no region follows.
    expect(changes).toEqual([
      { field: 'reflex.velocity', from: 0, to: 0.25 },
      { field: 'reflex.regionStretch.Arm', from: 0, to: 3.5 },
      { field: 'reflex.regionStretch.Leg', from: 0, to: 3.5 },
      { field: 'reflex.regionStretch.Trunk', from: 0, to: 8.5 },
    ]);
  });

  it('says it in one line, and ignores the name and the timescale', () => {
    const now = {
      ...bare,
      name: 'other',
      stepsPerSecond: 1000,
      authority: 0.5,
      reflex: { ...NO_REFLEX, stretch: 3.5 },
    };
    expect(formatRecipeChanges(recipeChanges(bare, now))).toBe(
      'authority 0.3 -> 0.5, reflex.stretch 0 -> 3.5',
    );
    expect(recipeChanges(undefined, now)).toEqual([]);
    expect(recipeChanges(bare, bare)).toEqual([]);
    expect(formatRecipeChanges([])).toBe('');
    // The empty scenario is compared as the default one at its drop of 0 m, the body it always
    // was, so moving it to the tilting floor is the scenario and the default's one parameter.
    expect(formatRecipeChanges(recipeChanges(bare, { ...bare, scenario: 'tilting-floor' }))).toBe(
      'scenario "drop-standing-collapse" -> "tilting-floor", parameters.clearance 0 -> none',
    );
    // And named as that scenario, it is no change at all.
    expect(
      recipeChanges(bare, {
        ...bare,
        scenario: DEFAULT_BEHAVIOUR_SCENARIO,
        parameters: DEFAULT_BEHAVIOUR_PARAMETERS,
      }),
    ).toEqual([]);
  });
});

describe('a recipe in one line', () => {
  it('says where, what is under the brain, the cord, the noise and the memory', () => {
    expect(describeRecipe(clipStandRecipe('stand', 'l3_anatomical', 0.3))).toBe(
      'drop-standing-collapse; the quiet-standing clip under the brain; authority 0.3; cord stretch arm 3.5, hand 0, leg 3.5, trunk 8.5, neck 0, damping 0.25, 30 ms; tremor 0.05, sense 0.01; no memory',
    );
    expect(
      describeRecipe({
        ...bare,
        scenario: 'tilting-floor',
        feedforward: { kind: 'none' },
        memory: 8,
      }),
    ).toBe(
      'tilting-floor; the brain alone; authority 0.3; no cord; tremor 0.05, sense 0.01; memory 8',
    );
  });
});

describe('a recipe from before the seven scenarios were deleted', () => {
  it('names the scenarios the scenario package deleted, and none that exists', () => {
    // Two copies of one list, for the reason there are two of the default scenario's id.
    expect([...RETIRED_SCENARIOS]).toEqual([...SCENARIOS_RETIRED]);
    for (const id of RETIRED_SCENARIOS) {
      expect(
        SCENARIO_DEFINITIONS.some((d) => d.id === id),
        id,
      ).toBe(false);
    }
  });

  it('reads a deleted scenario as the default one at 0 m, and says so', () => {
    const old = { ...bare, scenario: 'quiet-standing', parameters: { tone: 1, reflex: 1 } };
    expect(checkRecipe(old)).toEqual([]);
    const { recipe, notes } = upgradeRecipe(old);
    expect(recipe.scenario).toBe(DEFAULT_BEHAVIOUR_SCENARIO);
    expect(recipe.parameters).toEqual({ clearance: 0 });
    expect(notes).toEqual([
      'the scenario quiet-standing was deleted on 2026-09-28 (scenarios no longer drive muscles), ' +
        'so "Drop, standing" at 0 m is used in its place',
    ]);
    // The clip of the same name is a clip, and stays under the brain.
    expect(recipe.feedforward).toEqual({ kind: 'clip', clip: 'quiet-standing' });
    // Everything else as it came.
    expect({ ...recipe, scenario: old.scenario, parameters: old.parameters }).toEqual(old);
  });

  it("reads the scenario's own muscle script under the brain as nothing, and says so", () => {
    const old = { ...bare, scenario: 'tilting-floor', feedforward: { kind: 'script' as const } };
    // The file still passes the check: it loads, it is not refused.
    expect(checkRecipe(old)).toEqual([]);
    const { recipe, notes } = upgradeRecipe(old);
    expect(recipe.feedforward).toEqual({ kind: 'none' });
    expect(recipe.scenario).toBe('tilting-floor');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/muscle script .* nothing plays under the brain in its place/);
  });

  it('reads an empty scenario as the default one, silently, and a recipe of today unchanged', () => {
    const { recipe, notes } = upgradeRecipe(bare);
    expect(recipe.scenario).toBe(DEFAULT_BEHAVIOUR_SCENARIO);
    expect(recipe.parameters).toEqual(DEFAULT_BEHAVIOUR_PARAMETERS);
    expect(notes).toEqual([]);
    const today = upgradeRecipe(DEFAULT_BEHAVIOUR);
    expect(today.recipe).toBe(DEFAULT_BEHAVIOUR);
    expect(today.notes).toEqual([]);
  });

  it('sets a rig with no scenario in the default one, where the reference stand stood', () => {
    expect(rigOptionsFor(bare, { hidden: [8], seconds: 1 }).scenario).toEqual({
      id: DEFAULT_BEHAVIOUR_SCENARIO,
      parameters: DEFAULT_BEHAVIOUR_PARAMETERS,
    });
  });
});
