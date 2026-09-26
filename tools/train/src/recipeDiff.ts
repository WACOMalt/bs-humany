/**
 * What differs between the world a checkpoint was trained in and the one a run is about to
 * train it in.
 *
 * A resume continues the search in whatever the recipe says now, not in whatever the checkpoint
 * was saved with -- that is what makes the coarse-to-fine carry-on possible, and it is also how
 * a run came to be resumed at a third of the authority it learned at without anybody being told.
 * So the trainer lists every field that changed before it spends a single episode, and a record
 * set in one world is not held up against scores earned in another: a centre that stands at
 * authority 0.3 cannot be compared with a record that stood at 1.
 *
 * Only the fields that make the world: the name is not one (a recipe renamed is the same run),
 * and the timescale follows from the profile, so it is reported as the profile.
 */

import { DEFAULT_NOISE, NO_REFLEX } from './rig.js';

/**
 * The fields of a recipe that say what world a policy is trained in. Loose, so that the trainer's
 * `TrainingRecipe` and a policy file's own copy of it both fit without either depending on the
 * other.
 */
export interface ComparableRecipe {
  readonly task: string;
  readonly scenario: string;
  readonly parameters: object;
  readonly profile: string;
  readonly morphology: object;
  readonly passive: boolean;
  readonly feedforward: { readonly kind: string; readonly clip?: string };
  readonly authority: number;
  readonly noise?: object | undefined;
  readonly reflex?: object | undefined;
  readonly memory?: number | undefined;
}

/** One field that differs, by its dotted path: `authority`, `reflex.stretch`, `parameters.tilt`. */
export interface RecipeDifference {
  readonly field: string;
  readonly was: string | number | boolean | undefined;
  readonly now: string | number | boolean | undefined;
}

/** How near two numbers may be and still be the same setting: a JSON round trip, not a change. */
const TOLERANCE = 1e-9;

type Leaf = string | number | boolean | undefined;

/** The world's fields, in the order they are listed. */
const SECTIONS = [
  'task',
  'scenario',
  'parameters',
  'profile',
  'morphology',
  'passive',
  'feedforward',
  'authority',
  'noise',
  'memory',
  'reflex',
];

/** What plays under the brain, as one value, so a changed clip is one difference and not two. */
function feedforwardOf(f: ComparableRecipe['feedforward']): string {
  if (f.kind === 'clip') return `the ${f.clip ?? 'unnamed'} clip`;
  if (f.kind === 'script') return "the scenario's script";
  return 'nothing';
}

/** Every leaf of a nested value under a dotted path. */
function flatten(value: unknown, path: string, into: Map<string, Leaf>): void {
  if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) flatten(inner, `${path}.${key}`, into);
    return;
  }
  into.set(path, value as Leaf);
}

/**
 * The world a recipe describes, as one flat map of leaves. A recipe that omits the noise, the
 * cord or the memory means what the rig means by omitting them -- the default noise, no cord and
 * no memory, as the checkpoints from before each of those were trained -- so they are filled in
 * the same way here, and an old checkpoint resumed under the defaults it was trained in shows
 * no difference.
 */
function worldOf(recipe: ComparableRecipe): Map<string, Leaf> {
  const leaves = new Map<string, Leaf>();
  leaves.set('task', recipe.task);
  leaves.set('scenario', recipe.scenario);
  flatten(recipe.parameters ?? {}, 'parameters', leaves);
  leaves.set('profile', recipe.profile);
  flatten(recipe.morphology ?? {}, 'morphology', leaves);
  leaves.set('passive', recipe.passive);
  leaves.set('feedforward', feedforwardOf(recipe.feedforward));
  leaves.set('authority', recipe.authority);
  flatten(recipe.noise ?? DEFAULT_NOISE, 'noise', leaves);
  leaves.set('memory', recipe.memory ?? 0);
  flatten(recipe.reflex ?? NO_REFLEX, 'reflex', leaves);
  return leaves;
}

function same(a: Leaf, b: Leaf): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= TOLERANCE;
  return a === b;
}

/**
 * Every field of the world that differs, in the recipe's own order. A checkpoint that records
 * no recipe -- one from before recipes were saved -- cannot be compared with anything, and is
 * reported as no difference rather than as all of them.
 */
export function recipeDifferences(
  saved: ComparableRecipe | undefined,
  now: ComparableRecipe,
): RecipeDifference[] {
  if (!saved) return [];
  const was = worldOf(saved);
  const is = worldOf(now);
  // A field only the saved recipe has -- a parameter the scenario no longer takes -- is listed
  // with the rest of its section, not after everything else.
  const section = (field: string) => SECTIONS.indexOf(field.split('.')[0] as string);
  const fields = [...is.keys(), ...[...was.keys()].filter((k) => !is.has(k))].sort(
    (a, b) => section(a) - section(b),
  );
  const out: RecipeDifference[] = [];
  for (const field of fields) {
    const a = was.get(field);
    const b = is.get(field);
    if (!same(a, b)) out.push({ field, was: a, now: b });
  }
  return out;
}

/** A number as a person would write the setting: two places, or as many as a small one needs. */
function number(x: number): string {
  if (x === 0 || Math.abs(x) >= 0.1) return x.toFixed(2);
  return String(Number(x.toPrecision(2)));
}

function value(v: Leaf): string {
  if (v === undefined) return 'unset';
  if (typeof v === 'number') return number(v);
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return v;
}

/** `l1_standard` as the studio names it, `L1`; anything else as it is. */
function profileName(id: Leaf): string {
  const level = typeof id === 'string' ? /^l(\d)/i.exec(id) : null;
  return level ? `L${level[1]}` : value(id);
}

function scenarioName(id: Leaf, names?: (id: string) => string): string {
  if (id === '' || id === undefined) return 'the reference stand';
  return names ? names(String(id)) : String(id);
}

/**
 * The differences in words, for a note or a panel: `authority 0.30 (was 1.00), in Standing
 * quietly (was the reference stand)`. A changed profile is worded as what a resume does about
 * it -- the policy is fitted from the coarser body onto this one -- rather than as a setting.
 * `scenarioNames` turns a scenario id into its title where the caller knows the titles.
 */
export function describeDifferences(
  list: readonly RecipeDifference[],
  scenarioNames?: (id: string) => string,
): string {
  return list
    .map(({ field, was, now }) => {
      if (field === 'profile') return `fitted from ${profileName(was)}`;
      if (field === 'scenario') {
        return `in ${scenarioName(now, scenarioNames)} (was ${scenarioName(was, scenarioNames)})`;
      }
      if (field === 'task') return `scored on ${value(now)} (was ${value(was)})`;
      if (field === 'feedforward') return `${value(now)} under the brain (was ${value(was)})`;
      if (field === 'passive') return `passive joints ${value(now)} (was ${value(was)})`;
      return `${field} ${value(now)} (was ${value(was)})`;
    })
    .join(', ');
}
