/**
 * A session, a recipe or a checkpoint that names a scenario deleted on 2026-09-28 still opens.
 *
 * The owner deleted the seven scenarios that drove muscles from their scripts -- "Standing
 * quietly", "Standing, with the nerves", the range of motion, the flailing arms and the three
 * activation clips played open loop -- because the drive sliders, the Spine sliders and the Brain
 * tab own what they did. The files that name them outlive them: a session saved last week, a
 * checkpoint trained in one, a recipe the dashboard wrote. Each still loads, in "Drop, standing"
 * at 0 m, and says once that it did, rather than being refused over a name nobody can pick any
 * more. The same goes for "the scenario's own muscle script" under the brain, which went with
 * them and is read as nothing.
 */

import { resolveMorphology } from '@bs-humany/anthropometry';
import type { PolicyFile } from '@bs-humany/modules-nerves';
import { DEFAULT_SCENARIO, RETIRED_SCENARIOS, scenario } from '@bs-humany/scenarios';
import { Simulation } from '@bs-humany/session';
import { buildDocument } from '@bs-humany/skeleton';
import { checkRecipe, upgradeRecipe } from '@bs-humany/train/recipe';
import { describe, expect, it } from 'vitest';
import { isSessionFile, normaliseSettings, withoutRetiredScenario } from './session.js';
import { feedforwardFrom } from './training/recipe.js';

/** A session as the studio wrote them before the deletion, settings only, in quiet standing. */
const SAVED = JSON.stringify({
  format: 'bs-humany.session/2',
  savedAt: '2026-09-20T12:00:00.000Z',
  settings: {
    sex: 0.5,
    stature: 1.7,
    mass: 70,
    profile: 'l3_anatomical',
    backend: 'mujoco',
    scenario: 'quiet-standing',
    scenarioParameters: { tone: 1.5, reflex: 0.8, settle: 0.25 },
    passive: true,
    redistribute: true,
    dropHeight: 0.2,
    muscles: true,
  },
});

describe('a session saved in a deleted scenario', () => {
  it('loads in "Drop, standing" at 0 m, says so once, and runs', async () => {
    const file: unknown = JSON.parse(SAVED);
    expect(isSessionFile(file)).toBe(true);
    if (!isSessionFile(file)) return;
    const { settings, note } = withoutRetiredScenario(normaliseSettings(file.settings));
    expect(settings.scenario).toBe(DEFAULT_SCENARIO);
    // The deleted scenario's own values mean nothing to the one in its place.
    expect(settings.scenarioParameters).toBeUndefined();
    // Everything else is the session's.
    expect(settings.profile).toBe('l3_anatomical');
    expect(settings.muscles).toBe(true);
    // One sentence, which the studio puts on its event line after the load.
    expect(note).toBe(
      'the scenario quiet-standing was deleted on 2026-09-28 (scenarios no longer drive muscles), ' +
        'so "Drop, standing" at 0 m is used in its place',
    );

    // And the run the studio builds from it goes.
    const chosen = scenario(settings.scenario);
    const simulation = new Simulation(
      buildDocument(),
      resolveMorphology({ sex: settings.sex, stature: settings.stature, mass: settings.mass }),
      {
        profileId: settings.profile,
        backend: 'mujoco',
        passiveJoints: settings.passive,
        redistribute: settings.redistribute,
        scenario: chosen,
        dropHeight: settings.dropHeight,
        groundHeight: chosen.ground.height,
        muscles: settings.muscles,
      },
    );
    await simulation.start();
    for (let frame = 0; frame < 5; frame++) simulation.advance(1 / 60);
    expect(simulation.ticks).toBeGreaterThan(0);
    expect(simulation.failure).toBeUndefined();
    expect(simulation.recording.scenario).toBe(DEFAULT_SCENARIO);
    simulation.dispose();
  }, 60_000);

  it('replaces every one of the seven, and nothing else', () => {
    const base = normaliseSettings(JSON.parse(SAVED).settings);
    for (const id of RETIRED_SCENARIOS) {
      const { settings, note } = withoutRetiredScenario({ ...base, scenario: id });
      expect(settings.scenario, id).toBe(DEFAULT_SCENARIO);
      expect(note, id).toContain(`the scenario ${id} was deleted`);
    }
    // A scenario that exists, and the free drop, are the session's own and say nothing.
    for (const id of ['tilting-floor', DEFAULT_SCENARIO, '']) {
      const kept = withoutRetiredScenario({ ...base, scenario: id, scenarioParameters: { a: 1 } });
      expect(kept.settings.scenario, id).toBe(id);
      expect(kept.settings.scenarioParameters, id).toEqual({ a: 1 });
      expect(kept.note, id).toBeUndefined();
    }
    // One the studio never had is left for the load to refuse by name, as it always was.
    expect(withoutRetiredScenario({ ...base, scenario: 'no-such' }).settings.scenario).toBe(
      'no-such',
    );
  });
});

describe('a checkpoint trained in a deleted scenario, over its script', () => {
  /** A checkpoint's own recipe as the trainer saved it before 2026-09-28. */
  const recipe: NonNullable<PolicyFile['recipe']> = {
    name: 'stand-old',
    task: 'stand',
    scenario: 'nerves-stand',
    parameters: { authority: 0.3, gain: 1 },
    profile: 'l3_anatomical',
    morphology: { sex: 0.5, stature: 1.7, mass: 70 },
    passive: true,
    redistribute: true,
    feedforward: { kind: 'script' },
    authority: 0.3,
  };

  it('is still a recipe, set up in "Drop, standing" at 0 m with nothing under the brain', () => {
    expect(checkRecipe(recipe)).toEqual([]);
    const upgraded = upgradeRecipe(recipe);
    expect(upgraded.recipe.scenario).toBe(DEFAULT_SCENARIO);
    expect(upgraded.recipe.parameters).toEqual({ clearance: 0 });
    expect(upgraded.recipe.feedforward).toEqual({ kind: 'none' });
    // The two things that are gone, each in a clause the set-up's announcement strings together.
    expect(upgraded.notes).toHaveLength(2);
    expect(upgraded.notes[0]).toContain('the scenario nerves-stand was deleted on 2026-09-28');
    expect(upgraded.notes[1]).toContain("the scenario's own muscle script under the brain");
    // The rest of it is the checkpoint's.
    expect(upgraded.recipe.name).toBe('stand-old');
    expect(upgraded.recipe.authority).toBe(0.3);
  });

  it("puts nothing under the brain on the form, which no longer offers the scenario's script", () => {
    expect(feedforwardFrom(recipe.feedforward.kind)).toEqual({ kind: 'none' });
  });
});
