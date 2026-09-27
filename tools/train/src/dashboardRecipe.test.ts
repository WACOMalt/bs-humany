/**
 * The recipe the dashboard builds from a studio request. This is where a run started from the
 * studio stopped being the run the studio showed: the stretch cap here was a fifth, left from the
 * scale the afferent had before it was fixed, while the slider went to eight, so every run started
 * from the Brain tab since then trained on a stretch of 0.2 whatever the slider said -- and saved
 * it, so the checkpoint reloads as that body. What is held here is that a request gets the cord it
 * sends, that a value the dashboard does change is reported, and that a name or a task that is not
 * one is refused rather than replaced.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recipeFrom, resumePreflight } from '../bin/recipe.mjs';
import {
  DEFAULT_NOISE,
  DEFAULT_REFLEX,
  NO_REFLEX,
  REFLEX_FIELDS,
  type TrainingRecipe,
  defaultRecipe,
} from './recipe.js';

const ROOT = join(import.meta.dirname, '../../..');
const STUDIO = readFileSync(join(ROOT, 'apps/studio/index.html'), 'utf8');

/** The Spine panel's sliders, by the cord field each one sets. */
const SLIDERS = {
  'spine-stretch': 'stretch',
  'spine-velocity': 'velocity',
  'spine-setpoint': 'setPoint',
  'spine-inhibition': 'inhibition',
  'spine-delay': 'delaySeconds',
} as const;

function slider(id: string): { min: number; max: number } {
  const tag = STUDIO.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
  const attribute = (name: string) => Number(tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1]);
  return { min: attribute('min'), max: attribute('max') };
}

/** A recipe that is not a refusal, or the test fails saying why it was one. */
function built(body: Record<string, unknown>) {
  const result = recipeFrom(body);
  if ('error' in result) throw new Error(`refused: ${result.error}`);
  return result;
}

describe('the cord a dashboard run trains over', () => {
  it('is the cord the request sends', () => {
    expect(built({ recipe: { reflex: DEFAULT_REFLEX } }).recipe.reflex).toEqual(DEFAULT_REFLEX);
    expect(built({ recipe: { reflex: DEFAULT_REFLEX } }).clamped).toEqual([]);
    expect(built({ recipe: { reflex: { stretch: 3.5 } } }).recipe.reflex).toEqual({
      ...DEFAULT_REFLEX,
      stretch: 3.5,
    });
    expect(built({ recipe: { reflex: { stretch: 0 } } }).recipe.reflex?.stretch).toBe(0);
    expect(built({ recipe: { reflex: NO_REFLEX } }).recipe.reflex).toEqual(NO_REFLEX);
  });

  it('fills a cord it is sent from the measured defaults, and leaves out one it is not', () => {
    expect(built({ recipe: { reflex: {} } }).recipe.reflex).toEqual(DEFAULT_REFLEX);
    // No cord in the request is no cord in the recipe, which the rig reads as `NO_REFLEX`: the
    // body every checkpoint before the spinal module was trained in.
    expect('reflex' in built({ recipe: {} }).recipe).toBe(false);
    expect('reflex' in built({}).recipe).toBe(false);
  });

  it("passes every slider's whole range through unchanged", () => {
    const ids = [...STUDIO.matchAll(/<input[^>]*type="range"[^>]*id="(spine-[\w-]+)"/g)].map(
      (m) => m[1],
    );
    // A new cord slider has to be added here, or this is no longer checking all of them.
    expect(ids.sort()).toEqual(Object.keys(SLIDERS).sort());
    for (const [id, field] of Object.entries(SLIDERS)) {
      const { min, max } = slider(id);
      expect(Number.isFinite(min) && Number.isFinite(max), id).toBe(true);
      for (const value of [min, max]) {
        const { recipe, clamped } = built({ recipe: { reflex: { [field]: value } } });
        expect(recipe.reflex?.[field], `${id} at ${value}`).toBe(value);
        expect(clamped, `${id} at ${value}`).toEqual([]);
      }
    }
  });

  it('brings a value past its limit into it, and says so', () => {
    const { recipe, clamped } = built({ recipe: { reflex: { stretch: 99, delaySeconds: 1 } } });
    expect(recipe.reflex?.stretch).toBe(8);
    expect(clamped).toEqual([
      { field: 'reflex.stretch', asked: 99, used: 8 },
      { field: 'reflex.delaySeconds', asked: 1, used: 0.2 },
    ]);
    expect(built({ recipe: { reflex: { stretch: 50 } } }).clamped).toEqual([
      { field: 'reflex.stretch', asked: 50, used: 8 },
    ]);
    // A number that is not one takes the default, and that is a change too.
    expect(built({ recipe: { reflex: { velocity: 'fast' } } }).clamped).toEqual([
      { field: 'reflex.velocity', asked: 'fast', used: DEFAULT_REFLEX.velocity },
    ]);
  });

  it('holds the noise, the memory and the authority the same way', () => {
    expect(built({}).recipe.noise).toEqual(DEFAULT_NOISE);
    expect(built({}).recipe.memory).toBe(0);
    expect(built({}).recipe.authority).toBe(0.3);
    const { recipe, clamped } = built({
      authority: 0.7,
      recipe: { noise: { motor: 2 }, memory: 100 },
    });
    expect(recipe.authority).toBe(0.7);
    expect(recipe.noise).toEqual({ ...DEFAULT_NOISE, motor: 0.5 });
    expect(recipe.memory).toBe(64);
    expect(clamped).toEqual([
      { field: 'noise.motor', asked: 2, used: 0.5 },
      { field: 'memory', asked: 100, used: 64 },
    ]);
    for (const k of REFLEX_FIELDS)
      expect(clamped.some((c) => c.field === `reflex.${k}`)).toBe(false);
  });
});

describe('the name and the task of a dashboard run', () => {
  it('defaults to the task, and the task to standing', () => {
    expect(built({}).recipe).toMatchObject({ name: 'stand', task: 'stand' });
    expect(built({ task: 'balance' }).recipe).toMatchObject({ name: 'balance', task: 'balance' });
    expect(built({ name: 'c1', task: '' }).recipe).toMatchObject({ name: 'c1', task: 'stand' });
  });

  it('refuses a name that is not one rather than training another', () => {
    for (const name of ['My-Stand', 'My Stand', '../x', 'a'.repeat(41), 42]) {
      const result = recipeFrom({ name });
      expect(result, String(name)).toMatchObject({ status: 400 });
      expect('error' in result && result.error, String(name)).toMatch(/checkpoint name/);
    }
    expect(built({ name: 'a'.repeat(40) }).recipe.name).toBe('a'.repeat(40));
  });

  it('refuses a task the rig does not score', () => {
    expect(recipeFrom({ task: 'walk' })).toEqual({
      status: 400,
      error: "unknown task 'walk'; known: stand, balance",
    });
  });
});

describe('a Resume from the dashboard', () => {
  const recipe = built({ name: 'stand', recipe: { reflex: DEFAULT_REFLEX } }).recipe;
  /** A saved recipe as an old file has it: no cord. */
  const old: TrainingRecipe = (() => {
    const { reflex: _r, ...rest } = defaultRecipe('stand', 'l3_anatomical', 0.3);
    return { ...rest, feedforward: { kind: 'none' } };
  })();

  it('is refused when there is nothing to continue', () => {
    expect(resumePreflight(recipe, {})).toEqual({
      status: 409,
      error: 'nothing saved under stand to resume; untick Resume to start it',
    });
  });

  it('is refused for a checkpoint trained on another task', () => {
    const balance = built({ name: 'stand', task: 'balance' }).recipe;
    expect(resumePreflight(balance, { policy: { task: 'stand' } })).toEqual({
      status: 409,
      error: 'stand was trained for stand, not balance',
    });
    expect(resumePreflight(balance, { centre: { task: 'stand' } })).toMatchObject({ status: 409 });
  });

  it('lists what the recipe changes, reading an old recipe as the body it was trained in', () => {
    expect(resumePreflight(recipe, { policy: { task: 'stand', recipe: old } })).toEqual({
      recipeChanges: 'reflex.stretch 0 -> 3.5, reflex.velocity 0 -> 0.25',
    });
    expect(resumePreflight(recipe, { centre: { task: 'stand' } })).toEqual({
      recipeChanges: undefined,
    });
    expect(resumePreflight(recipe, { policy: { task: 'stand', recipe } })).toEqual({
      recipeChanges: '',
    });
  });
});
