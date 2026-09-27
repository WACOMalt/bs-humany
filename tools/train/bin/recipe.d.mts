/** Types for `recipe.mjs`, which is plain JavaScript because the dashboard, a Node script, imports it. */

import type {
  SEARCH_DEFAULTS as Search,
  TrainingRecipe,
  UI_RUN_DEFAULTS as Ui,
} from '../src/recipe.js';

/** One value a request sent that is not the value the run uses. */
export interface Clamped {
  /** Dotted, as the recipe spells it: `reflex.stretch`, `noise.motor`, `authority`. */
  readonly field: string;
  readonly asked: unknown;
  readonly used: unknown;
}

/** A refusal, with the HTTP status the dashboard answers it with. */
export interface Refusal {
  readonly status: 400 | 409;
  readonly error: string;
}

export const SEARCH_DEFAULTS: typeof Search;
export const UI_RUN_DEFAULTS: typeof Ui;

/** The recipe a request asks for, checked, with every value it moved; or why it was refused. */
export function recipeFrom(
  body: Record<string, unknown>,
): { recipe: TrainingRecipe; clamped: Clamped[] } | Refusal;

/** Whether a Resume has anything to continue, and what it would continue it with. */
export function resumePreflight(
  recipe: TrainingRecipe,
  saved: {
    policy?: { task?: unknown; recipe?: TrainingRecipe } | undefined;
    centre?: { task?: unknown; recipe?: TrainingRecipe } | undefined;
  },
): { recipeChanges: string | undefined } | Refusal;
