/**
 * The recipe a request to the dashboard asks for, checked, and whether a Resume it asks for has
 * anything to continue.
 *
 * Its own file rather than a function inside `dashboard.mjs`, because the dashboard starts a server
 * the moment it is imported and so nothing in it can be tested. This was where a run started from
 * the studio quietly stopped being the run the studio showed: every default and every cap here was
 * a literal of its own, and when the cord was measured again its stretch cap was left at a fifth
 * while the sliders went to eight. Now every default, limit and rule comes from
 * `tools/train/src/recipe.ts`, loaded through jiti the way the trainer loads the rig -- but that
 * module alone, which loads nothing that runs, so the dashboard still starts without MuJoCo.
 *
 * Two kinds of wrong are treated differently, on purpose. A number out of range is brought into it
 * and the request is told, value by value, what was asked and what was used: the run still starts,
 * and nobody is surprised by it. A name or a task that is not one is refused, because the only
 * thing to substitute is a different checkpoint -- and a substituted name has trained over, and
 * lost, a checkpoint somebody wanted.
 */

import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const {
  AUTHORITY_LIMIT,
  DEFAULT_AUTHORITY,
  DEFAULT_BEHAVIOUR,
  DEFAULT_NOISE,
  DEFAULT_PROFILE,
  DEFAULT_REFLEX,
  DEFAULT_TASK,
  MEMORY_LIMIT,
  MORPHOLOGY_LIMITS,
  NOISE_LIMITS,
  PROFILES,
  REFERENCE_MORPHOLOGY,
  REFLEX_FIELDS,
  REFLEX_LIMITS,
  REFLEX_REGIONS,
  RETIRED_SCENARIOS,
  SEARCH_DEFAULTS: searchDefaults,
  TASKS,
  UI_RUN_DEFAULTS: uiRunDefaults,
  checkpointNameProblem,
  formatRecipeChanges,
  isTask,
  recipeChanges,
} = await jiti.import(fileURLToPath(new URL('../src/recipe.ts', import.meta.url)));

/** The search and run defaults a dashboard-started run falls back on, from the same module. */
export const SEARCH_DEFAULTS = searchDefaults;
export const UI_RUN_DEFAULTS = uiRunDefaults;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A number as a request can send one: a number, or a string that is one. Nothing else. */
const numberIn = (v) =>
  typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : Number.NaN;

/**
 * The recipe from the studio's request, every field checked: strings that are names or ids,
 * numbers that are finite and in range, booleans that are booleans. What is not checked here --
 * that the scenario exists, that its script exists when asked to play -- the trainer refuses on
 * start and the status says so.
 *
 * `{ recipe, clamped }`, where `clamped` lists every value the request sent that is not the value
 * the run will use, as `{ field, asked, used }`; or `{ status: 400, error }` for a request that
 * names no checkpoint or no task the rig can score. A field the request leaves out takes its
 * default silently, because nothing was asked -- the default behaviour's (`DEFAULT_BEHAVIOUR`):
 * the task `balance`, "Drop, standing" at 0 m, and its memory. A request that sends no scenario at
 * all gets the default one, with its parameters unless the request sends its own. One sent empty
 * gets it at its defaults: empty was the "reference stand", the body on the ground with nothing
 * round it, which is the body "Drop, standing" places at 0 m, so nothing about the run changes
 * and nothing is said.
 *
 * Two things a request may still send have gone, and each is replaced and listed in `clamped`, as
 * a value out of range is: a scenario deleted on 2026-09-28 (`RETIRED_SCENARIOS`) becomes the
 * default one at its defaults, and "the scenario's own muscle script" under the brain, which went
 * with them, becomes nothing. The studio has offered neither since, but a page left open, or a
 * request somebody wrote, may still send them.
 *
 * The cord is the one field whose absence means something other than its default. A recipe with no
 * `reflex` is a body with no cord -- that is how `rigOptionsFor` has always read one, and how every
 * checkpoint trained before the spinal module is still reloaded -- so a request without one gets a
 * recipe without one. A request with one gets every missing number from `DEFAULT_REFLEX`, so
 * asking for a stretch of 3.5 is the measured cord with a stretch of 3.5 rather than a stretch of
 * 3.5 on a cord of guesses. Its stretch by region is the exception once a stretch is sent: a
 * region the request leaves out then follows that stretch, so a request with a stretch and no
 * regions is that stretch everywhere.
 */
export function recipeFrom(body) {
  const task = body.task === undefined || body.task === '' ? DEFAULT_TASK : body.task;
  if (!isTask(task)) {
    return {
      status: 400,
      error: `unknown task '${String(body.task)}'; known: ${TASKS.join(', ')}`,
    };
  }
  const name = body.name === undefined || body.name === '' ? task : body.name;
  const nameProblem = checkpointNameProblem(name);
  if (nameProblem) return { status: 400, error: nameProblem };
  const r = isObject(body.recipe) ? body.recipe : {};
  if (r.reflex != null && !isObject(r.reflex)) {
    return { status: 400, error: `the cord is an object of its ${REFLEX_FIELDS.length} numbers` };
  }

  const clamped = [];
  /**
   * `raw` as a number inside `limit`, or `fallback` when it is not a number at all, and a line in
   * `clamped` whenever what was sent is not what is used.
   */
  const bounded = (field, raw, fallback, limit, round = false) => {
    const asked = numberIn(raw);
    const wanted = Number.isFinite(asked) ? asked : fallback;
    const used = Math.min(limit.max, Math.max(limit.min, round ? Math.round(wanted) : wanted));
    if (raw !== undefined && used !== asked) clamped.push({ field, asked: raw, used });
    return used;
  };

  const parameters = {};
  if (r.parameters && typeof r.parameters === 'object')
    for (const [k, v] of Object.entries(r.parameters))
      if (/^[\w-]{1,40}$/.test(k) && Number.isFinite(Number(v))) parameters[k] = Number(v);
  const proportions = {};
  if (r.morphology?.proportions && typeof r.morphology.proportions === 'object')
    for (const [k, v] of Object.entries(r.morphology.proportions))
      if (/^\w{1,40}$/.test(k) && Number.isFinite(Number(v))) proportions[k] = Number(v);
  const kind = r.feedforward?.kind;
  if (kind === 'script') clamped.push({ field: 'feedforward.kind', asked: 'script', used: 'none' });
  const feedforward =
    kind === 'clip'
      ? {
          kind: 'clip',
          clip: /^[\w-]{1,40}$/.test(String(r.feedforward.clip))
            ? String(r.feedforward.clip)
            : 'quiet-standing',
        }
      : { kind: 'none' };
  const profile = PROFILES.includes(r.profile) ? r.profile : DEFAULT_PROFILE;
  if (r.profile !== undefined && profile !== r.profile) {
    clamped.push({ field: 'profile', asked: r.profile, used: profile });
  }
  const morphology = {};
  for (const k of ['sex', 'stature', 'mass']) {
    morphology[k] = bounded(
      `morphology.${k}`,
      r.morphology?.[k],
      REFERENCE_MORPHOLOGY[k],
      MORPHOLOGY_LIMITS[k],
    );
  }
  const noise = {};
  for (const k of ['motor', 'sense', 'tau']) {
    noise[k] = bounded(`noise.${k}`, r.noise?.[k], DEFAULT_NOISE[k], NOISE_LIMITS[k]);
  }
  let reflex;
  if (isObject(r.reflex)) {
    reflex = {};
    for (const k of REFLEX_FIELDS) {
      reflex[k] = bounded(`reflex.${k}`, r.reflex[k], DEFAULT_REFLEX[k], REFLEX_LIMITS[k]);
    }
    // The stretch by region, held to the stretch's own range. A request that sends a stretch and no
    // regions -- every request from a studio before regions -- means that stretch everywhere, as a
    // cord with only `stretch` has always been read, so a region it leaves out follows the base.
    // One that sends no stretch either gets the measured regions with the measured stretch, like
    // every other number it leaves out. A region that is not a number falls back on the base, and
    // a name that is not a region is not a setting of the cord and is left out.
    const regions = isObject(r.reflex.regionStretch) ? r.reflex.regionStretch : {};
    const regionStretch =
      r.reflex.stretch === undefined ? { ...(DEFAULT_REFLEX.regionStretch ?? {}) } : {};
    for (const region of REFLEX_REGIONS) {
      if (regions[region] === undefined) continue;
      regionStretch[region] = bounded(
        `reflex.regionStretch.${region}`,
        regions[region],
        reflex.stretch,
        REFLEX_LIMITS.stretch,
      );
    }
    if (Object.keys(regionStretch).length > 0) reflex.regionStretch = regionStretch;
  }
  const sent = typeof r.scenario === 'string' && /^[\w-]{0,40}$/.test(r.scenario) ? r.scenario : '';
  const retired = RETIRED_SCENARIOS.includes(sent);
  if (retired) clamped.push({ field: 'scenario', asked: sent, used: DEFAULT_BEHAVIOUR.scenario });
  const scenario = sent === '' || retired ? DEFAULT_BEHAVIOUR.scenario : sent;
  const recipe = {
    name,
    task,
    scenario,
    parameters:
      (r.scenario === undefined && r.parameters === undefined) ||
      (r.scenario !== undefined && scenario !== sent)
        ? { ...DEFAULT_BEHAVIOUR.parameters }
        : parameters,
    profile,
    morphology: {
      ...morphology,
      ...(Object.keys(proportions).length ? { proportions } : {}),
    },
    passive: r.passive !== false,
    redistribute: r.redistribute !== false,
    feedforward,
    // Read from the top of the request, beside the task and the name, not from inside the recipe:
    // that is where the studio has always sent it.
    authority: bounded('authority', body.authority, DEFAULT_AUTHORITY, AUTHORITY_LIMIT),
    noise,
    ...(reflex ? { reflex } : {}),
    memory: bounded('memory', r.memory, DEFAULT_BEHAVIOUR.memory ?? 0, MEMORY_LIMIT, true),
  };
  return { recipe, clamped };
}

/**
 * Whether a Resume has anything to continue, checked before anything is written or spawned.
 *
 * `saved` is what is on disk under the recipe's name: the policy file and the search's centre,
 * each parsed, or undefined when there is none. The trainer used to be the one to find out, after
 * the recipe file had been overwritten, and what it found was nothing to resume -- so it started a
 * fresh policy under a Resume that said otherwise. A checkpoint trained for another task would be
 * continued on a score it never learnt, which is a fresh start that keeps the old one's name.
 *
 * `{ status: 409, error }`, or `{ recipeChanges }`: how the recipe the run is about to use differs
 * from the one the checkpoint was saved with, as one line (empty when nothing differs), or
 * undefined when the checkpoint saved none. A Resume continues the checkpoint's weights under the
 * recipe this request sends, which is how a policy is carried from one body to another; the list
 * is so that nobody does that without seeing it.
 */
export function resumePreflight(recipe, saved) {
  const { name, task } = recipe;
  if (!saved.policy && !saved.centre) {
    return {
      status: 409,
      error: `nothing saved under ${name} to resume; untick Resume to start it`,
    };
  }
  for (const file of [saved.policy, saved.centre]) {
    if (file && typeof file.task === 'string' && file.task !== task) {
      return { status: 409, error: `${name} was trained for ${file.task}, not ${task}` };
    }
  }
  const savedRecipe = saved.policy?.recipe ?? saved.centre?.recipe;
  return {
    recipeChanges: savedRecipe
      ? formatRecipeChanges(recipeChanges(savedRecipe, recipe))
      : undefined,
  };
}
