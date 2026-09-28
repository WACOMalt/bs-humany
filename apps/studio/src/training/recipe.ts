/**
 * What Start would train, worked out once from the Brain panel's form, and whether the name it
 * would train under may be used.
 *
 * The panel used to build its recipe twice, once for the dashboard and once for a run in the
 * window, and the two copies had drifted in small ways: the window's run fell back on the task
 * for an empty name, the dashboard's did not, and each carried its own copy of the noise's
 * correlation time. The name rule was a third copy of a regular expression that allowed one
 * character more than the studio binary would read. So the recipe is assembled here, from the
 * tabs and the form, and the verdict on its name is given here, and the panel draws both.
 *
 * No DOM and nothing that runs a body, so it is tested in Node. The rule for a name and every
 * default come from the trainer's recipe module by name -- that module imports nothing that runs,
 * so it brings no MuJoCo onto the main thread with it -- and a change there is a change here.
 */

import {
  DEFAULT_NOISE,
  type Feedforward,
  type TrainingRecipe as TrainerRecipe,
  checkpointNameProblem,
  formatRecipeChanges,
  recipeChanges,
} from '@bs-humany/train/recipe';
import type { CheckpointRow, RecipeInput, TrainingRecipe } from '../brain.js';

/**
 * The clip the "quiet-standing clip" choice plays under the brain: the one the first checkpoints
 * were trained over. An activation clip, not the scenario of the same name, which was deleted on
 * 2026-09-28; the clip stayed.
 */
export const STANDING_CLIP = 'quiet-standing';

/**
 * What plays under the brain, from the form's choice: `none` or `clip`. Anything else is nothing,
 * `script` among it -- "the scenario's own muscle script", which the form offered until the
 * scenarios that had one were deleted on 2026-09-28.
 */
export function feedforwardFrom(kind: string): Feedforward {
  if (kind === 'clip') return { kind: 'clip', clip: STANDING_CLIP };
  return { kind: 'none' };
}

/** The same choice in the words the recipe note uses. */
export function feedforwardPhrase(kind: string): string {
  if (kind === 'clip') return 'over the quiet-standing clip';
  return 'alone';
}

/** The Brain panel's part of a recipe: everything the Scene, Body and World tabs do not say. */
export interface RecipeForm {
  readonly name: string;
  readonly task: string;
  /** The form's choice of what plays under the brain: `none` or `clip`. */
  readonly feedforward: string;
  readonly authority: number;
  readonly noise: { readonly motor: number; readonly sense: number };
  readonly reflex: NonNullable<TrainingRecipe['reflex']>;
  readonly memory: number;
}

/**
 * The recipe Start trains, from the tabs and the form. The name is taken as it is typed, less the
 * spaces round it, and never replaced: a name that is not one is refused by `nameVerdict`, not
 * quietly swapped for the task, which is how a run under a mistyped name used to train over the
 * checkpoint the task is called.
 *
 * The tremor's correlation time has no control on the form, so it is the trainer's default here
 * and in no other place in the studio.
 *
 * The trainer's own recipe type rather than the checkpoint file's: a file may still say what plays
 * under the brain is "the scenario's own muscle script", retired on 2026-09-28, and a recipe Start
 * sends never can.
 */
export function buildRecipe(input: RecipeInput, form: RecipeForm): TrainerRecipe {
  return {
    ...input,
    name: form.name.trim(),
    task: form.task,
    feedforward: feedforwardFrom(form.feedforward),
    authority: form.authority,
    noise: { motor: form.noise.motor, sense: form.noise.sense, tau: DEFAULT_NOISE.tau },
    reflex: form.reflex,
    memory: form.memory,
  };
}

/** The ending the dashboard gives a run's search centre in its list. */
const CENTRE = /-centre\.json \(search centre\)$/;

/** Whether a row is a run's search centre rather than a checkpoint's saved policy. */
const isCentre = (row: Pick<CheckpointRow, 'id' | 'name'>): boolean =>
  row.id.startsWith('runs/') || row.name.endsWith(' (search centre)');

/**
 * The name a row's policy is saved under, or undefined for a search centre, which is the middle
 * of a run rather than a checkpoint. From the file rather than from the recipe inside it, because
 * the file's name is what the dashboard and the studio's store both look for when a name is
 * asked for: `balance.json` from a server and `balance` from this studio are the same checkpoint.
 */
export function checkpointNameOf(row: Pick<CheckpointRow, 'id' | 'name'>): string | undefined {
  if (isCentre(row)) return undefined;
  return row.name.replace(/\.json$/, '');
}

/** The checkpoint a search-centre row belongs to, or undefined for any other row. */
function centreNameOf(row: Pick<CheckpointRow, 'id' | 'name'>): string | undefined {
  return isCentre(row) && CENTRE.test(row.name) ? row.name.replace(CENTRE, '') : undefined;
}

/** Every name a row in the list holds, a saved policy or a search centre. */
function heldNames(rows: readonly Pick<CheckpointRow, 'id' | 'name'>[]): Set<string> {
  const held = new Set<string>();
  for (const row of rows) {
    const name = checkpointNameOf(row) ?? centreNameOf(row);
    if (name !== undefined) held.add(name);
  }
  return held;
}

/**
 * The name the form offers when nobody has typed one: the task, or the task with the first
 * number after it that nothing in the list is called.
 *
 * The form used to open on `stand`, which was the name of a checkpoint the studio shipped -- so
 * the first press of Start was refused, or with Resume ticked continued a policy nobody had
 * chosen. It opens on the task, balance, which is again the name of the one shipped checkpoint, so
 * the offer is `balance-2` until somebody types another.
 */
export function freeCheckpointName(
  rows: readonly Pick<CheckpointRow, 'id' | 'name'>[],
  task: string,
): string {
  const held = heldNames(rows);
  if (!held.has(task)) return task;
  for (let n = 2; ; n++) {
    const name = `${task}-${n}`;
    if (!held.has(name)) return name;
  }
}

/** What Start would do with the name on the form. */
export type NameVerdict =
  | 'starts'
  | 'continues'
  | 'invalid'
  | 'refused-exists'
  | 'refused-nothing'
  | 'refused-shipped'
  | 'refused-task';

export interface NameVerdictResult {
  readonly verdict: NameVerdict;
  /**
   * What the recipe note says. For a refusal, the whole sentence; for a start or a continuation,
   * the opening words -- `Starts stand-2`, `Continues stand` -- which the note follows with what
   * the run will be trained in.
   */
  readonly text: string;
  /** Why Start would be refused, as a clause to follow "Could not start: "; only for a refusal. */
  readonly problem?: string;
  /**
   * For a continuation, how the recipe it will train under differs from the one the checkpoint
   * was saved with, in the trainer's own words; empty when nothing differs or nothing was saved.
   */
  readonly changes?: string;
}

/** Whether Start may go ahead with this verdict. */
export const nameAllowsStart = (verdict: NameVerdict): boolean =>
  verdict === 'starts' || verdict === 'continues';

const refused = (verdict: NameVerdict, problem: string): NameVerdictResult => ({
  verdict,
  text: `Refused: ${problem}.`,
  problem,
});

/**
 * What Start would do with a name, from the list as it was last drawn: start a new checkpoint,
 * continue one, or refuse, and why.
 *
 * The same rules the dashboard keeps for a run it starts and the window keeps for a run of its
 * own, said before Start is pressed rather than after, so a person reads the refusal instead of
 * pressing a button that then does nothing:
 *
 * - A name that is not one is refused, never replaced.
 * - Without a server, a name only the studio's shipped set holds is refused whatever Resume
 *   says. The shipped checkpoints are part of the bundle, not this window's store, so there is
 *   nothing here to continue, and a new run under the name would hide the shipped one.
 * - A saved checkpoint is not trained over unless Resume is ticked.
 * - Resume with nothing saved under the name, as a policy or a search centre, is refused rather
 *   than quietly starting afresh under a word that said otherwise.
 * - Resume continues only the task a checkpoint was trained on: continuing a stand on a balance
 *   score is a fresh start that keeps the old one's name.
 *
 * `recipe`, when given, is the recipe Start would send, and a continuation says how it differs
 * from the saved one -- a resume trains in what the tabs say now, not in what it was trained in.
 */
export function nameVerdict(s: {
  readonly name: string;
  readonly task: string;
  readonly rows: readonly CheckpointRow[];
  readonly resume: boolean;
  readonly serverUp: boolean;
  readonly recipe?: TrainingRecipe;
}): NameVerdictResult {
  const name = s.name.trim();
  const problem = checkpointNameProblem(name);
  if (problem !== undefined) return refused('invalid', problem);

  const saved = s.rows.filter((row) => checkpointNameOf(row) === name);
  const centres = s.rows.filter((row) => centreNameOf(row) === name);
  if (!s.serverUp && saved.length > 0 && saved.every((row) => row.origin === 'shipped')) {
    return refused(
      'refused-shipped',
      `${name} ships with the studio and cannot be continued in this window; choose another name`,
    );
  }
  if (!s.resume) {
    return saved.length > 0
      ? refused(
          'refused-exists',
          `${name} exists. Tick Resume to continue it, or choose another name`,
        )
      : { verdict: 'starts', text: `Starts ${name}` };
  }
  if (saved.length === 0 && centres.length === 0) {
    return refused(
      'refused-nothing',
      `nothing saved under ${name} to continue. Untick Resume to start it`,
    );
  }
  // A file too old to say what it was trained on is not held against the task chosen now.
  const other = [...saved, ...centres].find(
    (row) => typeof row.task === 'string' && row.task !== s.task,
  );
  if (other) {
    return refused(
      'refused-task',
      `${name} was trained on ${other.task}; Resume continues only the same task. Choose another name`,
    );
  }
  const was = saved.find((row) => row.recipe)?.recipe ?? centres.find((row) => row.recipe)?.recipe;
  const changes = s.recipe && was ? formatRecipeChanges(recipeChanges(was, s.recipe)) : '';
  return { verdict: 'continues', text: `Continues ${name}`, changes };
}

/** One value the dashboard used in place of the one it was sent, as its reply lists them. */
export interface Adjusted {
  readonly field: string;
  readonly asked: unknown;
  readonly used: unknown;
}

/**
 * The values a server changed, in a line: `reflex.stretch 9 was capped at 8`. Empty when it
 * changed nothing, so a caller says "Started; ..." only when there is something to say. A value
 * the server holds to a range is said to be capped or raised; anything else, a profile it does not
 * know, is said to have been replaced.
 */
export function adjustedPhrase(list: readonly Adjusted[] | undefined): string {
  return (list ?? [])
    .map(({ field, asked, used }) => {
      const a = Number(asked);
      const how =
        typeof used === 'number' && Number.isFinite(a)
          ? used < a
            ? 'was capped at'
            : 'was raised to'
          : 'was replaced by';
      return `${field} ${String(asked)} ${how} ${String(used)}`;
    })
    .join(', ');
}
