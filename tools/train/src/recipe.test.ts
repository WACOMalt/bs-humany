/**
 * The recipe module: one home for what a training run may be. What is held here is the set of
 * agreements that used to be kept by hand across four files -- the cord's off against the spinal
 * module's, the stretch cap against the slider that sends it, the name rule, the task list -- and
 * the helpers that turn a recipe into words a person reads before a run starts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SPINAL_GAINS, type SpinalGains } from '@bs-humany/modules-nerves';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DEFAULT_NOISE,
  DEFAULT_REFLEX,
  MEMORY_LIMIT,
  NOISE_LIMITS,
  NO_REFLEX,
  REFLEX_FIELDS,
  REFLEX_LIMITS,
  type ReflexLevels,
  TASKS,
  type TrainingRecipe,
  checkRecipe,
  defaultRecipe,
  describeRecipe,
  formatRecipeChanges,
  isCheckpointName,
  isTask,
  recipeChanges,
  reflexWithFlags,
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

/** A recipe as an old file has it: no noise, no cord, no memory. */
const bare: TrainingRecipe = (() => {
  const { noise: _n, reflex: _r, memory: _m, ...rest } = defaultRecipe('stand', 'l1_standard', 0.3);
  return rest;
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
    expect(() => defaultRecipe('walk', 'l1_standard', 0.3)).toThrow(
      'unknown task "walk"; known tasks: stand, balance',
    );
    expect(defaultRecipe('balance', 'l1_standard', 0.3).feedforward).toEqual({
      kind: 'clip',
      clip: 'quiet-standing',
    });
  });
});

describe('a recipe read from a file', () => {
  it('passes when whole, old files included', () => {
    expect(checkRecipe(defaultRecipe('stand', 'l3_anatomical', 0.3))).toEqual([]);
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
    expect(changes).toContainEqual({ field: 'reflex.stretch', from: 0, to: 3.5 });
    expect(changes).toContainEqual({ field: 'reflex.velocity', from: 0, to: 0.25 });
    expect(changes).toHaveLength(2);
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
    expect(formatRecipeChanges(recipeChanges(bare, { ...bare, scenario: 'tilting-floor' }))).toBe(
      'scenario "" -> "tilting-floor"',
    );
  });
});

describe('a recipe in one line', () => {
  it('says where, what is under the brain, the cord, the noise and the memory', () => {
    expect(describeRecipe(defaultRecipe('stand', 'l3_anatomical', 0.3))).toBe(
      'reference stand; the quiet-standing clip under the brain; authority 0.3; cord stretch 3.5, damping 0.25, 30 ms; tremor 0.05, sense 0.01; no memory',
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
