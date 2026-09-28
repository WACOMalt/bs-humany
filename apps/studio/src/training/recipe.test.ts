/**
 * The Brain panel's recipe and the verdict on its name, held where they are now worked out.
 *
 * The panel used to assemble its recipe twice and judge its name three ways: a regular expression
 * of its own that allowed one character more than the binary, a server that refused what the
 * window's own run then trained, and a fallback that replaced an empty name with the task. These
 * pin the one version of each, and the words the shipped checkpoints are listed with.
 */

import { DEFAULT_NOISE, DEFAULT_REFLEX } from '@bs-humany/train/recipe';
import { describe, expect, it } from 'vitest';
import type { CheckpointRow, RecipeInput, TrainingRecipe } from '../brain.js';
import {
  type RecipeForm,
  adjustedPhrase,
  buildRecipe,
  checkpointNameOf,
  feedforwardFrom,
  feedforwardPhrase,
  freeCheckpointName,
  nameAllowsStart,
  nameVerdict,
} from './recipe.js';
import { shippedCheckpoints, trainedBefore } from './shipped.js';

const input: RecipeInput = {
  scenario: 'drop-standing-collapse',
  parameters: { clearance: 0 },
  profile: 'l3_anatomical',
  morphology: { sex: 0.5, stature: 1.7, mass: 70 },
  passive: true,
  redistribute: true,
};

const form: RecipeForm = {
  name: 'stand-2',
  task: 'stand',
  feedforward: 'none',
  authority: 0.7,
  noise: { motor: 0.05, sense: 0.01 },
  reflex: DEFAULT_REFLEX,
  memory: 0,
};

/** A row as a server lists a saved policy, or as the studio lists one of its own. */
const policyRow = (
  name: string,
  over: Partial<CheckpointRow> = {},
  served = false,
): CheckpointRow => ({
  id: served ? `policies/${name}.json` : name,
  name: served ? `${name}.json` : name,
  task: 'stand',
  profile: 'l3_anatomical',
  sizes: [4, 2],
  trained: null,
  ...over,
});

/** A run's search centre, which only a server lists. */
const centreRow = (name: string, task = 'stand'): CheckpointRow => ({
  id: `runs/${name}-centre.json`,
  name: `${name}-centre.json (search centre)`,
  task,
  profile: 'l3_anatomical',
  sizes: [4, 2],
  trained: null,
});

describe('the recipe Start trains', () => {
  it('carries the authority, name and task, and the tremor time is the trainer’s', () => {
    const recipe = buildRecipe(input, { ...form, name: '  stand-2 ' });
    expect(recipe.authority).toBe(0.7);
    expect(recipe.name).toBe('stand-2');
    expect(recipe.task).toBe('stand');
    expect(recipe.scenario).toBe('drop-standing-collapse');
    expect(recipe.noise).toEqual({ motor: 0.05, sense: 0.01, tau: DEFAULT_NOISE.tau });
    expect(recipe.noise?.tau).toBe(0.25);
    expect(recipe.reflex).toEqual(DEFAULT_REFLEX);
  });

  it('never puts the task in for an empty name', () => {
    expect(buildRecipe(input, { ...form, name: '' }).name).toBe('');
  });

  it('maps what plays under the brain, and says it in words', () => {
    expect(feedforwardFrom('none')).toEqual({ kind: 'none' });
    // The scenario's own muscle script, offered until 2026-09-28, is nothing now: a form state
    // saved for an Undo from before then still turns into a recipe the trainer takes.
    expect(feedforwardFrom('script')).toEqual({ kind: 'none' });
    // The activation clip called quiet-standing, which stayed when the scenario of that name went.
    expect(feedforwardFrom('clip')).toEqual({ kind: 'clip', clip: 'quiet-standing' });
    expect(buildRecipe(input, { ...form, feedforward: 'clip' }).feedforward).toEqual({
      kind: 'clip',
      clip: 'quiet-standing',
    });
    expect(feedforwardPhrase('script')).toBe('alone');
    expect(feedforwardPhrase('clip')).toBe('over the quiet-standing clip');
    expect(feedforwardPhrase('none')).toBe('alone');
  });
});

describe('a checkpoint’s name in the list', () => {
  it('is its file’s, from a server or from this studio, and a search centre has none', () => {
    expect(checkpointNameOf(policyRow('stand', {}, true))).toBe('stand');
    expect(checkpointNameOf(policyRow('stand'))).toBe('stand');
    expect(checkpointNameOf(centreRow('stand'))).toBeUndefined();
  });

  it('offers the task, or the first free number after it', () => {
    expect(freeCheckpointName([], 'stand')).toBe('stand');
    expect(freeCheckpointName([policyRow('stand'), policyRow('stand-2')], 'stand')).toBe('stand-3');
    expect(freeCheckpointName([policyRow('stand', {}, true)], 'balance')).toBe('balance');
    // A centre with no saved policy is still a run somebody may want to resume.
    expect(freeCheckpointName([centreRow('stand')], 'stand')).toBe('stand-2');
  });
});

describe('the verdict on a name', () => {
  const verdict = (
    name: string,
    rows: CheckpointRow[],
    over: { resume?: boolean; serverUp?: boolean; task?: string; recipe?: TrainingRecipe } = {},
  ) =>
    nameVerdict({
      name,
      task: over.task ?? 'stand',
      rows,
      resume: over.resume ?? false,
      serverUp: over.serverUp ?? true,
      ...(over.recipe ? { recipe: over.recipe } : {}),
    });

  it('refuses a name that is not one, and says what one is', () => {
    for (const name of ['My Stand', 'Stand', '-x', '', 'a'.repeat(41)]) {
      const v = verdict(name, []);
      expect(v.verdict, name).toBe('invalid');
      expect(v.text, name).toMatch(/^Refused: /);
      expect(nameAllowsStart(v.verdict)).toBe(false);
    }
    expect(verdict('My Stand', []).problem).toContain('lower-case letters');
  });

  it('starts a new name, and refuses one that exists unless Resume is ticked', () => {
    const rows = [policyRow('stand', {}, true)];
    expect(verdict('stand-2', rows)).toMatchObject({ verdict: 'starts', text: 'Starts stand-2' });
    const exists = verdict('stand', rows);
    expect(exists.verdict).toBe('refused-exists');
    expect(exists.text).toContain('Tick Resume');
    expect(verdict('stand', rows, { resume: true }).verdict).toBe('continues');
  });

  it('refuses a Resume with nothing to continue, and continues a centre with no record yet', () => {
    const nothing = verdict('nosuch', [], { resume: true });
    expect(nothing.verdict).toBe('refused-nothing');
    expect(nothing.text).toBe(
      'Refused: nothing saved under nosuch to continue. Untick Resume to start it.',
    );
    expect(verdict('stand', [centreRow('stand')], { resume: true }).verdict).toBe('continues');
  });

  it('refuses to continue a checkpoint on a task it was not trained on', () => {
    const v = verdict('stand', [policyRow('stand', {}, true)], { resume: true, task: 'balance' });
    expect(v.verdict).toBe('refused-task');
    expect(v.text).toContain('stand was trained on stand; Resume continues only the same task');
    expect(verdict('stand', [centreRow('stand')], { resume: true, task: 'balance' }).verdict).toBe(
      'refused-task',
    );
  });

  it('refuses a shipped name with no server, whatever Resume says', () => {
    const rows = [policyRow('stand', { origin: 'shipped' })];
    for (const resume of [false, true]) {
      const v = verdict('stand', rows, { resume, serverUp: false });
      expect(v.verdict).toBe('refused-shipped');
      expect(v.text).toBe(
        'Refused: stand ships with the studio and cannot be continued in this window; choose another name.',
      );
    }
    // Retrained here, the name is this studio's own and the ordinary rules apply.
    const mine = [policyRow('stand', { origin: 'local' })];
    expect(verdict('stand', mine, { resume: true, serverUp: false }).verdict).toBe('continues');
    // A server holds its copy as a file like any other, which it can continue.
    expect(verdict('stand', rows, { resume: true, serverUp: true }).verdict).toBe('continues');
  });

  it('says how a resume trains differently from how the checkpoint was trained', () => {
    const saved = buildRecipe(input, { ...form, name: 'stand', authority: 1 });
    const now = buildRecipe(input, { ...form, name: 'stand', authority: 0.3 });
    const rows = [policyRow('stand', { recipe: saved }, true)];
    const v = verdict('stand', rows, { resume: true, recipe: now });
    expect(v.verdict).toBe('continues');
    expect(v.changes).toBe('authority 1 -> 0.3');
    expect(verdict('stand', rows, { resume: true, recipe: saved }).changes).toBe('');
  });
});

describe('what a server did with what it was sent', () => {
  it('says each value it held to a limit, and nothing when there were none', () => {
    expect(adjustedPhrase(undefined)).toBe('');
    expect(adjustedPhrase([])).toBe('');
    expect(adjustedPhrase([{ field: 'reflex.stretch', asked: 9, used: 8 }])).toBe(
      'reflex.stretch 9 was capped at 8',
    );
    expect(
      adjustedPhrase([
        { field: 'noise.tau', asked: 0, used: 0.01 },
        { field: 'profile', asked: 'l9', used: 'l3_anatomical' },
      ]),
    ).toBe('noise.tau 0 was raised to 0.01, profile l9 was replaced by l3_anatomical');
  });
});

describe('the shipped checkpoints', () => {
  it('are one, balance, trained in the body as it is', async () => {
    // The five shipped before 2026-09-27 were all trained before the current cord and the hand
    // muscles; the owner retired them for one default behaviour trained after both.
    const shipped = await shippedCheckpoints();
    expect(shipped.map((s) => s.name)).toEqual(['balance']);
    for (const { name, file } of shipped) {
      expect(trainedBefore(file), name).toBeUndefined();
      expect(file.task, name).toBe('balance');
    }
  });

  it('say nothing once they are trained in the body as it is', () => {
    const now = { at: '2026-09-27T00:00:00Z', generations: 1, fitness: 1, episodes: 1 };
    expect(trainedBefore({ trained: now, outputs: [] })).toBeUndefined();
    // Between the two changes: the hands had arrived and the cord was not yet measured.
    const between = { ...now, at: '2026-09-22T21:00:00Z' };
    expect(trainedBefore({ trained: between, outputs: [] })).toBe('the current cord');
  });

  it('are read by what they carry when their file says nothing of when', () => {
    expect(trainedBefore({ outputs: ['fingerFlexorDrive:r'] })).toBe('the current cord');
    expect(
      trainedBefore({
        outputs: ['shoulderFlexorDrive:r'],
        recipe: { ...buildRecipe(input, form), reflex: DEFAULT_REFLEX },
      }),
    ).toBe('the hand muscles');
  });
});
